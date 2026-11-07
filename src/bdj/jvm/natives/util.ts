/*
 * Original code for bluray-web: helpers shared by the BD-J virtual machine's native methods.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { BLOCKED, Invoke, Suspend, ThrowResult, andThen } from '../interpreter';
import type { NativeResult } from '../interpreter';
import { selectMethod } from '../loader';
import type { JClass, JMethod } from '../loader';
import type { Jvm } from '../jvm';
import type { JThread } from '../threads';
import type { JArray, JObject, JValue } from '../values';

export const none = (): undefined => undefined;

/** Enters `o`'s monitor, blocking until it is free (retried when the scheduler wakes the thread), then runs `k`. */
export function withMonitor(jvm: Jvm, t: JThread, o: JObject, k: () => NativeResult): NativeResult {
  const attempt = (): NativeResult => {
    if (jvm.threads.monitorEnter(t, o)) return k();
    jvm.threads.onWake(t, attempt);
    return new Suspend(BLOCKED);
  };
  return attempt();
}

export function jsStr(jvm: Jvm, s: JValue): string {
  return jvm.heap.jsString(s as JObject | null) ?? '';
}

/** 'java.lang.String' → 'java/lang/String'. */
export const internalName = (name: string): string => name.replace(/\./g, '/');

/** The method `key` of `base`, selected for the receiver's class as invokevirtual or invokeinterface would. */
export function virtual(receiver: JObject, base: JClass, key: string): JMethod {
  const m = base.methods.get(key) ?? base.findMethod(key.slice(0, key.indexOf('(')), key.slice(key.indexOf('(')));
  if (!m) throw new Error(`${base.name}.${key} is missing`);
  if (m.cls.isInterface) return selectMethod(receiver.cls, m) ?? m;
  if (m.vtableIndex >= 0 && (m.access & 0x0002) === 0) return receiver.cls.vtable[m.vtableIndex] ?? m;
  return m;
}

export function method(c: JClass, key: string): JMethod {
  const m = c.methods.get(key);
  if (!m) throw new Error(`${c.name}.${key} is missing`);
  return m;
}

/** Runs `fn` on each item in turn (each may call Java), then `k`. */
export function each<T>(items: readonly T[], fn: (item: T) => NativeResult, k: () => NativeResult): NativeResult {
  const step = (i: number): NativeResult => (i >= items.length ? k() : andThen(fn(items[i]!), () => step(i + 1)));
  return step(0);
}

/** Creates an exception with its Java constructor `(desc)`, as HotSpot's THROW_ARG does, and throws it. */
export function throwConstructed(jvm: Jvm, t: JThread, cls: string, desc: string, args: readonly JValue[]): NativeResult {
  const c = jvm.bootClass(cls);
  return jvm.withInit(t, c, () => {
    const e = jvm.heap.newObject(c);
    return new Invoke(method(c, `<init>${desc}`), [e, ...args], () => new ThrowResult(e));
  });
}

export function byteArray(jvm: Jvm, bytes: Uint8Array | null): JArray | null {
  if (!bytes) return null;
  const loader = jvm.loader;
  const arr = jvm.heap.newArray(loader.arrayOf(loader.primitive('B')), bytes.length);
  (arr.data as Int8Array).set(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length));
  return arr;
}

const BOXES: Readonly<Record<string, string>> = {
  Z: 'java/lang/Boolean',
  B: 'java/lang/Byte',
  C: 'java/lang/Character',
  S: 'java/lang/Short',
  I: 'java/lang/Integer',
  J: 'java/lang/Long',
  F: 'java/lang/Float',
  D: 'java/lang/Double',
};

/** A new wrapper object, as HotSpot's Reflection::box allocates (not valueOf's cache). */
export function box(jvm: Jvm, desc: string, v: JValue | undefined): JValue {
  if (desc === 'V') return null;
  const name = BOXES[desc];
  if (!name) return v ?? null;
  const o = jvm.heap.newObject(jvm.bootClass(name));
  o.fields[o.cls.declaredField('value', desc)!.slot] = v!;
  return o;
}

/** The primitive descriptor of a wrapper object, or null. */
export function boxedType(o: JObject): string | null {
  for (const [d, n] of Object.entries(BOXES)) if (o.cls.name === n) return d;
  return null;
}

const WIDENS: Readonly<Record<string, string>> = {
  Z: 'Z',
  B: 'B',
  C: 'C',
  S: 'BS',
  I: 'BCSI',
  J: 'BCSIJ',
  F: 'BCSIJF',
  D: 'BCSIJFD',
};

/** A primitive value of type `from` widened to `to` (JLS §5.1.2), or undefined when that is not a widening. */
export function widen(v: JValue, from: string, to: string): JValue | undefined {
  if (!WIDENS[to]?.includes(from)) return undefined;
  if (to === 'J') return typeof v === 'bigint' ? v : BigInt(v as number);
  if (to === 'F') return Math.fround(Number(v));
  if (to === 'D') return Number(v);
  return v;
}

/** Unboxes a wrapper for a parameter of primitive type `to`, with widening; undefined on a mismatch. */
export function unbox(o: JValue, to: string): JValue | undefined {
  if (o === null || typeof o !== 'object') return undefined;
  const from = boxedType(o);
  if (!from) return undefined;
  return widen(o.fields[o.cls.declaredField('value', from)!.slot]!, from, to);
}
