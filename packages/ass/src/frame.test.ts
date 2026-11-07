import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFontFile } from './font-tables';
import { AssFonts } from './fonts';
import { FrameBuilder } from './frame';
import * as layout from './layout';
import { createFixedMeasurer } from './measure';
import { parseAss } from './parse';
import type { RenderSettings } from './state';

const SETTINGS: RenderSettings = { frameWidth: 1920, frameHeight: 1080, storageWidth: 1920, storageHeight: 1080, fontScale: 1 };
let fonts: AssFonts;
beforeAll(async () => {
  const bytes = new Uint8Array(readFileSync('fixtures/ass/fonts/DejaVuSans.ttf'));
  fonts = new AssFonts({ load: async () => {}, unload: () => {} }, await readFontFile('DejaVuSans.ttf', bytes));
});

const script = (...events: string[]) => parseAss(`[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,2,2,40,40,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`);
const ev = (layer: number, from: string, to: string, text: string) => `Dialogue: ${layer},${from},${to},Default,,0,0,0,,${text}`;

describe('FrameBuilder', () => {
  it('lists the events active at t by layer, then file order; the end is exclusive', () => {
    const b = new FrameBuilder(script(ev(1, '0:00:00.00', '0:00:02.00', 'a'), ev(0, '0:00:00.00', '0:00:02.00', 'b'), ev(0, '0:00:01.00', '0:00:03.00', 'c')), fonts, createFixedMeasurer(0.5));
    expect(b.build(1500, SETTINGS).events.map((e) => e.index)).toEqual([1, 2, 0]);
    expect(b.build(2000, SETTINGS).events.map((e) => e.index)).toEqual([2]);
  });

  it('stacks colliding events of a layer and remembers positions across frames', () => {
    const b = new FrameBuilder(script(ev(0, '0:00:00.00', '0:00:05.00', 'first'), ev(0, '0:00:01.00', '0:00:05.00', 'second')), fonts, createFixedMeasurer(0.5));
    const one = b.build(500, SETTINGS).events[0]!.box.top;
    const two = b.build(1500, SETTINGS).events.map((e) => e.box.top);
    expect(two[0]).toBe(one);
    expect(two[1]).toBeLessThan(one);
    // the collision move is what drawing must shift the event's images by (libass's shift_event)
    const moved = b.build(1500, SETTINGS).events[1]!;
    expect(moved.shiftY).toBeLessThan(0);
    expect(b.build(1500, SETTINGS).events[0]!.shiftY).toBe(0);
  });

  it('marks animated events', () => {
    const b = new FrameBuilder(script(ev(0, '0:00:00.00', '0:00:05.00', '{\\move(0,0,10,10)}a'), ev(0, '0:00:00.00', '0:00:05.00', '{\\b1}b'), ev(0, '0:00:00.00', '0:00:05.00', '{\\k20}c')), fonts, createFixedMeasurer(0.5));
    expect(b.build(100, SETTINGS).events.map((e) => e.animated)).toEqual([true, false, true]);
  });

  it('lays out only the active events of a large file', () => {
    const ts = (ms: number): string => `${Math.floor(ms / 3_600_000)}:${String(Math.floor(ms / 60_000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(Math.floor(ms / 10) % 100).padStart(2, '0')}`;
    const lines = Array.from({ length: 50_000 }, (_, i) => ev(0, ts(i * 100), ts(i * 100 + 50), `line ${i}`));
    const b = new FrameBuilder(script(...lines), fonts, createFixedMeasurer(0.5));
    const spy = vi.spyOn(layout, 'layoutEvent');
    const t0 = performance.now();
    for (const t of [1000, 61_000, 300_000, 600_000, 1_200_000, 2_000_000, 2_500_000, 2_900_000, 3_000_000, 4_999_900]) b.build(t + 20, SETTINGS);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(10);
    spy.mockRestore();
  });
});
