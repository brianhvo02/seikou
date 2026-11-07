import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphicsPlaneReader, GraphicsPlaneWriter, createGraphicsPlane, updateGraphic } from '../bdj/graphics-plane';
import { OverlayPlane } from '@seikou/pg';
import type { ShaderStage } from '../shaders/stage';
import { Compositor, fitRect } from './compositor';

describe('fitRect', () => {
  it('letterboxes wide video into a square', () => {
    expect(fitRect(1920, 1080, 1000, 1000)).toEqual({ x: 0, y: 218, width: 1000, height: 563 });
  });

  it('pillarboxes 4:3 into 16:9', () => {
    expect(fitRect(1440, 1080, 1920, 1080)).toEqual({ x: 240, y: 0, width: 1440, height: 1080 });
  });

  it('scales up to fill an exact match', () => {
    expect(fitRect(1280, 720, 1920, 1080)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('returns an empty rect for a frame with no size', () => {
    expect(fitRect(0, 1080, 1920, 1080)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('Compositor.drawIg', () => {
  afterEach(() => vi.unstubAllGlobals());

  function fake(width: number, height: number) {
    const calls: Array<[string, ...unknown[]]> = [];
    const ctx = (name: string) => new Proxy({}, { get: (_t, prop: string) => (...args: unknown[]) => calls.push([`${name}.${prop}`, ...args]) });
    const igCtx = ctx('ig');
    const mainCtx = ctx('main');
    const igCanvas = { getContext: () => igCtx } as unknown as OffscreenCanvas;
    const main = { width, height, getContext: () => mainCtx } as unknown as OffscreenCanvas;
    vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
    return { calls, compositor: new Compositor(main, () => igCanvas), igCanvas };
  }

  const opaque = (x: number, y: number, w: number, h: number) => ({ cmd: 'draw' as const, pts: -1, x, y, w, h, palette: [{ y: 0, cr: 0, cb: 0, t: 0 }, { y: 100, cr: 128, cb: 128, t: 255 }], img: [{ color: 1, len: w }] });

  it('puts the dirty rect into the IG canvas once and draws it letterboxed over the video', () => {
    const { calls, compositor, igCanvas } = fake(1000, 1000);
    const plane = new OverlayPlane();
    plane.apply({ cmd: 'init', pts: -1, x: 0, y: 0, w: 1920, h: 1080 });
    plane.takeDirty();
    plane.apply(opaque(10, 20, 4, 1));
    compositor.drawIg(plane);
    const puts = calls.filter(([n]) => n === 'ig.putImageData');
    expect(puts).toHaveLength(1);
    const [, image, dx, dy] = puts[0]!;
    expect(image).toMatchObject({ width: 4, height: 1 });
    expect([dx, dy]).toEqual([10, 20]);
    const draws = calls.filter(([n]) => n === 'main.drawImage');
    expect(draws).toEqual([['main.drawImage', igCanvas, 0, 218, 1000, 563]]);
    expect(plane.dirty()).toBeNull();
  });

  it('draws the picture again without copying when nothing changed', () => {
    const { calls, compositor } = fake(1920, 1080);
    const plane = new OverlayPlane();
    plane.apply(opaque(0, 0, 2, 1));
    compositor.drawIg(plane);
    calls.length = 0;
    compositor.drawIg(plane);
    expect(calls.map(([n]) => n)).toEqual(['main.drawImage']);
  });
});

describe('Compositor.drawPg', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('copies the dirty rect into its own canvas, separate from the IG one, and draws it fitted', () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const ctx = (name: string) => new Proxy({}, { get: (_t, prop: string) => (...args: unknown[]) => calls.push([`${name}.${prop}`, ...args]) });
    const canvases: OffscreenCanvas[] = [];
    const main = { width: 1000, height: 1000, getContext: () => ctx('main') } as unknown as OffscreenCanvas;
    vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
    const compositor = new Compositor(main, () => {
      const name = `c${canvases.length}`;
      const c = { getContext: () => ctx(name) } as unknown as OffscreenCanvas;
      canvases.push(c);
      return c;
    });
    const pg = new OverlayPlane();
    pg.apply({ cmd: 'draw', pts: -1, x: 10, y: 900, w: 4, h: 1, palette: [{ y: 0, cr: 0, cb: 0, t: 0 }, { y: 100, cr: 128, cb: 128, t: 255 }], img: [{ color: 1, len: 4 }] });
    const ig = new OverlayPlane();
    ig.apply({ cmd: 'draw', pts: -1, x: 0, y: 0, w: 2, h: 1, palette: [{ y: 0, cr: 0, cb: 0, t: 0 }, { y: 100, cr: 128, cb: 128, t: 255 }], img: [{ color: 1, len: 2 }] });
    compositor.drawPg(pg);
    compositor.drawIg(ig);
    expect(canvases).toHaveLength(2);
    const puts = calls.filter(([n]) => n.endsWith('.putImageData'));
    expect(puts.map(([n]) => n)).toEqual(['c0.putImageData', 'c1.putImageData']);
    expect(puts[0]!.slice(2)).toEqual([10, 900]);
    expect(calls.filter(([n]) => n === 'main.drawImage')).toEqual([['main.drawImage', canvases[0], 0, 218, 1000, 563], ['main.drawImage', canvases[1], 0, 218, 1000, 563]]);
    calls.length = 0;
    compositor.drawPg(pg);
    expect(calls.map(([n]) => n)).toEqual(['main.drawImage']);
  });
});

describe('Compositor.drawText', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('forgets the last frame when a playlist starts, and lays text over the 1920×1080 screen only without a picture', () => {
    const mainCtx = new Proxy({}, { get: () => () => undefined });
    const main = { width: 1000, height: 1000, getContext: () => mainCtx } as unknown as OffscreenCanvas;
    const compositor = new Compositor(main, () => ({}) as OffscreenCanvas);
    const calls: unknown[][] = [];
    const renderer = { render: (...args: unknown[]) => { calls.push(args); return 1; }, changed: () => false, visible: () => false };
    const opts = { offsetUs: 0, scale: 1 };
    compositor.drawVideo({ displayWidth: 640, displayHeight: 480, codedWidth: 640, codedHeight: 480 } as unknown as VideoFrame);
    compositor.startPlaylist(false);
    compositor.drawText(renderer, 5, opts);
    expect(calls.map((c) => c.slice(2))).toEqual([[{ x: 0, y: 218, width: 1000, height: 563 }, { ...opts, storage: null }]]);
    compositor.startPlaylist(true); // a playlist with a picture: nothing until its first frame
    compositor.drawText(renderer, 5, opts);
    expect(calls).toHaveLength(1);
  });

  it('hands the renderer the main context and the fitted rectangle of the last frame', () => {
    const mainCtx = new Proxy({}, { get: () => () => undefined });
    const main = { width: 1000, height: 1000, getContext: () => mainCtx } as unknown as OffscreenCanvas;
    const compositor = new Compositor(main, () => ({}) as OffscreenCanvas);
    const calls: unknown[][] = [];
    const renderer = { render: (...args: unknown[]) => { calls.push(args); return 1; }, changed: () => false, visible: () => false };
    const opts = { offsetUs: 0, scale: 1 };
    compositor.drawText(renderer, 5, opts);
    expect(calls).toEqual([]); // no frame yet: no video rectangle
    compositor.drawVideo({ displayWidth: 1920, displayHeight: 1080, codedWidth: 1440, codedHeight: 1088, visibleRect: { width: 1440, height: 1080 } } as unknown as VideoFrame);
    compositor.drawText(renderer, 5, opts);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(mainCtx);
    // the frame's visible coded size goes along as the storage size (anamorphic ASS layout)
    expect(calls[0]!.slice(1)).toEqual([5, { x: 0, y: 218, width: 1000, height: 563 }, { ...opts, storage: { width: 1440, height: 1080 } }]);
  });
});

describe('Compositor.drawVideo with a shader stage', () => {
  function fake() {
    const calls: Array<[string, ...unknown[]]> = [];
    const mainCtx = new Proxy({}, { get: (_t, prop: string) => (...args: unknown[]) => calls.push([`main.${prop}`, ...args]) });
    const main = { width: 1000, height: 1000, getContext: () => mainCtx } as unknown as OffscreenCanvas;
    return { calls, compositor: new Compositor(main, () => ({}) as OffscreenCanvas) };
  }
  const frame = { displayWidth: 1920, displayHeight: 1080, codedWidth: 1440, codedHeight: 1088, visibleRect: { width: 1440, height: 1080 } } as unknown as VideoFrame;

  it('draws the shaded image in the fitted rectangle, asking for it at that size', () => {
    const { calls, compositor } = fake();
    const shaded = { shaded: true } as unknown as OffscreenCanvas;
    const asked: unknown[][] = [];
    const stage = { process: (...args: unknown[]) => { asked.push(args); return shaded; } } as unknown as ShaderStage;
    compositor.setShaderStage(stage);
    compositor.drawVideo(frame);
    expect(asked).toEqual([[frame, { width: 1000, height: 563 }]]);
    expect(calls.filter(([n]) => n === 'main.drawImage')).toEqual([['main.drawImage', shaded, 0, 218, 1000, 563]]);
    // text is still laid out from the frame
    const text: unknown[][] = [];
    compositor.drawText({ render: (...args: unknown[]) => { text.push(args); return 0; }, changed: () => false, visible: () => false }, 0, { offsetUs: 0, scale: 1 });
    expect(text[0]!.slice(2)).toEqual([{ x: 0, y: 218, width: 1000, height: 563 }, { offsetUs: 0, scale: 1, storage: { width: 1440, height: 1080 } }]);
  });

  it('draws the raw frame when the stage has no image, and after the stage is removed', () => {
    const { calls, compositor } = fake();
    compositor.setShaderStage({ process: () => null } as unknown as ShaderStage);
    compositor.drawVideo(frame);
    compositor.setShaderStage(null);
    compositor.drawVideo(frame);
    expect(calls.filter(([n]) => n === 'main.drawImage')).toEqual([['main.drawImage', frame, 0, 218, 1000, 563], ['main.drawImage', frame, 0, 218, 1000, 563]]);
  });
});

describe('Compositor.drawBdj', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function fake(width: number, height: number) {
    const calls: Array<[string, ...unknown[]]> = [];
    const ctx = (name: string) => new Proxy({}, { get: (_t, prop: string) => (...args: unknown[]) => calls.push([`${name}.${prop}`, ...args]) });
    const bdjCanvas = { width: 1920, height: 1080, getContext: () => ctx('bdj') } as unknown as OffscreenCanvas;
    const main = { width, height, getContext: () => ctx('main') } as unknown as OffscreenCanvas;
    const created: OffscreenCanvas[] = [];
    vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
    const compositor = new Compositor(main, () => {
      created.push(bdjCanvas);
      return bdjCanvas;
    });
    return { calls, compositor, bdjCanvas, main, created };
  }

  function menu(): { writer: GraphicsPlaneWriter; reader: GraphicsPlaneReader } {
    const buffer = createGraphicsPlane();
    const writer = new GraphicsPlaneWriter(buffer);
    updateGraphic(writer, 1920, 1080, null, 0, 0, 0, 0);
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080).fill(-1), 100, 200, 109, 204);
    return { writer, reader: new GraphicsPlaneReader(buffer) };
  }

  it('copies a new plane whole, then only the flushed rect, and draws it over the video in the 16:9 menu rectangle', () => {
    const { calls, compositor, bdjCanvas } = fake(1000, 1000);
    const { writer, reader } = menu();
    compositor.drawVideo(null);
    compositor.drawBdj(reader);
    expect(calls.filter(([n]) => n === 'bdj.putImageData').map((c) => c.slice(2))).toEqual([[0, 0, 0, 0, 1920, 1080]]);
    expect(calls.filter(([n]) => n.startsWith('main.')).map(([n]) => n)).toEqual(['main.fillRect', 'main.drawImage']);
    expect(calls.at(-1)).toEqual(['main.drawImage', bdjCanvas, 0, 0, 1920, 1080, 0, 218, 1000, 563]);
    calls.length = 0;
    const cas = vi.spyOn(Atomics, 'compareExchange');
    compositor.drawBdj(reader);
    expect(calls.map(([n]) => n)).toEqual(['main.drawImage']); // nothing new to copy: the cached canvas is drawn
    expect(cas).not.toHaveBeenCalled(); // and the plane's lock is never tried
    cas.mockRestore();
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080), 5, 6, 7, 8);
    calls.length = 0;
    compositor.drawBdj(reader);
    expect(calls.filter(([n]) => n === 'bdj.putImageData').map((c) => c.slice(2))).toEqual([[0, 0, 5, 6, 3, 3]]);
  });

  it('after a resize (a rotation), draws the plane in the new video rectangle (Review Focus 1)', () => {
    const { calls, compositor, bdjCanvas, main } = fake(1920, 1080);
    const { reader } = menu();
    compositor.drawBdj(reader);
    expect(calls.at(-1)).toEqual(['main.drawImage', bdjCanvas, 0, 0, 1920, 1080, 0, 0, 1920, 1080]);
    compositor.resize(390, 844); // a phone turned to portrait
    expect([main.width, main.height]).toEqual([390, 844]);
    compositor.drawBdj(reader);
    const r = fitRect(1920, 1080, 390, 844);
    expect(calls.at(-1)).toEqual(['main.drawImage', bdjCanvas, 0, 0, 1920, 1080, r.x, r.y, r.width, r.height]);
    // the rectangle a 16:9 video frame is drawn in, and the one taps map through (ui/pointer.ts)
    const frame = { displayWidth: 1920, displayHeight: 1080, codedWidth: 1920, codedHeight: 1080 } as VideoFrame;
    compositor.drawVideo(frame);
    expect(calls.at(-1)).toEqual(['main.drawImage', frame, r.x, r.y, r.width, r.height]);
  });

  it('scales a smaller plane (1280×720) from its top-left pixels to the whole rectangle', () => {
    const { calls, compositor, bdjCanvas } = fake(1920, 1080);
    const buffer = createGraphicsPlane();
    const writer = new GraphicsPlaneWriter(buffer);
    updateGraphic(writer, 1280, 720, null, 0, 0, 0, 0);
    updateGraphic(writer, 1280, 720, new Int32Array(1280 * 720).fill(-1), 0, 0, 0, 0);
    compositor.drawBdj(new GraphicsPlaneReader(buffer));
    expect(calls.at(-1)).toEqual(['main.drawImage', bdjCanvas, 0, 0, 1280, 720, 0, 0, 1920, 1080]);
  });

  it('while Java holds the plane, draws the cached picture at once and copies the update on a later draw', () => {
    const { calls, compositor, bdjCanvas } = fake(1920, 1080);
    const { writer, reader } = menu();
    compositor.drawBdj(reader);
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080), 1, 2, 3, 4);
    writer.lock();
    calls.length = 0;
    const t0 = performance.now();
    compositor.drawBdj(reader);
    expect(performance.now() - t0).toBeLessThan(5);
    expect(calls).toEqual([['main.drawImage', bdjCanvas, 0, 0, 1920, 1080, 0, 0, 1920, 1080]]);
    expect(reader.pending()).toBe(true);
    writer.unlock();
    calls.length = 0;
    compositor.drawBdj(reader);
    expect(calls.filter(([n]) => n === 'bdj.putImageData').map((c) => c.slice(2))).toEqual([[0, 0, 1, 2, 3, 3]]);
  });

  it('draws nothing for an empty or closed plane, and clearBdj frees the canvas, made again for the next plane', () => {
    const { calls, compositor, bdjCanvas, created } = fake(1920, 1080);
    const { writer, reader } = menu();
    updateGraphic(writer, 1920, 1080, new Int32Array(1920 * 1080), 100, 200, 109, 204);
    compositor.drawBdj(reader);
    expect(calls.some(([n]) => n === 'main.drawImage')).toBe(false);
    const other = menu();
    compositor.drawBdj(other.reader);
    expect(calls.filter(([n]) => n === 'main.drawImage')).toHaveLength(1);
    expect(created).toHaveLength(1);
    compositor.clearBdj();
    expect([bdjCanvas.width, bdjCanvas.height]).toEqual([0, 0]);
    updateGraphic(other.writer, 0, 0, null, 0, 0, 0, 0);
    calls.length = 0;
    compositor.drawBdj(other.reader);
    expect(created).toHaveLength(2);
    expect(calls.some(([n]) => n === 'main.drawImage')).toBe(false);
  });
});

describe('Compositor background still (BD-J displayImage)', () => {
  function fake(width: number, height: number) {
    const calls: Array<[string, ...unknown[]]> = [];
    const mainCtx = new Proxy({}, { get: (_t, prop: string) => (...args: unknown[]) => calls.push([`main.${prop}`, ...args]) });
    const main = { width, height, getContext: () => mainCtx } as unknown as OffscreenCanvas;
    return { calls, compositor: new Compositor(main, () => ({}) as OffscreenCanvas) };
  }
  const frame = { displayWidth: 1440, displayHeight: 1080, codedWidth: 1440, codedHeight: 1080 } as unknown as VideoFrame;
  const image = { still: true } as unknown as ImageBitmap;

  it('draws the still in its part of the 16:9 screen rectangle, after the black fill and before the video', () => {
    const { calls, compositor } = fake(1000, 1000);
    compositor.setBackground({ image, rect: { x: 0.5, y: 0.25, width: 0.5, height: 0.5 } });
    compositor.drawVideo(null);
    // 16:9 in 1000×1000 is (0, 218) 1000×563
    expect(calls).toEqual([['main.fillRect', 0, 0, 1000, 1000], ['main.drawImage', image, 500, 218 + 563 * 0.25, 500, 563 * 0.5]]);
    // the 4:3 frame (pillarboxed at 240..1680 of 1920×1080) leaves the right of the still showing: still first, then video
    const wide = fake(1920, 1080);
    wide.compositor.setBackground({ image, rect: { x: 0.5, y: 0.25, width: 0.5, height: 0.5 } });
    wide.compositor.drawVideo(frame);
    expect(wide.calls.map(([n]) => n)).toEqual(['main.fillRect', 'main.drawImage', 'main.drawImage']);
    expect(wide.calls[1]).toEqual(['main.drawImage', image, 960, 270, 960, 540]);
    expect(wide.calls[2]).toEqual(['main.drawImage', frame, 240, 0, 1440, 1080]);
  });

  it('shows with no video (a menu without a playlist), and not after it is cleared', () => {
    const { calls, compositor } = fake(1920, 1080);
    compositor.setBackground({ image, rect: { x: 0, y: 0, width: 1, height: 1 } });
    compositor.drawVideo(null);
    expect(calls.filter(([n]) => n === 'main.drawImage')).toEqual([['main.drawImage', image, 0, 0, 1920, 1080]]);
    calls.length = 0;
    compositor.setBackground(null);
    compositor.drawVideo(null);
    expect(calls.map(([n]) => n)).toEqual(['main.fillRect']);
  });

  it('draws nothing for an empty rectangle', () => {
    const { calls, compositor } = fake(1920, 1080);
    compositor.setBackground({ image, rect: { x: 0, y: 0, width: 0, height: 1 } });
    compositor.drawVideo(null);
    expect(calls.map(([n]) => n)).toEqual(['main.fillRect']);
  });

  it('skips the still where a frame covers it (a full-screen feature over a full-screen still)', () => {
    const { calls, compositor } = fake(1920, 1080);
    const hd = { displayWidth: 1920, displayHeight: 1080, codedWidth: 1920, codedHeight: 1080 } as unknown as VideoFrame;
    compositor.setBackground({ image, rect: { x: 0, y: 0, width: 1, height: 1 } });
    compositor.drawVideo(hd);
    expect(calls.filter(([n]) => n === 'main.drawImage')).toEqual([['main.drawImage', hd, 0, 0, 1920, 1080]]);
    // a pillarboxed 4:3 frame leaves the sides of the still showing
    calls.length = 0;
    compositor.drawVideo(frame);
    expect(calls.filter(([n]) => n === 'main.drawImage').map(([, src]) => src)).toEqual([image, frame]);
  });
});
