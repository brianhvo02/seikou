// SPDX-License-Identifier: LGPL-3.0-or-later
// The compositor drawing BD-J's graphics plane (moved out of the engine package's render/compositor.test.ts: the plane is
// BD-J's, and the engine package names no BD-J module).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Compositor, fitRect } from '@seikou/engine/render/compositor';
import { GraphicsPlaneReader, GraphicsPlaneWriter, createGraphicsPlane, updateGraphic } from './graphics-plane';

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
