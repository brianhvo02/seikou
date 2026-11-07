/*
 * Original code for bluray-web: the bytecode interpreter of the BD-J virtual machine (JVM specification, chapter 6).
 * Java calls never recurse in JS: each pushes a Frame on the thread, so a green thread can park mid-stack.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { CpEntry } from './classfile';
import { ACC_ABSTRACT, ACC_PRIVATE, LoadPending, externalName, selectMethod } from './loader';
import type { JClass, JField, JMethod } from './loader';
import { JavaThrowable, isWide } from './values';
import type { JArray, JObject, JValue } from './values';
import type { JThread } from './threads';
import type { Jvm } from './jvm';
import { linkCallSite, resolveConstant, signaturePolymorphic } from './natives/invoke';
import { DECLINE } from './natives/intrinsics/common';

export interface Frame {
  readonly method: JMethod;
  pc: number;
  readonly locals: JValue[];
  readonly stack: JValue[];
  sp: number;
  then?: (ret: JValue | undefined, thrown: JObject | null) => NativeResult;
}

export type NativeResult = JValue | undefined | Suspend | Invoke | ThrowResult;

/**
 * The thread parks until the promise settles; its value, passed through `k` when given, is the native method's result
 * (a rejection with a JavaThrowable reaches `k` as a ThrowResult). The promise must resolve to a plain JValue or
 * undefined, never to an Invoke or a Frame: both have a `then` property, so the promise machinery would call it as a
 * thenable and the thread would hang without an error.
 */
export class Suspend {
  constructor(
    readonly promise: Promise<JValue | undefined>,
    readonly k?: (r: JValue | undefined | ThrowResult) => NativeResult,
  ) {}
}

/** The promise of a Suspend the scheduler settles itself: the thread is in a monitor wait, a sleep or a park. */
export const BLOCKED: Promise<never> = new Promise<never>(() => {});

/** Calls exactly `method` (no virtual selection, no class initialisation) and continues with `then`. */
export class Invoke {
  constructor(
    readonly method: JMethod,
    readonly args: readonly JValue[],
    readonly then: (ret: JValue | undefined) => NativeResult,
    /** Receives an exception the call throws; without it the exception propagates. */
    readonly onThrow?: (thrown: JObject) => NativeResult,
  ) {}
}

export class ThrowResult {
  constructor(readonly exception: JObject) {}
}

export type ExitReason = 'budget' | 'blocked' | 'finished';

export const MAX_FRAMES = 4000;

class JFrame implements Frame {
  pc = 0;
  sp = 0;
  /** Where to continue once the call made at `pc` completes; `pc` itself to retry the instruction. */
  nextPc = 0;
  /** The pending native call returns a double, which takes two slots (a number alone does not say so). */
  wideResult = false;
  then: ((ret: JValue | undefined, thrown: JObject | null) => NativeResult) | undefined = undefined;
  /** The monitor a synchronized method holds. */
  lock: JObject | null = null;
  constructor(
    readonly method: JMethod,
    readonly locals: JValue[],
    readonly stack: JValue[],
  ) {}
}

/** An exception the interpreter raises, created once the frame's pc is saved so the stack trace is right. */
class PendingThrow {
  constructor(
    readonly cls: string,
    readonly message?: string,
  ) {}
}

/** Runs `k` on the result of `r` once any calls and suspensions it makes complete; exceptions go to `onThrow` when given. */
export function andThen(
  r: NativeResult,
  k: (ret: JValue | undefined) => NativeResult,
  onThrow?: (thrown: JObject) => NativeResult,
): NativeResult {
  if (r instanceof Invoke) {
    return new Invoke(
      r.method,
      r.args,
      (ret) => andThen(r.then(ret), k, onThrow),
      (e) => (r.onThrow ? andThen(r.onThrow(e), k, onThrow) : onThrow ? onThrow(e) : new ThrowResult(e)),
    );
  }
  if (r instanceof ThrowResult) return onThrow ? onThrow(r.exception) : r;
  if (r instanceof Suspend) {
    const s = r;
    return new Suspend(s.promise, (v) => andThen(s.k ? s.k(v) : v, k, onThrow));
  }
  return k(r);
}

function newFrame(m: JMethod): JFrame {
  let t = m.frameTemplate;
  if (t === undefined) {
    const code = m.code!;
    t = m.frameTemplate = { locals: new Array<JValue>(Math.max(code.maxLocals, m.argSlots)).fill(null), stack: new Array<JValue>(code.maxStack).fill(null) };
  }
  return new JFrame(m, t.locals.slice(), t.stack.slice());
}

/** Applies a native's result to the thread's top frame, or ends the thread when it has none. */
export function complete(jvm: Jvm, t: JThread, r: NativeResult): void {
  if (t.state === 'suspended-native') t.state = 'runnable';
  for (;;) {
    if (r instanceof Invoke) {
      const inv = r;
      const m = inv.method;
      if (m.isNative) {
        if (jvm.threads.preempted) {
          jvm.threads.later(t, inv);
          return;
        }
        const lock = m.isSynchronized ? (m.isStatic ? jvm.mirror(m.cls) : (inv.args[0] as JObject)) : null;
        if (lock && !jvm.threads.monitorEnter(t, lock)) {
          jvm.threads.later(t, inv);
          return;
        }
        r = andThen(unlocking(jvm, t, lock, callNative(jvm, t, m, inv.args)), inv.then, inv.onThrow);
        continue;
      }
      if (m.intrinsic !== undefined && m.argSlots === inv.args.length && t.frames.length < MAX_FRAMES) {
        // one slot per argument (no long or double), so the arguments are laid out as on an operand stack
        const v = m.intrinsic(jvm, t, m, inv.args, 0);
        if (v !== DECLINE) {
          r = inv.then(v);
          continue;
        }
      }
      const thrown = (e: JObject): NativeResult => (inv.onThrow ? inv.onThrow(e) : new ThrowResult(e));
      if (!m.code) {
        r = thrown(jvm.throwNew('java/lang/AbstractMethodError', `${externalName(m.cls.name)}.${m.name}${m.desc}`).exception);
        continue;
      }
      if (t.frames.length >= MAX_FRAMES) {
        r = thrown(jvm.throwNew('java/lang/StackOverflowError').exception);
        continue;
      }
      const callee = newFrame(m);
      let s = 0;
      let k = 0;
      if (!m.isStatic) callee.locals[s++] = inv.args[k++]!;
      for (const a of m.argTypes) {
        callee.locals[s] = inv.args[k++]!;
        s += isWide(a) ? 2 : 1;
      }
      callee.then = (ret, e) => (e ? thrown(e) : inv.then(ret));
      if (m.isSynchronized) {
        callee.lock = m.isStatic ? jvm.mirror(m.cls) : (callee.locals[0] as JObject);
        if (!jvm.threads.monitorEnter(t, callee.lock)) {
          jvm.threads.later(t, inv);
          return;
        }
      }
      t.frames.push(callee);
      return;
    }
    if (r instanceof ThrowResult) {
      throwInto(jvm, t, r.exception);
      return;
    }
    if (r instanceof Suspend) {
      jvm.threads.suspend(t, r);
      return;
    }
    const caller = t.frames[t.frames.length - 1] as JFrame | undefined;
    if (!caller) {
      t.state = 'terminated';
      return;
    }
    if (r !== undefined) {
      caller.stack[caller.sp++] = r;
      if (typeof r === 'bigint' || caller.wideResult) caller.sp++;
    }
    caller.pc = caller.nextPc;
    return;
  }
}

/** Releases a synchronized native's monitor once its result is complete, whether it returns or throws. */
function unlocking(jvm: Jvm, t: JThread, lock: JObject | null, r: NativeResult): NativeResult {
  if (!lock) return r;
  return andThen(
    r,
    (v) => {
      jvm.threads.monitorExit(t, lock);
      return v;
    },
    (e) => {
      jvm.threads.monitorExit(t, lock);
      return new ThrowResult(e);
    },
  );
}

const NO_VALUES: JValue[] = [];

/**
 * Runs a native with a marker frame on the thread while it runs synchronously, so stack walks (exceptions it
 * throws, getCallerClass) see it as HotSpot's native frame; the marker is gone before its result is applied.
 */
function callNative(jvm: Jvm, t: JThread, m: JMethod, args: readonly JValue[]): NativeResult {
  t.frames.push(new JFrame(m, NO_VALUES, NO_VALUES));
  let failed = false;
  try {
    const fn = (m.native ??= jvm.natives.get(m.nativeKey));
    if (!fn) return jvm.throwNew('java/lang/UnsatisfiedLinkError', m.nativeKey);
    return fn({ jvm, thread: t, method: m }, ...args);
  } catch (e) {
    if (e instanceof JavaThrowable) return new ThrowResult(e.obj);
    failed = true; // a JS error stops the runtime; the marker stays so the fault's stack shows the native
    throw e;
  } finally {
    if (!failed && t.frames[t.frames.length - 1]?.method === m) t.frames.pop();
  }
}

/**
 * A debug aid (the BD-J library check): sees each Java method an exception unwinds into, in order, with whether a
 * handler there takes it, and `method` null when it ends its thread uncaught. A rethrow of the same object unwinds
 * again, so the observer sees every method the object ever reached.
 */
export type UnwindObserver = (exc: JObject, method: JMethod | null, caught: boolean) => void;

let unwindObserver: UnwindObserver | null = null;

/** Starts observing unwinds (null stops). */
export function setUnwindObserver(o: UnwindObserver | null): void {
  unwindObserver = o;
}

/** Unwinds to the nearest handler for `exc` (JVM §2.10); a frame with `then` receives the exception instead. */
export function throwInto(jvm: Jvm, t: JThread, exc: JObject): void {
  for (;;) {
    const f = t.frames[t.frames.length - 1] as JFrame | undefined;
    if (!f) {
      unwindObserver?.(exc, null, false);
      t.uncaught = exc;
      t.state = 'terminated';
      return;
    }
    const handler = findHandler(jvm, f, exc);
    unwindObserver?.(exc, f.method, handler >= 0);
    if (handler >= 0) {
      f.stack[0] = exc;
      f.sp = 1;
      f.pc = handler;
      return;
    }
    t.frames.pop();
    if (f.lock) jvm.threads.monitorExit(t, f.lock);
    if (f.then) {
      const r = f.then(undefined, exc);
      if (r instanceof ThrowResult) {
        exc = r.exception;
        continue;
      }
      complete(jvm, t, r);
      return;
    }
  }
}

function findHandler(jvm: Jvm, f: JFrame, exc: JObject): number {
  for (const h of f.method.code!.handlers) {
    if (f.pc < h.startPc || f.pc >= h.endPc) continue;
    if (h.catchType === 0) return h.handlerPc;
    let type: JClass;
    try {
      type = resolveClass(jvm, f.method.cls, h.catchType);
    } catch (e) {
      if (e instanceof JavaThrowable) continue;
      if (!(e instanceof LoadPending)) throw e;
      // The frame's loader has not loaded the catch type yet; the exception's own superclasses decide by name.
      const name = utf8(f.method.cls, (cpEntry(f.method.cls, h.catchType) as { name: number }).name);
      for (let c: JClass | null = exc.cls; c; c = c.superClass) if (c.name === name) return h.handlerPc;
      continue;
    }
    if (exc.cls.isSubclassOf(type)) return h.handlerPc;
  }
  return -1;
}

function cpEntry(cls: JClass, index: number): CpEntry {
  return cls.file!.cp[index] ?? null;
}

function utf8(cls: JClass, index: number): string {
  const e = cpEntry(cls, index);
  if (e?.tag !== 'utf8') throw new PendingThrow('java/lang/ClassFormatError', `constant ${index} is not a Utf8`);
  return e.value;
}

function resolveClass(jvm: Jvm, cls: JClass, index: number): JClass {
  const hit = cls.resolved[index];
  if (hit) return hit as JClass;
  const e = cpEntry(cls, index);
  if (e?.tag !== 'class') throw new PendingThrow('java/lang/ClassFormatError', `constant ${index} is not a Class`);
  const c = jvm.loader.resolveClass(cls, utf8(cls, e.name));
  cls.resolved[index] = c;
  return c;
}

function resolveField(jvm: Jvm, cls: JClass, index: number): JField {
  const hit = cls.resolved[index];
  if (hit) return hit as JField;
  const e = cpEntry(cls, index);
  if (e?.tag !== 'fieldref') throw new PendingThrow('java/lang/ClassFormatError', `constant ${index} is not a Fieldref`);
  const owner = resolveClass(jvm, cls, e.cls);
  const nat = cpEntry(cls, e.nat);
  if (nat?.tag !== 'nat') throw new PendingThrow('java/lang/ClassFormatError', `constant ${e.nat} is not a NameAndType`);
  const name = utf8(cls, nat.name);
  const f = owner.findField(name, utf8(cls, nat.desc));
  if (!f) throw new PendingThrow('java/lang/NoSuchFieldError', name);
  cls.resolved[index] = f;
  return f;
}

function resolveMethod(jvm: Jvm, cls: JClass, index: number): JMethod {
  const hit = cls.resolved[index];
  if (hit) return hit as JMethod;
  const e = cpEntry(cls, index);
  if (e?.tag !== 'methodref' && e?.tag !== 'imethodref') {
    throw new PendingThrow('java/lang/ClassFormatError', `constant ${index} is not a Methodref`);
  }
  const owner = resolveClass(jvm, cls, e.cls);
  const nat = cpEntry(cls, e.nat);
  if (nat?.tag !== 'nat') throw new PendingThrow('java/lang/ClassFormatError', `constant ${e.nat} is not a NameAndType`);
  const name = utf8(cls, nat.name);
  const desc = utf8(cls, nat.desc);
  const m =
    (e.tag === 'methodref' ? signaturePolymorphic(jvm, cls, owner, name, desc) : null) ??
    (e.tag === 'imethodref' ? owner.findInterfaceMethod(name, desc) : owner.findMethod(name, desc));
  if (!m) throw new PendingThrow('java/lang/NoSuchMethodError', `${externalName(owner.name)}.${name}${desc}`);
  cls.resolved[index] = m;
  return m;
}

/** ldc and ldc_w: int, float, String, Class, MethodType or MethodHandle. */
function resolveLdc(jvm: Jvm, t: JThread, cls: JClass, index: number): JValue {
  const e = cpEntry(cls, index);
  switch (e?.tag) {
    case 'int':
    case 'float':
      return e.value;
    case 'string': {
      const hit = cls.resolved[index];
      if (hit) return hit as JObject;
      const s = jvm.heap.intern(utf8(cls, e.utf8));
      cls.resolved[index] = s;
      return s;
    }
    case 'class':
      return jvm.mirror(resolveClass(jvm, cls, index));
    case 'mtype':
    case 'mhandle': {
      const hit = cls.resolved[index];
      if (hit) return hit as JObject;
      throw new LoadPending(resolveConstant(jvm, t, cls, index));
    }
    default:
      throw new PendingThrow('java/lang/ClassFormatError', `bad ldc constant ${index}`);
  }
}

function ldc2(cls: JClass, index: number): number | bigint {
  const e = cpEntry(cls, index);
  if (e?.tag === 'long' || e?.tag === 'double') return e.value;
  throw new PendingThrow('java/lang/ClassFormatError', `bad ldc2_w constant ${index}`);
}

/**
 * A method whose whole bytecode is one of a few shapes that cannot throw or call anything (javac's empty methods and
 * constructors chaining to one, constant returns, field getters and setters on `this`), which a call can do without a
 * frame. Shapes with a constant-pool reference count only once it is resolved, so recognising one has no effects.
 */
export type Tiny =
  | { readonly kind: 'void' }
  | { readonly kind: 'const'; readonly value: JValue }
  | { readonly kind: 'get'; readonly slot: number; readonly wide: boolean }
  | { readonly kind: 'length'; readonly slot: number }
  | { readonly kind: 'set'; readonly slot: number };

const TINY_VOID: Tiny = { kind: 'void' };
const RETURNS = new Set([0xac, 0xad, 0xae, 0xaf, 0xb0]);

/** m's Tiny shape, null when it has none; undefined (and nothing cached) while a reference it needs is unresolved. */
function tinyOf(m: JMethod): Tiny | null | undefined {
  if (m.tiny !== undefined) return m.tiny;
  const code = m.code?.code;
  if (!code || m.isNative || m.isSynchronized || m.intrinsic !== undefined || m.loopHooks !== undefined || code.length > 6) return (m.tiny = null);
  // the getfield or putfield's resolved field (resolved entries of a Fieldref are JFields, which alone have a slot)
  const resolvedField = (at: number): JField | undefined | null => {
    const hit = m.cls.resolved[(code[at]! << 8) | code[at + 1]!] as JField | undefined;
    if (hit === undefined) return undefined;
    return typeof hit.slot === 'number' && !hit.isStatic ? hit : null;
  };
  let tiny: Tiny | null | undefined = null;
  if (code.length === 1 && code[0] === 0xb1) tiny = TINY_VOID;
  else if (code.length === 2 && code[0]! >= 0x02 && code[0]! <= 0x08 && code[1] === 0xac) tiny = { kind: 'const', value: code[0]! - 0x03 };
  else if (code.length === 2 && code[0] === 0x01 && code[1] === 0xb0) tiny = { kind: 'const', value: null };
  else if (!m.isStatic && code[0] === 0x2a && code[1] === 0xb4 && code.length === 5 && RETURNS.has(code[4]!)) {
    const fld = resolvedField(2);
    tiny = fld ? { kind: 'get', slot: fld.slot, wide: fld.wide } : fld;
  } else if (!m.isStatic && code[0] === 0x2a && code[1] === 0xb4 && code.length === 6 && code[4] === 0xbe && code[5] === 0xac) {
    const fld = resolvedField(2);
    tiny = fld ? { kind: 'length', slot: fld.slot } : fld;
  } else if (!m.isStatic && code[0] === 0x2a && code.length === 6 && code[2] === 0xb5 && code[5] === 0xb1 && [0x1b, 0x1f, 0x23, 0x27, 0x2b].includes(code[1]!)) {
    const fld = resolvedField(3);
    tiny = fld ? { kind: 'set', slot: fld.slot } : fld;
  } else if (!m.isStatic && m.name === '<init>' && code.length === 5 && code[0] === 0x2a && code[1] === 0xb7 && code[4] === 0xb1) {
    // a constructor that only chains to an empty no-argument one
    const hit = m.cls.resolved[(code[2]! << 8) | code[3]!] as JMethod | undefined;
    if (hit === undefined) tiny = undefined;
    else if (hit.name === '<init>' && hit.desc === '()V') {
      const inner = tinyOf(hit);
      tiny = inner === undefined ? undefined : inner?.kind === 'void' ? TINY_VOID : null;
    }
  }
  if (tiny !== undefined) m.tiny = tiny;
  return tiny;
}

/** Pops the arguments for `m` from `f` and calls it: a new frame for Java code, the native function otherwise. */
function call(jvm: Jvm, t: JThread, f: JFrame, m: JMethod, nextPc: number): void {
  if (profile) profile.calls.set(m, (profile.calls.get(m) ?? 0) + 1);
  const tiny = m.tiny === null ? null : tinyOf(m);
  if (tiny && t.frames.length < MAX_FRAMES) {
    const base = f.sp - m.argSlots;
    switch (tiny.kind) {
      case 'void':
        f.sp = base;
        break;
      case 'const':
        f.stack[base] = tiny.value;
        f.sp = base + 1;
        break;
      case 'get':
        f.stack[base] = (f.stack[base] as JObject).fields[tiny.slot]!;
        f.sp = base + (tiny.wide ? 2 : 1);
        break;
      case 'length': {
        const arr = (f.stack[base] as JObject).fields[tiny.slot] as JArray | null;
        if (arr === null) return callFrame(jvm, t, f, m, nextPc); // the bytecode throws the NullPointerException
        f.stack[base] = arr.data.length;
        f.sp = base + 1;
        break;
      }
      case 'set':
        (f.stack[base] as JObject).fields[tiny.slot] = f.stack[base + 1]!;
        f.sp = base;
        break;
    }
    f.pc = nextPc;
    return;
  }
  callFrame(jvm, t, f, m, nextPc);
}

function callFrame(jvm: Jvm, t: JThread, f: JFrame, m: JMethod, nextPc: number): void {
  const intrinsic = m.intrinsic;
  // at the frame limit the call throws StackOverflowError, as the bytecode's frame would
  if (intrinsic !== undefined && t.frames.length < MAX_FRAMES) {
    const base = f.sp - m.argSlots;
    const v = intrinsic(jvm, t, m, f.stack, base);
    if (v !== DECLINE) {
      f.sp = base;
      if (v !== undefined) {
        f.stack[base] = v;
        f.sp = base + (m.returnType === 'J' || m.returnType === 'D' ? 2 : 1);
      }
      f.pc = nextPc;
      return;
    }
  }
  if (m.isNative) {
    let s = f.sp - m.argSlots;
    const lock = m.isSynchronized ? (m.isStatic ? jvm.mirror(m.cls) : (f.stack[s] as JObject)) : null;
    if (lock && !jvm.threads.monitorEnter(t, lock)) return; // blocked: the instruction runs again
    f.sp = s;
    const args: JValue[] = [];
    if (!m.isStatic) args.push(f.stack[s++]!);
    for (const a of m.argTypes) {
      args.push(f.stack[s]!);
      s += isWide(a) ? 2 : 1;
    }
    f.nextPc = nextPc;
    f.wideResult = m.returnType === 'D';
    complete(jvm, t, unlocking(jvm, t, lock, callNative(jvm, t, m, args)));
    return;
  }
  if (!m.code) throw new PendingThrow('java/lang/AbstractMethodError', `${externalName(m.cls.name)}.${m.name}${m.desc}`);
  if (t.frames.length >= MAX_FRAMES) throw new PendingThrow('java/lang/StackOverflowError');
  let lock: JObject | null = null;
  if (m.isSynchronized) {
    lock = m.isStatic ? jvm.mirror(m.cls) : (f.stack[f.sp - m.argSlots] as JObject);
    if (!jvm.threads.monitorEnter(t, lock)) return; // blocked: the instruction runs again
  }
  const callee = newFrame(m);
  callee.lock = lock;
  const base = f.sp - m.argSlots;
  for (let i = 0; i < m.argSlots; i++) callee.locals[i] = f.stack[base + i]!;
  f.sp = base;
  f.nextPc = nextPc;
  t.frames.push(callee);
}

/** Pops the returning frame and hands its value to the caller. */
function ret(jvm: Jvm, t: JThread, f: JFrame, v: JValue | undefined, wide: boolean): void {
  t.frames.pop();
  if (f.lock) jvm.threads.monitorExit(t, f.lock);
  if (f.then) {
    complete(jvm, t, f.then(v, null));
    return;
  }
  const caller = t.frames[t.frames.length - 1] as JFrame | undefined;
  if (!caller) {
    t.state = 'terminated';
    return;
  }
  if (v !== undefined) {
    caller.stack[caller.sp] = v;
    caller.sp += wide ? 2 : 1;
  }
  caller.pc = caller.nextPc;
}

/** Class initialisation before new, getstatic, putstatic and invokestatic; false when the frame must retry later. */
function ensureInit(jvm: Jvm, t: JThread, f: JFrame, c: JClass): boolean {
  const r = jvm.loader.initialize(t, c);
  if (r === null || r === undefined) return true;
  f.nextPc = f.pc;
  f.wideResult = false;
  complete(jvm, t, r);
  return false;
}

const INT_MIN = -2147483648;
const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;

function toInt(v: number): number {
  if (v !== v) return 0;
  if (v >= 2147483647) return 2147483647;
  if (v <= INT_MIN) return INT_MIN;
  return Math.trunc(v) | 0;
}

function toLong(v: number): bigint {
  if (v !== v) return 0n;
  if (v >= 9223372036854775807) return LONG_MAX;
  if (v <= -9223372036854775808) return LONG_MIN;
  return BigInt(Math.trunc(v));
}

/** Rounds once, to float: Number(bigint) first would round to double and then again. */
function longToFloat(a: bigint): number {
  const n = Number(a);
  if (Math.abs(n) < 2 ** 53) return Math.fround(n);
  const neg = a < 0n;
  const x = neg ? -a : a;
  const shift = x.toString(2).length - 26;
  const big = BigInt(shift);
  const sticky = (x & ((1n << big) - 1n)) !== 0n ? 1n : 0n;
  const r = Math.fround(Number((x >> big) | sticky) * 2 ** shift);
  return neg ? -r : r;
}

function fcmp(a: number, b: number, nan: number): number {
  if (a > b) return 1;
  if (a < b) return -1;
  if (a === b) return 0;
  return nan;
}

function checkIndex(arr: JArray | null, i: number): JArray {
  if (arr === null) throw new PendingThrow('java/lang/NullPointerException');
  if (i >>> 0 >= arr.data.length) throw new PendingThrow('java/lang/ArrayIndexOutOfBoundsException', String(i));
  return arr;
}

function multiArray(jvm: Jvm, cls: JClass, counts: readonly number[], d: number): JArray {
  const arr = jvm.heap.newArray(cls, counts[d]!);
  if (d + 1 < counts.length) {
    const data = arr.data as (JObject | null)[];
    for (let i = 0; i < data.length; i++) data[i] = multiArray(jvm, cls.componentType!, counts, d + 1);
  }
  return arr;
}

const NEWARRAY_TYPES = ['', '', '', '', 'Z', 'C', 'F', 'D', 'B', 'S', 'I', 'J'];

/** Per-method counts while profiling (a debug aid): bytecodes run in the method itself, and calls of it. */
export interface BytecodeProfile {
  readonly bytecodes: Map<JMethod, number>;
  readonly calls: Map<JMethod, number>;
}

let profile: BytecodeProfile | null = null;

/** Starts counting bytecodes and calls per method (null stops); the counts slow the interpreter down. */
export function setBytecodeProfile(p: BytecodeProfile | null): void {
  profile = p;
}

export function execute(jvm: Jvm, t: JThread, budget: number): ExitReason {
  if (t.state === 'terminated') return 'finished';
  if (t.state !== 'runnable') return 'blocked';
  const previous = jvm.currentThread;
  jvm.currentThread = t;
  try {
    return run(jvm, t, budget);
  } finally {
    jvm.currentThread = previous;
  }
}

function run(jvm: Jvm, t: JThread, budget: number): ExitReason {
  const prof = profile;
  let profMethod: JMethod | null = null;
  let profBudget = budget;
  outer: for (;;) {
    if (prof && profMethod) {
      prof.bytecodes.set(profMethod, (prof.bytecodes.get(profMethod) ?? 0) + (profBudget - budget));
      profMethod = null;
    }
    if (t.state === 'terminated') return 'finished';
    if (t.state !== 'runnable') return 'blocked';
    if (jvm.threads.preempted) return 'budget';
    const f = t.frames[t.frames.length - 1] as JFrame | undefined;
    if (!f) {
      t.state = 'terminated';
      return 'finished';
    }
    if (prof) {
      profMethod = f.method;
      profBudget = budget;
    }
    const cls = f.method.cls;
    const code = f.method.code!.code;
    const stack = f.stack;
    const locals = f.locals;
    let pc = f.pc;
    let sp = f.sp;
    try {
      for (;;) {
        if (--budget < 0) {
          f.pc = pc;
          f.sp = sp;
          if (prof) prof.bytecodes.set(f.method, (prof.bytecodes.get(f.method) ?? 0) + (profBudget - budget - 1));
          return 'budget';
        }
        const op = code[pc]!;
        // The frame's pc is needed by what can see it: calls, class initialisation and loading, exceptions made on
        // the spot, monitors (all from getstatic on, and ldc). The other instructions throw only PendingThrow, whose
        // catch below stores it.
        if (op >= 0xb2 || op === 0x12 || op === 0x13) f.pc = pc;
        switch (op) {
          case 0x00: // nop
            pc++;
            break;
          case 0x01: // aconst_null
            stack[sp++] = null;
            pc++;
            break;
          case 0x02: case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08: // iconst_<i>
            stack[sp++] = op - 0x03;
            pc++;
            break;
          case 0x09: case 0x0a: // lconst_<l>
            stack[sp] = BigInt(op - 0x09);
            sp += 2;
            pc++;
            break;
          case 0x0b: case 0x0c: case 0x0d: // fconst_<f>
            stack[sp++] = op - 0x0b;
            pc++;
            break;
          case 0x0e: case 0x0f: // dconst_<d>
            stack[sp] = op - 0x0e;
            sp += 2;
            pc++;
            break;
          case 0x10: // bipush
            stack[sp++] = (code[pc + 1]! << 24) >> 24;
            pc += 2;
            break;
          case 0x11: // sipush
            stack[sp++] = (((code[pc + 1]! << 8) | code[pc + 2]!) << 16) >> 16;
            pc += 3;
            break;
          case 0x12: { // ldc
            const v = resolveLdc(jvm, t, cls, code[pc + 1]!);
            stack[sp++] = v;
            pc += 2;
            break;
          }
          case 0x13: { // ldc_w
            const v = resolveLdc(jvm, t, cls, (code[pc + 1]! << 8) | code[pc + 2]!);
            stack[sp++] = v;
            pc += 3;
            break;
          }
          case 0x14: // ldc2_w
            stack[sp] = ldc2(cls, (code[pc + 1]! << 8) | code[pc + 2]!);
            sp += 2;
            pc += 3;
            break;
          case 0x15: case 0x17: case 0x19: // iload, fload, aload
            stack[sp++] = locals[code[pc + 1]!]!;
            pc += 2;
            break;
          case 0x16: case 0x18: // lload, dload
            stack[sp] = locals[code[pc + 1]!]!;
            sp += 2;
            pc += 2;
            break;
          case 0x1a: case 0x1b: case 0x1c: case 0x1d: // iload_<n>
            stack[sp++] = locals[op - 0x1a]!;
            pc++;
            break;
          case 0x1e: case 0x1f: case 0x20: case 0x21: // lload_<n>
            stack[sp] = locals[op - 0x1e]!;
            sp += 2;
            pc++;
            break;
          case 0x22: case 0x23: case 0x24: case 0x25: // fload_<n>
            stack[sp++] = locals[op - 0x22]!;
            pc++;
            break;
          case 0x26: case 0x27: case 0x28: case 0x29: // dload_<n>
            stack[sp] = locals[op - 0x26]!;
            sp += 2;
            pc++;
            break;
          case 0x2a: case 0x2b: case 0x2c: case 0x2d: // aload_<n>
            stack[sp++] = locals[op - 0x2a]!;
            pc++;
            break;
          case 0x2e: case 0x30: case 0x32: case 0x33: case 0x34: case 0x35: { // iaload, faload, aaload, baload, caload, saload
            const i = stack[--sp] as number;
            const arr = checkIndex(stack[sp - 1] as JArray | null, i);
            stack[sp - 1] = arr.data[i]!;
            pc++;
            break;
          }
          case 0x2f: case 0x31: { // laload, daload
            const i = stack[--sp] as number;
            const arr = checkIndex(stack[sp - 1] as JArray | null, i);
            stack[sp - 1] = arr.data[i]!;
            sp++;
            pc++;
            break;
          }
          case 0x36: case 0x38: case 0x3a: // istore, fstore, astore
            locals[code[pc + 1]!] = stack[--sp]!;
            pc += 2;
            break;
          case 0x37: case 0x39: // lstore, dstore
            sp -= 2;
            locals[code[pc + 1]!] = stack[sp]!;
            pc += 2;
            break;
          case 0x3b: case 0x3c: case 0x3d: case 0x3e: // istore_<n>
            locals[op - 0x3b] = stack[--sp]!;
            pc++;
            break;
          case 0x3f: case 0x40: case 0x41: case 0x42: // lstore_<n>
            sp -= 2;
            locals[op - 0x3f] = stack[sp]!;
            pc++;
            break;
          case 0x43: case 0x44: case 0x45: case 0x46: // fstore_<n>
            locals[op - 0x43] = stack[--sp]!;
            pc++;
            break;
          case 0x47: case 0x48: case 0x49: case 0x4a: // dstore_<n>
            sp -= 2;
            locals[op - 0x47] = stack[sp]!;
            pc++;
            break;
          case 0x4b: case 0x4c: case 0x4d: case 0x4e: // astore_<n>
            locals[op - 0x4b] = stack[--sp]!;
            pc++;
            break;
          case 0x4f: case 0x51: case 0x55: case 0x56: { // iastore, fastore, castore, sastore
            const v = stack[--sp] as number;
            const i = stack[--sp] as number;
            const arr = checkIndex(stack[--sp] as JArray | null, i);
            (arr.data as Int32Array)[i] = v;
            pc++;
            break;
          }
          case 0x54: { // bastore
            const v = stack[--sp] as number;
            const i = stack[--sp] as number;
            const arr = checkIndex(stack[--sp] as JArray | null, i);
            (arr.data as Int8Array)[i] = arr.cls.name === '[Z' ? v & 1 : v;
            pc++;
            break;
          }
          case 0x50: case 0x52: { // lastore, dastore
            sp -= 2;
            const v = stack[sp]!;
            const i = stack[--sp] as number;
            const arr = checkIndex(stack[--sp] as JArray | null, i);
            (arr.data as unknown as JValue[])[i] = v;
            pc++;
            break;
          }
          case 0x53: { // aastore
            const v = stack[--sp] as JObject | null;
            const i = stack[--sp] as number;
            const arr = checkIndex(stack[--sp] as JArray | null, i);
            if (v !== null && !v.cls.isSubclassOf(arr.cls.componentType!)) {
              throw new PendingThrow('java/lang/ArrayStoreException', externalName(v.cls.name));
            }
            (arr.data as (JObject | null)[])[i] = v;
            pc++;
            break;
          }
          case 0x57: // pop
            sp--;
            pc++;
            break;
          case 0x58: // pop2
            sp -= 2;
            pc++;
            break;
          case 0x59: // dup
            stack[sp] = stack[sp - 1]!;
            sp++;
            pc++;
            break;
          case 0x5a: { // dup_x1
            const v1 = stack[sp - 1]!;
            stack[sp - 1] = stack[sp - 2]!;
            stack[sp - 2] = v1;
            stack[sp++] = v1;
            pc++;
            break;
          }
          case 0x5b: { // dup_x2
            const v1 = stack[sp - 1]!;
            stack[sp - 1] = stack[sp - 2]!;
            stack[sp - 2] = stack[sp - 3]!;
            stack[sp - 3] = v1;
            stack[sp++] = v1;
            pc++;
            break;
          }
          case 0x5c: // dup2
            stack[sp] = stack[sp - 2]!;
            stack[sp + 1] = stack[sp - 1]!;
            sp += 2;
            pc++;
            break;
          case 0x5d: { // dup2_x1
            const v1 = stack[sp - 1]!;
            const v2 = stack[sp - 2]!;
            const v3 = stack[sp - 3]!;
            stack[sp - 3] = v2;
            stack[sp - 2] = v1;
            stack[sp - 1] = v3;
            stack[sp] = v2;
            stack[sp + 1] = v1;
            sp += 2;
            pc++;
            break;
          }
          case 0x5e: { // dup2_x2
            const v1 = stack[sp - 1]!;
            const v2 = stack[sp - 2]!;
            const v3 = stack[sp - 3]!;
            const v4 = stack[sp - 4]!;
            stack[sp - 4] = v2;
            stack[sp - 3] = v1;
            stack[sp - 2] = v4;
            stack[sp - 1] = v3;
            stack[sp] = v2;
            stack[sp + 1] = v1;
            sp += 2;
            pc++;
            break;
          }
          case 0x5f: { // swap
            const v1 = stack[sp - 1]!;
            stack[sp - 1] = stack[sp - 2]!;
            stack[sp - 2] = v1;
            pc++;
            break;
          }
          case 0x60: // iadd
            sp--;
            stack[sp - 1] = ((stack[sp - 1] as number) + (stack[sp] as number)) | 0;
            pc++;
            break;
          case 0x61: // ladd
            sp -= 2;
            stack[sp - 2] = BigInt.asIntN(64, (stack[sp - 2] as bigint) + (stack[sp] as bigint));
            pc++;
            break;
          case 0x62: // fadd
            sp--;
            stack[sp - 1] = Math.fround((stack[sp - 1] as number) + (stack[sp] as number));
            pc++;
            break;
          case 0x63: // dadd
            sp -= 2;
            stack[sp - 2] = (stack[sp - 2] as number) + (stack[sp] as number);
            pc++;
            break;
          case 0x64: // isub
            sp--;
            stack[sp - 1] = ((stack[sp - 1] as number) - (stack[sp] as number)) | 0;
            pc++;
            break;
          case 0x65: // lsub
            sp -= 2;
            stack[sp - 2] = BigInt.asIntN(64, (stack[sp - 2] as bigint) - (stack[sp] as bigint));
            pc++;
            break;
          case 0x66: // fsub
            sp--;
            stack[sp - 1] = Math.fround((stack[sp - 1] as number) - (stack[sp] as number));
            pc++;
            break;
          case 0x67: // dsub
            sp -= 2;
            stack[sp - 2] = (stack[sp - 2] as number) - (stack[sp] as number);
            pc++;
            break;
          case 0x68: // imul
            sp--;
            stack[sp - 1] = Math.imul(stack[sp - 1] as number, stack[sp] as number);
            pc++;
            break;
          case 0x69: // lmul
            sp -= 2;
            stack[sp - 2] = BigInt.asIntN(64, (stack[sp - 2] as bigint) * (stack[sp] as bigint));
            pc++;
            break;
          case 0x6a: // fmul
            sp--;
            stack[sp - 1] = Math.fround((stack[sp - 1] as number) * (stack[sp] as number));
            pc++;
            break;
          case 0x6b: // dmul
            sp -= 2;
            stack[sp - 2] = (stack[sp - 2] as number) * (stack[sp] as number);
            pc++;
            break;
          case 0x6c: { // idiv
            const b = stack[--sp] as number;
            if (b === 0) throw new PendingThrow('java/lang/ArithmeticException', '/ by zero');
            stack[sp - 1] = ((stack[sp - 1] as number) / b) | 0;
            pc++;
            break;
          }
          case 0x6d: { // ldiv
            sp -= 2;
            const b = stack[sp] as bigint;
            if (b === 0n) throw new PendingThrow('java/lang/ArithmeticException', '/ by zero');
            stack[sp - 2] = BigInt.asIntN(64, (stack[sp - 2] as bigint) / b);
            pc++;
            break;
          }
          case 0x6e: // fdiv
            sp--;
            stack[sp - 1] = Math.fround((stack[sp - 1] as number) / (stack[sp] as number));
            pc++;
            break;
          case 0x6f: // ddiv
            sp -= 2;
            stack[sp - 2] = (stack[sp - 2] as number) / (stack[sp] as number);
            pc++;
            break;
          case 0x70: { // irem
            const b = stack[--sp] as number;
            if (b === 0) throw new PendingThrow('java/lang/ArithmeticException', '/ by zero');
            stack[sp - 1] = ((stack[sp - 1] as number) % b) | 0;
            pc++;
            break;
          }
          case 0x71: { // lrem
            sp -= 2;
            const b = stack[sp] as bigint;
            if (b === 0n) throw new PendingThrow('java/lang/ArithmeticException', '/ by zero');
            stack[sp - 2] = (stack[sp - 2] as bigint) % b;
            pc++;
            break;
          }
          case 0x72: // frem
            sp--;
            stack[sp - 1] = Math.fround((stack[sp - 1] as number) % (stack[sp] as number));
            pc++;
            break;
          case 0x73: // drem
            sp -= 2;
            stack[sp - 2] = (stack[sp - 2] as number) % (stack[sp] as number);
            pc++;
            break;
          case 0x74: // ineg
            stack[sp - 1] = -(stack[sp - 1] as number) | 0;
            pc++;
            break;
          case 0x75: // lneg
            stack[sp - 2] = BigInt.asIntN(64, -(stack[sp - 2] as bigint));
            pc++;
            break;
          case 0x76: // fneg
            stack[sp - 1] = -(stack[sp - 1] as number);
            pc++;
            break;
          case 0x77: // dneg
            stack[sp - 2] = -(stack[sp - 2] as number);
            pc++;
            break;
          case 0x78: // ishl
            sp--;
            stack[sp - 1] = (stack[sp - 1] as number) << (stack[sp] as number);
            pc++;
            break;
          case 0x79: // lshl
            sp--;
            stack[sp - 2] = BigInt.asIntN(64, (stack[sp - 2] as bigint) << BigInt((stack[sp] as number) & 63));
            pc++;
            break;
          case 0x7a: // ishr
            sp--;
            stack[sp - 1] = (stack[sp - 1] as number) >> (stack[sp] as number);
            pc++;
            break;
          case 0x7b: // lshr
            sp--;
            stack[sp - 2] = (stack[sp - 2] as bigint) >> BigInt((stack[sp] as number) & 63);
            pc++;
            break;
          case 0x7c: // iushr
            sp--;
            stack[sp - 1] = ((stack[sp - 1] as number) >>> (stack[sp] as number)) | 0;
            pc++;
            break;
          case 0x7d: // lushr
            sp--;
            stack[sp - 2] = BigInt.asIntN(64, BigInt.asUintN(64, stack[sp - 2] as bigint) >> BigInt((stack[sp] as number) & 63));
            pc++;
            break;
          case 0x7e: // iand
            sp--;
            stack[sp - 1] = (stack[sp - 1] as number) & (stack[sp] as number);
            pc++;
            break;
          case 0x7f: // land
            sp -= 2;
            stack[sp - 2] = (stack[sp - 2] as bigint) & (stack[sp] as bigint);
            pc++;
            break;
          case 0x80: // ior
            sp--;
            stack[sp - 1] = (stack[sp - 1] as number) | (stack[sp] as number);
            pc++;
            break;
          case 0x81: // lor
            sp -= 2;
            stack[sp - 2] = (stack[sp - 2] as bigint) | (stack[sp] as bigint);
            pc++;
            break;
          case 0x82: // ixor
            sp--;
            stack[sp - 1] = (stack[sp - 1] as number) ^ (stack[sp] as number);
            pc++;
            break;
          case 0x83: // lxor
            sp -= 2;
            stack[sp - 2] = (stack[sp - 2] as bigint) ^ (stack[sp] as bigint);
            pc++;
            break;
          case 0x84: { // iinc
            const n = code[pc + 1]!;
            locals[n] = ((locals[n] as number) + ((code[pc + 2]! << 24) >> 24)) | 0;
            pc += 3;
            break;
          }
          case 0x85: // i2l
            stack[sp - 1] = BigInt(stack[sp - 1] as number);
            sp++;
            pc++;
            break;
          case 0x86: // i2f
            stack[sp - 1] = Math.fround(stack[sp - 1] as number);
            pc++;
            break;
          case 0x87: // i2d
            sp++;
            pc++;
            break;
          case 0x88: // l2i
            sp--;
            stack[sp - 1] = Number(BigInt.asIntN(32, stack[sp - 1] as bigint));
            pc++;
            break;
          case 0x89: // l2f
            sp--;
            stack[sp - 1] = longToFloat(stack[sp - 1] as bigint);
            pc++;
            break;
          case 0x8a: // l2d
            stack[sp - 2] = Number(stack[sp - 2] as bigint);
            pc++;
            break;
          case 0x8b: // f2i
            stack[sp - 1] = toInt(stack[sp - 1] as number);
            pc++;
            break;
          case 0x8c: // f2l
            stack[sp - 1] = toLong(stack[sp - 1] as number);
            sp++;
            pc++;
            break;
          case 0x8d: // f2d
            sp++;
            pc++;
            break;
          case 0x8e: // d2i
            sp--;
            stack[sp - 1] = toInt(stack[sp - 1] as number);
            pc++;
            break;
          case 0x8f: // d2l
            stack[sp - 2] = toLong(stack[sp - 2] as number);
            pc++;
            break;
          case 0x90: // d2f
            sp--;
            stack[sp - 1] = Math.fround(stack[sp - 1] as number);
            pc++;
            break;
          case 0x91: // i2b
            stack[sp - 1] = ((stack[sp - 1] as number) << 24) >> 24;
            pc++;
            break;
          case 0x92: // i2c
            stack[sp - 1] = (stack[sp - 1] as number) & 0xffff;
            pc++;
            break;
          case 0x93: // i2s
            stack[sp - 1] = ((stack[sp - 1] as number) << 16) >> 16;
            pc++;
            break;
          case 0x94: { // lcmp
            sp -= 4;
            const a = stack[sp] as bigint;
            const b = stack[sp + 2] as bigint;
            stack[sp++] = a > b ? 1 : a < b ? -1 : 0;
            pc++;
            break;
          }
          case 0x95: case 0x96: // fcmpl, fcmpg
            sp--;
            stack[sp - 1] = fcmp(stack[sp - 1] as number, stack[sp] as number, op === 0x95 ? -1 : 1);
            pc++;
            break;
          case 0x97: case 0x98: // dcmpl, dcmpg
            sp -= 4;
            stack[sp] = fcmp(stack[sp] as number, stack[sp + 2] as number, op === 0x97 ? -1 : 1);
            sp++;
            pc++;
            break;
          case 0x99: case 0x9a: case 0x9b: case 0x9c: case 0x9d: case 0x9e: { // if<cond>
            const v = stack[--sp] as number;
            const taken =
              op === 0x99 ? v === 0 : op === 0x9a ? v !== 0 : op === 0x9b ? v < 0 : op === 0x9c ? v >= 0 : op === 0x9d ? v > 0 : v <= 0;
            pc += taken ? (((code[pc + 1]! << 8) | code[pc + 2]!) << 16) >> 16 : 3;
            break;
          }
          case 0x9f: case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4: { // if_icmp<cond>
            sp -= 2;
            const a = stack[sp] as number;
            const b = stack[sp + 1] as number;
            const taken =
              op === 0x9f ? a === b : op === 0xa0 ? a !== b : op === 0xa1 ? a < b : op === 0xa2 ? a >= b : op === 0xa3 ? a > b : a <= b;
            pc += taken ? (((code[pc + 1]! << 8) | code[pc + 2]!) << 16) >> 16 : 3;
            break;
          }
          case 0xa5: case 0xa6: { // if_acmpeq, if_acmpne
            sp -= 2;
            const same = stack[sp] === stack[sp + 1];
            pc += same === (op === 0xa5) ? (((code[pc + 1]! << 8) | code[pc + 2]!) << 16) >> 16 : 3;
            break;
          }
          case 0xa7: // goto
            pc += (((code[pc + 1]! << 8) | code[pc + 2]!) << 16) >> 16;
            break;
          case 0xa8: // jsr
            stack[sp++] = pc + 3;
            pc += (((code[pc + 1]! << 8) | code[pc + 2]!) << 16) >> 16;
            break;
          case 0xa9: // ret
            pc = locals[code[pc + 1]!] as number;
            break;
          case 0xaa: { // tableswitch
            const p = (pc + 4) & ~3;
            const i = stack[--sp] as number;
            const low = s32(code, p + 4);
            const high = s32(code, p + 8);
            pc += i < low || i > high ? s32(code, p) : s32(code, p + 12 + (i - low) * 4);
            break;
          }
          case 0xab: { // lookupswitch
            const p = (pc + 4) & ~3;
            const key = stack[--sp] as number;
            let lo = 0;
            let hi = s32(code, p + 4) - 1;
            let offset = s32(code, p);
            while (lo <= hi) {
              const mid = (lo + hi) >> 1;
              const k = s32(code, p + 8 + mid * 8);
              if (k < key) lo = mid + 1;
              else if (k > key) hi = mid - 1;
              else {
                offset = s32(code, p + 12 + mid * 8);
                break;
              }
            }
            pc += offset;
            break;
          }
          case 0xac: case 0xae: case 0xb0: // ireturn, freturn, areturn
            ret(jvm, t, f, stack[sp - 1]!, false);
            continue outer;
          case 0xad: case 0xaf: // lreturn, dreturn
            ret(jvm, t, f, stack[sp - 2]!, true);
            continue outer;
          case 0xb1: // return
            ret(jvm, t, f, undefined, false);
            continue outer;
          case 0xb2: { // getstatic
            const fld = resolveField(jvm, cls, (code[pc + 1]! << 8) | code[pc + 2]!);
            if (!fld.isStatic) throw new PendingThrow('java/lang/IncompatibleClassChangeError', `Expected static field ${externalName(fld.cls.name)}.${fld.name}`);
            if (fld.cls.state !== 'initialized') {
              f.sp = sp;
              if (!ensureInit(jvm, t, f, fld.cls)) continue outer;
            }
            stack[sp] = fld.cls.staticValues[fld.slot]!;
            sp += fld.wide ? 2 : 1;
            pc += 3;
            break;
          }
          case 0xb3: { // putstatic
            const fld = resolveField(jvm, cls, (code[pc + 1]! << 8) | code[pc + 2]!);
            if (!fld.isStatic) throw new PendingThrow('java/lang/IncompatibleClassChangeError', `Expected static field ${externalName(fld.cls.name)}.${fld.name}`);
            if (fld.cls.state !== 'initialized') {
              f.sp = sp;
              if (!ensureInit(jvm, t, f, fld.cls)) continue outer;
            }
            sp -= fld.wide ? 2 : 1;
            fld.cls.staticValues[fld.slot] = stack[sp]!;
            pc += 3;
            break;
          }
          case 0xb4: { // getfield
            const fld = resolveField(jvm, cls, (code[pc + 1]! << 8) | code[pc + 2]!);
            if (fld.isStatic) throw new PendingThrow('java/lang/IncompatibleClassChangeError', `Expected non-static field ${externalName(fld.cls.name)}.${fld.name}`);
            const o = stack[sp - 1] as JObject | null;
            if (o === null) throw new PendingThrow('java/lang/NullPointerException');
            stack[sp - 1] = o.fields[fld.slot]!;
            if (fld.wide) sp++;
            pc += 3;
            break;
          }
          case 0xb5: { // putfield
            const fld = resolveField(jvm, cls, (code[pc + 1]! << 8) | code[pc + 2]!);
            if (fld.isStatic) throw new PendingThrow('java/lang/IncompatibleClassChangeError', `Expected non-static field ${externalName(fld.cls.name)}.${fld.name}`);
            sp -= fld.wide ? 2 : 1;
            const v = stack[sp]!;
            const o = stack[--sp] as JObject | null;
            if (o === null) throw new PendingThrow('java/lang/NullPointerException');
            o.fields[fld.slot] = v;
            pc += 3;
            break;
          }
          case 0xb6: { // invokevirtual
            const m = resolveMethod(jvm, cls, (code[pc + 1]! << 8) | code[pc + 2]!);
            const recv = stack[sp - m.argSlots] as JObject | null;
            if (recv === null) throw new PendingThrow('java/lang/NullPointerException');
            let target = m;
            if (m.cls.isInterface) target = selectMethod(recv.cls, m) ?? m;
            else if (m.vtableIndex >= 0) target = recv.cls.vtable[m.vtableIndex]!;
            if (target.access & ACC_ABSTRACT) {
              throw new PendingThrow('java/lang/AbstractMethodError', `${externalName(recv.cls.name)}.${m.name}${m.desc}`);
            }
            f.sp = sp;
            call(jvm, t, f, target, pc + 3);
            continue outer;
          }
          case 0xb7: { // invokespecial
            let m = resolveMethod(jvm, cls, (code[pc + 1]! << 8) | code[pc + 2]!);
            if (stack[sp - m.argSlots] === null) throw new PendingThrow('java/lang/NullPointerException');
            if (
              m.name !== '<init>' &&
              (m.access & ACC_PRIVATE) === 0 &&
              !m.cls.isInterface &&
              m.cls !== cls &&
              (cls.access & 0x0020) !== 0 && // ACC_SUPER
              cls.isSubclassOf(m.cls)
            ) {
              m = cls.superClass!.findMethod(m.name, m.desc) ?? m;
            }
            f.sp = sp;
            call(jvm, t, f, m, pc + 3);
            continue outer;
          }
          case 0xb8: { // invokestatic
            const m = resolveMethod(jvm, cls, (code[pc + 1]! << 8) | code[pc + 2]!);
            if (!m.isStatic) throw new PendingThrow('java/lang/IncompatibleClassChangeError', `Expected static method ${externalName(m.cls.name)}.${m.name}${m.desc}`);
            f.sp = sp;
            if (m.cls.state !== 'initialized' && !ensureInit(jvm, t, f, m.cls)) continue outer;
            call(jvm, t, f, m, pc + 3);
            continue outer;
          }
          case 0xb9: { // invokeinterface
            const m = resolveMethod(jvm, cls, (code[pc + 1]! << 8) | code[pc + 2]!);
            const recv = stack[sp - m.argSlots] as JObject | null;
            if (recv === null) throw new PendingThrow('java/lang/NullPointerException');
            if (!recv.cls.isSubclassOf(m.cls)) {
              throw new PendingThrow(
                'java/lang/IncompatibleClassChangeError',
                `Class ${externalName(recv.cls.name)} does not implement the requested interface ${externalName(m.cls.name)}`,
              );
            }
            const target = selectMethod(recv.cls, m);
            if (!target || target.isAbstract) {
              throw new PendingThrow('java/lang/AbstractMethodError', `${externalName(recv.cls.name)}.${m.name}${m.desc}`);
            }
            f.sp = sp;
            call(jvm, t, f, target, pc + 5);
            continue outer;
          }
          case 0xba: { // invokedynamic: linked once per instruction, then a call of its call site
            const site = f.method.callSites?.get(pc);
            if (!site) throw new LoadPending(linkCallSite(jvm, t, f.method, pc, (code[pc + 1]! << 8) | code[pc + 2]!));
            f.sp = sp;
            call(jvm, t, f, site, pc + 5);
            continue outer;
          }
          case 0xbb: { // new
            const c = resolveClass(jvm, cls, (code[pc + 1]! << 8) | code[pc + 2]!);
            if (c.isInterface || c.access & ACC_ABSTRACT) throw new PendingThrow('java/lang/InstantiationError', externalName(c.name));
            if (c.state !== 'initialized') {
              f.sp = sp;
              if (!ensureInit(jvm, t, f, c)) continue outer;
            }
            stack[sp++] = jvm.heap.newObject(c);
            pc += 3;
            break;
          }
          case 0xbc: { // newarray
            const n = stack[sp - 1] as number;
            if (n < 0) throw new PendingThrow('java/lang/NegativeArraySizeException');
            const loader = jvm.loader;
            const type = NEWARRAY_TYPES[code[pc + 1]!] as 'Z' | 'C' | 'F' | 'D' | 'B' | 'S' | 'I' | 'J';
            stack[sp - 1] = jvm.heap.newArray(loader.arrayOf(loader.primitive(type)), n);
            pc += 2;
            break;
          }
          case 0xbd: { // anewarray
            const c = resolveClass(jvm, cls, (code[pc + 1]! << 8) | code[pc + 2]!);
            const n = stack[sp - 1] as number;
            if (n < 0) throw new PendingThrow('java/lang/NegativeArraySizeException');
            stack[sp - 1] = jvm.heap.newArray(jvm.loader.arrayOf(c), n);
            pc += 3;
            break;
          }
          case 0xbe: { // arraylength
            const arr = stack[sp - 1] as JArray | null;
            if (arr === null) throw new PendingThrow('java/lang/NullPointerException');
            stack[sp - 1] = arr.data.length;
            pc++;
            break;
          }
          case 0xbf: { // athrow
            const e = stack[sp - 1] as JObject | null;
            if (e === null) throw new PendingThrow('java/lang/NullPointerException');
            throwInto(jvm, t, e);
            continue outer;
          }
          case 0xc0: { // checkcast
            const o = stack[sp - 1] as JObject | null;
            if (o !== null) {
              const c = resolveClass(jvm, cls, (code[pc + 1]! << 8) | code[pc + 2]!);
              if (!o.cls.isSubclassOf(c)) {
                throw new PendingThrow('java/lang/ClassCastException', `${externalName(o.cls.name)} cannot be cast to ${externalName(c.name)}`);
              }
            }
            pc += 3;
            break;
          }
          case 0xc1: { // instanceof
            const o = stack[sp - 1] as JObject | null;
            stack[sp - 1] = o !== null && o.cls.isSubclassOf(resolveClass(jvm, cls, (code[pc + 1]! << 8) | code[pc + 2]!)) ? 1 : 0;
            pc += 3;
            break;
          }
          case 0xc2: { // monitorenter
            const o = stack[sp - 1] as JObject | null;
            if (o === null) throw new PendingThrow('java/lang/NullPointerException');
            if (!jvm.threads.monitorEnter(t, o)) {
              f.sp = sp;
              continue outer;
            }
            sp--;
            pc++;
            break;
          }
          case 0xc3: { // monitorexit
            const o = stack[--sp] as JObject | null;
            if (o === null) throw new PendingThrow('java/lang/NullPointerException');
            jvm.threads.monitorExit(t, o);
            pc++;
            if (jvm.threads.preempted) {
              // the monitor passed to another thread, which runs first (Ruling R19)
              f.pc = pc;
              f.sp = sp;
              // this instruction counted, unlike at the budget check (which stops before running one)
              if (prof) prof.bytecodes.set(f.method, (prof.bytecodes.get(f.method) ?? 0) + (profBudget - budget));
              return 'budget';
            }
            break;
          }
          case 0xc4: { // wide
            const wop = code[pc + 1]!;
            const n = (code[pc + 2]! << 8) | code[pc + 3]!;
            switch (wop) {
              case 0x15: case 0x17: case 0x19:
                stack[sp++] = locals[n]!;
                break;
              case 0x16: case 0x18:
                stack[sp] = locals[n]!;
                sp += 2;
                break;
              case 0x36: case 0x38: case 0x3a:
                locals[n] = stack[--sp]!;
                break;
              case 0x37: case 0x39:
                sp -= 2;
                locals[n] = stack[sp]!;
                break;
              case 0xa9:
                pc = locals[n] as number;
                continue;
              case 0x84:
                locals[n] = ((locals[n] as number) + ((((code[pc + 4]! << 8) | code[pc + 5]!) << 16) >> 16)) | 0;
                pc += 6;
                continue;
              default:
                throw new PendingThrow('java/lang/VerifyError', `bad wide opcode ${wop}`);
            }
            pc += 4;
            break;
          }
          case 0xc5: { // multianewarray
            const c = resolveClass(jvm, cls, (code[pc + 1]! << 8) | code[pc + 2]!);
            const dims = code[pc + 3]!;
            sp -= dims;
            const counts = stack.slice(sp, sp + dims) as number[];
            if (counts.some((n) => n < 0)) throw new PendingThrow('java/lang/NegativeArraySizeException');
            stack[sp++] = multiArray(jvm, c, counts, 0);
            pc += 4;
            break;
          }
          case 0xc6: case 0xc7: { // ifnull, ifnonnull
            const isNull = stack[--sp] === null;
            pc += isNull === (op === 0xc6) ? (((code[pc + 1]! << 8) | code[pc + 2]!) << 16) >> 16 : 3;
            break;
          }
          case 0xcb: { // a goto with a loop hook (natives/intrinsics)
            const next = f.method.loopHooks!.get(pc)!(jvm, t, f.method, locals);
            pc = next === DECLINE ? pc + ((((code[pc + 1]! << 8) | code[pc + 2]!) << 16) >> 16) : next;
            break;
          }
          case 0xc8: // goto_w
            pc += s32(code, pc + 1);
            break;
          case 0xc9: // jsr_w
            stack[sp++] = pc + 5;
            pc += s32(code, pc + 1);
            break;
          default:
            throw new PendingThrow('java/lang/VerifyError', `bad opcode ${op} in ${externalName(cls.name)}.${f.method.name}`);
        }
      }
    } catch (e) {
      f.pc = pc;
      if (e instanceof LoadPending) {
        // A Java class loader must load a class, or Java code link a call site or constant, first; the instruction
        // runs again afterwards.
        f.sp = sp;
        f.nextPc = f.pc;
        f.wideResult = false;
        complete(jvm, t, andThen(e.work, () => undefined));
        continue outer;
      }
      let exc: JObject;
      if (e instanceof PendingThrow) exc = jvm.throwNew(e.cls, e.message).exception;
      else if (e instanceof JavaThrowable) exc = e.obj;
      else throw e;
      throwInto(jvm, t, exc);
    }
  }
}

function s32(code: Uint8Array, p: number): number {
  return (code[p]! << 24) | (code[p + 1]! << 16) | (code[p + 2]! << 8) | code[p + 3]!;
}

