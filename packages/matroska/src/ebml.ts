// SPDX-License-Identifier: LGPL-3.0-or-later
import { Id } from './ids';

// EBML (RFC 8794) is the binary container syntax Matroska is built on. A file is a tree of
// elements, each written as: Element ID (§5), Element Data Size (§6), then that many bytes of data.
// IDs and sizes are variable-length: the position of the first 1 bit in the first byte gives the
// total length (§4: VINT_WIDTH, VINT_MARKER, VINT_DATA). The functions below build the bytes of
// one element each; a parent's payload is simply its children's bytes joined.

const encoder = new TextEncoder();

/** Joins byte arrays into one new array. */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function beBytes(v: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let rest = v;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/**
 * Shortest EBML Element Data Size for `n` (RFC 8794 §6.1), 1 to 8 bytes: a length marker bit
 * followed by the value in 7 bits per byte. The all-ones value of each width is reserved to mean
 * "unknown size" (§6.2), so the largest value that fits in a width is one less than all ones.
 * Throws RangeError for a negative or too-large value.
 */
export function vint(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n) throw new RangeError(`vint of negative value ${v}`);
  for (let len = 1; len <= 8; len++) {
    if (v < (1n << BigInt(7 * len)) - 1n) return beBytes(v | (1n << BigInt(7 * len)), len);
  }
  throw new RangeError(`vint value ${v} too large`);
}

/**
 * Element Data Size always written in 8 bytes (RFC 8794 §6.1: a size need not be encoded at
 * its shortest length), so a placeholder can be overwritten in place once the real size is known. Throws
 * RangeError outside 0 to 2^56 - 2.
 */
export function vintFixed8(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v >= (1n << 56n) - 1n) throw new RangeError(`vintFixed8 value ${v} out of range`);
  return beBytes(v | (1n << 56n), 8);
}

/**
 * Element ID bytes (RFC 8794 §5): the id as it appears in `Id`, big-endian, 1 to 4 bytes. The id
 * constants already include the length-marker bits, so no further encoding is needed.
 */
export function idBytes(id: number): Uint8Array {
  const len = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  return beBytes(BigInt(id), len);
}

function element(id: number, payload: Uint8Array): Uint8Array {
  return concat([idBytes(id), vint(payload.length), payload]);
}

/** Unsigned Integer element (RFC 8794 §7.2): big-endian in the fewest bytes (1 to 8) that hold `v`. Throws RangeError when negative. */
export function uint(id: number, v: number | bigint): Uint8Array {
  const big = BigInt(v);
  if (big < 0n) throw new RangeError(`uint of negative value ${big}`);
  let len = 1;
  while (len < 8 && big >= 1n << BigInt(8 * len)) len++;
  return element(id, beBytes(big, len));
}

/** Signed Integer element (RFC 8794 §7.1): two's complement, big-endian, in the fewest bytes that hold `v`. */
export function sint(id: number, v: number | bigint): Uint8Array {
  const big = BigInt(v);
  let len = 1;
  while (len < 8 && (big < -(1n << BigInt(8 * len - 1)) || big >= 1n << BigInt(8 * len - 1))) len++;
  return element(id, beBytes(BigInt.asUintN(8 * len, big), len));
}

/** Float element (RFC 8794 §7.3) as an 8-byte big-endian IEEE 754 double (a float element may be 0, 4 or 8 bytes). */
export function float64(id: number, v: number): Uint8Array {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setFloat64(0, v, false);
  return element(id, payload);
}

/** String element (RFC 8794 §7.4): printable ASCII (0x20 to 0x7E) only. Not checked: the caller must pass such text. */
export function ascii(id: number, s: string): Uint8Array {
  return element(id, encoder.encode(s));
}

/** UTF-8 element (RFC 8794 §7.5): the string's UTF-8 bytes, no terminator. */
export function utf8(id: number, s: string): Uint8Array {
  return element(id, encoder.encode(s));
}

/** Binary element (RFC 8794 §7.8): `b` copied as the element's data. */
export function binary(id: number, b: Uint8Array): Uint8Array {
  return element(id, b);
}

/** Master element (RFC 8794 §7.7): a container whose data is its already-encoded `children`, in order. */
export function master(id: number, children: readonly Uint8Array[]): Uint8Array {
  return element(id, concat(children));
}

/**
 * A Void element (RFC 8794 §11.3.2) of exactly `size` bytes in total, including its id and size
 * field. Readers skip a Void's data, so it reserves room that is overwritten later. Throws
 * RangeError when `size` is under 2 or above what a 2-byte size field can describe.
 */
export function voidElement(size: number): Uint8Array {
  if (size < 2) throw new RangeError(`void element needs at least 2 bytes, got ${size}`);
  const sizeLen = size - 2 < 127 ? 1 : 2;
  const payload = size - 1 - sizeLen;
  if (payload >= 16383) throw new RangeError(`void element of ${size} bytes too large`);
  const out = new Uint8Array(size);
  out[0] = Id.Void;
  out.set(beBytes(BigInt(payload) | (1n << BigInt(7 * sizeLen)), sizeLen), 1);
  return out;
}
