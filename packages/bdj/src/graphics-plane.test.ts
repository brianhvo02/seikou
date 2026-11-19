import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphicsPlaneReader, GraphicsPlaneWriter, PLANE_HEIGHT, PLANE_WIDTH, createGraphicsPlane, updateGraphic } from './graphics-plane';

/** A plain RGBA ImageData stand-in (Node has none). */
const image = (): ImageData => ({ data: new Uint8ClampedArray(PLANE_WIDTH * PLANE_HEIGHT * 4), width: PLANE_WIDTH, height: PLANE_HEIGHT, colorSpace: 'srgb' }) as ImageData;

function plane(): { writer: GraphicsPlaneWriter; reader: GraphicsPlaneReader; pixels: Int32Array } {
  const buffer = createGraphicsPlane();
  const reader = new GraphicsPlaneReader(buffer);
  return { writer: new GraphicsPlaneWriter(buffer), reader, pixels: new Int32Array(buffer, buffer.byteLength - PLANE_WIDTH * PLANE_HEIGHT * 4) };
}

/** Java's back buffer: width × height, every pixel `fill`. */
const backBuffer = (width: number, height: number, fill: number): Int32Array => new Int32Array(width * height).fill(fill);

/** The plane pixels that are not 0, as "x,y" keys. */
function drawn(pixels: Int32Array): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < pixels.length; i++) if (pixels[i] !== 0) out.add(`${i % PLANE_WIDTH},${Math.floor(i / PLANE_WIDTH)}`);
  return out;
}

/** The harness's hash (tools/bdj-trace/README.md, Planes), over the plane's bytes as stored (little-endian words). */
function referenceHash(pixels: Int32Array): string {
  const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

describe('updateGraphic (updateGraphicN → _updateGraphic → bdpriv_bdj_osd_cb)', () => {
  it('writes exactly the dirty rect, taking rows `width` apart from the back buffer', () => {
    const { writer, pixels } = plane();
    const src = new Int32Array(1280 * 720);
    for (let i = 0; i < src.length; i++) src[i] = (0xff000000 | i) | 0;
    updateGraphic(writer, 1280, 720, null, 0, 0, 0, 0);
    updateGraphic(writer, 1280, 720, src, 10, 20, 13, 22);
    const keys = drawn(pixels);
    expect(keys.size).toBe(4 * 3);
    for (let y = 20; y <= 22; y++) for (let x = 10; x <= 13; x++) expect(pixels[y * PLANE_WIDTH + x]).toBe(src[y * 1280 + x]);
  });

  it("clips the rect to the plane as _updateGraphic clips to the application's buffer", () => {
    const { writer, reader, pixels } = plane();
    updateGraphic(writer, 1920, 1080, null, 0, 0, 0, 0);
    reader.copyDirtyInto(image());
    updateGraphic(writer, 1920, 1080, backBuffer(1920, 1080, -1), 1900, 1070, 2000, 1200);
    expect(drawn(pixels).size).toBe(20 * 10);
    expect(reader.copyDirtyInto(image())).toEqual({ x: 1900, y: 1070, width: 20, height: 10 });
  });

  it('ignores an empty or negative rect (nothing to draw), and a null image opens (w, h > 0) or closes the plane', () => {
    const { writer, reader } = plane();
    updateGraphic(writer, 1920, 1080, null, 0, 0, 0, 0);
    expect(reader.size()).toEqual({ width: 1920, height: 1080 });
    const flushes = reader.flushCount();
    updateGraphic(writer, 1920, 1080, backBuffer(1920, 1080, -1), 5, 5, 4, 9);
    updateGraphic(writer, 1920, 1080, backBuffer(1920, 1080, -1), 5, 5, 9, 4);
    updateGraphic(writer, 1920, 1080, backBuffer(1920, 1080, -1), -9, -9, -1, -1);
    expect(reader.flushCount()).toBe(flushes);
    expect(reader.visible()).toBe(false);
    updateGraphic(writer, 0, 0, null, 0, 0, 0, 0);
    expect(reader.size()).toEqual({ width: 0, height: 0 });
  });

  it('stops the copy at the end of a short back buffer (the array access error), keeping the rows before it', () => {
    const { writer, pixels } = plane();
    updateGraphic(writer, 100, 100, backBuffer(100, 50, -1), 0, 0, 9, 99);
    expect(drawn(pixels).size).toBe(10 * 50);
  });
});

describe('GraphicsPlaneWriter / GraphicsPlaneReader', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows nothing to the reader until flush', () => {
    const { writer, reader } = plane();
    writer.init(1920, 1080);
    const img = image();
    reader.copyDirtyInto(img);
    const version = reader.version();
    writer.draw(backBuffer(1920, 1080, 0x80102030), 1920, 2, 3, 4, 5);
    expect(reader.pending()).toBe(false);
    expect(reader.copyDirtyInto(img)).toBeNull();
    expect(reader.flushCount()).toBe(0);
    expect(reader.visible()).toBe(false);
    expect(reader.version()).toBe(version);
    writer.flush();
    expect(reader.pending()).toBe(true);
    expect(reader.flushCount()).toBe(1);
    expect(reader.visible()).toBe(true);
    expect(reader.copyDirtyInto(img)).toEqual({ x: 2, y: 3, width: 3, height: 3 });
    const at = (3 * PLANE_WIDTH + 2) * 4;
    expect([...img.data.subarray(at, at + 4)]).toEqual([0x10, 0x20, 0x30, 0x80]); // ARGB → RGBA, not premultiplied
    expect(reader.pending()).toBe(false);
    expect(reader.copyDirtyInto(img)).toBeNull();
  });

  it('collects the flushed rects until the reader takes them', () => {
    const { writer, reader } = plane();
    writer.init(1920, 1080);
    reader.copyDirtyInto(image());
    const src = backBuffer(1920, 1080, -1);
    writer.draw(src, 1920, 10, 10, 10, 10);
    writer.flush();
    writer.draw(src, 1920, 30, 5, 31, 6);
    writer.flush();
    expect(reader.copyDirtyInto(image())).toEqual({ x: 10, y: 5, width: 22, height: 6 });
  });

  it('visible() turns false when the disc clears the plane, by drawing transparent pixels or by closing it', () => {
    const { writer, reader } = plane();
    updateGraphic(writer, 1920, 1080, null, 0, 0, 0, 0);
    const java = backBuffer(1920, 1080, 0);
    java.fill(0xff00ff00 | 0, 100, 200);
    updateGraphic(writer, 1920, 1080, java, 100, 0, 199, 0);
    expect(reader.visible()).toBe(true);
    java.fill(0x00ffffff, 100, 150); // alpha 0, colour left in
    updateGraphic(writer, 1920, 1080, java, 100, 0, 149, 0);
    expect(reader.visible()).toBe(true);
    java.fill(0, 150, 200);
    updateGraphic(writer, 1920, 1080, java, 150, 0, 199, 0);
    expect(reader.visible()).toBe(false);
    updateGraphic(writer, 1920, 1080, java.fill(-1), 0, 0, 0, 0);
    expect(reader.visible()).toBe(true);
    updateGraphic(writer, 0, 0, null, 0, 0, 0, 0);
    expect(reader.visible()).toBe(false);
    expect(reader.pending()).toBe(true); // the close clears what the reader shows
    expect(reader.copyDirtyInto(image())).toEqual({ x: 0, y: 0, width: PLANE_WIDTH, height: PLANE_HEIGHT });
  });

  it('init clears the plane, and a smaller plane keeps its pixels at the top left', () => {
    const { writer, reader, pixels } = plane();
    updateGraphic(writer, 1920, 1080, null, 0, 0, 0, 0);
    updateGraphic(writer, 1920, 1080, backBuffer(1920, 1080, -1), 0, 0, 1919, 1079);
    updateGraphic(writer, 1280, 720, null, 0, 0, 0, 0);
    expect(drawn(pixels).size).toBe(0);
    updateGraphic(writer, 1280, 720, backBuffer(1280, 720, -1), 1279, 719, 1279, 719);
    expect(pixels[719 * PLANE_WIDTH + 1279]).toBe(-1);
    expect(reader.size()).toEqual({ width: 1280, height: 720 });
  });

  it('copies everything with `all`, for a reader that has not drawn this plane yet', () => {
    const { writer, reader } = plane();
    updateGraphic(writer, 1920, 1080, null, 0, 0, 0, 0);
    updateGraphic(writer, 1920, 1080, backBuffer(1920, 1080, -1), 0, 0, 0, 0);
    reader.copyDirtyInto(image());
    expect(reader.copyDirtyInto(image(), true)).toEqual({ x: 0, y: 0, width: PLANE_WIDTH, height: PLANE_HEIGHT });
  });

  it("hashes the plane as tools/bdj-trace does (FNV-1a 32 over the words' little-endian bytes)", () => {
    const { writer, reader, pixels } = plane();
    const empty = reader.hash();
    expect(empty).toBe(referenceHash(pixels));
    expect(empty).toMatch(/^[0-9a-f]{8}$/);
    const java = new Int32Array(1920 * 1080);
    for (let i = 0; i < java.length; i += 7) java[i] = (i * 2654435761) | 0;
    updateGraphic(writer, 1920, 1080, null, 0, 0, 0, 0);
    updateGraphic(writer, 1920, 1080, java, 0, 0, 1919, 1079);
    const h = reader.hash();
    expect(h).not.toBe(empty);
    expect(h).toBe(referenceHash(pixels));
    updateGraphic(writer, 0, 0, null, 0, 0, 0, 0);
    expect(reader.hash()).toBe(empty);
  });

  it('the reader gives up at once on a plane the writer holds, and the update stays pending for its next copy', () => {
    const { writer, reader } = plane();
    writer.init(1920, 1080);
    const img = image();
    writer.lock();
    const wait = vi.spyOn(Atomics, 'wait');
    const t0 = performance.now();
    expect(reader.copyDirtyInto(img)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(5);
    expect(wait).not.toHaveBeenCalled();
    expect(reader.pending()).toBe(true);
    writer.unlock();
    expect(reader.copyDirtyInto(img)).toEqual({ x: 0, y: 0, width: PLANE_WIDTH, height: PLANE_HEIGHT });
  });

  it('copiedVersion is the version a copy took: unchanged by a copy that waited for the writer or found nothing', () => {
    const { writer, reader } = plane();
    const img = image();
    expect(reader.copiedVersion()).toBe(-1);
    writer.init(1920, 1080);
    writer.lock();
    expect(reader.copyDirtyInto(img)).toBeNull();
    expect(reader.copiedVersion()).toBe(-1);
    writer.unlock();
    reader.copyDirtyInto(img);
    expect(reader.copiedVersion()).toBe(reader.version());
    const first = reader.version();
    updateGraphic(writer, 1920, 1080, backBuffer(1920, 1080, -1), 0, 0, 9, 9);
    writer.flush(); // a flush with nothing drawn since publishes no area
    expect(reader.version()).toBe(first + 2);
    reader.copyDirtyInto(img);
    expect(reader.copiedVersion()).toBe(first + 2);
    expect(reader.copyDirtyInto(img)).toBeNull();
    expect(reader.copiedVersion()).toBe(first + 2);
  });

  it('with nothing pending, the reader returns without touching the lock, even while the writer holds it', () => {
    const { writer, reader } = plane();
    writer.init(1920, 1080);
    const img = image();
    reader.copyDirtyInto(img);
    writer.lock();
    const cas = vi.spyOn(Atomics, 'compareExchange');
    expect(reader.copyDirtyInto(img)).toBeNull();
    expect(cas).not.toHaveBeenCalled();
    writer.unlock();
  });
});
