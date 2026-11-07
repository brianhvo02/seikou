/*
 * Original code for bluray-web: the native-method table of the BD-J virtual machine.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { JValue, JObject } from '../values';
import type { JMethod } from '../loader';
import type { JThread } from '../threads';
import type { Jvm } from '../jvm';
import type { NativeResult } from '../interpreter';
import { registerAwtNatives } from './awt';
import { registerInvokeNatives } from './invoke';
import { registerIoNatives } from './io';
import { registerLangNatives } from './lang';
import { registerMiscNatives } from './misc';
import { registerNetNatives } from './net';
import { registerReflectNatives } from './reflect';
import { registerStrictMathNatives } from './strictmath';
import { registerUnsafeNatives } from './unsafe';
import { registerZipNatives } from './zip';
import type { ClassLibraryHelpers, IntrinsicFn, LoopHook } from './intrinsics/index';

export interface NativeContext {
  readonly jvm: Jvm;
  readonly thread: JThread;
  readonly method: JMethod;
}

/** Receives the receiver (instance methods) and then one value per parameter; a long is one bigint. */
export type NativeFn = (ctx: NativeContext, ...args: JValue[]) => NativeResult;

export class NativeTable {
  private readonly fns = new Map<string, NativeFn>();
  private readonly replacedKeys = new Set<string>();
  private readonly intrinsicFns = new Map<string, IntrinsicFn>();
  private readonly hooks = new Map<string, readonly LoopHook[]>();
  /** What the class library's intrinsics module lends the engine's intrinsics. */
  readonly helpers: ClassLibraryHelpers = { pixelConverters: new Map() };

  /** Keys are 'java/lang/Object.hashCode()I'. */
  register(entries: Readonly<Record<string, NativeFn>>): void {
    for (const [key, fn] of Object.entries(entries)) this.fns.set(key, fn);
  }

  /** Implements Java (non-native) methods natively: classes defined afterwards run these instead of the bytecode. */
  replace(entries: Readonly<Record<string, NativeFn>>): void {
    this.register(entries);
    for (const key of Object.keys(entries)) this.replacedKeys.add(key);
  }

  get replaced(): ReadonlySet<string> {
    return this.replacedKeys;
  }

  /**
   * Gives Java methods a JS fast path (natives/intrinsics): classes defined afterwards try it before their bytecode,
   * which still runs whenever the intrinsic declines.
   */
  intrinsify(entries: Readonly<Record<string, IntrinsicFn>>): void {
    for (const [key, fn] of Object.entries(entries)) this.intrinsicFns.set(key, fn);
  }

  get intrinsics(): ReadonlyMap<string, IntrinsicFn> {
    return this.intrinsicFns;
  }

  /** Hooks loops inside Java methods (natives/intrinsics): classes defined afterwards run them at those gotos. */
  hookLoops(entries: Readonly<Record<string, readonly LoopHook[]>>): void {
    for (const [key, list] of Object.entries(entries)) this.hooks.set(key, list);
  }

  get loopHooks(): ReadonlyMap<string, readonly LoopHook[]> {
    return this.hooks;
  }

  get(key: string): NativeFn | undefined {
    return this.fns.get(key);
  }

  get keys(): readonly string[] {
    return [...this.fns.keys()];
  }
}

const none = (): undefined => undefined;

/** The natives that code running before the JDK boots reaches. */
export function registerBootstrapNatives(table: NativeTable): void {
  table.register({
    'java/lang/Object.registerNatives()V': none,
    'java/lang/Object.hashCode()I': (ctx, self) => ctx.jvm.heap.identityHash(self as JObject),
    'java/lang/Object.getClass()Ljava/lang/Class;': (ctx, self) => ctx.jvm.mirror((self as JObject).cls),
    'java/lang/System.registerNatives()V': none,
    'java/lang/Class.registerNatives()V': none,
    'java/lang/Class.desiredAssertionStatus0(Ljava/lang/Class;)Z': () => 0,
    'java/lang/Throwable.fillInStackTrace(I)Ljava/lang/Throwable;': (ctx, self) => {
      ctx.jvm.fillInStackTrace(self as JObject, ctx.thread);
      return self;
    },
  });
}

/** Object monitors and Thread timing, as thin wrappers over the scheduler; a long arrives as a bigint. */
export function registerSchedulerNatives(table: NativeTable): void {
  table.register({
    'java/lang/Thread.registerNatives()V': none,
    'java/lang/Object.wait(J)V': (ctx, self, ms) => ctx.jvm.threads.wait(ctx.thread, self as JObject, Number(ms as bigint)),
    'java/lang/Object.notify()V': (ctx, self) => void ctx.jvm.threads.notify(self as JObject, false, ctx.thread),
    'java/lang/Object.notifyAll()V': (ctx, self) => void ctx.jvm.threads.notify(self as JObject, true, ctx.thread),
    'java/lang/Thread.sleep(J)V': (ctx, ms) => ctx.jvm.threads.sleep(ctx.thread, Number(ms as bigint)),
    'java/lang/Thread.yield()V': (ctx) => ctx.jvm.threads.yield(ctx.thread),
  });
}

/** The JDK's natives: java.lang, java.lang.invoke, reflection, Unsafe, sun.misc, java.io and sun.nio, zip, net and AWT. */
export function registerJdkNatives(table: NativeTable): void {
  registerLangNatives(table);
  registerInvokeNatives(table);
  registerIoNatives(table);
  registerStrictMathNatives(table);
  registerReflectNatives(table);
  registerUnsafeNatives(table);
  registerMiscNatives(table);
  registerZipNatives(table);
  registerNetNatives(table);
  registerAwtNatives(table);
}
