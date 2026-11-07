/*
 * Original code for bluray-web: ColorModel.getRGB(int) as a function of the pixel, for the loop hooks over whole pixel
 * arrays. IndexColorModel.getRGB(int) (a palette lookup) is here; other colour models come from the converters a class
 * library registers (NativeTable.helpers.pixelConverters; DirectColorModel's is in src/bdj-classlib/intrinsics).
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { JClass } from '../../loader';
import type { JArray, JObject } from '../../values';
import { perClass, slotOf } from './common';
import type { ClassLibraryHelpers } from './common';

const indexSlots = perClass((cls) => ({ rgb: slotOf(cls, 'rgb', '[I'), pixelMask: slotOf(cls, 'pixel_mask', 'I') }));

/** IndexColorModel.getRGB(int) (final): rgb[pixel & pixel_mask], when no pixel can index outside rgb. */
function indexRGB(cm: JObject): ((pixel: number) => number) | null {
  const s = indexSlots(cm.cls);
  const rgbArr = cm.fields[s.rgb] as JArray | null;
  const mask = cm.fields[s.pixelMask] as number;
  if (rgbArr === null || mask < 0 || mask >= rgbArr.data.length) return null;
  const rgb = rgbArr.data as Int32Array;
  return (pixel) => rgb[pixel & mask]!;
}

/** The class-library class whose getRGB(int) a ColorModel class runs (by virtual selection), or null. */
const getRGBClass = perClass((cls): string | null => {
  let base: JClass | null = cls;
  while (base && base.name !== 'java/awt/image/ColorModel') base = base.superClass;
  const decl = base?.methods.get('getRGB(I)I');
  if (!decl || decl.vtableIndex < 0) return null;
  const selected = cls.vtable[decl.vtableIndex];
  return selected && selected.cls.loader === null ? selected.cls.name : null;
});

/**
 * `cm.getRGB(pixel)` as a function of the pixel, for the colour models with a converter and only when no pixel can make
 * it throw; null otherwise (the caller declines).
 */
export function pixelToRGB(helpers: ClassLibraryHelpers, cm: JObject): ((pixel: number) => number) | null {
  const name = getRGBClass(cm.cls);
  const convert = name === null ? undefined : helpers.pixelConverters.get(name);
  return convert ? convert(cm) : null;
}

/** The engine's own converters. */
export const engineColorModels: ReadonlyMap<string, (cm: JObject) => ((pixel: number) => number) | null> = new Map([['java/awt/image/IndexColorModel', indexRGB]]);

