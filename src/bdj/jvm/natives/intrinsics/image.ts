/*
 * Loop hooks for java.awt.BDImageConsumer.setPixels, which converts a decoded image into libbluray's back buffer one
 * ColorModel.getRGB call per pixel: the hook does the remaining pixels of the copy loop as the bytecode would, and the
 * method's bytecode goes on from the loop's exit (dirty area, status and observers).
 *
 * Derived from libbluray, src/libbluray/bdj/java/java/awt/BDImageConsumer.java.
 * Copyright (C) 2012  libbluray
 * Copyright (C) 2012-2019  Petri Hintukainen <phintuka@users.sourceforge.net>
 * Modified for bluray-web (2026).
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { JArray, JObject, JValue } from '../../values';
import { pixelToRGB } from './color-model';
import { DECLINE, perClass, slotOf } from './common';
import type { LoopHook, LoopHookFn } from './common';

const consumerSlots = perClass((cls) => ({ width: slotOf(cls, 'width', 'I'), backBuffer: slotOf(cls, 'backBuffer', '[I') }));

/**
 * setPixels(int x, int y, int w, int h, ColorModel cm, <pixels>, int offset, int scansize), hooked at the inner loop's
 * goto, with locals 9 = X (already advanced) and 10 = Y:
 *   for (Y = y; Y < y + h; Y++) for (X = x; X < x + w; X++)
 *     backBuffer[Y * width + X] = cm.getRGB(pixels[offset + (Y - y) * scansize + (X - x)]);
 * `bytes`: the byte[] overload, whose pixels are taken & 0xFF. Returns `exit`, the pc after the loops.
 */
function setPixelsHook(bytes: boolean, exit: number): LoopHookFn {
  return (jvm, _t, m, locals: JValue[]) => {
    const self = locals[0] as JObject;
    const x = locals[1] as number;
    const y = locals[2] as number;
    const w = locals[3] as number;
    const h = locals[4] as number;
    const cm = locals[5] as JObject | null;
    const pixelsArr = locals[6] as JArray | null;
    const offset = locals[7] as number;
    const scansize = locals[8] as number;
    let X = locals[9] as number;
    let Y = locals[10] as number;
    const s = consumerSlots(m.cls);
    const bufArr = self.fields[s.backBuffer] as JArray | null;
    const width = self.fields[s.width] as number;
    if (cm === null || pixelsArr === null || bufArr === null) return DECLINE;
    const toRGB = pixelToRGB(jvm.natives.helpers, cm);
    if (toRGB === null) return DECLINE;
    const xEnd = (x + w) | 0;
    const yEnd = (y + h) | 0;
    const buf = bufArr.data as Int32Array;
    const pixels = pixelsArr.data as Int32Array | Int8Array;
    // Every index the remaining iterations use must be in range, or the bytecode runs and throws where Java does.
    // The int arithmetic agrees with these exact sums modulo 2^32, so an exact sum in range is the index Java uses.
    for (let r = Y, c0 = X; r < yEnd; r++, c0 = x) {
      if (c0 >= xEnd) continue;
      const d = r * width;
      const p = offset + (r - y) * scansize - x;
      if (d + c0 < 0 || d + xEnd - 1 >= buf.length || p + c0 < 0 || p + xEnd - 1 >= pixels.length) return DECLINE;
    }
    for (;;) {
      const d = Math.imul(Y, width);
      const p = (offset + Math.imul(Y - y, scansize) - x) | 0;
      if (bytes) for (; X < xEnd; X++) buf[(d + X) | 0] = toRGB(pixels[(p + X) | 0]! & 0xff);
      else for (; X < xEnd; X++) buf[(d + X) | 0] = toRGB(pixels[(p + X) | 0]!);
      if (++Y >= yEnd) break;
      X = x;
    }
    locals[9] = X;
    locals[10] = Y;
    return exit;
  };
}

export const imageLoopHooks: Readonly<Record<string, readonly LoopHook[]>> = {
  'java/awt/BDImageConsumer.setPixels(IIIILjava/awt/image/ColorModel;[III)V': [{ pc: 64, checksum: 0xf38b02b0, fn: setPixelsHook(false, 73) }],
  'java/awt/BDImageConsumer.setPixels(IIIILjava/awt/image/ColorModel;[BII)V': [{ pc: 68, checksum: 0xe4bf8ad9, fn: setPixelsHook(true, 77) }],
};
