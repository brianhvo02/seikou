import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from './png';

describe('png', () => {
  it('round-trips RGBA exactly', () => {
    const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) & 0xff);
    const out = decodePng(encodePng(3, 2, rgba));
    expect(out.width).toBe(3);
    expect(out.height).toBe(2);
    expect([...out.rgba]).toEqual([...rgba]);
  });

  it('decodes 8-bit RGB (as Chrome screenshots opaque content) to opaque RGBA', () => {
    const png = encodePng(2, 2, new Uint8Array(16));
    png[25] = 2; // colour type RGB
    // Rows: filter 0 then 1 (Sub), three bytes per pixel.
    const raw = Buffer.from([0, 10, 20, 30, 40, 50, 60, 1, 5, 6, 7, 1, 1, 1]);
    const ihdrEnd = 8 + 12 + 13;
    const idat = deflateSync(raw);
    const chunk = Buffer.alloc(12 + idat.length);
    chunk.writeUInt32BE(idat.length, 0);
    chunk.write('IDAT', 4, 'latin1');
    idat.copy(chunk, 8);
    const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const out = decodePng(new Uint8Array(Buffer.concat([Buffer.from(png.subarray(0, ihdrEnd)), chunk, iend])));
    expect([...out.rgba]).toEqual([10, 20, 30, 255, 40, 50, 60, 255, 5, 6, 7, 255, 6, 7, 8, 255]);
  });

  it('decodes 8-bit greyscale (the deinterlacing references) to opaque grey RGBA', () => {
    const png = encodePng(2, 1, new Uint8Array(8));
    png[25] = 0; // colour type greyscale
    const raw = Buffer.from([1, 16, 219]); // filter 1 (Sub): 16, then 16 + 219
    const ihdrEnd = 8 + 12 + 13;
    const idat = deflateSync(raw);
    const chunk = Buffer.alloc(12 + idat.length);
    chunk.writeUInt32BE(idat.length, 0);
    chunk.write('IDAT', 4, 'latin1');
    idat.copy(chunk, 8);
    const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const out = decodePng(new Uint8Array(Buffer.concat([Buffer.from(png.subarray(0, ihdrEnd)), chunk, iend])));
    expect([...out.rgba]).toEqual([16, 16, 16, 255, 235, 235, 235, 255]);
  });

  it('rejects anything that is not 8-bit RGB, RGBA or greyscale', () => {
    const png = encodePng(1, 1, new Uint8Array(4));
    png[25] = 4; // colour type greyscale with alpha
    expect(() => decodePng(png)).toThrow(/RGBA/);
  });
});
