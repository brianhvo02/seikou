import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseEvent } from './events';
import { readFontFile } from './font-tables';
import { AssFonts } from './fonts';
import { layoutEvent, type LaidOutEvent } from './layout';
import { createFixedMeasurer } from './measure';
import { parseAss } from './parse';
import type { RenderSettings } from './state';

const SETTINGS: RenderSettings = { frameWidth: 1920, frameHeight: 1080, storageWidth: 1920, storageHeight: 1080, fontScale: 1 };
let fonts: AssFonts;
beforeAll(async () => {
  const bytes = (f: string): Uint8Array => new Uint8Array(readFileSync(`fixtures/ass/fonts/${f}`));
  fonts = new AssFonts({ load: async () => {}, unload: () => {} }, await readFontFile('DejaVuSans.ttf', bytes('DejaVuSans.ttf')));
  await fonts.add([{ name: 'DejaVuSans.ttf', bytes: bytes('DejaVuSans.ttf') }]);
});

function lay(text: string, opts: { wrap?: number; playRes?: [number, number]; margins?: [number, number, number]; settings?: RenderSettings; now?: number; effect?: string } = {}): LaidOutEvent {
  const [px, py] = opts.playRes ?? [1920, 1080];
  const [ml, mr, mv] = opts.margins ?? [40, 40, 50];
  const track = parseAss(`[Script Info]
ScriptType: v4.00+
PlayResX: ${px}
PlayResY: ${py}
WrapStyle: ${opts.wrap ?? 0}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,2,2,${ml},${mr},${mv},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,${opts.effect ?? ''},${text}
`);
  const e = parseEvent(track, track.events[0]!, opts.settings ?? SETTINGS, opts.now ?? 0)!;
  return layoutEvent(e, fonts, createFixedMeasurer(0.5));
}

const shown = (l: LaidOutEvent) => l.text.glyphs.filter((g) => !g.skip && g.symbol !== 10);
const lineTexts = (l: LaidOutEvent): string[] => {
  const out: string[] = [''];
  for (const g of l.text.glyphs) {
    if (g.linebreak) out.push('');
    // ligature components are skipped but still part of the text
    if (!g.isTrimmedWhitespace && g.symbol !== 10) out[out.length - 1] += String.fromCodePoint(g.symbol);
  }
  return out.map((s) => s.trim());
};
const centreX = (l: LaidOutEvent): number => l.deviceX + (l.bbox[0] + l.bbox[2]) / 2;

describe('layoutEvent', () => {
  it('centres a bottom line with its baseline above the bottom margin by its descender', () => {
    const l = lay('Hello world');
    expect(l.lines).toHaveLength(1);
    expect(centreX(l)).toBeCloseTo(960, 0);
    expect(l.deviceY).toBeCloseTo(1080 - 50 - l.lines[0]!.desc, 6);
    expect(l.lines[0]!.asc).toBeGreaterThan(l.lines[0]!.desc);
  });

  it('puts \\an7 at the left margin, first ascender below the top margin', () => {
    const l = lay('{\\an7}Top left');
    expect(l.deviceX).toBe(40);
    expect(l.deviceY).toBeCloseTo(50 + l.lines[0]!.asc, 6);
  });

  it('anchors \\pos at the alignment point of the text box', () => {
    const l = lay('{\\pos(960,540)\\an5}Centre');
    expect(centreX(l)).toBeCloseTo(960, 6);
    expect(l.deviceY + (l.bbox[1] + l.bbox[3]) / 2).toBeCloseTo(540, 6);
    const r = lay('{\\pos(100,200)\\an3}Right');
    expect(r.deviceX + r.bbox[2]).toBeCloseTo(100, 6);
    expect(r.deviceY + r.bbox[3]).toBeCloseTo(200, 6);
  });

  it('lets event margins override the style', () => {
    expect(lay('{\\an7}x', { margins: [300, 0, 0] }).deviceX).toBe(300);
  });

  const LONG = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty';

  it('wraps WrapStyle 0 into balanced lines inside the margins', () => {
    const l = lay(LONG);
    expect(l.lines.length).toBeGreaterThanOrEqual(2);
    expect(lineTexts(l).join(' ')).toBe(LONG);
    expect(l.bbox[2] - l.bbox[0]).toBeLessThanOrEqual(1920 - 80);
  });

  it('fills lines greedily with WrapStyle 1, and treats WrapStyle 3 as 0 (libass does)', () => {
    const greedy = lineTexts(lay(LONG, { wrap: 1 }));
    const smart = lineTexts(lay(LONG, { wrap: 0 }));
    expect(greedy[0]!.length).toBeGreaterThanOrEqual(smart[0]!.length);
    expect(lineTexts(lay(LONG, { wrap: 3 }))).toEqual(smart);
  });

  it('breaks only at \\N with WrapStyle 2', () => {
    expect(lay(LONG, { wrap: 2 }).lines).toHaveLength(1);
    expect(lineTexts(lay('a\\Nb\\nc', { wrap: 2 }))).toEqual(['a', 'b', 'c']);
    expect(lineTexts(lay('a\\Nb\\nc', { wrap: 0 }))).toEqual(['a', 'b c']);
  });

  it('never breaks at \\h', () => {
    const words = Array.from({ length: 60 }, () => 'ab').join('\\h');
    expect(lay(words).lines).toHaveLength(1);
  });

  it('trims spaces at line ends and at the start', () => {
    const l = lay('  hi  ');
    expect(shown(l).map((g) => String.fromCodePoint(g.symbol)).join('')).toBe('hi');
  });

  it('shears the baseline with \\fay', () => {
    const g = shown(lay('{\\fay0.5}ab'));
    expect(g[1]!.posY - g[0]!.posY).toBeCloseTo(0.5 * g[0]!.advanceX, -1);
  });

  it('scales PlayRes to the frame', () => {
    const big = lay('{\\pos(100,100)\\an7}x');
    const small = lay('{\\pos(100,100)\\an7}x', { playRes: [640, 360] });
    expect(small.deviceX).toBeCloseTo(300, 6);
    expect(big.deviceX).toBeCloseTo(100, 6);
  });

  it('rounds advances to whole pixels at the 256 px outline size, as FreeType does', () => {
    const g = shown(lay('ab'));
    // the fixed measurer gives 0.5 em, rounded to whole pixels at the outline size before scaling down
    const em = g[0]!.emPx;
    expect(g[0]!.advanceX).toBe(Math.round(Math.round(0.5 * em) * 64 * g[0]!.scaleX));
  });

  it('merges ligature clusters: the first character draws the ligature, the rest are skipped', () => {
    const g = shown(lay('first'));
    expect(g.map((x) => String.fromCodePoint(x.symbol)).join('')).toBe('frst');
    const em = g[0]!.emPx;
    expect(g[0]!.advanceX).toBe(Math.round(Math.round(2 * 0.5 * em) * 64 * g[0]!.scaleX));
    expect(shown(lay('{\\fsp5}first')).map((x) => String.fromCodePoint(x.symbol)).join('')).toBe('first'); // no ligatures with spacing
  });

  it('measures a drawing by its control box', () => {
    const [d] = shown(lay('{\\p1}m 0 0 l 100 0 100 50 0 50'));
    expect(d!.advanceX).toBe(100 * 64);
    expect(d!.asc).toBe(50 * 64);
    expect(d!.desc).toBe(0);
  });

  it('converts clip rectangles to frame pixels for positioned events', () => {
    const l = lay('{\\pos(10,10)\\clip(0,0,320,180)}x', { playRes: [640, 360] });
    expect([l.clip.x0, l.clip.y0, l.clip.x1, l.clip.y1]).toEqual([0, 0, 960, 540]);
  });
});

describe('legacy Effect transitions (ass_apply_transition_effects)', () => {
  it('scrolls a Banner right to left from the right edge, one script pixel per delay ms, unwrapped and without collisions', () => {
    const l = lay('a long banner line that would wrap at the margins if it were a normal one, but banners never wrap', { effect: 'Banner;5', now: 1000 });
    expect(l.text.state.evtType & 2).toBe(2);
    expect(l.text.state.detectCollisions).toBe(false);
    expect(l.lines).toHaveLength(1);
    expect(l.deviceX).toBeCloseTo(1920 - 200, 6);
  });
  it('scrolls a Banner left to right with its right edge at the shift', () => {
    const l = lay('banner', { effect: 'Banner;10;1', now: 3000 });
    expect(l.deviceX).toBeCloseTo(300 - (l.bbox[2] - l.bbox[0]), 6);
  });
  it('counts a delay under one storage pixel as one (VSFilter)', () => {
    const l = lay('banner', { effect: 'Banner;0', now: 50 });
    expect(l.deviceX).toBeCloseTo(1920 - 50, 6);
  });
  it('scrolls up from y1 and down from y0, clipped to the band', () => {
    const up = lay('scrolling', { effect: 'Scroll up;600;200;20', now: 2000 });
    expect(up.text.state.evtType & 4).toBe(4);
    expect(up.deviceY + up.bbox[1]).toBeCloseTo(600 - 100, 6);
    expect([up.clip.y0, up.clip.y1]).toEqual([200, 600]);
    const down = lay('scrolling', { effect: 'Scroll down;200;600;20', now: 2000 });
    expect(down.deviceY + down.bbox[3]).toBeCloseTo(200 + 100, 6);
  });
  it('ignores an unknown effect and a scroll with too few fields', () => {
    expect(lay('x', { effect: 'Karaoke' }).text.state.evtType).toBe(0);
    expect(lay('x', { effect: 'Scroll up;10;20' }).text.state.evtType).toBe(0);
    expect(lay('x', { effect: 'Banner' }).text.state.evtType).toBe(0);
  });
});
