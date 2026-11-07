/*
 * java.awt.Rectangle.intersection(Rectangle) of a plain Rectangle, for the engine's BDGraphicsBase.drawSpanN
 * intrinsics.
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

import type { JObject } from '../../bdj/jvm/values';
import { perClass, slotOf } from '../../bdj/jvm/natives/intrinsics/common';
import type { Span } from '../../bdj/jvm/natives/intrinsics/common';

/** java.awt.Rectangle's fields; null for a subclass, whose intersection could be overridden. */
const rectangleSlots = perClass((cls) =>
  cls.name === 'java/awt/Rectangle' && cls.loader === null
    ? { x: slotOf(cls, 'x', 'I'), y: slotOf(cls, 'y', 'I'), width: slotOf(cls, 'width', 'I'), height: slotOf(cls, 'height', 'I') }
    : null,
);

/**
 * clip.intersection(new Rectangle(x, y, w, h)), as Rectangle.intersection computes it (in longs, then narrowed), into
 * `span`; false when the clip is not a plain Rectangle, or Rectangle is not initialised yet (the bytecode's
 * `new Rectangle` would initialise it).
 */
export function rectangleIntersection(clip: JObject, x: number, y: number, w: number, h: number, span: Span): boolean {
  const r = rectangleSlots(clip.cls);
  if (r === null || clip.cls.state !== 'initialized') return false;
  const f = clip.fields;
  let tx1 = f[r.x] as number;
  let ty1 = f[r.y] as number;
  let tx2 = tx1 + (f[r.width] as number); // exact: the sums of two ints are the longs Java computes
  let ty2 = ty1 + (f[r.height] as number);
  const rx2 = x + w;
  const ry2 = y + h;
  if (tx1 < x) tx1 = x;
  if (ty1 < y) ty1 = y;
  if (tx2 > rx2) tx2 = rx2;
  if (ty2 > ry2) ty2 = ry2;
  tx2 -= tx1;
  ty2 -= ty1;
  if (tx2 < -2147483648) tx2 = -2147483648;
  if (ty2 < -2147483648) ty2 = -2147483648;
  span.x = tx1;
  span.y = ty1;
  span.width = tx2 | 0; // l2i keeps the low 32 bits
  span.height = ty2 | 0;
  return true;
}

