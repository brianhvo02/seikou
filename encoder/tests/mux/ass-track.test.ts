// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assToMatroska } from '../../src/mux/ass-track';
import { readIvf } from '../../src/mux/ivf';
import { writeMkv } from '../../src/mux/mkv-writer';
import { ffmpegPath } from '../helpers/tools';
import { fx } from '../paths';

const dec = new TextDecoder();

const HEADER = [
  '[Script Info]',
  'Title: Starfall Wanderer 01',
  'ScriptType: v4.00+',
  'PlayResX: 1920',
  'PlayResY: 1080',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize',
  'Style: Default,Starfall Sans,60',
  'Style: Sign,Wanderer Serif,40',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
];

function script(events: string[]): string {
  return [...HEADER, ...events, ''].join('\r\n');
}

describe('assToMatroska', () => {
  it('splits a script into CodecPrivate and blocks', () => {
    const { codecPrivate, blocks } = assToMatroska(
      script([
        'Comment: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,a note for the typesetter',
        'Dialogue: 0,0:00:01.00,0:00:02.50,Default,Mira,0,0,0,,The wanderer wakes, at last',
        'Dialogue: 1,0:00:03.20,0:00:04.00,Sign,,10,20,30,fx,{\\an8}Starfall',
      ]),
      60_000,
    );
    expect(dec.decode(codecPrivate)).toBe([...HEADER, ''].join('\r\n'));
    expect(blocks.map((b) => ({ timeMs: b.timeMs, durationMs: b.durationMs, data: dec.decode(b.data) }))).toEqual([
      { timeMs: 1000, durationMs: 1500, data: '0,0,Default,Mira,0,0,0,,The wanderer wakes, at last' },
      { timeMs: 3200, durationMs: 800, data: '1,1,Sign,,10,20,30,fx,{\\an8}Starfall' },
    ]);
  });

  it('lays out blocks by the field names of the Format line', () => {
    const text = [
      '[Events]',
      'Format: Start, End, Style, Layer, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0:00:01.00,0:00:02.00,Default,3,,0,0,0,,Hello, there',
    ].join('\n');
    const { codecPrivate, blocks } = assToMatroska(text, 60_000);
    expect(dec.decode(codecPrivate)).toBe(
      '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n',
    );
    expect(dec.decode(blocks[0]!.data)).toBe('0,3,Default,,0,0,0,,Hello, there');
  });

  it('ReadOrder counts Dialogue lines in file order', () => {
    const { blocks } = assToMatroska(
      script([
        'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,third on screen',
        'Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,not counted',
        'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,first on screen',
        'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,second on screen',
      ]),
      60_000,
    );
    // Blocks come in time order; ReadOrder keeps each line's place in the file.
    expect(blocks.map((b) => [b.timeMs, dec.decode(b.data).split(',')[0]])).toEqual([
      [1000, '1'],
      [3000, '2'],
      [5000, '0'],
    ]);
  });

  it('drops events outside the episode and clamps a negative start', () => {
    const { blocks } = assToMatroska(
      script([
        'Dialogue: 0,0:00:00.50,0:00:01.00,Default,,0,0,0,,ends at zero',
        'Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,starts before zero',
        'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,inside',
        'Dialogue: 0,0:00:11.00,0:00:12.00,Default,,0,0,0,,starts at the end',
        'Dialogue: 0,0:00:10.99,0:00:12.00,Default,,0,0,0,,starts just before the end',
      ]),
      10_000,
      () => -1000,
    );
    expect(blocks.map((b) => [b.timeMs, b.durationMs, dec.decode(b.data).split(',').at(-1)])).toEqual([
      [0, 1000, 'starts before zero'],
      [4000, 1000, 'inside'],
      [9990, 1010, 'starts just before the end'],
    ]);
  });

  it('gives the offset each event start in the script and keeps whole milliseconds', () => {
    const seen: number[] = [];
    const { blocks } = assToMatroska(
      script(['Dialogue: 0,0:00:10.00,0:00:11.00,Default,,0,0,0,,x', 'Dialogue: 0,0:00:20.00,0:00:21.00,Default,,0,0,0,,y']),
      60_000,
      (startMs) => {
        seen.push(startMs);
        return startMs < 15_000 ? 0.4 : 1158;
      },
    );
    expect(seen).toEqual([10_000, 20_000]);
    expect(blocks.map((b) => [b.timeMs, b.durationMs])).toEqual([
      [10_000, 1000],
      [21_158, 1000],
    ]);
  });
});

describe.skipIf(ffmpegPath === null)('assToMatroska with ffmpeg as the oracle', () => {
  it('ffmpeg reads the events back with their times and text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ass-track-'));
    try {
      const { codecPrivate, blocks } = assToMatroska(
        script([
          'Dialogue: 0,0:00:00.10,0:00:00.30,Default,Mira,0,0,0,,The wanderer wakes, at last',
          'Dialogue: 1,0:00:00.05,0:00:00.20,Sign,,10,20,30,,{\\an8}Starfall',
        ]),
        60_000,
      );
      const ivf = await readIvf(createReadStream(fx('fixtures/small.ivf')));
      const seq = await ivf.sequenceHeader;
      const out = join(dir, 'a.mkv');
      await writeMkv(out, {
        video: { width: 64, height: 64, fpsNum: 24000, fpsDen: 1001, codecPrivate: seq.av1C, name: '', language: 'und', isDefault: true },
        videoPackets: ivf.packets,
        audio: [],
        subtitles: [{ codecId: 'S_TEXT/ASS', name: 'English', language: 'eng', isDefault: true, codecPrivate, blocks }],
        attachments: [],
        chapters: [],
      });
      const ass = join(dir, 'a.ass');
      execFileSync(ffmpegPath!, ['-v', 'error', '-i', out, '-map', '0:s', '-c', 'copy', ass]);
      const events = readFileSync(ass, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('Dialogue:'));
      // ffmpeg's ASS muxer puts the events back in ReadOrder, which is the script's own order.
      expect(events).toEqual([
        'Dialogue: 0,0:00:00.10,0:00:00.30,Default,Mira,0,0,0,,The wanderer wakes, at last',
        'Dialogue: 1,0:00:00.05,0:00:00.20,Sign,,10,20,30,,{\\an8}Starfall',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
