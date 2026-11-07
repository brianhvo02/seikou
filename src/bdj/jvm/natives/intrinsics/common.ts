/*
 * Original code for bluray-web: what the BD-J virtual machine's intrinsics (index.ts) share.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { JClass, JMethod } from '../../loader';
import type { JThread } from '../../threads';
import type { Jvm } from '../../jvm';
import type { JObject, JValue } from '../../values';

/** An intrinsic's answer when the bytecode must run instead. */
export const DECLINE: unique symbol = Symbol('decline');

/**
 * Runs with the call's arguments still on the caller's operand stack, from `base` (the receiver first for instance
 * methods; a long or double takes two slots). Returns the method's value (undefined for void) or DECLINE, and must not
 * change anything when it declines. It never runs Java code, suspends or throws.
 */
export type IntrinsicFn = (jvm: Jvm, t: JThread, m: JMethod, stack: readonly JValue[], base: number) => JValue | undefined | typeof DECLINE;

/**
 * Runs at a loop's backward `goto` (after one iteration of the bytecode) with the frame's locals, which the operand
 * stack does not hold at that point: does the remaining iterations, leaves the locals as the bytecode would, and
 * returns the pc where the loop exits; or declines, without changing anything, and the goto runs.
 */
export type LoopHookFn = (jvm: Jvm, t: JThread, m: JMethod, locals: JValue[]) => number | typeof DECLINE;

/** A loop hook on the goto at `pc` of a method whose bytecode has the given checksum (codeChecksum). */
export interface LoopHook {
  readonly pc: number;
  readonly checksum: number;
  readonly fn: LoopHookFn;
}

/** The opcode a hooked goto is rewritten to in the interpreter's copy of the code (one the JVM leaves unused). */
export const HOOKED_GOTO = 0xcb;

/** FNV-1a over a method's bytecode: a loop hook reads the frame's locals by slot, so it applies to that code only. */
export function codeChecksum(code: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) h = Math.imul(h ^ code[i]!, 0x01000193);
  return h >>> 0;
}

/** A rectangle's x, y, width and height, as Rectangle.intersection leaves them. */
export interface Span {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Computations of the class library's code that the engine's intrinsics call but do not carry. */
export interface ClassLibraryHelpers {
  /**
   * clip.intersection(new Rectangle(x, y, w, h)) into `out` for a plain java.awt.Rectangle clip; false (nothing
   * changed) otherwise. Without it, the drawSpanN intrinsics decline.
   */
  rectangleIntersection?: (clip: JObject, x: number, y: number, w: number, h: number, out: Span) => boolean;
  /** By class-library class name: that class's getRGB(int) as a function of the pixel, or null where it could throw. */
  readonly pixelConverters: Map<string, (cm: JObject) => ((pixel: number) => number) | null>;
}

/** The slot of an instance field (or, with `isStatic`, a static one) found from `cls` as getfield resolves it. */
export function slotOf(cls: JClass, name: string, desc: string, isStatic = false): number {
  const f = cls.findField(name, desc);
  if (!f || f.isStatic !== isStatic) throw new Error(`intrinsic: ${cls.name} has no ${isStatic ? 'static' : 'instance'} field ${name} ${desc}`);
  return f.slot;
}

/** Every perClass cache's reset of its one-entry fast path. */
const fastPaths: (() => void)[] = [];

/**
 * Forgets the classes perClass's fast paths hold: a halted JVM is then held by nothing here (these caches are
 * module-wide, so in a test process that runs several JVMs the last class seen would keep its whole JVM alive).
 */
export function dropPerClassFastPaths(): void {
  for (const reset of fastPaths) reset();
}

/** Per-class data an intrinsic computes once (field slots), with a one-entry fast path. */
export function perClass<T>(make: (cls: JClass) => T): (cls: JClass) => T {
  const all = new WeakMap<JClass, T>();
  let lastCls: JClass | null = null;
  let last: T | undefined;
  fastPaths.push(() => {
    lastCls = null;
    last = undefined;
  });
  return (cls) => {
    if (cls === lastCls) return last as T;
    let v = all.get(cls);
    if (v === undefined) {
      v = make(cls);
      all.set(cls, v);
    }
    lastCls = cls;
    last = v;
    return v;
  };
}

/** True when `t` could enter and leave `o`'s monitor at once, with nothing else to see (no owner, no waiting entrants). */
export function monitorFree(t: JThread, o: JObject): boolean {
  const m = o.monitor;
  return m === null || m.owner === t || (m.owner === null && m.entrySet.length === 0);
}

/** f2i (JVM §6.5): NaN is 0, out-of-range values saturate. */
export function f2i(v: number): number {
  if (v !== v) return 0;
  if (v >= 2147483647) return 2147483647;
  if (v <= -2147483648) return -2147483648;
  return Math.trunc(v) | 0;
}
