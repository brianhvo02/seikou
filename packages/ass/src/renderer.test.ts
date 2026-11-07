import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AssRendererLimits, Rect } from './host-types';
import { readFontFile } from './font-tables';
import { AssFonts } from './fonts';
import { FrameBuilder } from './frame';
import { createFixedMeasurer } from './measure';
import { parseAss } from './parse';
import type { RenderedEvent } from './raster';
import { AssRenderer, convertColor } from './renderer';
import { YCbCr } from './types';

let fonts: AssFonts;
beforeAll(async () => {
  const bytes = new Uint8Array(readFileSync('fixtures/ass/fonts/DejaVuSans.ttf'));
  fonts = new AssFonts({ load: async () => {}, unload: () => {} }, await readFontFile('DejaVuSans.ttf', bytes));
});

const script = (events: string[], extra = '') => parseAss(`[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
${extra}
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,64,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,3,2,2,40,40,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`);
const ev = (from: string, to: string, text: string) => `Dialogue: 0,${from},${to},Default,,0,0,0,,${text}`;
const MB = 1024 * 1024;
const DESKTOP_LIMITS: AssRendererLimits = { assEventCacheBytes: 128 * MB, assLayerCacheBytes: 128 * MB, assMaskCacheBytes: 64 * MB, maxTextSupersampling: 8 };
const RECT: Rect = { x: 0, y: 60, width: 1920, height: 1080 };
const OPTS = { offsetUs: 0, scale: 1, storage: null };

function fakeCtx() {
  const draws: unknown[] = [];
  const ctx = { drawImage: (...a: unknown[]) => draws.push(a), save() {}, restore() {}, translate() {} } as unknown as OffscreenCanvasRenderingContext2D;
  return { ctx, draws };
}

function renderer(track = script([ev('0:00:01.00', '0:00:03.00', 'static'), ev('0:00:01.00', '0:00:03.00', '{\\move(0,0,100,100)}moving')]), colorMatrix: 'video' | 'none' = 'none', canvas = {} as OffscreenCanvas) {
  const rendered: number[] = [];
  const r = new AssRenderer(track, fonts, {
    measurer: createFixedMeasurer(0.5),
    createCanvas: () => ({}) as OffscreenCanvas,
    nowMs: () => 0,
    Path2D: class {} as unknown as typeof Path2D,
    colorMatrix,
    limits: DESKTOP_LIMITS,
    canvasFilter: true,
    renderEvent: (_rc, e): RenderedEvent => { rendered.push(e.index); return { canvas, x: 0, y: 0 }; },
  });
  return { r, rendered };
}

describe('AssRenderer', () => {
  it('renders a static event once and blits it, an animated one every frame', () => {
    const { r, rendered } = renderer();
    const { ctx, draws } = fakeCtx();
    for (let t = 1000; t < 2000; t += 100) expect(r.render(ctx, t * 1000, RECT, OPTS)).toBe(2);
    expect(rendered.filter((i) => i === 0)).toHaveLength(1);
    expect(rendered.filter((i) => i === 1)).toHaveLength(10);
    expect(draws).toHaveLength(20);
  });

  it('reports changes: event boundaries, settings, and every frame while something moves', () => {
    const { r } = renderer(script([ev('0:00:01.00', '0:00:03.00', 'static'), ev('0:00:04.00', '0:00:05.00', '{\\fad(100,100)}fading')]));
    const { ctx } = fakeCtx();
    expect(r.changed(1_100_000, OPTS)).toBe(true);
    r.render(ctx, 1_100_000, RECT, OPTS);
    expect(r.changed(1_500_000, OPTS)).toBe(false);
    expect(r.changed(1_500_000, { ...OPTS, scale: 1.5 })).toBe(true);
    expect(r.changed(3_100_000, OPTS)).toBe(true);
    r.render(ctx, 4_200_000, RECT, OPTS);
    expect(r.changed(4_300_000, OPTS)).toBe(true);
  });

  it('forgets collision memory on a seek seen by changed() and on reset()', () => {
    const { r } = renderer();
    const spy = vi.spyOn(FrameBuilder.prototype, 'reset');
    r.changed(10_000_000, OPTS);
    r.changed(10_040_000, OPTS);
    expect(spy).not.toHaveBeenCalled();
    r.changed(4_000_000, OPTS);
    expect(spy).toHaveBeenCalledTimes(1);
    r.reset();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('keeps at most 64 cached events', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ev(`0:00:${String(i).padStart(2, '0')}.00`, `0:00:${String(i).padStart(2, '0')}.50`, `line ${i}`)).map((l, i) => (i >= 60 ? l.replace(/0:00:(\d\d)/g, (_m, s) => `0:01:${String(Number(s) - 60).padStart(2, '0')}`) : l));
    const { r } = renderer(script(lines));
    const { ctx } = fakeCtx();
    for (let i = 0; i < 100; i++) r.render(ctx, (i < 60 ? i : 60 + (i - 60)) * 1_000_000 + 100_000, RECT, OPTS);
    expect(r.cacheSize()).toBeLessThanOrEqual(64);
  });

  it('bounds the cached events by their pixels too (128 MiB)', () => {
    const lines = Array.from({ length: 5 }, (_, i) => ev(`0:00:0${i}.00`, `0:00:0${i}.50`, `line ${i}`));
    const { r } = renderer(script(lines), 'none', { width: 4096, height: 4096 } as OffscreenCanvas); // 64 MiB each
    const { ctx } = fakeCtx();
    for (let i = 0; i < 5; i++) r.render(ctx, i * 1_000_000 + 100_000, RECT, OPTS);
    expect(r.cacheSize()).toBe(2);
  });

  it('applies the offset and reports what is visible', () => {
    const { r } = renderer(script([ev('0:00:01.00', '0:00:02.00', 'x')]));
    expect(r.visible(1_500_000, OPTS)).toBe(true);
    expect(r.visible(1_500_000, { ...OPTS, offsetUs: 1_000_000 })).toBe(false);
    expect(r.visible(2_500_000, { ...OPTS, offsetUs: 1_000_000 })).toBe(true);
  });

  it('counts drawn and animated events and times the draw', () => {
    const { r } = renderer();
    r.render(fakeCtx().ctx, 1_500_000, RECT, OPTS);
    expect(r.stats()).toMatchObject({ events: 2, animated: 1, overBudget: 0, renders: 1 });
  });
});

describe('convertColor', () => {
  it('converts BT.601 script colours to BT.709 for the player, and nothing else', () => {
    const red = 0xff000000;
    const conv = convertColor(red, YCbCr.Bt601Tv, 'video');
    expect(conv).not.toBe(red);
    expect(conv & 0xff).toBe(0);
    expect(conv >>> 24).toBeGreaterThan(0xf0);
    expect(convertColor(red, YCbCr.Default, 'video')).toBe(conv);
    expect(convertColor(red, YCbCr.None, 'video')).toBe(red);
    expect(convertColor(red, YCbCr.Bt709Tv, 'video')).toBe(red);
    expect(convertColor(red, YCbCr.Bt601Tv, 'none')).toBe(red);
    expect(convertColor(0xffffff40, YCbCr.Bt601Tv, 'video')).toBe(0xffffff40); // grey stays, alpha stays
  });
});
