import { afterEach, describe, expect, it, vi } from 'vitest';
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
