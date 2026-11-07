import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readFontFile } from './font-tables';
import { AssFonts } from './fonts';
import { FrameBuilder } from './frame';
import { createFixedMeasurer } from './measure';
import { parseAss } from './parse';
import { frameToTrace } from './trace';

const SETTINGS = { frameWidth: 1920, frameHeight: 1080, storageWidth: 1920, storageHeight: 1080, fontScale: 1 };

async function trace(text: string, t = 500) {
  const bytes = new Uint8Array(readFileSync('fixtures/ass/fonts/DejaVuSans.ttf'));
  const fonts = new AssFonts({ load: async () => {}, unload: () => {} }, await readFontFile('DejaVuSans.ttf', bytes));
  await fonts.add([{ name: 'DejaVuSans.ttf', bytes }]);
  const track = parseAss(`[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,2,2,40,40,50,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 2,0:00:00.00,0:00:01.00,Default,,0,0,0,,${text}\n`);
  return frameToTrace(new FrameBuilder(track, fonts, createFixedMeasurer(0.5)).build(t, SETTINGS), fonts);
}

describe('frameToTrace', () => {
  it('writes one event with its box, clip and runs split where styles change', async () => {
    const [e, ...rest] = await trace('Hi {\\c&H0000FF&}there');
    expect(rest).toEqual([]);
    expect([e!.t, e!.event, e!.layer, e!.lines]).toEqual([500, 0, 2, 1]);
    expect(e!.clip).toEqual({ rect: [0, 0, 1920, 1080], inverse: false });
    expect(e!.runs.map((r) => [r.text, r.font, r.colors[0]])).toEqual([['Hi ', 'DejaVu Sans|DejaVuSans', 'FFFFFF00'], ['there', 'DejaVu Sans|DejaVuSans', 'FF000000']]);
    expect(e!.runs[0]!.glyphs.map((g) => g.ch)).toEqual([0x48, 0x69, 0x20]);
    expect(e!.runs[0]!.matrix).toHaveLength(9);
    expect(e!.runs[0]!.matrix[8]).toBe(1);
  });

  it('applies the fade to the run colours and reports vector clips', async () => {
    const [e] = await trace('{\\fad(1000,0)\\iclip(m 0 0 l 10 0 10 10)}x');
    expect(e!.runs[0]!.colors[0]).toBe('FFFFFF7F');
    expect(e!.clip).toEqual({ vector: 'm 0 0 l 10 0 10 10', scale: 1, inverse: true });
  });

  it('marks drawings', async () => {
    const [e] = await trace('{\\p1}m 0 0 l 10 0 10 10{\\p0}');
    expect(e!.runs.map((r) => [r.drawing, r.text])).toEqual([[true, '￼']]);
  });
});
