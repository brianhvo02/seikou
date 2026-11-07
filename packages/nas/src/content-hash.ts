/**
 * TheDiscDB's ContentHash of a disc, written from TheDiscDb/web's HashingExtensions.CalculateHash and the order its
 * HashDisc mutation hashes files in (see NOTICE): the MD5 of each `.m2ts` size as an int64 little-endian, in name
 * order, as uppercase hex. Node's crypto isn't available to the engine, so the MD5 (RFC 1321) is here too.
 */

/** Per-round left rotations, RFC 1321 §3.4. */
const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
/** K[i] = floor(abs(sin(i + 1)) * 2^32). */
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

/** The MD5 digest of `bytes` as uppercase hex. */
export function md5Hex(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLength >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLength / 2 ** 32), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(block + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const sum = (a + f + K[i]! + m[g]!) >>> 0;
      const s = SHIFTS[(i >> 4) * 4 + (i & 3)]!;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((word, i) => out.setUint32(i * 4, word, true));
  return Array.from(new Uint8Array(out.buffer), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/**
 * TheDiscDB's ContentHash of a disc's BDMV/STREAM files: null when there are no `.m2ts` files. Names are ordered by
 * the code units of the upper-cased name (the reference orders by name; clip names are digits). Throws a RangeError for
 * a size that isn't a safe non-negative integer.
 */
export function contentHash(streams: readonly { name: string; size: number }[]): string | null {
  for (const { name, size } of streams) if (!Number.isSafeInteger(size) || size < 0) throw new RangeError(`bad size ${size} for ${name}`);
  const clips = streams
    .filter((s) => s.name.toUpperCase().endsWith('.M2TS'))
    .map((s) => ({ key: s.name.toUpperCase(), size: s.size }))
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  if (clips.length === 0) return null;
  const bytes = new Uint8Array(clips.length * 8);
  const view = new DataView(bytes.buffer);
  clips.forEach(({ size }, i) => {
    view.setUint32(i * 8, size % 2 ** 32, true);
    view.setUint32(i * 8 + 4, Math.floor(size / 2 ** 32), true);
  });
  return md5Hex(bytes);
}
