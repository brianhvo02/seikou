/*
 * Ported from libbluray src/libbluray/decoders/rle.c (rle_crop_object)
 * Copyright (C) 2013  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { RleElem } from './segments';

/**
 * rle_crop_object: crop a (width-wide) RLE image to the rectangle (x, y, w, h).
 * The input must carry a zero-length end-of-line element after every line, as the
 * decoder emits them; the output does too, one per cropped line.
 */
export function cropRle(img: readonly RleElem[], width: number, x: number, y: number, w: number, h: number): RleElem[] {
  const out: RleElem[] = [];
  const x0 = x;
  const x1 = x + w; // first pixel outside of the cropped region
  let i = 0;

  // skip crop_y lines
  for (let row = 0; row < y; row++) {
    for (let px = 0; px < width; ) {
      const e = img[i++];
      if (!e) return out; // C would read past the buffer
      px += e.len;
    }
  }

  for (let row = 0; row < h; row++) {
    for (let px = 0; px < width; ) {
      const e = img[i++];
      if (!e) return out;
      let len = e.len;
      if (len < 1) continue; // "rle eol marker in middle of line"

      // starts outside, ends outside
      if (px + len < x0 || px >= x1) {
        px += len;
        continue;
      }
      // starts before?
      if (px < x0) {
        len -= x0 - px;
        px = x0;
      }
      px += len;
      // ends after?
      if (px >= x1) len -= px - x1;

      out.push({ len, color: e.color });
    }
    // skip the eol marker if present ("rle eol marker missing" otherwise)
    const eol = img[i];
    if (eol && eol.len === 0) i++;
    out.push({ len: 0, color: 0 });
  }
  return out;
}
