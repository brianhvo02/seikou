/** The ASS trace page: lays out (and later draws) a script with our port, in Chrome, as the libass harness does. */
import { readFontFile } from '@seikou/ass/font-tables';
import { AssFonts, createFontFaceLoader } from '@seikou/ass/fonts';
import { FrameBuilder } from '@seikou/ass/frame';
import { createCanvasMeasurer } from '@seikou/ass/measure';
import { AssRenderer } from '@seikou/ass/renderer';
import { MEMORY_PROFILES } from '../../../src/engine/memory-profile';
import { drawWarped } from '@seikou/ass/warp';
import { parseAss } from '@seikou/ass/parse';
import type { RenderSettings } from '@seikou/ass/state';
import { frameToTrace } from '@seikou/ass/trace';
import { formatTrace } from '../format';
import { comparePixels } from '../pixels';
import type { AssSessionPage, AssTracePage, FrameResult } from './types';

const bytesOf = async (url: string): Promise<Uint8Array> => new Uint8Array(await (await fetch(url)).arrayBuffer());

const page: AssTracePage = {
  async run(scriptUrl, fontUrls, times, pixels, storage) {
    const track = parseAss(new TextDecoder().decode(await bytesOf(scriptUrl)));
    const defaultFont = await readFontFile('DejaVuSans.ttf', await bytesOf('/fixtures/ass/fonts/DejaVuSans.ttf'));
    const fonts = new AssFonts(createFontFaceLoader(document.fonts), defaultFont);
    // libass registers a script's [Fonts] before the fonts directory
    await fonts.add(track.fonts.map((f) => ({ name: f.name, bytes: f.bytes })));
    await fonts.add(await Promise.all(fontUrls.map(async (u) => ({ name: u.split('/').pop()!, bytes: await bytesOf(u) }))));
    const settings: RenderSettings = { frameWidth: 1920, frameHeight: 1080, storageWidth: storage?.[0] ?? 1920, storageHeight: storage?.[1] ?? 1080, fontScale: 1 };
    const measureCtx = new OffscreenCanvas(1, 1).getContext('2d')!;
    // first pass: resolve every face the frames use, so they are loaded before measuring
    const probe = new FrameBuilder(track, fonts, createCanvasMeasurer(measureCtx));
    for (const t of times) probe.build(t, settings);
    await fonts.ready();
    const builder = new FrameBuilder(track, fonts, createCanvasMeasurer(measureCtx));
    const renderer = new AssRenderer(track, fonts, {
      measurer: createCanvasMeasurer(measureCtx),
      createCanvas: (w, h) => new OffscreenCanvas(w, h),
      nowMs: () => performance.now(),
      Path2D,
      colorMatrix: 'none', // goldens are libass's colours, unconverted
      warp: drawWarped,
      limits: MEMORY_PROFILES.desktop,
      canvasFilter: true,
    });
    const events = [];
    const frames: string[] = [];
    const renderMs: { ms: number; animated: boolean }[] = [];
    const canvas = new OffscreenCanvas(1920, 1080);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    for (const t of times) {
      events.push(...frameToTrace(builder.build(t, settings), fonts));
      if (!pixels) continue;
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, 1920, 1080);
      renderer.changed(t * 1000, { offsetUs: 0, scale: 1 });
      renderer.render(ctx, t * 1000, { x: 0, y: 0, width: 1920, height: 1080 }, { offsetUs: 0, scale: 1, storage: { width: settings.storageWidth, height: settings.storageHeight } });
      renderMs.push({ ms: renderer.stats().renderMs, animated: renderer.stats().animated > 0 });
      const rgba = ctx.getImageData(0, 0, 1920, 1080).data;
      let bin = '';
      for (let i = 0; i < rgba.length; i += 0x8000) bin += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
      frames.push(btoa(bin));
    }
    return { trace: formatTrace(events), frames, missingFamilies: [...fonts.missingFamilies()], renderMs };
  },
};

(window as unknown as { assTrace: AssTracePage }).assTrace = page;

/** The session: one script, its fonts, a layout builder and a renderer that live across steps. */
let session: { builder: FrameBuilder; renderer: AssRenderer; fonts: AssFonts; settings: RenderSettings; ctx: OffscreenCanvasRenderingContext2D; readCtx: OffscreenCanvasRenderingContext2D } | null = null;

const toBase64 = (rgba: Uint8ClampedArray): string => {
  let bin = '';
  for (let i = 0; i < rgba.length; i += 0x8000) bin += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
  return btoa(bin);
};

async function goldenPixels(url: string): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(await (await fetch(url)).blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  return new Uint8Array(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer);
}

const sessionPage: AssSessionPage = {
  async open(scriptUrl, fontUrls, storage) {
    const track = parseAss(new TextDecoder().decode(await bytesOf(scriptUrl)));
    const defaultFont = await readFontFile('DejaVuSans.ttf', await bytesOf('/fixtures/ass/fonts/DejaVuSans.ttf'));
    const fonts = new AssFonts(createFontFaceLoader(document.fonts), defaultFont);
    await fonts.add(track.fonts.map((f) => ({ name: f.name, bytes: f.bytes })));
    await fonts.add(await Promise.all(fontUrls.map(async (u) => ({ name: decodeURIComponent(u.split('/').pop()!), bytes: await bytesOf(u) }))));
    const settings: RenderSettings = { frameWidth: 1920, frameHeight: 1080, storageWidth: storage?.[0] ?? 1920, storageHeight: storage?.[1] ?? 1080, fontScale: 1 };
    const measureCtx = new OffscreenCanvas(1, 1).getContext('2d')!;
    // every face any event uses, loaded before measuring
    const probe = new FrameBuilder(track, fonts, createCanvasMeasurer(measureCtx));
    for (const e of track.events) probe.build(e.start, settings);
    await fonts.ready();
    session = {
      builder: new FrameBuilder(track, fonts, createCanvasMeasurer(measureCtx)),
      renderer: new AssRenderer(track, fonts, { measurer: createCanvasMeasurer(measureCtx), createCanvas: (w, h) => new OffscreenCanvas(w, h), nowMs: () => performance.now(), Path2D, colorMatrix: 'none', warp: drawWarped, limits: MEMORY_PROFILES.desktop, canvasFilter: true }),
      fonts,
      settings,
      // drawn on a GPU canvas like the player's, copied to a CPU one for the comparison
      ctx: new OffscreenCanvas(1920, 1080).getContext('2d')!,
      readCtx: new OffscreenCanvas(1920, 1080).getContext('2d', { willReadFrequently: true })!,
    };
    return { missingFamilies: [...fonts.missingFamilies()] };
  },
  async step(times, goldenBase, boxes, skip) {
    const s = session!;
    const events = [];
    const results: FrameResult[] = [];
    const renderMs: { t: number; ms: number; animated: boolean }[] = [];
    const skipped = new Set(skip);
    for (const t of times) {
      events.push(...frameToTrace(s.builder.build(t, s.settings), s.fonts));
      s.ctx.fillStyle = '#808080';
      s.ctx.fillRect(0, 0, 1920, 1080);
      s.renderer.changed(t * 1000, { offsetUs: 0, scale: 1 });
      s.renderer.render(s.ctx, t * 1000, { x: 0, y: 0, width: 1920, height: 1080 }, { offsetUs: 0, scale: 1, storage: { width: s.settings.storageWidth, height: s.settings.storageHeight } });
      renderMs.push({ t, ms: s.renderer.stats().renderMs, animated: s.renderer.stats().animated > 0 });
      if (!goldenBase || skipped.has(t)) continue;
      s.readCtx.drawImage(s.ctx.canvas, 0, 0);
      const actual = s.readCtx.getImageData(0, 0, 1920, 1080).data;
      const r = comparePixels(await goldenPixels(`${goldenBase}/${t}.png`), new Uint8Array(actual.buffer), 1920, 1080, boxes[t] ?? []);
      results.push({ t, differing: r.differing, budget: r.budget, pass: r.pass, ...(r.pass ? {} : { actual: toBase64(actual) }) });
    }
    return { trace: formatTrace(events), results, renderMs };
  },
};

(window as unknown as { assSession: AssSessionPage }).assSession = sessionPage;
