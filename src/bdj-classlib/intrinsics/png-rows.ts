/*
 * A loop hook for the row loop of sun.awt.image.PNGImageDecoder.produceImage (pc 960 to 1699), which turns a
 * filtered row into pixels as that method does.
 *
 * Derived from OpenJDK 8 (the class library in src/bdj-classlib/rt-bdj.jar, whose source is named in
 * src/bdj-classlib/NOTICE); see NOTICE in this directory.
 * Copyright (c) 1995, 2013, Oracle and/or its affiliates. All rights reserved.
 * Modified for bluray-web (2026).
 *
 * This code is free software; you can redistribute it and/or modify it under the terms of the GNU General Public
 * License version 2 only, as published by the Free Software Foundation, with the Classpath Exception (see LICENSE and
 * ASSEMBLY_EXCEPTION in src/bdj-classlib/).
 *
 * SPDX-License-Identifier: GPL-2.0-only WITH Classpath-exception-2.0
 */

import type { JArray, JObject, JValue } from '../../bdj/jvm/values';
import { DECLINE, perClass, slotOf } from '../../bdj/jvm/natives/intrinsics/common';
import type { LoopHook, LoopHookFn } from '../../bdj/jvm/natives/intrinsics/common';

const decoderSlots = perClass((cls) => ({
  width: slotOf(cls, 'width', 'I'),
  bitDepth: slotOf(cls, 'bitDepth', 'I'),
  transparentPixel: slotOf(cls, 'transparentPixel', 'I'),
  transparentPixel16: slotOf(cls, 'transparentPixel_16', '[B'),
}));

/** Per combined type (colorType | bitDepth << 3) of the int[] path: source bytes per pixel and the last byte read. */
const INT_TYPES: Readonly<Record<number, readonly [step: number, last: number]>> = {
  70: [4, 3], // RGBA, 8 bits
  134: [8, 6], // RGBA, 16 bits
  66: [3, 2], // RGB, 8 bits
  130: [6, 5], // RGB, 16 bits (the transparency test reads up to 5)
  68: [2, 1], // grey and alpha, 8 bits
  132: [4, 2], // grey and alpha, 16 bits
};

/** Per bit depth of the byte[] path: the shift from sample position to byte, and samples per pixel step. */
const BYTE_DEPTHS: Readonly<Record<number, readonly [shift: number, step: number]>> = { 1: [3, 1], 2: [2, 1], 4: [1, 1], 8: [0, 1], 16: [0, 2] };

/**
 * produceImage's pixel loop, hooked at its goto (pc 1699) with locals 2 = bPixels, 3 = wPixels, 7 = combinedType,
 * 17 = colInc, 24 = rowOffset, 26 = rowByteBuffer, 29 = col, 30 = spos, 31 = pixel (and 32, 33 as scratch):
 *   for (col = startingCol, spos = 0; col < width; col += colInc) { <one pixel from rowByteBuffer[spos...]> }
 * Exits to pc 1702.
 */
const produceRow: LoopHookFn = (_jvm, _t, m, locals: JValue[]) => {
  const fields = (locals[0] as JObject).fields;
  const s = decoderSlots(m.cls);
  const width = fields[s.width] as number;
  const colInc = locals[17] as number;
  let col = locals[29] as number;
  let spos = locals[30] as number;
  const rowOffset = locals[24] as number;
  const rowArr = locals[26] as JArray | null;
  const wArr = locals[3] as JArray | null;
  const bArr = locals[2] as JArray | null;
  if (col >= width || colInc <= 0 || width > 0x3fffffff || rowArr === null) return DECLINE;
  const n = Math.ceil((width - col) / colInc);
  const lastCol = col + (n - 1) * colInc;
  const row = rowArr.data as Int8Array;
  if (wArr !== null) {
    const type = locals[7] as number;
    const t = INT_TYPES[type];
    if (t === undefined) return DECLINE;
    const [step, last] = t;
    const out = wArr.data as Int32Array;
    const tp16Arr = fields[s.transparentPixel16] as JArray | null;
    if (col + rowOffset < 0 || lastCol + rowOffset >= out.length) return DECLINE;
    if (spos < 0 || spos + (n - 1) * step + last >= row.length) return DECLINE;
    if (type === 130 && tp16Arr !== null && tp16Arr.data.length < 6) return DECLINE;
    const transparent = fields[s.transparentPixel] as number;
    let pixel = locals[31] as number;
    let l32 = locals[32] as JValue;
    let l33 = locals[33] as JValue;
    for (; col < width; col += colInc) {
      const i = col + rowOffset;
      switch (type) {
        case 70:
          out[i] = ((row[spos]! & 255) << 16) | ((row[spos + 1]! & 255) << 8) | (row[spos + 2]! & 255) | ((row[spos + 3]! & 255) << 24);
          spos += 4;
          break;
        case 134:
          out[i] = ((row[spos]! & 255) << 16) | ((row[spos + 2]! & 255) << 8) | (row[spos + 4]! & 255) | ((row[spos + 6]! & 255) << 24);
          spos += 8;
          break;
        case 66:
          pixel = ((row[spos]! & 255) << 16) | ((row[spos + 1]! & 255) << 8) | (row[spos + 2]! & 255);
          if (pixel !== transparent) pixel |= 0xff000000;
          out[i] = pixel;
          spos += 3;
          break;
        case 130: {
          pixel = ((row[spos]! & 255) << 16) | ((row[spos + 2]! & 255) << 8) | (row[spos + 4]! & 255);
          const tp16 = tp16Arr === null ? null : (tp16Arr.data as Int8Array);
          let isTransparent = tp16 !== null ? 1 : 0;
          let k = 0;
          while (isTransparent !== 0 && k < 6) {
            isTransparent &= (row[spos + k]! & 255) === (tp16![k]! & 255) ? 1 : 0;
            k++;
          }
          if (isTransparent === 0) pixel |= 0xff000000;
          out[i] = pixel;
          spos += 6;
          l32 = isTransparent;
          l33 = k;
          break;
        }
        case 68: {
          const c = row[spos]! & 255;
          out[i] = (c << 16) | (c << 8) | c | ((row[spos + 1]! & 255) << 24);
          spos += 2;
          l33 = c;
          break;
        }
        case 132: {
          const c = row[spos]! & 255;
          out[i] = (c << 16) | (c << 8) | c | ((row[spos + 2]! & 255) << 24);
          spos += 4;
          l33 = c;
          break;
        }
      }
    }
    locals[31] = pixel;
    locals[32] = l32;
    locals[33] = l33;
  } else {
    if (bArr === null) return DECLINE;
    const depth = fields[s.bitDepth] as number;
    const d = BYTE_DEPTHS[depth];
    if (d === undefined) return DECLINE;
    const [shift, step] = d;
    const out = bArr.data as Int8Array;
    if (col + rowOffset < 0 || lastCol + rowOffset >= out.length) return DECLINE;
    if (spos < 0 || (spos + (n - 1) * step) >> shift >= row.length) return DECLINE;
    for (; col < width; col += colInc) {
      const i = col + rowOffset;
      switch (depth) {
        case 1:
          out[i] = (row[spos >> 3]! >> (7 - (spos & 7))) & 1;
          spos++;
          break;
        case 2:
          out[i] = (row[spos >> 2]! >> ((3 - (spos & 3)) * 2)) & 3;
          spos++;
          break;
        case 4:
          out[i] = (row[spos >> 1]! >> ((1 - (spos & 1)) * 4)) & 15;
          spos++;
          break;
        case 8:
          out[i] = row[spos++]!;
          break;
        case 16:
          out[i] = row[spos]!;
          spos += 2;
          break;
      }
    }
  }
  locals[29] = col;
  locals[30] = spos;
  return 1702;
};

export const pngLoopHooks: Readonly<Record<string, readonly LoopHook[]>> = {
  'sun/awt/image/PNGImageDecoder.produceImage()V': [{ pc: 1699, checksum: 0xde6a4fe3, fn: produceRow }],
};
