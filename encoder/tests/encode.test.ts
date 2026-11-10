// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FetchCache } from '@seikou/fansubs/fetch-cache';
import { fixtureFansubSources } from '@seikou/fansubs/fixture-sources';
import { discKeyOfFolder } from '../src/disc/disc-key';
import { encodeEpisodes, episodeName, opusArgs, svtArgs, type EncodeEvent, type EncodeOptions } from '../src/encode';
import { EpisodeSpecError, firstFramePlaylistUs, parseEpisodeSpec, planEpisodes } from '../src/plan/episodes';
import { readPlaylistPmts } from '../src/disc/pmt';
import { readMkv } from '../src/mux/mkv-file';
import { nodeRangeReader } from '../src/mux/node-io';
import { NoAudioChosenError } from '../src/subs/encode-record';
import { RecordStore, type SubtitleRecord } from '../src/subs/record';
import { ReleaseCache } from '../src/subs/release-cache';
import { Id, openMatroska } from '@seikou/matroska';
import { blocksInOrder, countVideoBlocks, find, findAll, floatOf, parseMkv, stringOf, uintOf } from './helpers/ebml-reader';
import { loadPlaylist } from '../src/disc/playlist';
import { probeClip, type ClipProbe } from '../src/disc/probe';
import { ffprobePath, haveFfprobe, haveTools, toolPaths } from './helpers/tools';
import { fx } from './paths';

interface ProbedStream {
  codec_name: string;
  start_time: string;
  /** Last packet's pts + duration minus the stream start, in seconds (Matroska streams carry no duration). */
  duration: number;
}

/** ffprobe oracle: per-codec start time and duration measured from the demuxed packets. */
function probeStreams(file: string): Record<string, ProbedStream> {
  const out = execFileSync(
    ffprobePath!,
    ['-v', 'error', '-show_entries', 'stream=index,codec_name,start_time:packet=stream_index,pts_time,duration_time', '-of', 'json', file],
    { encoding: 'utf8' },
  );
  const j = JSON.parse(out) as {
    streams: { index: number; codec_name: string; start_time: string }[];
    packets: { stream_index: number; pts_time: string; duration_time: string }[];
  };
  return Object.fromEntries(
    j.streams.map((st) => {
      const ends = j.packets.filter((pk) => pk.stream_index === st.index).map((pk) => Number(pk.pts_time) + Number(pk.duration_time));
      return [st.codec_name, { codec_name: st.codec_name, start_time: st.start_time, duration: Math.max(...ends) - Number(st.start_time) }];
    }),
  );
}

afterEach(() => {
  delete process.env.FAKE_ENC_EXIT;
  delete process.env.FAKE_ENC_IVF;
  delete process.env.FAKE_ENC_NOREAD;
  delete process.env.FAKE_SLEEP;
});

it('every {n} of the name pattern becomes the episode number', () => {
  expect(episodeName('Starfall {n} - part {n}', 3)).toBe('Starfall 03 - part 03');
  expect(episodeName('ep-{n}', 12)).toBe('ep-12');
});

it('film grain comes from the settings', () => {
  const args = svtArgs({ crf: 25, preset: 4, filmGrain: 9, extraSvtArgs: [] });
  expect(args.slice(args.indexOf('--film-grain'), args.indexOf('--film-grain') + 2)).toEqual(['--film-grain', '9']);
});

it('builds encoder argument lists from the spec defaults', () => {
  expect(svtArgs({ crf: 25, preset: 4, filmGrain: 4, extraSvtArgs: ['--lp', '4'] })).toEqual(['--preset', '4', '--crf', '25', '--enable-variance-boost', '1', '--tf-strength', '1', '--film-grain', '4', '--sharpness', '1', '--luminance-qp-bias', '25', '--enable-qm', '1', '--qm-min', '0', '--tile-columns', '1', '--keyint', '-2', '--color-primaries', '1', '--transfer-characteristics', '1', '--matrix-coefficients', '1', '--color-range', '0', '--progress', '0', '--lp', '4']);
  expect(opusArgs(2)).toEqual(['--bitrate', '160', '--ignorelength']);
  expect(opusArgs(6)).toEqual(['--bitrate', '320', '--ignorelength']);
});

describe.skipIf(!haveTools)('end to end on disc1', () => {
  const base = (out: string): EncodeOptions => ({ discDir: fx('fixtures/disc1'), playlistId: '00000', episodes: '1-2,3-4', outDir: out, namePattern: 'ep-{n}', crf: 40, preset: 8, extraSvtArgs: [], filmGrain: 4, cacheDir: join(out, 'cache'), tools: toolPaths()!, dataDir: join(out, 'data'), noSubtitles: false, noPgs: false });

  it('encodes two episodes with chapters and no leftover files', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const paths = await encodeEpisodes(base(out), () => {});
    expect(paths.map((p) => basename(p))).toEqual(['ep-01.mkv', 'ep-02.mkv']);
    const t = parseMkv(readFileSync(paths[0]!));
    expect(findAll(t, Id.ChapterTimeStart).map(uintOf)).toEqual([0n, 2002000000n]);
    expect(countVideoBlocks(t)).toBe(96);
    expect(floatOf(find(t, Id.Duration)!)).toBeCloseTo(4004, 1); // the audio end excludes the Opus pre-skip (CodecDelay)
    expect(readdirSync(out).sort()).toEqual(['cache', 'ep-01.mkv', 'ep-02.mkv']);
  }, 600_000);

  it.skipIf(!haveFfprobe)('encodes a multi-clip episode and a mid-clip start with A/V in step', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const paths = await encodeEpisodes({ ...base(out), episodes: '1-3,4-' }, () => {});
    expect(paths).toHaveLength(2);
    const expected = [
      { videoS: 6.006, chaptersNs: [0n, 2002000000n, 4004000000n] },
      { videoS: 2.002, chaptersNs: [0n] },
    ];
    paths.forEach((p, i) => {
      const s = probeStreams(p);
      expect(Math.abs(s.av1!.duration - expected[i]!.videoS)).toBeLessThanOrEqual(0.002);
      expect(Math.abs(s.opus!.duration - s.av1!.duration)).toBeLessThanOrEqual(0.02);
      expect(findAll(parseMkv(readFileSync(p)), Id.ChapterTimeStart).map(uintOf)).toEqual(expected[i]!.chaptersNs);
    });
  }, 600_000);

  it.skipIf(!haveFfprobe)('lets BestSource pad late-starting audio instead of offsetting it in the MKV', async () => {
    const playlist = await loadPlaylist(fx('fixtures/disc1-late'), '00000');
    const probe = await probeClip(playlist.items[0]!);
    expect(probe.video.firstPts90).toBe(900000);
    expect(probe.audio[0]!.firstPts90).toBe(901800);
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const [p] = await encodeEpisodes({ ...base(out), discDir: fx('fixtures/disc1-late'), episodes: '1-2' }, () => {});
    const s = probeStreams(p!);
    expect(Number(s.opus!.start_time)).toBe(0);
    expect(Math.abs(s.av1!.duration - 4.004)).toBeLessThanOrEqual(0.002);
    expect(Math.abs(s.opus!.duration - s.av1!.duration)).toBeLessThanOrEqual(0.02);
  }, 600_000);

  it('encode --web writes the directory for each episode', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const webDir = join(out, 'web');
    const events: EncodeEvent[] = [];
    const paths = await encodeEpisodes({ ...base(out), webDir }, (e) => events.push(e));
    expect(paths.map((p) => basename(p))).toEqual(['ep-01.mkv', 'ep-02.mkv']);
    expect(readdirSync(webDir).sort()).toEqual(['ep-01', 'ep-02']);
    for (const [i, name] of ['ep-01', 'ep-02'].entries()) {
      const dir = join(webDir, name);
      expect(readdirSync(dir).sort()).toEqual(['chapters.vtt', 'episode.json', 'video.webm']);
      const manifest = JSON.parse(readFileSync(join(dir, 'episode.json'), 'utf8')) as { video: { file: string; width: number }; audio: unknown[]; chapters: string };
      expect(manifest.video.file).toBe('video.webm');
      expect(manifest.audio).toHaveLength(1);
      const webm = parseMkv(readFileSync(join(dir, 'video.webm')));
      expect(stringOf(find(webm, Id.DocType))).toBe('webm');
      expect(countVideoBlocks(webm)).toBe(countVideoBlocks(parseMkv(readFileSync(paths[i]!))));
      expect(readFileSync(join(dir, 'chapters.vtt'), 'utf8').match(/-->/g)).toHaveLength(2);
      if (haveFfprobe) {
        const s = probeStreams(join(dir, 'video.webm'));
        expect(Object.keys(s).sort()).toEqual(['av1', 'opus']);
        expect(Math.abs(s.opus!.duration - s.av1!.duration)).toBeLessThanOrEqual(0.02);
      }
    }
    expect(events.filter((e) => e.kind === 'log' && e.message.startsWith('Packaged'))).toHaveLength(2);
  }, 600_000);

  it('deletes the partial file when an audio encoder fails', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    process.env.FAKE_ENC_EXIT = '3';
    // Exit before reading anything, so the failure does not wait on BestSource decoding the episode.
    process.env.FAKE_ENC_NOREAD = '1';
    await expect(encodeEpisodes({ ...base(out), episodes: '1-2', tools: { ...toolPaths()!, opusenc: fx('tests/fake-bin/opusenc') } }, () => {})).rejects.toMatchObject({ tool: 'opusenc', code: 3 });
    expect(existsSync(join(out, 'ep-01.mkv'))).toBe(false);
  }, 120_000);

  it('deletes the partial file when the encoder fails', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const opts = { ...base(out), episodes: '1-2' };
    process.env.FAKE_ENC_EXIT = '3';
    // A valid IVF makes writeMkv create the file; the exit code then surfaces as a ChainError after the mux loop.
    process.env.FAKE_ENC_IVF = fx('fixtures/small.ivf');
    await expect(encodeEpisodes({ ...opts, tools: { ...toolPaths()!, svt: fx('tests/fake-bin/SvtAv1EncApp') } }, () => {})).rejects.toMatchObject({ tool: 'SvtAv1EncApp', code: 3 });
    expect(existsSync(join(out, 'ep-01.mkv'))).toBe(false);
  }, 120_000);
});

/** The pids of the direct children of this process. */
function childPids(): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).split('\n').filter((l) => l !== '').map(Number);
  } catch {
    return [];
  }
}

describe.skipIf(!haveTools)('partial files, cancel, progress and subsets on disc1', () => {
  const base = (out: string): EncodeOptions => ({ discDir: fx('fixtures/disc1'), playlistId: '00000', episodes: '1-2,3-4', outDir: out, namePattern: 'ep-{n}', crf: 40, preset: 8, extraSvtArgs: [], filmGrain: 4, cacheDir: join(out, 'cache'), tools: toolPaths()!, dataDir: join(out, 'data'), noSubtitles: false, noPgs: false });

  it('an episode is written as .partial and renamed when complete', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const [p] = await encodeEpisodes({ ...base(out), onlyEpisodes: [1] }, () => {});
    expect(p).toBe(join(out, 'ep-01.mkv'));
    expect(readdirSync(out).sort()).toEqual(['cache', 'ep-01.mkv']);
    // An older finished file is only replaced by the rename: a failed run leaves it whole and no partial behind.
    writeFileSync(join(out, 'ep-01.mkv'), 'old');
    process.env.FAKE_ENC_EXIT = '3';
    process.env.FAKE_ENC_IVF = fx('fixtures/small.ivf');
    await expect(encodeEpisodes({ ...base(out), onlyEpisodes: [1], tools: { ...toolPaths()!, svt: fx('tests/fake-bin/SvtAv1EncApp') } }, () => {})).rejects.toMatchObject({ code: 3 });
    expect(readFileSync(join(out, 'ep-01.mkv'), 'utf8')).toBe('old');
    expect(existsSync(join(out, 'ep-01.mkv.partial'))).toBe(false);
  }, 600_000);

  it('aborting stops every chain and removes the partial file', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const marker = '61.37';
    process.env.FAKE_SLEEP = marker;
    process.env.FAKE_ENC_IVF = fx('fixtures/small.ivf');
    const before = new Set(childPids());
    const controller = new AbortController();
    const tools = { ...toolPaths()!, svt: fx('tests/fake-bin/SvtAv1EncApp'), opusenc: fx('tests/fake-bin/opusenc') };
    const run = encodeEpisodes({ ...base(out), tools, signal: controller.signal }, () => {}).catch((e: unknown) => e);
    // Wait until the video and audio chains (four processes) are running.
    const deadline = Date.now() + 120_000;
    while (childPids().filter((p) => !before.has(p)).length < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(childPids().filter((p) => !before.has(p)).length).toBeGreaterThanOrEqual(4);
    controller.abort();
    const err = await run;
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(childPids().filter((p) => !before.has(p))).toEqual([]);
    let sleepers = '';
    try {
      sleepers = execFileSync('pgrep', ['-f', `sleep ${marker}`], { encoding: 'utf8' });
    } catch {
      // pgrep exits 1 when nothing matches
    }
    expect(sleepers.trim()).toBe('');
    expect(readdirSync(out).filter((n) => n.endsWith('.partial') || n.endsWith('.mkv'))).toEqual([]);
  }, 180_000);

  it('an abort that arrives after a tool failed keeps the tool failure', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    process.env.FAKE_ENC_EXIT = '3';
    process.env.FAKE_ENC_NOREAD = '1';
    const controller = new AbortController();
    const tools = { ...toolPaths()!, opusenc: fx('tests/fake-bin/opusenc') };
    // The abort comes from the first event after the failing tool is started, while the failure is being handled.
    const err = await encodeEpisodes({ ...base(out), tools, signal: controller.signal }, (e) => {
      if (e.kind === 'episode-start') setTimeout(() => controller.abort(), 300);
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ tool: 'opusenc', code: 3 });
  }, 120_000);

  it('an already aborted signal rejects before anything is spawned', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const before = childPids();
    await expect(encodeEpisodes({ ...base(out), signal: AbortSignal.abort() }, () => {})).rejects.toMatchObject({ name: 'AbortError' });
    expect(childPids()).toEqual(before);
    expect(existsSync(join(out, 'cache'))).toBe(false);
  });

  it('onlyEpisodes encodes the listed episodes only', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const events: EncodeEvent[] = [];
    const paths = await encodeEpisodes({ ...base(out), onlyEpisodes: [2] }, (e) => events.push(e));
    expect(paths.map((p) => basename(p))).toEqual(['ep-02.mkv']);
    expect(readdirSync(out).sort()).toEqual(['cache', 'ep-02.mkv']);
    expect(events.filter((e) => e.kind === 'episode-start').map((e) => e.episode)).toEqual([2]);
    await expect(encodeEpisodes({ ...base(out), onlyEpisodes: [3] }, () => {})).rejects.toThrow(/episode 3/i);
    await expect(encodeEpisodes({ ...base(out), onlyEpisodes: [] }, () => {})).rejects.toBeInstanceOf(EpisodeSpecError);
  }, 600_000);

  it('progress events report frames done and total', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    // A frozen clock: only the closing event at 100% is sent.
    let events: EncodeEvent[] = [];
    await encodeEpisodes({ ...base(out), onlyEpisodes: [1], now: () => 0 }, (e) => events.push(e));
    let progress = events.filter((e) => e.kind === 'progress');
    expect(progress.map((e) => [e.episode, e.framesDone, e.frames])).toEqual([[1, 96, 96]]);
    // A clock that moves 400 ms per reading: events come in order, the last at 100%.
    let t = 0;
    events = [];
    await encodeEpisodes({ ...base(out), onlyEpisodes: [1], now: () => (t += 400) }, (e) => events.push(e));
    progress = events.filter((e) => e.kind === 'progress');
    expect(progress.length).toBeGreaterThan(2);
    const done = progress.map((e) => e.framesDone!);
    expect([...done].sort((a, b) => a - b)).toEqual(done);
    expect(progress.at(-1)).toMatchObject({ framesDone: 96, frames: 96 });
    expect(progress.slice(0, -1).every((e) => e.framesDone! < 96 && e.frames === 96)).toBe(true);
  }, 600_000);

  it('reports packaged, and package-failed with the MKV kept', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const events: EncodeEvent[] = [];
    await encodeEpisodes({ ...base(out), onlyEpisodes: [1], webDir: join(out, 'web') }, (e) => events.push(e));
    expect(events.filter((e) => e.kind === 'packaged').map((e) => e.episode)).toEqual([1]);
    // A file where the package directory's parent should go makes packaging fail.
    writeFileSync(join(out, 'blocked'), 'x');
    const failed: EncodeEvent[] = [];
    await expect(encodeEpisodes({ ...base(out), onlyEpisodes: [1], webDir: join(out, 'blocked') }, (e) => failed.push(e))).rejects.toThrow();
    expect(failed.filter((e) => e.kind === 'package-failed')).toHaveLength(1);
    expect(failed.find((e) => e.kind === 'package-failed')!.message).not.toBe('');
    expect(existsSync(join(out, 'ep-01.mkv'))).toBe(true);
    expect(failed.some((e) => e.kind === 'episode-done')).toBe(false);
  }, 600_000);
});

describe.skipIf(!haveTools)('end to end on disc3', () => {
  it('onlyFirstAudio cuts the first audio stream only', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const opts: EncodeOptions = { discDir: fx('fixtures/disc3'), playlistId: '00000', episodes: '1-', outDir: out, namePattern: 'ep-{n}', crf: 50, preset: 10, extraSvtArgs: [], filmGrain: 4, cacheDir: join(out, 'cache'), tools: toolPaths()!, dataDir: join(out, 'data'), noSubtitles: false, noPgs: false, onlyFirstAudio: true };
    const [p] = await encodeEpisodes(opts, () => {});
    expect(trackSummary(p!).map((t) => [t.codec, t.name])).toEqual([['V_AV1', ''], ['A_OPUS', 'Japanese']]);
  }, 600_000);

  it('encodes disc3 with four Opus tracks', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const opts: EncodeOptions = { discDir: fx('fixtures/disc3'), playlistId: '00000', episodes: '1-', outDir: out, namePattern: 'ep-{n}', crf: 50, preset: 10, extraSvtArgs: [], filmGrain: 4, cacheDir: join(out, 'cache'), tools: toolPaths()!, dataDir: join(out, 'data'), noSubtitles: false, noPgs: false };
    const [p] = await encodeEpisodes(opts, () => {});
    const tracks = findAll(parseMkv(readFileSync(p!)), Id.TrackEntry).map((t) => ({
      codec: stringOf(find(t, Id.CodecID)),
      name: stringOf(find(t, Id.Name)),
      language: stringOf(find(t, Id.Language)),
      isDefault: uintOf(find(t, Id.FlagDefault)) === 1n,
    }));
    expect(tracks).toEqual([
      { codec: 'V_AV1', name: '', language: 'und', isDefault: true },
      { codec: 'A_OPUS', name: 'Japanese', language: 'jpn', isDefault: true },
      { codec: 'A_OPUS', name: 'English', language: 'eng', isDefault: false },
      { codec: 'A_OPUS', name: 'English', language: 'eng', isDefault: false },
      { codec: 'A_OPUS', name: 'French', language: 'fra', isDefault: false },
    ]);
    if (haveFfprobe) {
      const j = JSON.parse(execFileSync(ffprobePath!, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,channels:stream_tags=language', '-of', 'json', p!], { encoding: 'utf8' })) as {
        streams: { codec_type: string; codec_name: string; channels?: number; tags?: { language?: string } }[];
      };
      expect(j.streams.filter((s) => s.codec_type === 'video').map((s) => s.codec_name)).toEqual(['av1']);
      const audio = j.streams.filter((s) => s.codec_type === 'audio');
      expect(audio.map((s) => s.codec_name)).toEqual(['opus', 'opus', 'opus', 'opus']);
      expect(audio.map((s) => s.channels)).toEqual([2, 6, 2, 6]);
      expect(audio.map((s) => s.tags?.language)).toEqual(['jpn', 'eng', 'eng', 'fra']);
    }
  }, 600_000);

  it("follows the saved record's audio order, ticks, names and video label", async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const opts: EncodeOptions = { discDir: fx('fixtures/disc3'), playlistId: '00000', episodes: '1-', outDir: out, namePattern: 'ep-{n}', crf: 50, preset: 10, extraSvtArgs: [], filmGrain: 4, cacheDir: join(out, 'cache'), tools: toolPaths()!, dataDir: join(out, 'data'), noSubtitles: false, noPgs: false };
    const { key, label } = await discKeyOfFolder(opts.discDir);
    await new RecordStore(opts.dataDir).write({
      disc: { key, label },
      playlist: '00000',
      episodeSpec: '1-',
      anilist: null,
      releases: [],
      fonts: [],
      episodes: [
        {
          index: 1,
          title: 'Starfall Wanderer 1',
          tracks: [],
          metadata: {
            title: 'Starfall Wanderer 1',
            video: { name: 'Starfall Wanderer', language: 'jpn' },
            audio: [
              { pid: 0x1103, name: 'Starfall dub', language: 'fra', included: true },
              { pid: 0x1100, name: 'Original', language: 'jpn', included: true },
              { pid: 0x1101, name: 'Commentary', language: 'eng', included: false },
            ],
            chapters: [],
          },
        },
      ],
      savedAt: '2026-11-07T00:00:00Z',
    });
    const events: EncodeEvent[] = [];
    const [p] = await encodeEpisodes(opts, (e) => events.push(e));
    const tracks = findAll(parseMkv(readFileSync(p!)), Id.TrackEntry).map((t) => [stringOf(find(t, Id.Name)), stringOf(find(t, Id.Language)), uintOf(find(t, Id.FlagDefault))]);
    expect(tracks).toEqual([
      ['Starfall Wanderer', 'jpn', 1n],
      ['Starfall dub', 'fra', 1n],
      ['Original', 'jpn', 0n],
    ]);
    expect(events.filter((e) => e.kind === 'log').map((e) => e.message)).toEqual([expect.stringContaining('audio PID 0x1102 is not in the saved record')]);
  }, 600_000);
});

it('refuses, before any tool starts, an episode whose ticked audio streams are all missing from the playlist', async () => {
  const out = mkdtempSync(join(tmpdir(), 'et-'));
  const discDir = fx('fixtures/disc3');
  const { key, label } = await discKeyOfFolder(discDir);
  await new RecordStore(join(out, 'data')).write({
    disc: { key, label },
    playlist: '00000',
    episodeSpec: '1-',
    anilist: null,
    releases: [],
    fonts: [],
    episodes: [
      {
        index: 1,
        title: 'Starfall Wanderer 1',
        tracks: [],
        metadata: { title: 'Starfall Wanderer 1', video: { name: '', language: 'jpn' }, audio: [{ pid: 0x1999, name: 'Gone', language: 'jpn', included: true }], chapters: [] },
      },
    ],
    savedAt: '2026-11-07T00:00:00Z',
  });
  const missing = { vspipe: '/nonexistent/vspipe', svt: '/nonexistent/SvtAv1EncApp', opusenc: '/nonexistent/opusenc' };
  const opts: EncodeOptions = { discDir, playlistId: '00000', episodes: '1-', outDir: join(out, 'mkv'), namePattern: 'ep-{n}', crf: 50, preset: 10, extraSvtArgs: [], filmGrain: 4, cacheDir: join(out, 'cache'), tools: missing, dataDir: join(out, 'data'), noSubtitles: false, noPgs: false };
  const err = await encodeEpisodes(opts, () => {}).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NoAudioChosenError);
  expect((err as Error).message).toBe('Episode 1 has no audio stream ticked in the saved choices; tick one in the helper or pass --no-subtitles');
  expect(existsSync(join(out, 'mkv'))).toBe(false);
});

/** Every track of `file` as the Matroska reader sees it, in file order. */
function trackSummary(file: string): { codec: string; name: string; language: string; isDefault: boolean }[] {
  return findAll(parseMkv(readFileSync(file)), Id.TrackEntry).map((t) => ({
    codec: stringOf(find(t, Id.CodecID)),
    name: stringOf(find(t, Id.Name)),
    language: stringOf(find(t, Id.Language)),
    isDefault: uintOf(find(t, Id.FlagDefault)) === 1n,
  }));
}

describe.skipIf(!haveTools)('end to end on disc-speech with a saved record', () => {
  it('encodes disc-speech episode 1 with the saved record', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const discDir = fx('fixtures/disc-speech');
    const dataDir = join(out, 'data');
    const fansubs = fx('tests/fixtures/fansubs');
    const release = await new ReleaseCache(dataDir, { tosho: fixtureFansubSources(fansubs).tosho, fetchCache: new FetchCache(join(out, 'fetch'), 1 << 30) }).fetchTosho(7001);
    const [ep1, ep2] = release.files;
    const { key, label } = await discKeyOfFolder(discDir);
    const audio = [{ pid: 0x1100, name: 'Original', language: 'jpn', included: true }];
    const tracksOf = (file: typeof ep1, shiftMs: number, nudgeMs: number): SubtitleRecord['episodes'][number]['tracks'] =>
      file!.tracks.map((t) => ({ release: release.key, file: t.path, kind: t.kind, language: 'eng', name: t.kind === 'full' ? 'English (GroupA)' : 'Signs (GroupA)', shiftMs, nudgeMs, split: null, included: true }));
    await new RecordStore(dataDir).write({
      disc: { key, label },
      playlist: '00000',
      episodeSpec: '1-3,4-5',
      anilist: null,
      releases: [{ source: 'tosho', id: release.key, group: release.group, label: release.label }],
      fonts: release.fonts.map((f) => f.path),
      episodes: [
        { index: 1, title: 'Arrival', tracks: tracksOf(ep1, 1200, 42), metadata: { title: 'Lantern Harbor - 01 - Arrival', video: { name: 'Lantern Harbor', language: 'jpn' }, audio, chapters: ['Cold open', '', 'Closing'] } },
        { index: 2, title: 'Departure', tracks: tracksOf(ep2, 0, 0).slice(0, 1), metadata: { title: 'Lantern Harbor - 02', video: { name: '', language: 'jpn' }, audio, chapters: [] } },
      ],
      savedAt: '2026-11-07T00:00:00Z',
    });
    const opts: EncodeOptions = { discDir, playlistId: '00000', episodes: '1-3,4-5', outDir: join(out, 'mkv'), namePattern: 'ep-{n}', crf: 50, preset: 10, extraSvtArgs: [], filmGrain: 4, cacheDir: join(out, 'cache'), tools: toolPaths()!, dataDir, noSubtitles: false, noPgs: false, title: 'Ignored' };
    const [p1, p2] = await encodeEpisodes(opts, () => {});
    const tree = parseMkv(readFileSync(p1!));
    expect(stringOf(find(tree, Id.Title))).toBe('Lantern Harbor - 01 - Arrival');
    expect(trackSummary(p1!)).toEqual([
      { codec: 'V_AV1', name: 'Lantern Harbor', language: 'jpn', isDefault: true },
      { codec: 'A_OPUS', name: 'Original', language: 'jpn', isDefault: true },
      { codec: 'S_TEXT/ASS', name: 'English (GroupA)', language: 'eng', isDefault: true },
      { codec: 'S_TEXT/ASS', name: 'Signs (GroupA)', language: 'eng', isDefault: false },
    ]);
    const files = findAll(tree, Id.AttachedFile);
    expect(files.map((f) => [stringOf(find(f, Id.FileName)), stringOf(find(f, Id.FileMediaType))])).toEqual([['DejaVuSansMono.ttf', 'font/ttf']]);
    expect(findAll(tree, Id.ChapString).map(stringOf)).toEqual(['Cold open', 'Chapter 2', 'Closing']);
    // The fixture's first Full line starts at 0:00:00.00; the shift (1200 ms) and the nudge (42 ms) move it to 1242 ms.
    const first = blocksInOrder(tree).find((b) => b.track === 3)!;
    expect(first.timeMs).toBe(1242);
    // The second episode has only its own Full track and its own title.
    const tree2 = parseMkv(readFileSync(p2!));
    expect(stringOf(find(tree2, Id.Title))).toBe('Lantern Harbor - 02');
    expect(trackSummary(p2!).map((t) => t.codec)).toEqual(['V_AV1', 'A_OPUS', 'S_TEXT/ASS']);
    if (haveFfprobe) {
      const names: Record<string, string> = { V_AV1: 'av1', A_OPUS: 'opus', 'S_TEXT/ASS': 'ass' };
      for (const p of [p1!, p2!]) {
        const j = JSON.parse(execFileSync(ffprobePath!, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', p], { encoding: 'utf8' })) as { streams: { codec_type: string; codec_name: string }[] };
        expect(j.streams.filter((s) => s.codec_type !== 'attachment').map((s) => s.codec_name)).toEqual(trackSummary(p).map((t) => names[t.codec]));
        expect(j.streams.filter((s) => s.codec_type === 'attachment')).toHaveLength(1);
      }
    }
  }, 600_000);
});

describe.skipIf(!haveTools)('chapter names and tags on disc-speech', () => {
  it("names the episode's chapters and tags it with its disc, playlist, start and AniList entry", async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const discDir = fx('fixtures/disc-speech');
    const opts: EncodeOptions = {
      discDir, playlistId: '00000', episodes: '1-2,3-4', outDir: join(out, 'mkv'), namePattern: 'ep-{n}', crf: 50, preset: 10, extraSvtArgs: [], filmGrain: 4,
      cacheDir: join(out, 'cache'), tools: toolPaths()!, dataDir: join(out, 'data'), noSubtitles: false, noPgs: false, onlyEpisodes: [2],
      episodeInfo: { chapterNames: { '3': 'Opening' }, titles: { '3': { title: { source: 'anilist', anilistId: 990001 }, episode: 2, name: null } }, savedAt: '2026-11-09T00:00:00Z' },
    };
    const [path] = await encodeEpisodes(opts, () => {});
    const mkv = await readMkv(path!);
    expect(mkv.chapters.map((c) => c.title)).toEqual(['Opening', 'Chapter 2']);
    const { tags } = await openMatroska(await nodeRangeReader(path!));
    const playlist = await loadPlaylist(discDir, '00000');
    const probes = new Map<string, ClipProbe>();
    for (const item of playlist.items) if (!probes.has(item.clipId)) probes.set(item.clipId, await probeClip(item));
    const [, plan] = planEpisodes(playlist, probes, parseEpisodeSpec('1-2,3-4', playlist.chapters.length), [], await readPlaylistPmts(playlist));
    expect(tags).toMatchObject({
      ANILIST_ID: '990001',
      EPISODE: '2',
      SEIKOU_PLAYLIST: '00000',
      SEIKOU_DISC_KEY: (await discKeyOfFolder(discDir)).key,
      SEIKOU_EPISODE_START_MS: String(Math.round(firstFramePlaylistUs(playlist, plan!) / 1000)),
    });
    expect('EPISODE_TITLE' in tags).toBe(false);
  }, 600_000);
});

describe.skipIf(!haveTools)('end to end on disc-subs', () => {
  const opts = (out: string, noPgs: boolean): EncodeOptions => ({ discDir: fx('fixtures/disc-subs'), playlistId: '00000', episodes: '1-', outDir: out, namePattern: 'ep-{n}', crf: 50, preset: 10, extraSvtArgs: [], filmGrain: 4, cacheDir: join(out, 'cache'), tools: toolPaths()!, dataDir: join(out, 'data'), noSubtitles: false, noPgs });

  it('encodes disc-subs with its two PGS tracks', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const [p] = await encodeEpisodes(opts(out, false), () => {});
    expect(trackSummary(p!)).toEqual([
      { codec: 'V_AV1', name: '', language: 'und', isDefault: true },
      { codec: 'A_OPUS', name: 'English', language: 'eng', isDefault: true },
      { codec: 'S_HDMV/PGS', name: 'English (disc)', language: 'eng', isDefault: false },
      { codec: 'S_HDMV/PGS', name: 'Japanese (disc)', language: 'jpn', isDefault: false },
    ]);
    if (haveFfprobe) {
      const j = JSON.parse(execFileSync(ffprobePath!, ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', p!], { encoding: 'utf8' })) as { streams: { codec_name: string }[] };
      expect(j.streams.map((s) => s.codec_name)).toEqual(['av1', 'opus', 'hdmv_pgs_subtitle', 'hdmv_pgs_subtitle']);
    }
  }, 600_000);

  it('--no-pgs leaves them out', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const [p] = await encodeEpisodes(opts(out, true), () => {});
    expect(trackSummary(p!).map((t) => t.codec)).toEqual(['V_AV1', 'A_OPUS']);
  }, 600_000);
});

it('follows the record it is given and does not read the saved one again', async () => {
  const out = mkdtempSync(join(tmpdir(), 'et-'));
  const discDir = fx('fixtures/disc3');
  const { key, label } = await discKeyOfFolder(discDir);
  // A saved record that would be refused (no audio ticked) if it were read again.
  await new RecordStore(join(out, 'data')).write({
    disc: { key, label },
    playlist: '00000',
    episodeSpec: '1-',
    anilist: null,
    releases: [],
    fonts: [],
    episodes: [{ index: 1, title: 'x', tracks: [], metadata: { title: 'x', video: { name: '', language: 'jpn' }, audio: [{ pid: 0x1100, name: 'A', language: 'jpn', included: false }], chapters: [] } }],
    savedAt: '2026-11-07T00:00:00Z',
  });
  const missing = { vspipe: '/nonexistent/vspipe', svt: '/nonexistent/SvtAv1EncApp', opusenc: '/nonexistent/opusenc' };
  const opts: EncodeOptions = { discDir, playlistId: '00000', episodes: '1-', outDir: join(out, 'mkv'), namePattern: 'ep-{n}', crf: 50, preset: 10, extraSvtArgs: [], filmGrain: 4, cacheDir: join(out, 'cache'), tools: missing, dataDir: join(out, 'data'), noSubtitles: false, noPgs: true, record: null };
  const err = await encodeEpisodes(opts, () => {}).catch((e: unknown) => e);
  expect(err).not.toBeInstanceOf(NoAudioChosenError);
});

it('reads every episode\'s subtitle files before any tool starts', async () => {
  const out = mkdtempSync(join(tmpdir(), 'et-'));
  const discDir = fx('fixtures/disc1');
  const dataDir = join(out, 'data');
  mkdirSync(join(dataDir, 'cache'), { recursive: true });
  writeFileSync(join(dataDir, 'cache/ep1.ass'), '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.10,0:00:00.50,Default,,0,0,0,,Hi\n');
  const { key, label } = await discKeyOfFolder(discDir);
  const episode = (index: number, file: string): SubtitleRecord['episodes'][number] => ({
    index,
    title: `Episode ${index}`,
    tracks: [{ release: 'local-0', file, kind: 'full', language: 'eng', name: 'English', shiftMs: 0, nudgeMs: 0, split: null, included: true }],
    metadata: { title: `Episode ${index}`, video: { name: '', language: 'und' }, audio: [{ pid: 0x1100, name: '', language: 'eng', included: true }], chapters: [] },
  });
  const record: SubtitleRecord = { disc: { key, label }, playlist: '00000', episodeSpec: '1-2,3-4', anilist: null, releases: [{ source: 'local', id: 'local-0', group: '', label: 'own files' }], fonts: [], episodes: [episode(1, 'cache/ep1.ass'), episode(2, 'cache/gone.ass')], savedAt: '2026-11-07T00:00:00Z' };
  const missing = { vspipe: '/nonexistent/vspipe', svt: '/nonexistent/SvtAv1EncApp', opusenc: '/nonexistent/opusenc' };
  const opts: EncodeOptions = { discDir, playlistId: '00000', episodes: '1-2,3-4', outDir: join(out, 'mkv'), namePattern: 'ep-{n}', crf: 50, preset: 10, extraSvtArgs: [], filmGrain: 4, cacheDir: join(out, 'cache'), tools: missing, dataDir, noSubtitles: false, noPgs: true, record };
  // The tools are missing, so reaching the first encode would fail with a spawn error instead.
  await expect(encodeEpisodes(opts, () => {})).rejects.toMatchObject({ code: 'ENOENT', path: expect.stringContaining('gone.ass') });
  expect(existsSync(join(out, 'mkv'))).toBe(false);
});

it("plans an episode from its own clips alone: another clip's bytes are never read", async () => {
  const out = mkdtempSync(join(tmpdir(), 'et-'));
  const discDir = join(out, 'disc1');
  cpSync(fx('fixtures/disc1'), discDir, { recursive: true });
  // Clip 1 holds episode 1 (chapters 1-2) alone; zeroed, it has no PAT, PMT or PES, so reading it fails.
  const clip1 = join(discDir, 'BDMV/STREAM/00001.m2ts');
  writeFileSync(clip1, Buffer.alloc(statSync(clip1).size));
  const missing = { vspipe: '/nonexistent/vspipe', svt: '/nonexistent/SvtAv1EncApp', opusenc: '/nonexistent/opusenc' };
  const opts = (only: number): EncodeOptions => ({ discDir, playlistId: '00000', episodes: '1-2,3-4', outDir: join(out, `mkv-${only}`), namePattern: 'ep-{n}', crf: 50, preset: 10, extraSvtArgs: [], filmGrain: 4, cacheDir: join(out, 'cache'), tools: missing, dataDir: join(out, 'data'), noSubtitles: false, noPgs: false, record: null, episodeInfo: null, onlyEpisodes: [only] });
  const events: EncodeEvent[] = [];
  // The tools are missing, so the run fails only once episode 2's encode starts.
  const err = await encodeEpisodes(opts(2), (e) => events.push(e)).catch((e: unknown) => e);
  expect(events.filter((e) => e.kind === 'episode-start').map((e) => e.episode)).toEqual([2]);
  expect(String(err)).not.toMatch(/00001/);
  // Episode 1 does read the zeroed clip.
  await expect(encodeEpisodes(opts(1), () => {})).rejects.toThrow(/00001/);
});
