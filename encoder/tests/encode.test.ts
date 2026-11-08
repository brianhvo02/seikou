// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discKeyOfFolder } from '../src/disc/disc-key';
import { encodeEpisodes, opusArgs, svtArgs, type EncodeEvent, type EncodeOptions } from '../src/encode';
import { NoAudioChosenError } from '../src/subs/encode-record';
import { RecordStore } from '../src/subs/record';
import { Id } from '../src/mux/mkv-ids';
import { countVideoBlocks, find, findAll, floatOf, parseMkv, stringOf, uintOf } from './helpers/ebml-reader';
import { loadPlaylist } from '../src/disc/playlist';
import { probeClip } from '../src/disc/probe';
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
});

it('builds encoder argument lists from the spec defaults', () => {
  expect(svtArgs({ crf: 25, preset: 4, extraSvtArgs: ['--lp', '4'] })).toEqual(['--preset', '4', '--crf', '25', '--enable-variance-boost', '1', '--tf-strength', '1', '--film-grain', '4', '--sharpness', '1', '--luminance-qp-bias', '25', '--enable-qm', '1', '--qm-min', '0', '--tile-columns', '1', '--keyint', '-2', '--color-primaries', '1', '--transfer-characteristics', '1', '--matrix-coefficients', '1', '--color-range', '0', '--progress', '0', '--lp', '4']);
  expect(opusArgs(2)).toEqual(['--bitrate', '160', '--ignorelength']);
  expect(opusArgs(6)).toEqual(['--bitrate', '320', '--ignorelength']);
});

describe.skipIf(!haveTools)('end to end on disc1', () => {
  const base = (out: string): EncodeOptions => ({ discDir: fx('fixtures/disc1'), playlistId: '00000', episodes: '1-2,3-4', outDir: out, namePattern: 'ep-{n}', crf: 40, preset: 8, extraSvtArgs: [], cacheDir: join(out, 'cache'), tools: toolPaths()!, dataDir: join(out, 'data'), noSubtitles: false, noPgs: false });

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

describe.skipIf(!haveTools)('end to end on disc3', () => {
  it('encodes disc3 with four Opus tracks', async () => {
    const out = mkdtempSync(join(tmpdir(), 'et-'));
    const opts: EncodeOptions = { discDir: fx('fixtures/disc3'), playlistId: '00000', episodes: '1-', outDir: out, namePattern: 'ep-{n}', crf: 50, preset: 10, extraSvtArgs: [], cacheDir: join(out, 'cache'), tools: toolPaths()!, dataDir: join(out, 'data'), noSubtitles: false, noPgs: false };
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
    const opts: EncodeOptions = { discDir: fx('fixtures/disc3'), playlistId: '00000', episodes: '1-', outDir: out, namePattern: 'ep-{n}', crf: 50, preset: 10, extraSvtArgs: [], cacheDir: join(out, 'cache'), tools: toolPaths()!, dataDir: join(out, 'data'), noSubtitles: false, noPgs: false };
    const { key, label } = await discKeyOfFolder(opts.discDir);
    await new RecordStore(opts.dataDir).write({
      disc: { key, label },
      playlist: '00000',
      episodeSpec: '1-',
      anilist: null,
      release: null,
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
    release: null,
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
  const opts: EncodeOptions = { discDir, playlistId: '00000', episodes: '1-', outDir: join(out, 'mkv'), namePattern: 'ep-{n}', crf: 50, preset: 10, extraSvtArgs: [], cacheDir: join(out, 'cache'), tools: missing, dataDir: join(out, 'data'), noSubtitles: false, noPgs: false };
  const err = await encodeEpisodes(opts, () => {}).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(NoAudioChosenError);
  expect((err as Error).message).toBe('Episode 1 has no audio stream ticked in the saved choices; tick one in the helper or pass --no-subtitles');
  expect(existsSync(join(out, 'mkv'))).toBe(false);
});
