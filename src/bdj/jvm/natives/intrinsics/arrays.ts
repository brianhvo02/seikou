/*
 * Original code for bluray-web: an intrinsic for java.util.Arrays.fill(int[], int), which libbluray uses to clear
 * whole back buffers.
 *
 * Copyright (C) 2026 bluray-web contributors
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

export const arrayIntrinsics: Readonly<Record<string, IntrinsicFn>> = {
  'java/util/Arrays.fill([II)V': fillInt,
};
