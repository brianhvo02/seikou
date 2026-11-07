/*
 * Original implementation for bluray-web, 2026; palette entry semantics from
 * libbluray src/libbluray/decoders/overlay.h (BD_PG_PALETTE_ENTRY).
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { PgPaletteEntry } from './segments';

const KY = 255 / 219;
const KRV = (255 / 224) * 2 * (1 - 0.2126);
const KBU = (255 / 224) * 2 * (1 - 0.0722);
const KGU = (KBU * 0.0722) / 0.7152;
const KGV = (KRV * 0.2126) / 0.7152;

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** One entry, BT.709 limited range, packed 0xAABBGGRR; alpha is T (not premultiplied). */
export function ycrcbToRgba(e: PgPaletteEntry | undefined): number {
  if (!e) return 0;
  const y = KY * (e.y - 16);
  const cr = e.cr - 128;
  const cb = e.cb - 128;
  const r = clamp8(y + KRV * cr);
  const g = clamp8(y - KGU * cb - KGV * cr);
  const b = clamp8(y + KBU * cb);
  return (((e.t & 0xff) << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** 256 entries packed 0xAABBGGRR (the byte order of little-endian ImageData). */
export function paletteToRgba(entries: readonly PgPaletteEntry[]): Uint32Array {
  const out = new Uint32Array(256);
  for (let i = 0; i < 256; i++) out[i] = ycrcbToRgba(entries[i]);
  return out;
}
