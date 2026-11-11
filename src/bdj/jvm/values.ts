/*
 * Original code for Seikou: Java values and objects of the BD-J virtual machine.
 *
 * Copyright (C) 2026 Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import type { JClass } from './loader';
import type { Monitor } from './threads';

/**
 * A Java value (JVM Specification, Java SE 8, §2.2 to §2.4): int, short, byte, char, boolean, float and double are
 * numbers; long is a bigint; a reference is a JObject or null. A returnAddress (§2.3.3), which `jsr` pushes and `ret`
 * reads, is a number: the bytecode offset to return to.
 */
export type JValue = number | bigint | JObject | null;

/** A Java object on the heap (`heap.ts`). Objects live only in the BD-J worker; the JS garbage collector frees them. */
export interface JObject {
  /** The object's class (for an array, its array class). */
  readonly cls: JClass;
  /** Instance fields, superclass fields first, indexed by `JField.slot`; empty for arrays. */
  readonly fields: JValue[];
  /** The object's monitor (§2.11.10), made on the first `monitorenter`, synchronized call or wait for class initialisation; null until then. */
  monitor: Monitor | null;
  /** The identity hash, 0 until `Heap.identityHash` gives one. */
  hash: number;
  /** Data the JVM's natives attach to the object (a Class mirror's JClass, a Thread's JThread, a Throwable's stack trace, a MemberName's target); null otherwise. */
  nativeData: unknown;
}

/**
 * The elements of an array, by component type: boolean and byte in Int8Array, char in Uint16Array, short in
 * Int16Array, int in Int32Array, float in Float32Array, double in Float64Array, long in BigInt64Array and references
 * in a plain array.
 */
export type ArrayData =
  | Int8Array
  | Uint16Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | (JObject | null)[];

/** A Java array (§2.4): an object whose elements are in `data`. Its length is `data.length`. */
export interface JArray extends JObject {
  readonly data: ArrayData;
}

/** Carries a Java exception through JS frames (loader and native code) to the interpreter. */
export class JavaThrowable extends Error {
  constructor(readonly obj: JObject) {
    super(obj.cls.name);
  }
}

/** Default value of a field or array element with this descriptor (§2.3, §2.4): 0, 0n for long, null for references. */
export function defaultValue(desc: string): JValue {
  const c = desc.charCodeAt(0);
  if (c === 0x4a) return 0n; // J
  if (c === 0x4c || c === 0x5b) return null; // L, [
  return 0;
}

/** Whether a descriptor is long or double, which take two local-variable and operand-stack slots (§2.6.1, §2.6.2). */
export const isWide = (desc: string): boolean => desc === 'J' || desc === 'D';
