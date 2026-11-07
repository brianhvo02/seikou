import { describe, expect, it } from 'vitest';
import { parseEvent, processKaraoke, splitStyleRuns, type EventText } from './events';
import { parseAss } from './parse';
import { DECO_ROTATE, EF_KARAOKE, EF_KARAOKE_KF, type RenderSettings } from './state';

const SETTINGS: RenderSettings = { frameWidth: 1920, frameHeight: 1080, storageWidth: 1920, storageHeight: 1080, fontScale: 1 };
function trackWith(text: string, playResY = 1080) {
  return parseAss(`[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: ${playResY}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,2,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,${text}
`);
}
const parsed = (text: string, now = 0, playResY = 1080): EventText | null => {
  const t = trackWith(text, playResY);
  return parseEvent(t, t.events[0]!, SETTINGS, now);
};
const chars = (e: EventText): string => e.glyphs.map((g) => String.fromCodePoint(g.symbol)).join('');

describe('parseEvent', () => {
  it('makes one glyph per character with the state at that point, and splits style runs', () => {
    const e = parsed('a{\\c&H0000FF&}b')!;
    expect(chars(e)).toBe('ab');
    expect(e.glyphs.map((g) => g.c[0])).toEqual([0xffffff00, 0xff000000]);
    splitStyleRuns(e);
    expect(e.glyphs.map((g) => g.startsNewRun)).toEqual([true, true]);
    const same = parsed('ab')!;
    splitStyleRuns(same);
    expect(same.glyphs.map((g) => g.startsNewRun)).toEqual([true, false]);
  });

  it('turns \\N into a newline glyph', () => {
    expect(chars(parsed('a\\Nb')!)).toBe('a\nb');
  });

  it('scales the font size by PlayResY to 256 with the scale moved into scale_x/y (no hinting)', () => {
    const [g] = parsed('a', 0, 540)!.glyphs;
    expect([g!.fontSize, g!.scaleX, g!.scaleY, g!.scaleFix]).toEqual([256, 0.5, 0.5, 2]);
    expect(g!.hspacingScaled).toBe(2 * 1 * 64); // spacing × screen_scale_x / par × scale_x (before fix_glyph_scaling), 26.6
  });

  it('collects drawings as one glyph each', () => {
    const e = parsed('{\\p1}m 0 0 l 10 0 10 10{\\p0}x')!;
    expect(e.glyphs.map((g) => [g.symbol, g.drawingText, g.drawingScale])).toEqual([[0xfffc, 'm 0 0 l 10 0 10 10', 1], [0x78, null, 0]]);
  });

  it('returns null for an event with only override blocks', () => {
    expect(parsed('{comment}')).toBeNull();
    expect(parsed('{\\b1}')).toBeNull();
  });

  it('reads an unclosed brace as text', () => {
    expect(chars(parsed('a{b')!)).toBe('a{b');
  });

  it('marks vertical-font glyphs from U+02F1 on with DECO_ROTATE', () => {
    const e = parsed('{\\fn@DejaVu Sans}aあ')!;
    expect(e.glyphs.map((g) => (g.flags & DECO_ROTATE) !== 0)).toEqual([false, true]);
  });
});

describe('processKaraoke', () => {
  const place = (e: EventText): void => e.glyphs.forEach((g, i) => { g.posX = i * 640; g.advanceX = 640; });

  it('switches \\k syllables at their start', () => {
    const e = parsed('{\\k50}ab{\\k100}cd')!;
    splitStyleRuns(e);
    place(e);
    processKaraoke(e, 400);
    expect(e.glyphs.map((g) => g.effectType)).toEqual([EF_KARAOKE, EF_KARAOKE, EF_KARAOKE, EF_KARAOKE]);
    expect(e.glyphs.map((g) => g.effectTiming)).toEqual([100_000_000, 100_000_000 - 640, -100_000_000 - 1280, -100_000_000 - 1920]);
  });

  it('sweeps \\kf across the syllable', () => {
    const e = parsed('{\\kf100}abcd')!;
    splitStyleRuns(e);
    place(e);
    processKaraoke(e, 500);
    expect(e.glyphs.map((g) => g.effectType)).toEqual([EF_KARAOKE_KF, EF_KARAOKE_KF, EF_KARAOKE_KF, EF_KARAOKE_KF]);
    expect(e.glyphs.map((g) => g.effectTiming)).toEqual([1280, 640, 0, -640]);
  });
});
