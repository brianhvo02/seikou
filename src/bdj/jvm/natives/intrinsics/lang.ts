/*
 * Original code for bluray-web: intrinsics for small java.lang and java.util methods that a disc's start-up calls tens
 * of thousands of times (Math.min and Math.max on ints, Arrays.copyOfRange on chars and the String(char[], int, int)
 * constructor that uses it). Each implements the specified Java API behaviour (their Javadoc); checked against the
 * class library by the equivalence tests (tests/bdj/intrinsics.test.ts). Whatever would throw is left to the bytecode.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { JClass } from '../../loader';
import type { Jvm } from '../../jvm';
import type { JArray, JObject } from '../../values';
import { DECLINE, perClass, slotOf } from './common';
import type { IntrinsicFn } from './common';

const readyClasses = new WeakMap<Jvm, Map<string, JClass>>();

/** Whether a boot class is initialised, so a static call into it that the bytecode makes has nothing else to do. */
function classReady(jvm: Jvm, name: string): boolean {
  let byName = readyClasses.get(jvm);
  if (!byName) readyClasses.set(jvm, (byName = new Map()));
  let c = byName.get(name);
  if (!c) {
    const loaded = jvm.loader.loadBoot(name);
    if (!loaded) return false;
    byName.set(name, (c = loaded));
  }
  return c.state === 'initialized';
}

const mathReady = (jvm: Jvm): boolean => classReady(jvm, 'java/lang/Math');

/** Math.min(int, int). */
const minInt: IntrinsicFn = (_jvm, _t, _m, stack, base) => Math.min(stack[base] as number, stack[base + 1] as number);

/** Math.max(int, int). */
const maxInt: IntrinsicFn = (_jvm, _t, _m, stack, base) => Math.max(stack[base] as number, stack[base + 1] as number);

/** A new char[] holding original[from, to), padded with zeros past original's end; null where the bytecode throws. */
function charRange(jvm: Jvm, originalArr: JArray | null, from: number, to: number): JArray | null {
  if (originalArr === null || !mathReady(jvm)) return null;
  const original = originalArr.data as Uint16Array;
  const length = to - from;
  // a negative length (IllegalArgumentException), a start outside original (System.arraycopy throws); and a size this
  // engine would rather let the bytecode allocate
  if (length < 0 || from < 0 || from > original.length || length > 0x7fffffff) return null;
  const copy = jvm.heap.newArray(jvm.loader.arrayOf(jvm.loader.primitive('C')), length);
  (copy.data as Uint16Array).set(original.subarray(from, from + Math.min(original.length - from, length)));
  return copy;
}

/** Arrays.copyOfRange(char[] original, int from, int to) (static). */
const copyOfRangeChars: IntrinsicFn = (jvm, _t, _m, stack, base) =>
  charRange(jvm, stack[base] as JArray | null, stack[base + 1] as number, stack[base + 2] as number) ?? DECLINE;

const stringSlots = perClass((cls) => ({ value: slotOf(cls, 'value', '[C') }));

/**
 * new String(char[] value, int offset, int count) for count > 0 within value: the string's value is a copy of those
 * chars. (count 0 shares the empty string's array, which is left to the bytecode.)
 */
const stringFromChars: IntrinsicFn = (jvm, _t, m, stack, base) => {
  const self = stack[base] as JObject;
  const valueArr = stack[base + 1] as JArray | null;
  const offset = stack[base + 2] as number;
  const count = stack[base + 3] as number;
  if (valueArr === null || offset < 0 || count <= 0 || offset > valueArr.data.length - count) return DECLINE;
  if (!classReady(jvm, 'java/util/Arrays')) return DECLINE; // the bytecode's call of copyOfRange would initialise it
  const copy = charRange(jvm, valueArr, offset, offset + count);
  if (copy === null) return DECLINE;
  self.fields[stringSlots(m.cls).value] = copy;
  return undefined;
};

export const langIntrinsics: Readonly<Record<string, IntrinsicFn>> = {
  'java/lang/Math.min(II)I': minInt,
  'java/lang/Math.max(II)I': maxInt,
  'java/util/Arrays.copyOfRange([CII)[C': copyOfRangeChars,
  'java/lang/String.<init>([CII)V': stringFromChars,
};
