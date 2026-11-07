/*
 * Original code for bluray-web: an intrinsic for sun.awt.image.PNGImageDecoder.update_crc, the class library's CRC-32
 * over each PNG chunk (the CRC-32 of the PNG specification), computed from the class's own crc_table as its bytecode
 * does. The row loop of PNGImageDecoder.produceImage has its loop hook with the class library
 * (src/bdj-classlib/intrinsics/png-rows.ts).
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { JArray } from '../../values';
import { DECLINE, perClass, slotOf } from './common';
import type { IntrinsicFn } from './common';

const crcTableSlot = perClass((cls) => slotOf(cls, 'crc_table', '[I', true));

/** PNGImageDecoder.update_crc(int crc, byte[] buf, int offset, int len) (static). */
const updateCrc: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  let crc = stack[base] as number;
  const bufArr = stack[base + 1] as JArray | null;
  const offset = stack[base + 2] as number;
  const len = stack[base + 3] as number;
  if (len <= 0) return crc;
  const tableArr = m.cls.staticValues[crcTableSlot(m.cls)] as JArray | null;
  if (bufArr === null || tableArr === null || tableArr.data.length < 256) return DECLINE;
  const buf = bufArr.data as Int8Array;
  if (offset < 0 || offset + len > buf.length) return DECLINE;
  const table = tableArr.data as Int32Array;
  for (let i = offset; i < offset + len; i++) crc = table[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return crc;
};

export const pngIntrinsics: Readonly<Record<string, IntrinsicFn>> = {
  'sun/awt/image/PNGImageDecoder.update_crc(I[BII)I': updateCrc,
};
