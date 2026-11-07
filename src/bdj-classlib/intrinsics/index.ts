/*
 * The intrinsics that derive from the class library's own code: registered into a JVM through
 * JvmOptions.extraIntrinsics by the BD-J worker entry and by tests.
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

import type { NativeTable } from '../../bdj/jvm/natives/index';
import { colorModelIntrinsics, directRGB } from './color-model';
import { jarTextIntrinsics, jarTextLoopHooks } from './jar-text';
import { pngLoopHooks } from './png-rows';
import { rectangleIntersection } from './rectangle';

/** Installs the class library's intrinsics, loop hooks and helpers (JvmOptions.extraIntrinsics). */
export function registerClassLibraryIntrinsics(table: NativeTable): void {
  table.intrinsify(colorModelIntrinsics);
  table.intrinsify(jarTextIntrinsics);
  table.hookLoops(pngLoopHooks);
  table.hookLoops(jarTextLoopHooks);
  table.helpers.rectangleIntersection = rectangleIntersection;
  table.helpers.pixelConverters.set('java/awt/image/DirectColorModel', directRGB);
}
