// SPDX-License-Identifier: LGPL-3.0-or-later
import { Id } from './mkv-ids';

const encoder = new TextEncoder();

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

/** Shortest EBML size encoding, 1 to 8 bytes (the all-ones value is reserved for "unknown"). */
export function vint(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n) throw new RangeError(`vint of negative value ${v}`);
  for (let len = 1; len <= 8; len++) {
    if (v < (1n << BigInt(7 * len)) - 1n) return beBytes(v | (1n << BigInt(7 * len)), len);
  }
  throw new RangeError(`vint value ${v} too large`);
}

/** 8-byte size encoding, so a placeholder can be patched in place later. */
export function vintFixed8(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n || v >= (1n << 56n) - 1n) throw new RangeError(`vintFixed8 value ${v} out of range`);
  return beBytes(v | (1n << 56n), 8);
}

/** Element id bytes: the id as written, big-endian, without leading zero bytes. */
export function idBytes(id: number): Uint8Array {
  const len = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  return beBytes(BigInt(id), len);
}

function element(id: number, payload: Uint8Array): Uint8Array {
  return concat([idBytes(id), vint(payload.length), payload]);
}

export function uint(id: number, v: number | bigint): Uint8Array {
  const big = BigInt(v);
  if (big < 0n) throw new RangeError(`uint of negative value ${big}`);
  let len = 1;
  while (len < 8 && big >= 1n << BigInt(8 * len)) len++;
  return element(id, beBytes(big, len));
}

/** Signed integer element, two's complement in the fewest bytes that hold it. */
export function sint(id: number, v: number | bigint): Uint8Array {
  const big = BigInt(v);
  let len = 1;
  while (len < 8 && (big < -(1n << BigInt(8 * len - 1)) || big >= 1n << BigInt(8 * len - 1))) len++;
  return element(id, beBytes(BigInt.asUintN(8 * len, big), len));
}

export function float64(id: number, v: number): Uint8Array {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setFloat64(0, v, false);
  return element(id, payload);
}

export function ascii(id: number, s: string): Uint8Array {
  return element(id, encoder.encode(s));
}

export function utf8(id: number, s: string): Uint8Array {
  return element(id, encoder.encode(s));
}

export function binary(id: number, b: Uint8Array): Uint8Array {
  return element(id, b);
}

export function master(id: number, children: readonly Uint8Array[]): Uint8Array {
  return element(id, concat(children));
}

/** A Void element of exactly `size` bytes in total, including its id and size field. */
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
