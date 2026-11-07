/*
 * Original code for bluray-web: Java values and objects of the BD-J virtual machine.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { JClass } from './loader';
import type { Monitor } from './threads';

/** int, short, byte, char, boolean, float and double are numbers; long is a bigint. */
export type JValue = number | bigint | JObject | null;

export interface JObject {
  readonly cls: JClass;
  readonly fields: JValue[];
  monitor: Monitor | null;
  hash: number;
  nativeData: unknown;
}

export type ArrayData =
  | Int8Array
  | Uint16Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | (JObject | null)[];

export interface JArray extends JObject {
  readonly data: ArrayData;
}

/** Carries a Java exception through JS frames (loader and native code) to the interpreter. */
export class JavaThrowable extends Error {
  constructor(readonly obj: JObject) {
    super(obj.cls.name);
  }
}

/** Default value of a field or array element with this descriptor. */
export function defaultValue(desc: string): JValue {
  const c = desc.charCodeAt(0);
  if (c === 0x4a) return 0n; // J
  if (c === 0x4c || c === 0x5b) return null; // L, [
  return 0;
}

/** long and double take two local-variable and operand-stack slots. */
export const isWide = (desc: string): boolean => desc === 'J' || desc === 'D';
