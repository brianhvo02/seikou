import { describe, expect, it } from 'vitest';
import { parseAss } from './parse';
import { DECO_STRIKETHROUGH, DECO_UNDERLINE, EF_KARAOKE, EF_KARAOKE_KF, initRenderState, type RenderSettings } from './state';
import { applyFade, hasHardOverrides, interpolateAlpha, nextChar, parseTags } from './tags';

const SETTINGS: RenderSettings = { frameWidth: 1920, frameHeight: 1080, storageWidth: 1920, storageHeight: 1080, fontScale: 1 };
const TRACK = parseAss(`[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,50,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1
Style: Alt,DejaVu Serif,30,&H0000FF00,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,x
`);
const state = () => initRenderState(TRACK, TRACK.events[0]!, SETTINGS);
const at = (block: string, now = 0) => {
  const s = state();
  parseTags(s, block, 1, false, now);
  return s;
};

describe('parseTags', () => {
  it('sets colours (BGR in the tag) and alphas', () => {
    const s = at('\\c&H0000FF&\\3a&H80&');
    expect(s.c[0]).toBe(0xff000000);
    expect(s.c[2] & 0xff).toBe(0x80);
    expect(at('\\alpha&HFF&').c.map((c) => c & 0xff)).toEqual([0xff, 0xff, 0xff, 0xff]);
  });

  it('animates with \\t and acceleration at the given time', () => {
    expect(at('\\t(0,1000,\\fs100)', 500).fontSize).toBeCloseTo(75);
    expect(at('\\t(0,1000,2,\\fs100)', 500).fontSize).toBeCloseTo(62.5);
    expect(at('\\t(\\fs100)', 10_000).fontSize).toBeCloseTo(100);
    expect(at('\\t(0,1000,\\fs100)\\bord5', 500)).toMatchObject({ fontSize: 75, borderX: 5 });
    expect(at('\\t(0,1000,\\c&H0000FF&)', 500).c[0]).toBe(0xff7f7f00);
    expect(at('\\t(0,1000,\\fs100)', 500).detectCollisions).toBe(false);
  });

  it('uses the first \\pos or \\move and ignores later ones', () => {
    const s = at('\\pos(10,20)\\pos(30,40)\\move(0,0,100,100)');
    expect([s.posX, s.posY, s.evtType, s.detectCollisions]).toEqual([10, 20, 1, false]);
  });

  it('interpolates \\move between t1 and t2, and over the event without times', () => {
    expect([at('\\move(0,0,100,200,1000,2000)', 1500).posX, at('\\move(0,0,100,200,1000,2000)', 1500).posY]).toEqual([50, 100]);
    expect(at('\\move(0,0,100,0)', 5000).posX).toBe(50);
    expect(at('\\move(0,0,100)', 5000).evtType).toBe(0); // wrong argument count: ignored
  });

  it('computes \\fad and \\fade alpha once', () => {
    expect(at('\\fad(1000,0)', 500).fade).toBe(interpolateAlpha(500, 0, 1000, 10_000, 10_000, 0xff, 0, 0xff));
    expect(at('\\fad(1000,0)', 500).fade).toBe(127);
    expect(at('\\fade(255,0,255,0,1000,2000,3000)\\fad(0,0)', 2500).fade).toBe(127);
    expect(applyFade(0xffffff00, 0x80) & 0xff).toBe(0x80);
    expect(applyFade(0xffffff40, 0) & 0xff).toBe(0x40);
  });

  it('resets to the line style or a named one with \\r', () => {
    expect(at('\\fs99\\r').fontSize).toBe(50);
    expect(at('\\rAlt').fontSize).toBe(30);
    expect(at('\\rAlt').fontRequest.family).toBe('DejaVu Serif');
    expect(at('\\rNope').fontSize).toBe(50);
  });

  it('reads rectangle and vector clips, and \\iclip as inverse', () => {
    expect(at('\\clip(1,2,3,4)')).toMatchObject({ clipX0: 1, clipY0: 2, clipX1: 3, clipY1: 4, clipMode: 0 });
    expect(at('\\iclip(1,2,3,4)').clipMode).toBe(1);
    expect(at('\\iclip(m 0 0 l 10 0 10 10)')).toMatchObject({ clipDrawingText: 'm 0 0 l 10 0 10 10', clipDrawingMode: 1, clipDrawingScale: 1 });
    expect(at('\\clip(2,m 0 0 l 10 0 10 10)')).toMatchObject({ clipDrawingText: 'm 0 0 l 10 0 10 10', clipDrawingMode: 0, clipDrawingScale: 2 });
    expect(at('\\clip(1,2,3)')).toMatchObject({ clipX1: 1920, clipDrawingText: null });
  });

  it('treats a signed \\fs as relative and clamps borders', () => {
    expect(at('\\fs-5').fontSize).toBe(25);
    expect(at('\\fs+5').fontSize).toBe(75);
    expect(at('\\fs0').fontSize).toBe(50);
    expect(at('\\bord-3')).toMatchObject({ borderX: 0, borderY: 0 });
    expect(at('\\xbord4\\ybord1')).toMatchObject({ borderX: 4, borderY: 1 });
    expect(at('\\xshad-2').shadowX).toBe(-2);
    expect(at('\\shad-2').shadowX).toBe(0);
    expect(at('\\blur500').blur).toBe(100);
    expect(at('\\be2.4').be).toBe(2);
    expect(at('\\be500').be).toBe(127);
  });

  it('keeps the first \\an or \\a, in legacy numbering', () => {
    expect(at('\\an8\\an1').alignment).toBe(6);
    expect(at('\\a8').alignment).toBe(5);
    expect(at('\\an0').alignment).toBe(2);
  });

  it('sets font requests from \\b, \\i, \\fn (with @ for vertical)', () => {
    expect(at('\\b1').fontRequest.bold).toBe(700);
    expect(at('\\b500').fontRequest.bold).toBe(500);
    expect(at('\\b2').fontRequest.bold).toBe(400);
    expect(at('\\i1').fontRequest.italic).toBe(100);
    expect(at('\\fn@Foo Bar').fontRequest).toMatchObject({ family: 'Foo Bar', vertical: true });
    expect(at('\\fnX\\fn0').fontRequest.family).toBe('DejaVu Sans');
  });

  it('sets decorations, wrap style, drawing mode and karaoke timing', () => {
    expect(at('\\u1\\s1').flags).toBe(DECO_UNDERLINE | DECO_STRIKETHROUGH);
    expect(at('\\q2').wrapStyle).toBe(2);
    expect(at('\\q9').wrapStyle).toBe(0);
    expect(at('\\p2\\pbo-5')).toMatchObject({ drawingScale: 2, pbo: -5 });
    expect(at('\\k50')).toMatchObject({ effectType: EF_KARAOKE, effectTiming: 500 });
    expect(at('\\k20\\K30')).toMatchObject({ effectType: EF_KARAOKE_KF, effectTiming: 300, effectSkipTiming: 200 });
  });

  it('reads rotations and shears, with \\fr as \\frz', () => {
    expect(at('\\frx10\\fry20\\fr30\\fax0.5\\fay-0.25')).toMatchObject({ frx: 10, fry: 20, frz: 30, fax: 0.5, fay: -0.25 });
    expect(at('\\org(5,6)\\org(7,8)')).toMatchObject({ orgX: 5, orgY: 6, haveOrigin: true });
  });
});

describe('nextChar', () => {
  it('turns escapes into characters as libass does', () => {
    const s = state();
    const all = (text: string): number[] => { const out: number[] = []; for (let i = 0; i < text.length; ) { const [c, n] = nextChar(s, text, i); out.push(c); i = n; } return out; };
    expect(all('a\\Nb\\nc\\hd\\{\te')).toEqual([0x61, 10, 0x62, 0x20, 0x63, 0xa0, 0x64, 0x7b, 0x20, 0x65]);
    s.wrapStyle = 2;
    expect(all('\\n')).toEqual([10]);
    expect(all('😀')).toEqual([0x1f600]);
  });
});

describe('hasHardOverrides', () => {
  it('finds positioning tags inside override blocks only', () => {
    expect(hasHardOverrides('{\\pos(1,2)}x')).toBe(true);
    expect(hasHardOverrides('{\\p1}m 0 0')).toBe(true);
    expect(hasHardOverrides('\\pos(1,2) {\\b1}x')).toBe(false);
  });
});
