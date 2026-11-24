import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { readFontFile } from './font-tables';
import { AssFonts } from './fonts';
import { FrameBuilder } from './frame';
import { createFixedMeasurer } from './measure';
import { parseAss } from './parse';
import type { RenderSettings } from './state';
import {
  backgroundBox, beBlur, blurVariance, dilate, synthBlur, FILTER_BORDER_STYLE_3, FILTER_FILL_IN_BORDER, FILTER_FILL_IN_SHADOW, FILTER_NONZERO_BORDER,
  FILTER_NONZERO_SHADOW, fixOutline, gaussianBlur, layerKey, quantizePositions, quantizeShadow, renderEvent, runFlags,
  type RasterContext,
} from './raster';

const glyph = (over: Record<string, number | number[]> = {}) => ({
  borderStyle: 1, borderX: 2, borderY: 2, shadowX: 0, shadowY: 0, effectType: 0, fade: 0, c: [0xffffff00, 0x0000ff00, 0, 0x80], ...over,
}) as unknown as Parameters<typeof runFlags>[0];

describe('runFlags (render_and_combine_glyphs)', () => {
  it('fills the border under an opaque fill with no fade', () => {
    expect(runFlags(glyph())).toBe(FILTER_NONZERO_BORDER | FILTER_FILL_IN_BORDER);
  });
  it('keeps a shadow only with a border or a fill-in shadow', () => {
    expect(runFlags(glyph({ shadowX: 2, shadowY: 2 }))).toBe(FILTER_NONZERO_BORDER | FILTER_NONZERO_SHADOW | FILTER_FILL_IN_SHADOW | FILTER_FILL_IN_BORDER);
    expect(runFlags(glyph({ borderX: 0, borderY: 0, shadowX: 2, c: [0xffffffff, 0, 0, 0] }))).toBe(0);
  });
  it('treats an opaque box style as filled border', () => {
    expect(runFlags(glyph({ borderStyle: 3 })) & (FILTER_BORDER_STYLE_3 | FILTER_FILL_IN_BORDER)).toBe(FILTER_BORDER_STYLE_3 | FILTER_FILL_IN_BORDER);
  });
  it('does not fill the border under a semi-transparent fill', () => {
    expect(runFlags(glyph({ c: [0xffffff80, 0x0000ff00, 0, 0] })) & FILTER_FILL_IN_BORDER).toBe(0);
  });
});

describe('blurVariance', () => {
  it('is zero without blur and grows with \\blur through libass quantisation', () => {
    expect(blurVariance(0, 1)).toBe(0);
    const v2 = blurVariance(2, 1);
    // radius 2 × 2/sqrt(ln 256) ≈ 1.699 px, quantised to step 13, restored to σ = expm1(13/256)·32 ≈ 1.667
    expect(Math.sqrt(v2)).toBeCloseTo(32 * Math.expm1(13 / 256), 9);
    expect(blurVariance(4, 1)).toBeGreaterThan(v2);
  });
});

describe('quantizeShadow', () => {
  it('rounds the 26.6 shadow offset to the blur-dependent grid', () => {
    expect(quantizeShadow(2 * 64, 0)).toBe(128);
    expect(quantizeShadow(130, 0)).toBe(128);
  });
});

describe('fixOutline', () => {
  it('cuts the fill out of the border as ass_fix_outline does', () => {
    const fill = new Uint8Array([0, 128, 255, 200]);
    const border = new Uint8Array([255, 255, 255, 100]);
    fixOutline(fill, border);
    expect([...border]).toEqual([255, 191, 0, 0]);
  });
});

describe('dilate', () => {
  it('grows a single pixel into a disk of the radius', () => {
    const w = 9;
    const m = new Uint8Array(w * w);
    m[4 * w + 4] = 255;
    const out = dilate(m, w, w, 2, 2);
    expect(out[4 * w + 4]).toBe(255);
    expect(out[4 * w + 5]).toBe(255);
    expect(out[4 * w + 6]).toBe(255);
    expect(out[4 * w + 8]).toBe(0);
    expect(out[2 * w + 4]).toBe(255);
    expect(out[2 * w + 2]).toBeLessThan(255); // √8 ≈ 2.83 > 2: partly covered
  });

  it('dilates by an ellipse with different radii', () => {
    const w = 11;
    const m = new Uint8Array(w * w);
    m[5 * w + 5] = 255;
    const out = dilate(m, w, w, 4, 1);
    expect(out[5 * w + 9]).toBe(255);
    expect(out[8 * w + 5]).toBe(0);
  });
});

describe('beBlur (ass_synth_blur box passes)', () => {
  const dot = (w: number, h: number, x: number, y: number, v = 255): Uint8Array => {
    const m = new Uint8Array(w * h);
    m[y * w + x] = v;
    return m;
  };
  it('leaves the mask alone at \\be0', () => {
    const m = dot(5, 5, 2, 2);
    beBlur(m, 5, 5, 0);
    expect(m).toEqual(dot(5, 5, 2, 2));
  });
  it('spreads one pass with VSFilter\'s [1 2 1] kernel, truncated (>> 4)', () => {
    const m = dot(5, 5, 2, 2);
    beBlur(m, 5, 5, 1);
    // 255 × {1,2,4}/16 = 15.9, 31.9, 63.75 → 15, 31, 63
    expect(Array.from(m.subarray(5, 20))).toEqual([0, 15, 31, 15, 0, 0, 31, 63, 31, 0, 0, 15, 31, 15, 0]);
    expect(m[2]).toBe(0);
  });
  it('treats outside the bitmap as zero', () => {
    const m = dot(3, 3, 0, 0);
    beBlur(m, 3, 3, 1);
    expect(Array.from(m)).toEqual([63, 31, 0, 31, 15, 0, 0, 0, 0]);
  });
  it('runs all but the last pass at 6 bits (be_blur_pre and be_blur_post)', () => {
    const m = dot(7, 7, 3, 3);
    beBlur(m, 7, 7, 2);
    // pre: 255 → 64; pass: centre 64·4/16 = 16, edge 8, corner 4; post: v·4 − (v > 32) → 64, 32, 16;
    // last pass at the centre: (16·1·4 + 32·2·4 + 64·4) / 16 ... computed by the kernel below
    const k = [1, 2, 1];
    const first = new Array(49).fill(0);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const v = (64 * k[dx + 1]! * k[dy + 1]!) >> 4;
      first[(3 + dy) * 7 + 3 + dx] = v * 4 - (v > 32 ? 1 : 0);
    }
    const second = new Array(49).fill(0);
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy;
        const xx = x + dx;
        if (yy >= 0 && yy < 7 && xx >= 0 && xx < 7) s += first[yy * 7 + xx] * k[dx + 1]! * k[dy + 1]!;
      }
      second[y * 7 + x] = s >> 4;
    }
    expect(Array.from(m)).toEqual(second);
  });
});

describe('synthBlur (the blur step of ass_composite_construct)', () => {
  const square = (): Uint8Array => {
    const m = new Uint8Array(20 * 20);
    for (let y = 7; y < 13; y++) for (let x = 7; x < 13; x++) m[y * 20 + x] = 255;
    return m;
  };
  it('runs \\blur\'s Gaussian, then \\be\'s box passes, on the fill of a run without a border', () => {
    const expected = gaussianBlur(square(), 20, 20, 0.8, 0.8);
    beBlur(expected, 20, 20, 2);
    const { fill } = synthBlur(square(), null, 20, 20, 0, 0.8, 0.8, 2);
    expect(fill).toEqual(expected);
    // not the Gaussian with \be folded in as 0.5 px² per pass
    expect(fill).not.toEqual(gaussianBlur(square(), 20, 20, Math.sqrt(0.64 + 1), Math.sqrt(0.64 + 1)));
  });
  it('blurs only the border of a bordered run', () => {
    const { fill, border } = synthBlur(square(), square(), 20, 20, FILTER_NONZERO_BORDER, 0, 0, 1);
    expect(fill).toEqual(square());
    const b = square();
    beBlur(b, 20, 20, 1);
    expect(border).toEqual(b);
  });
});

describe('gaussianBlur', () => {
  const line = (): Uint8Array => {
    const m = new Uint8Array(40 * 3);
    for (let y = 0; y < 3; y++) m[y * 40 + 19] = m[y * 40 + 20] = 255;
    return m;
  };

  it('softens a 2 px stroke even at deviations under 0.8 px', () => {
    const out = gaussianBlur(line(), 40, 3, 0.64, 0);
    expect(out[40 + 18]).toBeGreaterThan(30);
    expect(out[40 + 19]).toBeGreaterThan(190);
    expect(out[40 + 19]).toBeLessThan(225);
    expect(out[40 + 19]).toBe(out[40 + 20]);
  });

  it('keeps the mass and blurs each axis by its own deviation', () => {
    const out = gaussianBlur(line(), 40, 3, 1.5, 0);
    expect(out.reduce((a, b) => a + b, 0)).toBeGreaterThan(3 * 510 - 12);
    expect(out[18]).toBe(out[40 + 18]); // no vertical blur
    expect(gaussianBlur(line(), 40, 3, 0, 0)).toEqual(line());
  });
});

describe('quantizePositions (quantize_transform)', () => {
  const g = (x0: number, x1: number) => ({ bboxXMin: x0, bboxXMax: x1, bboxYMin: -640, bboxYMax: 0 }) as unknown as Parameters<typeof quantizePositions>[0][number];
  const at = (x: number, y: number) => [1, 0, x, 0, 1, y, 0, 0, 1] as [number, number, number, number, number, number, number, number, number];

  it('moves the run by the rounding of the first inked glyph\'s box centre', () => {
    // centre of glyph 0: (3 + 100, -320 + 5) 26.6 → x 103/8 = 12.875 → 13 (+1), y -315/8 = -39.375 → -39 (+3)
    const [m0, m1] = quantizePositions([g(0, 200), g(0, 202)], [at(3, 5), at(1003, 5)]);
    expect([m0![2], m0![5]]).toEqual([4, 8]);
    // glyph 1: centre x (1003 + 101)/8 = 138 minus the run's offset (-0.125) → 138.125 → 138: unmoved;
    // y has the same centre as glyph 0, so it moves with it
    expect([m1![2], m1![5]]).toEqual([1003, 8]);
  });

  it('ignores glyphs without ink for the run offset and keeps perspective matrices', () => {
    const persp = [1, 0, 3, 0, 1, 5, 1e-3, 0, 1] as const;
    const [space, ink, p] = quantizePositions([g(0, 0), g(0, 200), g(0, 200)], [at(3, 5), at(3, 5), [...persp]]);
    expect(ink![2]).toBe(4); // as if it came first: the space before it sets no offset
    expect(space![2]).toBe(0); // its own centre (3 26.6 = 0.375 grid) rounded
    expect(p).toEqual([...persp]);
  });
});

describe('layerKey', () => {
  it('tells apart runs that differ only in colour, karaoke or shadow offset', () => {
    const base = layerKey('m', [1, 2, 3, 4], 0, 0, 64, 64);
    expect(layerKey('m', [1, 2, 3, 4], 0, 0, 64, 64)).toBe(base);
    expect(layerKey('m', [1, 2, 3, 5], 0, 0, 64, 64)).not.toBe(base);
    expect(layerKey('m', [1, 2, 3, 4], 0, 1, 64, 64)).not.toBe(base);
    expect(layerKey('m', [1, 2, 3, 4], 0, 0, 128, 64)).not.toBe(base); // \xshad changed, same masks
    expect(layerKey('m', [1, 2, 3, 4], 0, 0, 64, -64)).not.toBe(base);
  });
});

describe('renderEvent without canvas filters', () => {
  const settings: RenderSettings = { frameWidth: 1920, frameHeight: 1080, storageWidth: 1920, storageHeight: 1080, fontScale: 1 };
  const script = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,40,40,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\\blur2\\t(0,4000,\\frz90)}blurred
`;
  const fakeCanvas = (w: number, h: number): OffscreenCanvas => {
    const ctx = new Proxy({}, { get: (_t, k) => (k === 'getImageData' ? () => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => undefined) });
    return { width: w, height: h, getContext: () => ctx } as unknown as OffscreenCanvas;
  };
  async function load(): Promise<FrameBuilder> {
    const fonts = new AssFonts({ load: async () => {}, unload: () => {} }, await readFontFile('DejaVuSans.ttf', new Uint8Array(readFileSync('fixtures/ass/fonts/DejaVuSans.ttf'))));
    return new FrameBuilder(parseAss(script), fonts, createFixedMeasurer(0.5));
  }
  let builder: FrameBuilder;
  beforeAll(async () => {
    vi.stubGlobal('ImageData', class { readonly data: Uint8ClampedArray; constructor(readonly width: number, readonly height: number) { this.data = new Uint8ClampedArray(width * height * 4); } });
    builder = await load();
  });
  afterAll(() => { vi.unstubAllGlobals(); });
  function runShapeChange(canvasFilter: boolean): number {
    let masksSet = 0;
    const masks = new Map<string, never>();
    const rc: RasterContext = {
      createCanvas: fakeCanvas,
      Path2D: class { addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} rect() {} } as unknown as typeof Path2D,
      masks: { get: (k) => masks.get(k), set: (k, v) => { masksSet++; masks.set(k, v as never); } },
      lastShapes: new Map(),
      canvasFilter,
    };
    for (const t of [500, 1500, 2500]) renderEvent(rc, builder.build(t, settings).events[0]!, { width: 1920, height: 1080 });
    return masksSet;
  }
  it('keeps a run whose only change is \\be on the masks (box passes), never the GPU Gaussian', async () => {
    const fonts = new AssFonts({ load: async () => {}, unload: () => {} }, await readFontFile('DejaVuSans.ttf', new Uint8Array(readFileSync('fixtures/ass/fonts/DejaVuSans.ttf'))));
    const be = new FrameBuilder(parseAss(script.replace('{\\blur2\\t(0,4000,\\frz90)}blurred', '{\\be1\\t(0,4000,\\be9)}stepping')), fonts, createFixedMeasurer(0.5));
    let masksSet = 0;
    const masks = new Map<string, never>();
    const rc: RasterContext = {
      createCanvas: fakeCanvas,
      Path2D: class { addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} rect() {} } as unknown as typeof Path2D,
      masks: { get: (k) => masks.get(k), set: (k, v) => { masksSet++; masks.set(k, v as never); } },
      lastShapes: new Map(),
      canvasFilter: true,
    };
    for (const t of [500, 1500, 2500]) renderEvent(rc, be.build(t, settings).events[0]!, { width: 1920, height: 1080 });
    expect(masksSet).toBe(3);
  });
  it('draws a reshaped blurred run directly where canvases filter, through the masks where they do not', () => {
    expect(runShapeChange(true)).toBe(1); // only the first frame, before the shape changes
    expect(runShapeChange(false)).toBe(3);
  });
});

describe('backgroundBox (add_background, BorderStyle 4)', () => {
  const settings: RenderSettings = { frameWidth: 1920, frameHeight: 1080, storageWidth: 1920, storageHeight: 1080, fontScale: 1 };
  const script = (style: string, events: string): string => `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,64,&H00FFFFFF,&H000000FF,&H00000000,&H40302010,0,0,0,0,100,100,0,0,${style},40,40,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}`;
  async function frame(style: string, events: string, t = 500) {
    const fonts = new AssFonts({ load: async () => {}, unload: () => {} }, await readFontFile('DejaVuSans.ttf', new Uint8Array(readFileSync('fixtures/ass/fonts/DejaVuSans.ttf'))));
    return new FrameBuilder(parseAss(script(style, events)), fonts, createFixedMeasurer(0.5)).build(t, settings);
  }
  it('is the event box widened by positive shadows, in the back colour', async () => {
    const f = await frame('4,2,3,2', 'Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\\xshad5\\yshad-2}boxed');
    const ev = f.events[0]!;
    const b = backgroundBox(ev, { width: 1920, height: 1080 })!;
    expect(b).toEqual({ x: ev.box.left - 5, y: ev.box.top, w: ev.box.width + 10, h: ev.box.height, color: 0x10203040 }); // &H40302010 is AABBGGRR
  });
  it('is null for other border styles and clamped to the frame', async () => {
    const one = await frame('1,2,3,2', 'Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,plain');
    expect(backgroundBox(one.events[0]!, { width: 1920, height: 1080 })).toBeNull();
    const edge = await frame('4,2,8,7', 'Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\\pos(0,0)}corner');
    const b = backgroundBox(edge.events[0]!, { width: 1920, height: 1080 })!;
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
  });
  it('takes the fade, and the place before collisions', async () => {
    const f = await frame('4,2,0,2', [
      'Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\\fad(0,1000)}first',
      'Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,second',
    ].join('\n'), 4500);
    const moved = f.events.find((e) => e.shiftY !== 0)!;
    expect(backgroundBox(moved, { width: 1920, height: 1080 })!.y).toBe(moved.box.top - moved.shiftY);
    const faded = f.events.find((e) => e.index === 0)!;
    expect(backgroundBox(faded, { width: 1920, height: 1080 })!.color & 0xff).toBeGreaterThan(0x40);
  });
});
