/*
 * Original code for bluray-web: intrinsics of the BD-J virtual machine, JS fast paths for hot class-library methods.
 *
 * An intrinsic runs in place of a Java method's bytecode and must leave exactly what the bytecode would: the same
 * return value, array contents and field values. Whenever the bytecode would throw, block on a monitor, call code
 * that could be overridden, or do anything else the intrinsic does not reproduce, the intrinsic declines (returns
 * DECLINE) before changing anything, and the interpreter runs the bytecode instead. Exceptions therefore always come
 * from the bytecode, at the same point and with the same stack trace.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { NativeTable } from '../index';
import { arrayIntrinsics } from './arrays';
import { engineColorModels } from './color-model';
import { cryptoIntrinsics } from './crypto';
import { graphicsIntrinsics } from './graphics';
import { imageLoopHooks } from './image';
import { langIntrinsics } from './lang';
import { pngIntrinsics } from './png';
import { stringIntrinsics } from './strings';

export { DECLINE } from './common';
export type { ClassLibraryHelpers, IntrinsicFn, LoopHook, LoopHookFn, Span } from './common';

/**
 * Installs the engine's intrinsics and loop hooks (JvmOptions.intrinsics turns them off). Those derived from the class
 * library's own code live with it (src/bdj-classlib/intrinsics) and come in through JvmOptions.extraIntrinsics.
 */
export function registerIntrinsics(table: NativeTable): void {
  table.intrinsify(graphicsIntrinsics);
  table.intrinsify(pngIntrinsics);
  table.intrinsify(arrayIntrinsics);
  table.intrinsify(cryptoIntrinsics);
  table.intrinsify(stringIntrinsics);
  table.intrinsify(langIntrinsics);
  table.hookLoops(imageLoopHooks);
  for (const [name, convert] of engineColorModels) table.helpers.pixelConverters.set(name, convert);
}
