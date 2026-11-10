// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Every occurrence of `from` in ASCII and UTF-16BE (the name table's encodings), replaced by `to` of the same length. */
function replaceAll(bytes: Uint8Array, from: string, to: string): void {
  if (from.length !== to.length) throw new Error('a rename keeps the length, so no table moves');
  for (const enc of [(s: string) => Buffer.from(s, 'latin1'), (s: string) => Buffer.from(s, 'utf16le').swap16()]) {
    const f = enc(from);
    const t = enc(to);
    for (let at = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).indexOf(f); at >= 0; at = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).indexOf(f, at + 1)) bytes.set(t, at);
  }
}

const sum = (b: Uint8Array, at: number, len: number): number => {
  let s = 0;
  for (let i = 0; i < len; i += 4) s = (s + (((b[at + i] ?? 0) << 24) | ((b[at + i + 1] ?? 0) << 16) | ((b[at + i + 2] ?? 0) << 8) | (b[at + i + 3] ?? 0))) >>> 0;
  return s;
};

/**
 * A copy of a TrueType font whose names say `to` where they said `from` (same length), with the table checksums and
 * head.checkSumAdjustment fixed: a font of a made-up family that no device has installed.
 */
export function renamedFont(src: string, out: string, renames: readonly (readonly [from: string, to: string])[]): string {
  const b = new Uint8Array(readFileSync(src));
  for (const [from, to] of renames) replaceAll(b, from, to);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let head = -1;
  for (let i = 0; i < v.getUint16(4); i++) {
    const rec = 12 + 16 * i;
    const tag = String.fromCharCode(b[rec]!, b[rec + 1]!, b[rec + 2]!, b[rec + 3]!);
    const off = v.getUint32(rec + 8);
    if (tag === 'head') {
      head = off;
      v.setUint32(off + 8, 0);
    }
    v.setUint32(rec + 4, sum(b, off, v.getUint32(rec + 12)));
  }
  if (head >= 0) v.setUint32(head + 8, (0xb1b0afba - sum(b, 0, b.length)) >>> 0);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, b);
  return out;
}
