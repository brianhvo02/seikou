import { describe, expect, it } from 'vitest';
import { BackgroundStill, encodedImageSize, type ShownStill } from './background';

/** A stand-in ImageBitmap that records its close. */
function fakeBitmap(name: string, width = 1920, height = 1080): ImageBitmap & { closed: boolean; name: string } {
  const b = { name, width, height, closed: false, close: () => void (b.closed = true) };
  return b as unknown as ImageBitmap & { closed: boolean; name: string };
}

/** A decoder whose decodes the test settles by hand, in any order. */
function manualDecoder() {
  const pending: { bytes: Uint8Array; resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }[] = [];
  const decode = (bytes: Uint8Array): Promise<ImageBitmap> => new Promise((resolve, reject) => pending.push({ bytes, resolve, reject }));
  return { decode, pending };
}

const FULL = { x: 0, y: 0, width: 1, height: 1 };
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('BackgroundStill', () => {
  it('shows a decoded still and closes it when a newer one replaces it', async () => {
    const { decode, pending } = manualDecoder();
    const changes: (ShownStill | null)[] = [];
    const bg = new BackgroundStill({ decode, onChange: (s) => changes.push(s) });
    bg.show(new Uint8Array([1]), FULL);
    expect(pending[0]!.bytes).toEqual(new Uint8Array([1]));
    const a = fakeBitmap('a');
    pending[0]!.resolve(a);
    await flush();
    expect(changes).toEqual([{ image: a, rect: FULL }]);
    expect(bg.current?.image).toBe(a);

    bg.show(new Uint8Array([2]), { x: 0.25, y: 0, width: 0.5, height: 1 });
    await flush();
    expect(a.closed).toBe(false); // still shown while the new one decodes
    const b = fakeBitmap('b');
    pending[1]!.resolve(b);
    await flush();
    expect(changes.at(-1)).toEqual({ image: b, rect: { x: 0.25, y: 0, width: 0.5, height: 1 } });
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
  });

  it('closes a decode that finishes after a newer still or a clear, without showing it', async () => {
    const { decode, pending } = manualDecoder();
    const changes: (ShownStill | null)[] = [];
    const bg = new BackgroundStill({ decode, onChange: (s) => changes.push(s) });
    bg.show(new Uint8Array([1]), FULL);
    bg.show(new Uint8Array([2]), FULL);
    const second = fakeBitmap('second');
    pending[1]!.resolve(second);
    const first = fakeBitmap('first');
    pending[0]!.resolve(first);
    await flush();
    expect(changes).toEqual([{ image: second, rect: FULL }]);
    expect(first.closed).toBe(true);

    bg.show(new Uint8Array([3]), FULL);
    bg.clear();
    const third = fakeBitmap('third');
    pending[2]!.resolve(third);
    await flush();
    expect(third.closed).toBe(true);
    expect(second.closed).toBe(true);
    expect(changes.at(-1)).toBeNull();
    expect(bg.current).toBeNull();
  });

  it('clear tells the compositor before closing the bitmap, and clearing nothing is silent', async () => {
    const { decode, pending } = manualDecoder();
    const log: string[] = [];
    const bg = new BackgroundStill({ decode, onChange: (s) => log.push(s ? 'show' : 'hide') });
    bg.clear();
    expect(log).toEqual([]);
    bg.show(new Uint8Array([1]), FULL);
    const a = fakeBitmap('a');
    const close = a.close.bind(a);
    a.close = () => {
      log.push('close');
      close();
    };
    pending[0]!.resolve(a);
    await flush();
    bg.clear();
    expect(log).toEqual(['show', 'hide', 'close']);
  });

  it('a still that cannot be decoded clears the background and is reported', async () => {
    const { decode, pending } = manualDecoder();
    const errors: string[] = [];
    const changes: (ShownStill | null)[] = [];
    const bg = new BackgroundStill({ decode, onChange: (s) => changes.push(s), onError: (m) => errors.push(m) });
    bg.show(new Uint8Array([1]), FULL);
    const a = fakeBitmap('a');
    pending[0]!.resolve(a);
    await flush();
    bg.show(new Uint8Array([0xde, 0xad]), FULL);
    pending[1]!.reject(new Error('not an image'));
    await flush();
    expect(errors).toEqual(['a background image could not be decoded: not an image']);
    expect(changes.at(-1)).toBeNull();
    expect(a.closed).toBe(true);
  });

  it('a decoder that throws at once is a failed decode', async () => {
    const errors: string[] = [];
    const bg = new BackgroundStill({
      decode: () => {
        throw new Error('no decoder');
      },
      onChange: () => undefined,
      onError: (m) => errors.push(m),
    });
    bg.show(new Uint8Array([1]), FULL);
    await flush();
    expect(errors).toEqual(['a background image could not be decoded: no decoder']);
  });

  it('a rectangle with non-finite fields falls back to the whole screen in those fields', async () => {
    const { decode, pending } = manualDecoder();
    const bg = new BackgroundStill({ decode, onChange: () => undefined });
    bg.show(new Uint8Array([1]), { x: Number.NaN, y: 0.5, width: Number.POSITIVE_INFINITY, height: 0.5 });
    pending[0]!.resolve(fakeBitmap('a'));
    await flush();
    expect(bg.current?.rect).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 });
  });

  it('a still over the memory budget is not shown, by its header or once decoded', async () => {
    const { decode, pending } = manualDecoder();
    const changes: (ShownStill | null)[] = [];
    const errors: string[] = [];
    const bg = new BackgroundStill({ decode, onChange: (s) => changes.push(s), onError: (m) => errors.push(m), maxDecodedBytes: () => 16 * 1024 * 1024 });
    bg.show(png(4000, 3000), FULL);
    expect(pending).toHaveLength(0); // never decoded
    expect(errors).toEqual(['a 4000x3000 background image (45.8 MB decoded) is over the memory budget of 16.0 MB']);
    bg.show(new Uint8Array([1]), FULL); // no size in its header
    const big = fakeBitmap('big', 4000, 3000);
    pending[0]!.resolve(big);
    await flush();
    expect(big.closed).toBe(true);
    expect(changes).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(bg.decodedBytes).toBe(0);
  });

  it('two 1080p stills fit the constrained budget while one replaces the other; bigger ones replace the shown one first', async () => {
    const { decode, pending } = manualDecoder();
    const changes: (ShownStill | null)[] = [];
    const bg = new BackgroundStill({ decode, onChange: (s) => changes.push(s), maxDecodedBytes: () => 16 * 1024 * 1024 });
    bg.show(png(1920, 1080), FULL);
    const a = fakeBitmap('a');
    pending[0]!.resolve(a);
    await flush();
    bg.show(png(1920, 1080), FULL);
    expect(bg.decodedBytes).toBe(2 * 1920 * 1080 * 4);
    expect(a.closed).toBe(false); // shown until the new one is decoded
    const b = fakeBitmap('b');
    pending[1]!.resolve(b);
    await flush();
    expect(a.closed).toBe(true);
    bg.show(png(1920, 1600), FULL);
    expect(b.closed).toBe(true); // both would not fit
    expect(changes.at(-1)).toBeNull();
    expect(bg.decodedBytes).toBe(1920 * 1600 * 4);
  });

  it('reads the size a PNG, GIF or JPEG header declares', () => {
    expect(encodedImageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(encodedImageSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x80, 0x07, 0x38, 0x04]))).toEqual({ width: 1920, height: 1080 });
    // SOI, an APP0 segment of 4 bytes, then SOF2 (progressive): length, precision, height, width
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03]);
    expect(encodedImageSize(jpeg)).toEqual({ width: 1920, height: 1080 });
    expect(encodedImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x02]))).toBeNull();
    expect(encodedImageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

/** The start of a PNG: the signature and an IHDR chunk declaring this size. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}
