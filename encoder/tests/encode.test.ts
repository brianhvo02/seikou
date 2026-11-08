// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeEpisodes, opusArgs, svtArgs, type EncodeOptions } from '../src/encode';
import { Id } from '../src/mux/mkv-ids';
import { countVideoBlocks, find, findAll, floatOf, parseMkv, uintOf } from './helpers/ebml-reader';
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
