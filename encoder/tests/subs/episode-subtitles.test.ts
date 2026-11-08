// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { episodeSubtitleTracks, recordFontLoader } from '../../src/subs/episode-subtitles';
import type { RecordTrack, SubtitleRecord } from '../../src/subs/record';
import type { CachedRelease } from '../../src/subs/release-cache';

const dec = new TextDecoder();

const SCRIPT = [
  '[Script Info]',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname',
  'Style: Default,Starfall Sans',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,The wanderer wakes',
  'Dialogue: 0,0:01:40.00,0:01:42.00,Default,,0,0,0,,After the cut',
  '',
].join('\n');

function track(over: Partial<RecordTrack>): RecordTrack {
  return {
    file: 'releases/tosho-77/f1-t1.ass',
    kind: 'full',
    language: 'eng',
    name: 'English (Starfall Subs)',
    shiftMs: 0,
    nudgeMs: 0,
    split: null,
    included: true,
    ...over,
  };
}

function record(tracks: RecordTrack[], fonts: string[] = []): SubtitleRecord {
  return {
    disc: { key: 'd.0123456789abcdef', label: 'Starfall Wanderer Vol. 1' },
    playlist: '00001',
    episodeSpec: '1-2',
    anilist: null,
    release: { source: 'tosho', id: 'tosho-77', group: 'Starfall Subs', label: '[Starfall Subs] Starfall Wanderer' },
    fonts,
    episodes: [
      {
        index: 1,
        title: 'The Wanderer Wakes',
        tracks,
        metadata: { title: 'Starfall Wanderer 01', video: { name: '', language: 'jpn' }, audio: [], chapters: [] },
      },
    ],
    savedAt: '2026-11-07T00:00:00.000Z',
  };
}

describe('episodeSubtitleTracks', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'episode-subs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function put(rel: string, data: string | Uint8Array): void {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), data);
  }

  it('applies shift then nudge', async () => {
    put('releases/tosho-77/f1-t1.ass', SCRIPT);
    const { tracks } = await episodeSubtitleTracks(record([track({ shiftMs: 1200, nudgeMs: -42 })]), 1, 1_440_000, dir);
    expect(tracks[0]!.blocks.map((b) => [b.timeMs, b.durationMs])).toEqual([
      [11_158, 2000],
      [101_158, 2000],
    ]);
  });

  it('rounds the shift to centiseconds as the preview did, then adds the nudge in milliseconds', async () => {
    put('releases/tosho-77/f1-t1.ass', SCRIPT);
    // 10.00 s + 1208 ms is 11.21 s in the retimed copy the preview played.
    const shifted = await episodeSubtitleTracks(record([track({ shiftMs: 1208, nudgeMs: 0 })]), 1, 1_440_000, dir);
    expect(shifted.tracks[0]!.blocks.map((b) => b.timeMs)).toEqual([11_210, 101_210]);
    const nudged = await episodeSubtitleTracks(record([track({ shiftMs: 1208, nudgeMs: -3 })]), 1, 1_440_000, dir);
    expect(nudged.tracks[0]!.blocks.map((b) => b.timeMs)).toEqual([11_207, 101_207]);
  });

  it('rounds a split part to centiseconds too', async () => {
    put('releases/tosho-77/f1-t1.ass', SCRIPT);
    const split = [{ fromMs: 0, offsetMs: 1208 }];
    const { tracks } = await episodeSubtitleTracks(record([track({ split })]), 1, 1_440_000, dir);
    expect(tracks[0]!.blocks.map((b) => [b.timeMs, b.durationMs])).toEqual([
      [11_210, 2000],
      [101_210, 2000],
    ]);
  });

  it('clamps at 0 before the nudge, as the preview did', async () => {
    put(
      'releases/tosho-77/f1-t1.ass',
      SCRIPT.replace('Dialogue: 0,0:00:10.00,0:00:12.00', 'Dialogue: 0,0:00:00.50,0:00:02.00'),
    );
    // The shift takes the start to -0.50 s, which the retimed copy clamps to 0; the nudge then moves it to 300 ms.
    const { tracks } = await episodeSubtitleTracks(record([track({ shiftMs: -1000, nudgeMs: 300 })]), 1, 1_440_000, dir);
    expect(tracks[0]!.blocks.map((b) => [b.timeMs, b.durationMs])).toEqual([
      [300, 1000],
      [99_300, 2000],
    ]);
  });

  it("applies split parts by the event's start", async () => {
    put('releases/tosho-77/f1-t1.ass', SCRIPT);
    // Parts are chosen by the start in the script, before the nudge; shiftMs is not used when a split is set.
    const split = [
      { fromMs: 60_000, offsetMs: -5000 },
      { fromMs: 0, offsetMs: 300 },
    ];
    const { tracks } = await episodeSubtitleTracks(record([track({ shiftMs: 999, nudgeMs: 10, split })]), 1, 1_440_000, dir);
    expect(tracks[0]!.blocks.map((b) => b.timeMs)).toEqual([10_310, 95_010]);
  });

  it('drops events past the episode end', async () => {
    put('releases/tosho-77/f1-t1.ass', SCRIPT);
    const { tracks } = await episodeSubtitleTracks(record([track({})]), 1, 60_000, dir);
    expect(tracks[0]!.blocks.map((b) => dec.decode(b.data))).toEqual(['0,0,Default,,0,0,0,,The wanderer wakes']);
  });

  it('unticked tracks are left out and the first included is default', async () => {
    put('releases/tosho-77/f1-t1.ass', SCRIPT);
    put('releases/tosho-77/f1-t2.ass', SCRIPT);
    put('releases/tosho-77/f1-t3.ass', SCRIPT);
    const r = record([
      track({ file: 'releases/tosho-77/f1-t1.ass', name: 'Unticked', included: false }),
      track({ file: 'releases/tosho-77/f1-t2.ass', name: 'English (Starfall Subs)', language: 'eng' }),
      track({ file: 'releases/tosho-77/f1-t3.ass', name: 'Signs & Songs', kind: 'signs', language: 'eng' }),
    ]);
    const { tracks } = await episodeSubtitleTracks(r, 1, 1_440_000, dir);
    expect(tracks.map((t) => ({ name: t.name, language: t.language, isDefault: t.isDefault, isForced: t.isForced, codecId: t.codecId }))).toEqual([
      { name: 'English (Starfall Subs)', language: 'eng', isDefault: true, isForced: false, codecId: 'S_TEXT/ASS' },
      // A signs track is forced, which is how its kind reaches the packaged file names.
      { name: 'Signs & Songs', language: 'eng', isDefault: false, isForced: true, codecId: 'S_TEXT/ASS' },
    ]);
    expect(dec.decode(tracks[0]!.codecPrivate)).toContain('[V4+ Styles]');
  });

  it('gives no track when none is ticked', async () => {
    put('releases/tosho-77/f1-t1.ass', SCRIPT);
    const { tracks } = await episodeSubtitleTracks(record([track({ included: false })]), 1, 1_440_000, dir);
    expect(tracks).toEqual([]);
  });

  it('fonts get RFC 8081 types and their release names', async () => {
    put('releases/tosho-77/f1-t1.ass', SCRIPT);
    const fonts = ['ttf', 'otf', 'ttc', 'woff', 'woff2'].map((ext, i) => `fonts/${String(i).repeat(64)}.${ext}`);
    fonts.forEach((f, i) => put(f, new Uint8Array([i, i, i])));
    const release: CachedRelease = {
      key: 'tosho-77',
      source: 'tosho',
      label: '[Starfall Subs] Starfall Wanderer',
      group: 'Starfall Subs',
      files: [],
      // The fifth font is not in the release's list, so it keeps its pooled name.
      fonts: [
        { name: 'StarfallSans.ttf', path: fonts[0]! },
        { name: 'StarfallSans-Copy.ttf', path: fonts[0]! },
        { name: 'WandererSerif.otf', path: fonts[1]! },
        { name: 'Comet.ttc', path: fonts[2]! },
        { name: 'Nebula.woff', path: fonts[3]! },
      ],
    };
    put('releases/tosho-77/release.json', JSON.stringify(release));
    const { attachments } = await episodeSubtitleTracks(record([track({})], fonts), 1, 1_440_000, dir);
    expect(attachments.map((a) => ({ name: a.name, mediaType: a.mediaType, data: [...a.data] }))).toEqual([
      { name: 'StarfallSans.ttf', mediaType: 'font/ttf', data: [0, 0, 0] },
      { name: 'WandererSerif.otf', mediaType: 'font/otf', data: [1, 1, 1] },
      { name: 'Comet.ttc', mediaType: 'font/collection', data: [2, 2, 2] },
      { name: 'Nebula.woff', mediaType: 'font/woff', data: [3, 3, 3] },
      { name: `${'4'.repeat(64)}.woff2`, mediaType: 'font/woff2', data: [4, 4, 4] },
    ]);
  });

  it('fonts keep their pooled names when the release is not cached', async () => {
    put('releases/tosho-77/f1-t1.ass', SCRIPT);
    const font = `fonts/${'a'.repeat(64)}.otf`;
    put(font, new Uint8Array([7]));
    const { attachments } = await episodeSubtitleTracks(record([track({})], [font]), 1, 1_440_000, dir);
    expect(attachments.map((a) => [a.name, a.mediaType])).toEqual([[`${'a'.repeat(64)}.otf`, 'font/otf']]);
  });

  it('episodes given one font loader share the same attachments', async () => {
    put('releases/tosho-77/f1-t1.ass', SCRIPT);
    const font = `fonts/${'c'.repeat(64)}.ttf`;
    put(font, new Uint8Array([9]));
    const r = record([track({})], [font]);
    r.episodes.push({ ...r.episodes[0]!, index: 2 });
    const fonts = recordFontLoader(r, dir);
    const one = await episodeSubtitleTracks(r, 1, 1_440_000, dir, fonts);
    const two = await episodeSubtitleTracks(r, 2, 1_440_000, dir, fonts);
    expect(two.attachments[0]!.data).toBe(one.attachments[0]!.data);
  });

  it('throws for an episode the record does not hold', async () => {
    await expect(episodeSubtitleTracks(record([]), 2, 1_440_000, dir)).rejects.toThrow(/episode 2/);
  });
});
