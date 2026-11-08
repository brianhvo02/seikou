// SPDX-License-Identifier: LGPL-3.0-or-later
// Checks the facts fixtures/encodes/README.md states about the committed encode fixtures.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blobRangeReader } from './blob-reader';
import { openMatroska } from './playback';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/encodes/990001');
const open = (n: number) => openMatroska(blobRangeReader(new Blob([readFileSync(join(dir, `${n}.mkv`))])));

describe.each([1, 2])('fixtures/encodes/990001/%i.mkv', (episode) => {
  it('has five named chapters', async () => {
    const mkv = await open(episode);
    expect(mkv.chapters.map((c) => [c.startMs, c.name])).toEqual([
      [0, 'Avant'],
      [10_000, 'Opening'],
      [20_000, 'Part A'],
      [40_000, 'Ending'],
      [50_000, 'Preview'],
    ]);
  });

  it('is about a minute long', async () => {
    const mkv = await open(episode);
    expect(mkv.durationMs).toBeGreaterThanOrEqual(60_000);
    expect(mkv.durationMs).toBeLessThan(60_100);
  });

  it('carries the tags', async () => {
    const { tags } = await open(episode);
    expect(tags).toMatchObject({
      ANILIST_ID: '990001',
      EPISODE: String(episode),
      EPISODE_TITLE: episode === 1 ? 'The Lantern Road' : 'A Quiet Harbor',
      SEIKOU_DISC_KEY: 'f.148C2FD8E35B72A696EB6FB331CB0AE7',
      SEIKOU_PLAYLIST: '00000',
      SEIKOU_EPISODE_START_MS: String((episode - 1) * 60_000),
      ENCODER: 'seikou-encode',
    });
  });

  it('has AV1, Opus, ASS and PGS tracks with the named labels', async () => {
    const mkv = await open(episode);
    expect(mkv.tracks.map((t) => [t.codecId, t.name, t.language, t.isDefault])).toEqual([
      ['V_AV1', '', 'und', true],
      ['A_OPUS', 'Japanese', 'jpn', true],
      ['S_TEXT/ASS', 'English', 'eng', true],
      ['S_HDMV/PGS', 'English (disc)', 'eng', false],
    ]);
    expect(mkv.tracks[1]!.audio).toEqual({ channels: 2, sampleRate: 48000 });
    expect(mkv.attachments.map((a) => [a.name, a.mediaType])).toEqual([['DejaVuSansMono.ttf', 'font/ttf']]);
  });

  it('has an ASS line on screen at 21 s and PGS display sets from 5 s', async () => {
    const mkv = await open(episode);
    const ass: { timeMs: number; durationMs?: number }[] = [];
    const pgs: number[] = [];
    for await (const b of mkv.blocksFrom(0)) {
      if (b.track === 3) ass.push({ timeMs: b.timeMs, ...(b.durationMs !== undefined ? { durationMs: b.durationMs } : {}) });
      if (b.track === 4) pgs.push(b.timeMs);
    }
    expect(ass.some((e) => e.timeMs < 20_000 && e.timeMs + (e.durationMs ?? 0) > 22_000)).toBe(true);
    expect(pgs).toEqual([5000, 7000, 8000, 10000, 12000, 14000]);
  });
});
