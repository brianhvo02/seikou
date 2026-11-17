/** The PNGs the ASS harness writes and the pixel tests read: 8-bit RGBA, not interlaced (and 8-bit RGB or grayscale to read). */
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  return new Uint8Array(Buffer.concat([Buffer.from(SIGNATURE), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]));
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!SIGNATURE.every((v, i) => buf[i] === v)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let bpp = 4;
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || (data[9] !== 6 && data[9] !== 2 && data[9] !== 0) || data[12] !== 0) throw new Error('only 8-bit RGB, RGBA or grayscale, non-interlaced PNGs are supported');
      bpp = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 1;
    } else if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? pixels[y * stride + x - bpp]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp]! : 0;
      const pred = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : NaN;
      if (Number.isNaN(pred)) throw new Error(`bad PNG filter ${filter}`);
      pixels[y * stride + x] = (line[x]! + pred) & 0xff;
    }
  }
  if (bpp === 4) return { width, height, rgba: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += bpp, j += 4) {
    rgba[j] = pixels[i]!;
    rgba[j + 1] = pixels[i + (bpp === 3 ? 1 : 0)]!;
    rgba[j + 2] = pixels[i + (bpp === 3 ? 2 : 0)]!;
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}
