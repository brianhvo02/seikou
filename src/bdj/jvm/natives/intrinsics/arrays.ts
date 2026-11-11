/*
 * Original code for Seikou: an intrinsic for java.util.Arrays.fill(int[], int), which libbluray uses to clear
 * whole back buffers.
 *
 * Copyright (C) 2026 Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { JArray } from '../../values';
import { DECLINE } from './common';
import type { IntrinsicFn } from './common';

/** Arrays.fill(int[] a, int val) (static). */
const fillInt: IntrinsicFn = (_jvm, _t, _m, stack, base) => {
  const a = stack[base] as JArray | null;
  if (a === null) return DECLINE;
  (a.data as Int32Array).fill(stack[base + 1] as number);
  return undefined;
};

/** The intrinsics in this file by native-table key, for NativeTable.intrinsify. */
export const arrayIntrinsics: Readonly<Record<string, IntrinsicFn>> = {
  'java/util/Arrays.fill([II)V': fillInt,
};
