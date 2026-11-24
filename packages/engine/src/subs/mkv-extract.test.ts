// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { parseAss } from '@seikou/ass';
import { blobRangeReader, writeMatroska, type MkvSubtitleTrack, type RangeReader } from '@seikou/matroska';
import { describe, expect, it } from 'vitest';
import { memorySink } from '@seikou/matroska/test-io';
import { extractMkvText, mkvTrackFileName, type MkvTextTrack } from './mkv-extract';

const enc = new TextEncoder();

function readerOf(bytes: Uint8Array): RangeReader {
  return blobRangeReader(new Blob([bytes as BlobPart]));
}

async function* frames(n: number): AsyncGenerator<{ index: number; keyframe: boolean; data: Uint8Array }> {
  for (let i = 0; i < n; i++) yield { index: i, keyframe: i === 0, data: new Uint8Array(100).fill(i) };
}

async function written(subtitles: MkvSubtitleTrack[], attachments: { name: string; mediaType: string; data: Uint8Array }[] = []): Promise<Uint8Array> {
  const sink = memorySink();
  await writeMatroska(sink, {
    video: { width: 64, height: 48, fpsNum: 25, fpsDen: 1, codecPrivate: new Uint8Array([0x81, 0, 0, 0]), name: 'Video', language: 'und', isDefault: true },
    videoPackets: frames(50),
    audio: [],
    subtitles,
    attachments,
    chapters: [],
    tags: {},
  });
  return sink.bytes();
}

const HEADER = '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,20\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

describe('extractMkvText', () => {
  it('rebuilds the ASS of an encoded episode as the script it was muxed from', async () => {
    const bytes = new Uint8Array(readFileSync('fixtures/encodes/990001/1.mkv'));
    const out = await extractMkvText(readerOf(bytes));
    expect(out.tracks).toHaveLength(1);
    const t = out.tracks[0]!;
    expect(t).toMatchObject({ kind: 'ass', name: 'English', language: 'eng', isDefault: true, isForced: false, dialogueLines: 5 });
    const parsed = parseAss(t.text);
    const got = parsed.events.map((e) => [e.start, e.start + e.duration, parsed.styles[e.style]!.name, e.text]);
    expect(got).toEqual([
      [1000, 3000, 'Default', 'Episode 1 begins'],
      [12000, 14000, 'Default', 'The opening line'],
      [19000, 23000, 'Default', 'A line across the twenty second mark'],
      [41000, 44000, 'Default', 'The ending line'],
      [55000, 58000, 'Default', 'Next time'],
    ]);
    expect(out.fonts.map((f) => f.name)).toEqual(['DejaVuSansMono.ttf']);
    expect(out.fonts[0]!.data.length).toBe(340712);
  });

  it('orders Dialogue lines by ReadOrder and writes Start/End from the block time and duration', async () => {
    const sub: MkvSubtitleTrack = {
      name: 'Signs', language: 'jpn', isDefault: false, isForced: true, codecId: 'S_TEXT/ASS', codecPrivate: enc.encode(HEADER),
      blocks: [
        { timeMs: 0, durationMs: 1500, data: enc.encode('2,0,Default,,0,0,0,,third, with a comma') },
        { timeMs: 1500, durationMs: 61230, data: enc.encode('0,1,Default,Bob,1,2,3,fx,first') },
        { timeMs: 62730, durationMs: 40, data: enc.encode('1,0,Default,,0,0,0,,second') },
      ],
    };
    const out = await extractMkvText(readerOf(await written([sub])));
    const t = out.tracks[0]!;
    expect(t).toMatchObject({ number: 2, kind: 'ass', name: 'Signs', language: 'jpn', isDefault: false, isForced: true, dialogueLines: 3 });
    expect(t.text.startsWith(HEADER)).toBe(true);
    expect(t.text.slice(HEADER.length).split('\n').filter(Boolean)).toEqual([
      'Dialogue: 1,0:00:01.50,0:01:02.73,Default,Bob,1,2,3,fx,first',
      'Dialogue: 0,0:01:02.73,0:01:02.77,Default,,0,0,0,,second',
      'Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,third, with a comma',
    ]);
  });

  it('writes S_TEXT/UTF8 as numbered SRT cues', async () => {
    const sub: MkvSubtitleTrack = {
      name: '', language: 'eng', isDefault: true, codecId: 'S_TEXT/UTF8' as 'S_TEXT/ASS',
      blocks: [
        { timeMs: 1000, durationMs: 1500, data: enc.encode('Hello') },
        { timeMs: 3661001, durationMs: 2000, data: enc.encode('Two\nlines') },
      ],
    };
    const out = await extractMkvText(readerOf(await written([sub])));
    const t = out.tracks[0]!;
    expect(t.kind).toBe('srt');
    expect(t.name).toBeNull();
    expect(t.dialogueLines).toBe(2);
    expect(t.text).toBe('1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n01:01:01,001 --> 01:01:03,001\nTwo\nlines\n');
  });

  it('answers no tracks and reads no attachment for a file without text tracks', async () => {
    const bytes = await written([], [{ name: 'a.ttf', mediaType: 'font/ttf', data: new Uint8Array(200_000).fill(7) }]);
    const inner = readerOf(bytes);
    let read = 0;
    const counting: RangeReader = { size: inner.size, async read(o, l, s) { const r = await inner.read(o, l, s); read += r.length; return r; } };
    const out = await extractMkvText(counting);
    expect(out).toEqual({ tracks: [], fonts: [], via: 'none' });
    expect(read).toBeLessThan(100_000);
  });
});

describe('mkvTrackFileName', () => {
  const track = (over: Partial<MkvTextTrack>): MkvTextTrack => ({ number: 3, kind: 'ass', name: 'English', language: 'eng', isDefault: true, isForced: false, dialogueLines: 1, text: '', ...over });

  it('keeps names plain and short', () => {
    expect(mkvTrackFileName('Show - 01.mkv', track({}))).toBe('Show - 01 [3] English.ass');
    expect(mkvTrackFileName('Show - 01.mkv', track({ name: null, kind: 'srt' }))).toBe('Show - 01 [3] eng.srt');
    expect(mkvTrackFileName('a/b\\c\u0001d.mkv', track({ name: 'x/y' }))).toBe('a_b_c_d [3] x_y.ass');
    const long = mkvTrackFileName(`${'あ'.repeat(100)}.mkv`, track({}));
    expect(enc.encode(long).length).toBeLessThanOrEqual(255);
    expect(long.endsWith(' [3] English.ass')).toBe(true);
  });
});
