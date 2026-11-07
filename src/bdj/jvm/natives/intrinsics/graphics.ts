/*
 * Intrinsics for libbluray's AWT back buffer: java.awt.BDGraphicsBase's span drawing (drawSpanN with its
 * applyComposite and alphaBlend, the Area.add it calls; the Rectangle.intersection it calls is the class library's
 * helper, NativeTable.helpers.rectangleIntersection) and
 * java.awt.BDRootWindow.isBackBufferClear. They compute what libbluray's Java does, pixel for pixel.
 *
 * Derived from libbluray, src/libbluray/bdj/java/java/awt/BDGraphicsBase.java, Area.java and BDRootWindow.java.
 * Copyright (C) 2012  libbluray
 * Copyright (C) 2012-2019  Petri Hintukainen <phintuka@users.sourceforge.net>
 * Modified for bluray-web (2026).
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { JClass, JMethod } from '../../loader';
import type { JThread } from '../../threads';
import type { JArray, JObject } from '../../values';
import type { Jvm } from '../../jvm';
import { DECLINE, f2i, monitorFree, perClass, slotOf } from './common';
import type { IntrinsicFn, Span } from './common';

const CLEAR = 1;
const SRC = 2;
const SRC_OVER = 3;

/** BDGraphicsBase's fields, from the class that declares drawSpanN. */
const graphicsSlots = perClass((cls) => ({
  width: slotOf(cls, 'width', 'I'),
  backBuffer: slotOf(cls, 'backBuffer', '[I'),
  dirty: slotOf(cls, 'dirty', 'Ljava/awt/Area;'),
  composite: slotOf(cls, 'composite', 'Ljava/awt/AlphaComposite;'),
  xorColor: slotOf(cls, 'xorColor', 'Ljava/awt/Color;'),
  actualClip: slotOf(cls, 'actualClip', 'Ljava/awt/Rectangle;'),
}));

/** libbluray's java.awt.Area; null for anything else. */
const areaSlots = perClass((cls) =>
  cls.name === 'java/awt/Area' && cls.loader === null
    ? { x0: slotOf(cls, 'x0', 'I'), y0: slotOf(cls, 'y0', 'I'), x1: slotOf(cls, 'x1', 'I'), y1: slotOf(cls, 'y1', 'I') }
    : null,
);

/** The slot of Color.value when the class does not override getRGB() (so getRGB() returns it); null otherwise. */
const colorValueSlot = perClass((cls): number | null => {
  let color: JClass | null = cls;
  while (color && color.name !== 'java/awt/Color') color = color.superClass;
  const getRGB = color?.methods.get('getRGB()I');
  if (!color || !getRGB || getRGB.vtableIndex < 0 || cls.vtable[getRGB.vtableIndex] !== getRGB) return null;
  return slotOf(color, 'value', 'I');
});

/** AlphaComposite (a final class): rule and extraAlpha. */
const compositeSlots = perClass((cls) => ({ rule: slotOf(cls, 'rule', 'I'), extraAlpha: slotOf(cls, 'extraAlpha', 'F') }));

/** BDGraphicsBase.applyComposite: the alpha scaled by the composite's extra alpha, in float as Java does. */
function applyComposite(rgb: number, extraAlpha: number): number {
  return (f2i(Math.fround(Math.fround(rgb >>> 24) * extraAlpha)) << 24) | (rgb & 0x00ffffff);
}

/** BDGraphicsBase.alphaBlend (all products stay well inside int range; the divisions are of positive ints). */
export function alphaBlend(dest: number, src: number): number {
  let As = src >>> 24;
  if (As === 0) return dest;
  if (As === 255) return src;
  let Ad = dest >>> 24;
  if (Ad === 0) return src;
  let R = ((src >>> 16) & 255) * As * 255;
  let G = ((src >>> 8) & 255) * As * 255;
  let B = (src & 255) * As * 255;
  Ad = Ad * (255 - As);
  As = As * 255 + Ad;
  R = ((R + ((dest >>> 16) & 255) * Ad) / As) | 0;
  G = ((G + ((dest >>> 8) & 255) * Ad) / As) | 0;
  B = ((B + (dest & 255) * Ad) / As) | 0;
  R = Math.min(255, R);
  G = Math.min(255, G);
  B = Math.min(255, B);
  Ad = Math.min(255, (As / 255) | 0);
  return (Ad << 24) | (R << 16) | (G << 8) | B;
}

const span: Span = { x: 0, y: 0, width: 0, height: 0 };

/**
 * actualClip.intersection(new Rectangle(x, y, w, 1)) into `span`, through the class library's helper; false when there
 * is none or it declines.
 */
function intersect(jvm: Jvm, clip: JObject, x: number, y: number, w: number, h: number): boolean {
  const f = jvm.natives.helpers.rectangleIntersection;
  return f !== undefined && f(clip, x, y, w, h, span);
}

/** Whether `dirty.add(rect)` can be done here: libbluray's Area, its monitor free for `t`. */
function canAddDirty(t: JThread, dirty: JObject | null): dirty is JObject {
  return dirty !== null && areaSlots(dirty.cls) !== null && monitorFree(t, dirty);
}

/** Area.add(Rectangle) with the span. */
function addDirty(dirty: JObject, s: Span): void {
  const a = areaSlots(dirty.cls)!;
  const f = dirty.fields;
  if ((s.x | s.width | s.y | s.height) >= 0) {
    f[a.x0] = Math.min(f[a.x0] as number, s.x);
    f[a.x1] = Math.max(f[a.x1] as number, (s.x + s.width - 1) | 0);
    f[a.y0] = Math.min(f[a.y0] as number, s.y);
    f[a.y1] = Math.max(f[a.y1] as number, (s.y + s.height - 1) | 0);
  }
}

/** BDGraphicsBase.drawSpanN(int x, int y, int length, int rgb): one colour along a clipped span. */
const drawSpanColor: IntrinsicFn = (jvm, t, m: JMethod, stack, base) => {
  const self = stack[base] as JObject;
  let x = stack[base + 1] as number;
  const y = stack[base + 2] as number;
  let length = stack[base + 3] as number;
  let rgb = stack[base + 4] as number;
  const g = graphicsSlots(m.cls);
  const fields = self.fields;
  const clip = fields[g.actualClip] as JObject | null;
  if (clip === null || !intersect(jvm, clip, x, y, length, 1)) return DECLINE;
  const buf = fields[g.backBuffer] as JArray | null;
  if (span.width <= 0 || span.height <= 0 || span.x < 0 || span.y < 0 || buf === null) return undefined;
  x = span.x;
  length = span.width;
  const dirty = fields[g.dirty] as JObject | null;
  if (!canAddDirty(t, dirty)) return DECLINE;
  const data = buf.data as Int32Array;
  const start = (Math.imul(y, fields[g.width] as number) + x) | 0;
  if (start < 0 || start + length > data.length) return DECLINE; // the bytecode throws partway
  const xor = fields[g.xorColor] as JObject | null;
  if (xor !== null) {
    const value = colorValueSlot(xor.cls);
    if (value === null) return DECLINE;
    const v = (xor.fields[value] as number) ^ rgb;
    for (let i = 0; i < length; i++) data[start + i] ^= v;
    addDirty(dirty, span);
    return undefined;
  }
  const composite = fields[g.composite] as JObject | null;
  if (composite === null) return DECLINE;
  const c = compositeSlots(composite.cls);
  switch (composite.fields[c.rule] as number) {
    case CLEAR:
      data.fill(0, start, start + length);
      break;
    case SRC:
      rgb = applyComposite(rgb, composite.fields[c.extraAlpha] as number);
      data.fill(rgb, start, start + length);
      break;
    case SRC_OVER:
      rgb = applyComposite(rgb, composite.fields[c.extraAlpha] as number);
      for (let i = start; i < start + length; i++) data[i] = alphaBlend(data[i]!, rgb);
      break;
  }
  addDirty(dirty, span);
  return undefined;
};

/** BDGraphicsBase.drawSpanN(int x, int y, int length, int[] src, int srcOffset, boolean flipX): pixels along a span. */
const drawSpanPixels: IntrinsicFn = (jvm, t, m: JMethod, stack, base) => {
  const self = stack[base] as JObject;
  let x = stack[base + 1] as number;
  const y = stack[base + 2] as number;
  let length = stack[base + 3] as number;
  const srcArr = stack[base + 4] as JArray | null;
  let srcOffset = stack[base + 5] as number;
  const flipX = (stack[base + 6] as number) !== 0;
  if (srcArr === null) return DECLINE;
  const src = srcArr.data as Int32Array;
  // avoid overreading source
  if (((srcOffset + length) | 0) > src.length) length = (length - ((((srcOffset + length) | 0) - src.length) | 0)) | 0;
  // avoid underreading source
  if (srcOffset < 0) {
    length = (length + srcOffset) | 0;
    x = (x - srcOffset) | 0;
    srcOffset = 0;
  }
  if (length <= 0) return undefined;
  const g = graphicsSlots(m.cls);
  const fields = self.fields;
  const clip = fields[g.actualClip] as JObject | null;
  if (clip === null || !intersect(jvm, clip, x, y, length, 1)) return DECLINE;
  const buf = fields[g.backBuffer] as JArray | null;
  if (span.width <= 0 || span.height <= 0 || span.x < 0 || span.y < 0 || buf === null) return undefined;
  srcOffset = (srcOffset + ((span.x - x) | 0)) | 0;
  x = span.x;
  length = span.width;
  const dirty = fields[g.dirty] as JObject | null;
  if (!canAddDirty(t, dirty)) return DECLINE;
  const data = buf.data as Int32Array;
  const dst = (Math.imul(y, fields[g.width] as number) + x) | 0;
  if (dst < 0 || dst + length > data.length) return DECLINE; // the bytecode throws partway
  const xor = fields[g.xorColor] as JObject | null;
  let rule = 0;
  let extraAlpha = 0;
  let value = 0;
  if (xor !== null) {
    const slot = colorValueSlot(xor.cls);
    if (slot === null) return DECLINE;
    value = xor.fields[slot] as number;
  } else {
    const composite = fields[g.composite] as JObject | null;
    if (composite === null) return DECLINE;
    const c = compositeSlots(composite.cls);
    rule = composite.fields[c.rule] as number;
    extraAlpha = composite.fields[c.extraAlpha] as number;
  }
  const readsSrc = xor !== null || rule === SRC || rule === SRC_OVER;
  if (readsSrc && (srcOffset < 0 || srcOffset + length > src.length)) return DECLINE;
  if (xor !== null) {
    if (flipX) for (let i = 0; i < length; i++) data[dst + length - 1 - i] ^= value ^ src[srcOffset + i]!;
    else for (let i = 0; i < length; i++) data[dst + i] ^= value ^ src[srcOffset + i]!;
  } else if (rule === CLEAR) {
    data.fill(0, dst, dst + length);
  } else if (rule === SRC) {
    if (flipX) for (let i = 0; i < length; i++) data[dst + length - 1 - i] = applyComposite(src[srcOffset + i]!, extraAlpha);
    else for (let i = 0; i < length; i++) data[dst + i] = applyComposite(src[srcOffset + i]!, extraAlpha);
  } else if (rule === SRC_OVER) {
    if (flipX) {
      for (let i = 0; i < length; i++) {
        const d = dst + length - 1 - i;
        data[d] = alphaBlend(data[d]!, applyComposite(src[srcOffset + i]!, extraAlpha));
      }
    } else {
      for (let i = 0; i < length; i++) data[dst + i] = alphaBlend(data[dst + i]!, applyComposite(src[srcOffset + i]!, extraAlpha));
    }
  }
  addDirty(dirty, span);
  return undefined;
};

/** BDRootWindow's fields. */
const rootWindowSlots = perClass((cls) => ({ width: slotOf(cls, 'width', 'I'), height: slotOf(cls, 'height', 'I'), backBuffer: slotOf(cls, 'backBuffer', '[I') }));

/** BDRootWindow.isBackBufferClear: whether the first height * width pixels are all 0. */
const isBackBufferClear: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const fields = (stack[base] as JObject).fields;
  const w = rootWindowSlots(m.cls);
  const n = Math.imul(fields[w.height] as number, fields[w.width] as number);
  if (n <= 0) return 1;
  const buf = fields[w.backBuffer] as JArray | null;
  if (buf === null || n > buf.data.length) return DECLINE;
  const data = buf.data as Int32Array;
  for (let i = 0; i < n; i++) if (data[i] !== 0) return 0;
  return 1;
};

export const graphicsIntrinsics: Readonly<Record<string, IntrinsicFn>> = {
  'java/awt/BDGraphicsBase.drawSpanN(IIII)V': drawSpanColor,
  'java/awt/BDGraphicsBase.drawSpanN(III[IIZ)V': drawSpanPixels,
  'java/awt/BDRootWindow.isBackBufferClear()Z': isBackBufferClear,
};
