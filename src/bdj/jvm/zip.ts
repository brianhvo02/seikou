/*
 * Original code for bluray-web: jar (zip) reading and RFC 1951 inflate.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

export class ZipError extends Error {}

export interface ZipEntry {
  readonly name: string;
  readonly nameBytes: Uint8Array;
  /** 0 (stored) and 8 (deflated) can be read; others are listed but read() rejects them. */
  readonly method: number;
  /** The general-purpose bit flag. */
  readonly flag: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly crc: number;
  readonly localHeaderOffset: number;
  readonly time: number;
  /** MS-DOS date and time, (date << 16) | time, unsigned. */
  readonly dosTime: number;
  readonly extra: Uint8Array;
  readonly comment: Uint8Array;
}

/** Slicing-by-4 tables: CRC_TABLES[k][b] is the CRC of b followed by k zero bytes. */
const CRC_TABLES = (() => {
  const t = Array.from({ length: 4 }, () => new Int32Array(256));
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[0]![n] = c;
  }
  for (let n = 0; n < 256; n++) for (let k = 1; k < 4; k++) t[k]![n] = t[0]![t[k - 1]![n]! & 0xff]! ^ (t[k - 1]![n]! >>> 8);
  return t;
})();
const CRC_TABLE = CRC_TABLES[0]!;

export function adler32(data: Uint8Array, start = 0, end = data.length, seed = 1): number {
  let a = seed & 0xffff;
  let b = seed >>> 16;
  for (let i = start; i < end; ) {
    const stop = Math.min(end, i + 3800);
    for (; i < stop; i++) {
      a += data[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export function crc32(data: Uint8Array, start = 0, end = data.length, seed = 0): number {
  const [t0, t1, t2, t3] = CRC_TABLES as [Int32Array, Int32Array, Int32Array, Int32Array];
  let c = ~seed;
  let i = start;
  for (; i + 4 <= end; i += 4) {
    c ^= data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24);
    c = t3[c & 0xff]! ^ t2[(c >>> 8) & 0xff]! ^ t1[(c >>> 16) & 0xff]! ^ t0[c >>> 24]!;
  }
  for (; i < end; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

export interface InflateCoroutine {
  push(input: Uint8Array): void;
  /** Writes up to out.length bytes; returns bytes written. */
  pull(out: Uint8Array, offset: number, length: number): number;
  readonly finished: boolean;
  readonly needsInput: boolean;
  /** Bytes of pushed input not consumed (valid after finished). */
  readonly remaining: number;
}

const RING = 65536;
const RING_MASK = RING - 1;
// A match is at most 258 bytes, so decoding pauses well before the ring could overwrite unread output.
const PAUSE_AT = RING - 1024;

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Single-level lookup: index is the next maxLen bits (LSB first); entry is (symbol << 4) | codeLength, 0 if unused. */
interface Huffman {
  readonly table: Uint16Array;
  readonly mask: number;
  readonly maxLen: number;
}

function buildHuffman(lengths: ArrayLike<number>, n: number, allowIncomplete: boolean): Huffman {
  const count = new Uint16Array(16);
  let maxLen = 0;
  for (let i = 0; i < n; i++) {
    const l = lengths[i]!;
    count[l]!++;
    if (l > maxLen) maxLen = l;
  }
  count[0] = 0;
  if (maxLen === 0) return { table: new Uint16Array(1), mask: 0, maxLen: 0 };
  let left = 1;
  for (let l = 1; l <= 15; l++) {
    left = (left << 1) - count[l]!;
    if (left < 0) throw new ZipError('inflate: over-subscribed Huffman code');
  }
  if (left > 0 && !allowIncomplete) throw new ZipError('inflate: incomplete Huffman code');
  const next = new Uint16Array(16);
  for (let l = 1, code = 0; l <= 15; l++) {
    code = (code + count[l - 1]!) << 1;
    next[l] = code;
  }
  const size = 1 << maxLen;
  const table = new Uint16Array(size);
  for (let sym = 0; sym < n; sym++) {
    const l = lengths[sym]!;
    if (l === 0) continue;
    let code = next[l]!++;
    let rev = 0;
    for (let i = 0; i < l; i++, code >>= 1) rev = (rev << 1) | (code & 1);
    const entry = (sym << 4) | l;
    for (let k = rev; k < size; k += 1 << l) table[k] = entry;
  }
  return { table, mask: size - 1, maxLen };
}

const FIXED_LIT = (() => {
  const l = new Uint8Array(288);
  l.fill(8, 0, 144);
  l.fill(9, 144, 256);
  l.fill(7, 256, 280);
  l.fill(8, 280, 288);
  return buildHuffman(l, 288, false);
})();
const FIXED_DIST = buildHuffman(new Uint8Array(30).fill(5), 30, true);

export function inflateRaw(): InflateCoroutine {
  const ring = new Uint8Array(RING);
  let wpos = 0;
  let rpos = 0;
  let inBuf: Uint8Array = new Uint8Array(0);
  let inPos = 0;
  let inLen = 0;
  let bitbuf = 0;
  let bitcnt = 0;
  let waiting = true; // generator is blocked on input
  let done = false;
  let failure: unknown = null;

  function* getBits(n: number): Generator<void, number> {
    while (bitcnt < n) {
      if (inPos < inLen) {
        bitbuf |= inBuf[inPos++]! << bitcnt;
        bitcnt += 8;
      } else {
        waiting = true;
        yield;
      }
    }
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n;
    bitcnt -= n;
    return v;
  }

  function* getSymbol(h: Huffman): Generator<void, number> {
    for (;;) {
      while (bitcnt <= 24 && inPos < inLen) {
        bitbuf |= inBuf[inPos++]! << bitcnt;
        bitcnt += 8;
      }
      const e = h.table[bitbuf & h.mask]!;
      const l = e & 15;
      if (e !== 0 && l <= bitcnt) {
        bitbuf >>>= l;
        bitcnt -= l;
        return e >> 4;
      }
      if (bitcnt >= h.maxLen) throw new ZipError('inflate: invalid Huffman code');
      waiting = true;
      yield;
    }
  }

  function* readDynamic(): Generator<void, [Huffman, Huffman]> {
    const hlit = (yield* getBits(5)) + 257;
    const hdist = (yield* getBits(5)) + 1;
    const hclen = (yield* getBits(4)) + 4;
    if (hlit > 286 || hdist > 30) throw new ZipError('inflate: bad dynamic header');
    const cl = new Uint8Array(19);
    for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]!] = yield* getBits(3);
    const clHuff = buildHuffman(cl, 19, false);
    const lengths = new Uint8Array(hlit + hdist);
    for (let i = 0; i < hlit + hdist; ) {
      const sym = yield* getSymbol(clHuff);
      if (sym < 16) {
        lengths[i++] = sym;
        continue;
      }
      let rep: number;
      let val = 0;
      if (sym === 16) {
        if (i === 0) throw new ZipError('inflate: repeat with no previous length');
        val = lengths[i - 1]!;
        rep = 3 + (yield* getBits(2));
      } else if (sym === 17) rep = 3 + (yield* getBits(3));
      else rep = 11 + (yield* getBits(7));
      if (i + rep > hlit + hdist) throw new ZipError('inflate: too many code lengths');
      lengths.fill(val, i, i + rep);
      i += rep;
    }
    if (lengths[256] === 0) throw new ZipError('inflate: no end-of-block code');
    // zlib accepts an incomplete distance code only when it has a single code
    const lit = buildHuffman(lengths, hlit, false);
    const dist = buildHuffman(lengths.subarray(hlit), hdist, true);
    return [lit, dist];
  }

  function* run(): Generator<void, void> {
    for (let last = false; !last; ) {
      last = (yield* getBits(1)) === 1;
      const type = yield* getBits(2);
      if (type === 0) {
        bitbuf >>>= bitcnt & 7;
        bitcnt -= bitcnt & 7;
        const len = yield* getBits(16);
        const nlen = yield* getBits(16);
        if ((len ^ 0xffff) !== nlen) throw new ZipError('inflate: stored block length mismatch');
        let left = len;
        while (left > 0) {
          if (wpos - rpos >= PAUSE_AT) {
            waiting = false;
            yield;
            continue;
          }
          if (bitcnt >= 8) {
            ring[wpos++ & RING_MASK] = bitbuf & 0xff;
            bitbuf >>>= 8;
            bitcnt -= 8;
            left--;
          } else if (inPos < inLen) {
            const k = Math.min(left, inLen - inPos, PAUSE_AT - (wpos - rpos));
            for (let i = 0; i < k; i++) ring[wpos++ & RING_MASK] = inBuf[inPos++]!;
            left -= k;
          } else {
            waiting = true;
            yield;
          }
        }
        continue;
      }
      if (type === 3) throw new ZipError('inflate: invalid block type');
      let lit = FIXED_LIT;
      let dist = FIXED_DIST;
      if (type === 2) [lit, dist] = yield* readDynamic();
      const litTable = lit.table;
      const litMask = lit.mask;
      for (;;) {
        while (bitcnt <= 24 && inPos < inLen) {
          bitbuf |= inBuf[inPos++]! << bitcnt;
          bitcnt += 8;
        }
        const e = litTable[bitbuf & litMask]!;
        const l = e & 15;
        if (e === 0 || l > bitcnt) {
          if (e === 0 && bitcnt >= lit.maxLen) throw new ZipError('inflate: invalid literal/length code');
          waiting = true;
          yield;
          continue;
        }
        bitbuf >>>= l;
        bitcnt -= l;
        const sym = e >> 4;
        if (sym === 256) break;
        // Pausing only once a symbol that writes output is decoded, so end-of-block is never held back by a full ring.
        while (wpos - rpos >= PAUSE_AT) {
          waiting = false;
          yield;
        }
        if (sym < 256) {
          ring[wpos++ & RING_MASK] = sym;
          continue;
        }
        if (sym > 285) throw new ZipError('inflate: invalid length symbol');
        const li = sym - 257;
        const lx = LEN_EXTRA[li]!;
        let length = LEN_BASE[li]!;
        let ds: number;
        let d: number;
        if (inLen - inPos >= 6) {
          // The length's extra bits, the distance code and its extra bits take at most 33 bits: decode them here
          // rather than through the generators, which only matter when input can run out.
          while (bitcnt <= 24 && inPos < inLen) {
            bitbuf |= inBuf[inPos++]! << bitcnt;
            bitcnt += 8;
          }
          length += bitbuf & ((1 << lx) - 1);
          bitbuf >>>= lx;
          bitcnt -= lx;
          while (bitcnt <= 24 && inPos < inLen) {
            bitbuf |= inBuf[inPos++]! << bitcnt;
            bitcnt += 8;
          }
          const de = dist.table[bitbuf & dist.mask]!;
          if (de === 0) throw new ZipError('inflate: invalid Huffman code');
          bitbuf >>>= de & 15;
          bitcnt -= de & 15;
          ds = de >> 4;
          if (ds > 29) throw new ZipError('inflate: invalid distance symbol');
          const dx = DIST_EXTRA[ds]!;
          while (bitcnt <= 24 && inPos < inLen) {
            bitbuf |= inBuf[inPos++]! << bitcnt;
            bitcnt += 8;
          }
          d = DIST_BASE[ds]! + (bitbuf & ((1 << dx) - 1));
          bitbuf >>>= dx;
          bitcnt -= dx;
        } else {
          if (lx > 0) length += yield* getBits(lx);
          ds = yield* getSymbol(dist);
          if (ds > 29) throw new ZipError('inflate: invalid distance symbol');
          const dx = DIST_EXTRA[ds]!;
          d = DIST_BASE[ds]!;
          if (dx > 0) d += yield* getBits(dx);
        }
        if (d > wpos) throw new ZipError('inflate: distance too far back');
        let from = wpos - d;
        for (let i = 0; i < length; i++) ring[wpos++ & RING_MASK] = ring[from++ & RING_MASK]!;
      }
    }
    done = true;
  }

  const gen = run();

  return {
    push(input) {
      if (input.length === 0) return;
      if (inPos < inLen) {
        const merged = new Uint8Array(inLen - inPos + input.length);
        merged.set(inBuf.subarray(inPos, inLen));
        merged.set(input, inLen - inPos);
        inBuf = merged;
      } else inBuf = input.slice(); // callers such as the JDK Inflater refill their buffer after push
      inPos = 0;
      inLen = inBuf.length;
      waiting = false;
    },
    pull(out, offset, length) {
      if (failure) throw failure;
      let n = 0;
      for (;;) {
        const avail = wpos - rpos;
        if (avail > 0) {
          const k = Math.min(avail, length - n);
          const start = rpos & RING_MASK;
          const first = Math.min(k, RING - start);
          out.set(ring.subarray(start, start + first), offset + n);
          if (first < k) out.set(ring.subarray(0, k - first), offset + n + first);
          rpos += k;
          n += k;
          if (n === length) break;
        }
        if (done || waiting) break;
        try {
          gen.next();
        } catch (e) {
          failure = e;
          throw e;
        }
      }
      return n;
    },
    get finished() {
      return done && wpos === rpos;
    },
    get needsInput() {
      return !done && waiting && wpos === rpos;
    },
    get remaining() {
      // Like zlib's avail_in: prefetched whole bytes count as consumed until the stream ends, then those
      // from the current chunk are handed back (earlier chunks cannot be unread).
      return done ? inLen - inPos + Math.min(bitcnt >> 3, inPos) : inLen - inPos;
    },
  };
}

/**
 * Inflates a whole raw DEFLATE stream in one pass, straight into the output (matches copy from the output itself), for
 * zip entries read whole; inflateRaw's coroutine serves streams. Errors are inflateRaw's.
 */
export function inflateAll(data: Uint8Array, expectedSize?: number): Uint8Array {
  let out = new Uint8Array(expectedSize ?? Math.max(1024, data.length * 3));
  let n = 0;
  let pos = 0;
  let bitbuf = 0;
  let bitcnt = 0;
  const truncated = (): ZipError => new ZipError('inflate: truncated input');
  const tooBig = (): ZipError => new ZipError('inflate: output larger than expected');
  /** Room for `k` more output bytes, growing the output when its size is not known. */
  const room = (k: number): void => {
    if (n + k <= out.length) return;
    if (expectedSize !== undefined) throw tooBig();
    let size = out.length * 2;
    while (size < n + k) size *= 2;
    const bigger = new Uint8Array(size);
    bigger.set(out.subarray(0, n));
    out = bigger;
  };
  const bits = (k: number): number => {
    while (bitcnt < k) {
      if (pos >= data.length) throw truncated();
      bitbuf |= data[pos++]! << bitcnt;
      bitcnt += 8;
    }
    const v = bitbuf & ((1 << k) - 1);
    bitbuf >>>= k;
    bitcnt -= k;
    return v;
  };
  const symbol = (h: Huffman): number => {
    for (;;) {
      while (bitcnt <= 24 && pos < data.length) {
        bitbuf |= data[pos++]! << bitcnt;
        bitcnt += 8;
      }
      const e = h.table[bitbuf & h.mask]!;
      const l = e & 15;
      if (e !== 0 && l <= bitcnt) {
        bitbuf >>>= l;
        bitcnt -= l;
        return e >> 4;
      }
      if (bitcnt >= h.maxLen) throw new ZipError('inflate: invalid Huffman code');
      throw truncated();
    }
  };
  const dynamic = (): [Huffman, Huffman] => {
    const hlit = bits(5) + 257;
    const hdist = bits(5) + 1;
    const hclen = bits(4) + 4;
    if (hlit > 286 || hdist > 30) throw new ZipError('inflate: bad dynamic header');
    const cl = new Uint8Array(19);
    for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]!] = bits(3);
    const clHuff = buildHuffman(cl, 19, false);
    const lengths = new Uint8Array(hlit + hdist);
    for (let i = 0; i < hlit + hdist; ) {
      const sym = symbol(clHuff);
      if (sym < 16) {
        lengths[i++] = sym;
        continue;
      }
      let rep: number;
      let val = 0;
      if (sym === 16) {
        if (i === 0) throw new ZipError('inflate: repeat with no previous length');
        val = lengths[i - 1]!;
        rep = 3 + bits(2);
      } else if (sym === 17) rep = 3 + bits(3);
      else rep = 11 + bits(7);
      if (i + rep > hlit + hdist) throw new ZipError('inflate: too many code lengths');
      lengths.fill(val, i, i + rep);
      i += rep;
    }
    if (lengths[256] === 0) throw new ZipError('inflate: no end-of-block code');
    return [buildHuffman(lengths, hlit, false), buildHuffman(lengths.subarray(hlit), hdist, true)];
  };
  for (let last = false; !last; ) {
    last = bits(1) === 1;
    const type = bits(2);
    if (type === 0) {
      bitbuf >>>= bitcnt & 7;
      bitcnt -= bitcnt & 7;
      const len = bits(16);
      const nlen = bits(16);
      if ((len ^ 0xffff) !== nlen) throw new ZipError('inflate: stored block length mismatch');
      room(len);
      let left = len;
      while (left > 0 && bitcnt >= 8) {
        out[n++] = bitbuf & 0xff;
        bitbuf >>>= 8;
        bitcnt -= 8;
        left--;
      }
      if (pos + left > data.length) throw truncated();
      out.set(data.subarray(pos, pos + left), n);
      n += left;
      pos += left;
      continue;
    }
    if (type === 3) throw new ZipError('inflate: invalid block type');
    const [lit, dist] = type === 2 ? dynamic() : [FIXED_LIT, FIXED_DIST];
    const litTable = lit.table;
    const litMask = lit.mask;
    for (;;) {
      while (bitcnt <= 24 && pos < data.length) {
        bitbuf |= data[pos++]! << bitcnt;
        bitcnt += 8;
      }
      const e = litTable[bitbuf & litMask]!;
      const l = e & 15;
      if (e === 0 || l > bitcnt) {
        if (e === 0 && bitcnt >= lit.maxLen) throw new ZipError('inflate: invalid literal/length code');
        throw truncated();
      }
      bitbuf >>>= l;
      bitcnt -= l;
      const sym = e >> 4;
      if (sym < 256) {
        if (n === out.length) room(1);
        out[n++] = sym;
        continue;
      }
      if (sym === 256) break;
      if (sym > 285) throw new ZipError('inflate: invalid length symbol');
      const li = sym - 257;
      const lx = LEN_EXTRA[li]!;
      const length = LEN_BASE[li]! + (lx > 0 ? bits(lx) : 0);
      const ds = symbol(dist);
      if (ds > 29) throw new ZipError('inflate: invalid distance symbol');
      const dx = DIST_EXTRA[ds]!;
      const d = DIST_BASE[ds]! + (dx > 0 ? bits(dx) : 0);
      if (d > n) throw new ZipError('inflate: distance too far back');
      room(length);
      let from = n - d;
      if (d >= length) {
        out.copyWithin(n, from, from + length);
        n += length;
      } else {
        for (let i = 0; i < length; i++) out[n++] = out[from++]!;
      }
    }
  }
  if (expectedSize !== undefined && n !== expectedSize) throw new ZipError('inflate: output smaller than expected');
  return n === out.length ? out : out.slice(0, n);
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

export class ZipArchive {
  private constructor(
    /** The whole archive, which the archive keeps. */
    readonly bytes: Uint8Array,
    readonly entries: ReadonlyMap<string, ZipEntry>,
    readonly names: readonly string[],
    /** Every central-directory record in order, duplicates included. */
    readonly list: readonly ZipEntry[],
    readonly comment: Uint8Array,
  ) {}

  /** The archive starts with a local file header (not, for example, a self-extracting stub). */
  get startsWithLoc(): boolean {
    return this.bytes.length >= 4 && new DataView(this.bytes.buffer, this.bytes.byteOffset, 4).getUint32(0, true) === SIG_LOC;
  }

  /** The entry's stored bytes (compressed when deflated). */
  raw(entry: ZipEntry): Uint8Array {
    const start = this.dataOffset(entry);
    return this.bytes.subarray(start, start + entry.compressedSize);
  }

  static open(bytes: Uint8Array): ZipArchive {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    let eocd = -1;
    for (let i = bytes.length - 22, stop = Math.max(0, bytes.length - 22 - 65535); i >= stop; i--) {
      if (view.getUint32(i, true) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('zip: end of central directory not found');
    const count = view.getUint16(eocd + 10, true);
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('zip: zip64 is not supported');
    if (cdOffset + cdSize > eocd) throw new ZipError('zip: central directory out of range');
    const decoder = new TextDecoder('utf-8');
    const entries = new Map<string, ZipEntry>();
    const names: string[] = [];
    const list: ZipEntry[] = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > eocd || view.getUint32(p, true) !== SIG_CEN) throw new ZipError('zip: bad central directory record');
      const method = view.getUint16(p + 10, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const next = p + 46 + nameLen + extraLen + commentLen;
      if (next > eocd) throw new ZipError('zip: central directory record out of range');
      const dosTime = view.getUint16(p + 12, true);
      const dosDate = view.getUint16(p + 14, true);
      const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
      const name = decoder.decode(nameBytes);
      const entry: ZipEntry = {
        name,
        nameBytes,
        method,
        flag: view.getUint16(p + 8, true),
        compressedSize: view.getUint32(p + 20, true),
        size: view.getUint32(p + 24, true),
        crc: view.getUint32(p + 16, true),
        localHeaderOffset: view.getUint32(p + 42, true),
        time: Date.UTC(1980 + (dosDate >> 9), Math.max(0, ((dosDate >> 5) & 15) - 1), dosDate & 31 || 1, dosTime >> 11, (dosTime >> 5) & 63, (dosTime & 31) * 2),
        dosTime: ((dosDate << 16) | dosTime) >>> 0,
        extra: bytes.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen),
        comment: bytes.subarray(p + 46 + nameLen + extraLen, next),
      };
      list.push(entry);
      if (!entries.has(name)) names.push(name);
      entries.set(name, entry);
      p = next;
    }
    const commentLen = Math.min(view.getUint16(eocd + 20, true), bytes.length - eocd - 22);
    return new ZipArchive(bytes, entries, names, list, bytes.subarray(eocd + 22, eocd + 22 + commentLen));
  }

  dataOffset(entry: ZipEntry): number {
    const o = entry.localHeaderOffset;
    if (o + 30 > this.bytes.length) throw new ZipError('zip: local header out of range');
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.length);
    if (view.getUint32(o, true) !== SIG_LOC) throw new ZipError('zip: bad local header');
    const start = o + 30 + view.getUint16(o + 26, true) + view.getUint16(o + 28, true);
    if (start + entry.compressedSize > this.bytes.length) throw new ZipError('zip: entry data out of range');
    return start;
  }

  read(name: string): Uint8Array | null {
    const entry = this.entries.get(name);
    if (!entry) return null;
    if (entry.method !== 0 && entry.method !== 8) throw new ZipError(`zip: unsupported compression method ${entry.method}`);
    const raw = this.raw(entry);
    const data = entry.method === 0 ? raw.slice() : inflateAll(raw, entry.size);
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new ZipError(`zip: CRC mismatch in ${name}`);
    return data;
  }
}

function reverseBits(code: number, len: number): number {
  let r = 0;
  for (let i = 0; i < len; i++, code >>= 1) r = (r << 1) | (code & 1);
  return r;
}

const WINDOW = 32768;

/**
 * A raw DEFLATE (RFC 1951) encoder. Level 0 writes stored blocks; other levels find LZ77 matches through hash chains
 * and code them with the fixed Huffman tables. Input is buffered until a flush or finish.
 */
export class DeflateEncoder {
  private out = new Uint8Array(1024);
  private outStart = 0;
  private outEnd = 0;
  private bitbuf = 0;
  private bitcnt = 0;
  private pending: Uint8Array[] = [];
  private ended = false;

  constructor(public level: number) {}

  /** Copies `data` to be encoded. */
  write(data: Uint8Array): void {
    if (this.ended) throw new ZipError('deflate: write after finish');
    if (data.length > 0) this.pending.push(data.slice());
  }

  /** Encodes everything written so far, then an empty stored block, so the output so far is byte-aligned and decodable. */
  flush(): void {
    if (this.ended) return;
    if (this.pending.length > 0) this.encode(this.take(), false);
    this.bits(0, 3);
    this.align();
    for (const b of [0, 0, 0xff, 0xff]) this.byte(b);
  }

  finish(): void {
    if (this.ended) return;
    this.encode(this.take(), true);
    this.align();
    this.ended = true;
  }

  /** Encoded bytes not yet read. */
  get available(): number {
    return this.outEnd - this.outStart;
  }

  /** finish() was called and every encoded byte has been read. */
  get done(): boolean {
    return this.ended && this.available === 0;
  }

  read(out: Uint8Array, offset: number, length: number): number {
    const n = Math.min(length, this.available);
    out.set(this.out.subarray(this.outStart, this.outStart + n), offset);
    this.outStart += n;
    if (this.outStart === this.outEnd) this.outStart = this.outEnd = 0;
    return n;
  }

  private take(): Uint8Array {
    const total = this.pending.reduce((n, c) => n + c.length, 0);
    const d = new Uint8Array(total);
    let p = 0;
    for (const c of this.pending) {
      d.set(c, p);
      p += c.length;
    }
    this.pending = [];
    return d;
  }

  private byte(b: number): void {
    if (this.outEnd === this.out.length) {
      const live = this.outEnd - this.outStart;
      const grown = new Uint8Array(Math.max(1024, live * 2));
      grown.set(this.out.subarray(this.outStart, this.outEnd));
      this.out = grown;
      this.outStart = 0;
      this.outEnd = live;
    }
    this.out[this.outEnd++] = b;
  }

  private bits(v: number, n: number): void {
    this.bitbuf |= v << this.bitcnt;
    this.bitcnt += n;
    while (this.bitcnt >= 8) {
      this.byte(this.bitbuf & 0xff);
      this.bitbuf >>>= 8;
      this.bitcnt -= 8;
    }
  }

  private align(): void {
    if (this.bitcnt > 0) this.byte(this.bitbuf & 0xff);
    this.bitbuf = 0;
    this.bitcnt = 0;
  }

  private encode(d: Uint8Array, last: boolean): void {
    if (this.level === 0) this.stored(d, last);
    else this.fixed(d, last);
  }

  private stored(d: Uint8Array, last: boolean): void {
    let p = 0;
    do {
      const n = Math.min(65535, d.length - p);
      this.bits(last && p + n === d.length ? 1 : 0, 3);
      this.align();
      for (const b of [n & 0xff, n >> 8, ~n & 0xff, (~n >> 8) & 0xff]) this.byte(b);
      for (let i = 0; i < n; i++) this.byte(d[p + i]!);
      p += n;
    } while (p < d.length);
  }

  private symbol(sym: number): void {
    if (sym < 144) this.bits(reverseBits(0x30 + sym, 8), 8);
    else if (sym < 256) this.bits(reverseBits(0x190 + sym - 144, 9), 9);
    else if (sym < 280) this.bits(reverseBits(sym - 256, 7), 7);
    else this.bits(reverseBits(0xc0 + sym - 280, 8), 8);
  }

  private fixed(d: Uint8Array, last: boolean): void {
    this.bits(last ? 1 : 0, 1);
    this.bits(1, 2);
    const n = d.length;
    const maxChain = this.level >= 6 || this.level < 0 ? 256 : 32;
    const head = new Int32Array(1 << 15).fill(-1);
    const prev = new Int32Array(n);
    const hash = (i: number): number => ((d[i]! << 10) ^ (d[i + 1]! << 5) ^ d[i + 2]!) & 0x7fff;
    const insert = (i: number): void => {
      if (i + 2 >= n) return;
      const h = hash(i);
      prev[i] = head[h]!;
      head[h] = i;
    };
    for (let i = 0; i < n; ) {
      let bestLen = 0;
      let bestDist = 0;
      if (i + 2 < n) {
        const max = Math.min(258, n - i);
        for (let cand = head[hash(i)]!, chain = maxChain; cand >= 0 && i - cand <= WINDOW && chain > 0; cand = prev[cand]!, chain--) {
          if (d[cand + bestLen] !== d[i + bestLen]) continue;
          let l = 0;
          while (l < max && d[cand + l] === d[i + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = i - cand;
            if (l === max) break;
          }
        }
        insert(i);
      }
      if (bestLen < 3) {
        this.symbol(d[i]!);
        i++;
        continue;
      }
      let li = LEN_BASE.length - 1;
      while (LEN_BASE[li]! > bestLen) li--;
      this.symbol(257 + li);
      if (LEN_EXTRA[li]! > 0) this.bits(bestLen - LEN_BASE[li]!, LEN_EXTRA[li]!);
      let di = DIST_BASE.length - 1;
      while (DIST_BASE[di]! > bestDist) di--;
      this.bits(reverseBits(di, 5), 5);
      if (DIST_EXTRA[di]! > 0) this.bits(bestDist - DIST_BASE[di]!, DIST_EXTRA[di]!);
      for (let k = 1; k < bestLen; k++) insert(i + k);
      i += bestLen;
    }
    this.symbol(256);
  }
}
