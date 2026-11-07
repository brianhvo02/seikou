/*
 * java.awt.image.DirectColorModel.getRGB(int) (a final method) in the sRGB case: what its getAlpha, getRed,
 * getGreen and getBlue (through getsRGBComponentFromsRGB) compute, float operation for float operation; as an
 * intrinsic, and as the pixel converter of the engine's setPixels loop hooks.
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

import type { JArray, JObject } from '../../bdj/jvm/values';
import { DECLINE, f2i, perClass, slotOf } from '../../bdj/jvm/natives/intrinsics/common';
import type { IntrinsicFn } from '../../bdj/jvm/natives/intrinsics/common';

const slots = perClass((cls) => ({
  isSRGB: slotOf(cls, 'is_sRGB', 'Z'),
  supportsAlpha: slotOf(cls, 'supportsAlpha', 'Z'),
  isAlphaPremultiplied: slotOf(cls, 'isAlphaPremultiplied', 'Z'),
  maskArray: slotOf(cls, 'maskArray', '[I'),
  maskOffsets: slotOf(cls, 'maskOffsets', '[I'),
  scaleFactors: slotOf(cls, 'scaleFactors', '[F'),
}));

const fr = Math.fround;

/** DirectColorModel.getsRGBComponentFromsRGB(pixel, idx). */
function component(pixel: number, idx: number, masks: Int32Array, offsets: Int32Array, scale: Float32Array, premultiplied: boolean): number {
  let c = ((pixel & masks[idx]!) >>> offsets[idx]!) | 0;
  if (premultiplied) {
    const a = ((pixel & masks[3]!) >>> offsets[3]!) | 0;
    c = a === 0 ? 0 : f2i(fr(fr(fr(fr(fr(c) * scale[idx]!) * 255) / fr(fr(a) * scale[3]!)) + 0.5));
  } else if (scale[idx] !== 1) {
    c = f2i(fr(fr(fr(c) * scale[idx]!) + 0.5));
  }
  return c;
}

/** DirectColorModel.getRGB as a function of the pixel, when is_sRGB and no pixel can make the bytecode throw. */
export function directRGB(cm: JObject): ((pixel: number) => number) | null {
  const fields = cm.fields;
  const s = slots(cm.cls);
  if (fields[s.isSRGB] === 0) return null;
  const supportsAlpha = fields[s.supportsAlpha] !== 0;
  const premultiplied = fields[s.isAlphaPremultiplied] !== 0;
  const masksArr = fields[s.maskArray] as JArray | null;
  const offsetsArr = fields[s.maskOffsets] as JArray | null;
  const scaleArr = fields[s.scaleFactors] as JArray | null;
  if (masksArr === null || offsetsArr === null || scaleArr === null) return null;
  const masks = masksArr.data as Int32Array;
  const offsets = offsetsArr.data as Int32Array;
  const scale = scaleArr.data as Float32Array;
  const needed = supportsAlpha || premultiplied ? 4 : 3;
  if (masks.length < needed || offsets.length < needed || scale.length < needed) return null;
  return (pixel) => {
    let a = 255;
    if (supportsAlpha) {
      a = ((pixel & masks[3]!) >>> offsets[3]!) | 0;
      if (scale[3] !== 1) a = f2i(fr(fr(fr(a) * scale[3]!) + 0.5));
    }
    const r = component(pixel, 0, masks, offsets, scale, premultiplied);
    const g = component(pixel, 1, masks, offsets, scale, premultiplied);
    const b = component(pixel, 2, masks, offsets, scale, premultiplied);
    return (a << 24) | (r << 16) | (g << 8) | b;
  };
}

/** DirectColorModel.getRGB(int pixel) when is_sRGB; declines otherwise, and whenever the bytecode would throw. */
const getRGB: IntrinsicFn = (_jvm, _t, _m, stack, base) => {
  const f = directRGB(stack[base] as JObject);
  return f === null ? DECLINE : f(stack[base + 1] as number);
};

export const colorModelIntrinsics: Readonly<Record<string, IntrinsicFn>> = {
  'java/awt/image/DirectColorModel.getRGB(I)I': getRGB,
};
