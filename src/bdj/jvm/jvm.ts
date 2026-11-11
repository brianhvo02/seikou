/*
 * Original code for Seikou: the BD-J virtual machine, which runs Java 8 class files on green threads in one JS
 * thread.
 *
 * Copyright (C) 2026 Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { ZipArchive } from './zip';
import { Heap } from './heap';
import { ClassPath, Loader, externalName } from './loader';
import type { JClass, JMethod } from './loader';
import { Invoke, ThrowResult, andThen } from './interpreter';
import type { NativeResult } from './interpreter';
import { JThread, Scheduler } from './threads';
import { NativeTable, registerBootstrapNatives, registerJdkNatives, registerSchedulerNatives } from './natives/index';
import { registerIntrinsics } from './natives/intrinsics/index';
import { openZipStats } from './natives/zip';
import { JavaThrowable } from './values';
import type { JArray, JObject, JValue } from './values';
import type { Vfs } from './vfs';
import type { JvmMemoryStats } from '@seikou/engine/bdj-types';
export type { JvmMemoryStats } from '@seikou/engine/bdj-types';

export interface JvmOptions {
  readonly bootJars: readonly Uint8Array[];
  readonly nowMs: () => number;
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  /** The scheduler's periodic turn of the event loop (SchedulerOptions.yieldTask). */
  readonly yieldTask?: () => Promise<void>;
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  readonly vfs?: Vfs;
  /** Added to the JDK's own (initProperties), as the runtime's -D options are. */
  readonly systemProperties?: ReadonlyMap<string, string>;
  /** JS fast paths for hot class-library methods (natives/intrinsics); default true. */
  readonly intrinsics?: boolean;
  /**
   * Installs intrinsics kept outside the engine (the class library's, src/bdj-classlib/intrinsics, under its own
   * licence), after the engine's; skipped when `intrinsics` is false.
   */
  readonly extraIntrinsics?: (table: NativeTable) => void;
  /** Class-file bytes the classes may keep (memoryStats().classFileBytes): going over is reported once through `warn`. */
  readonly classBytesBudget?: number;
  /** The VM's own diagnostics (not Java's output). */
  readonly warn?: (line: string) => void;
}

/** A Throwable's stack, innermost first, kept in its nativeData. */
export interface StackTrace {
  readonly methods: readonly JMethod[];
  readonly pcs: readonly number[];
}

/** HotSpot's MaxJavaStackTraceDepth. */
const MAX_TRACE_DEPTH = 1024;
const TIME_SLICE = 10_000;

export class Jvm {
  readonly heap: Heap;
  readonly loader: Loader;
  readonly threads: Scheduler;
  readonly natives: NativeTable;
  /** The thread the interpreter is running, if any. */
  currentThread: JThread | null = null;
  /** The `main` java.lang.Thread boot() creates; threads callStatic starts run as it, like a JNI-attached thread. */
  mainThread: JObject | null = null;
  /** Set by Runtime.halt (Shutdown.halt0). */
  exitStatus: number | null = null;
  private statusSlot = -1;

  constructor(readonly opts: JvmOptions) {
    this.heap = new Heap(this);
    this.loader = new Loader(this, new ClassPath(opts.bootJars.map((b) => ZipArchive.open(b))));
    this.natives = new NativeTable();
    registerBootstrapNatives(this.natives);
    registerSchedulerNatives(this.natives);
    registerJdkNatives(this.natives);
    if (opts.intrinsics !== false) {
      registerIntrinsics(this.natives);
      opts.extraIntrinsics?.(this.natives);
    }
    this.threads = new Scheduler(this, { slice: TIME_SLICE, nowMs: opts.nowMs, setTimer: opts.setTimer, ...(opts.yieldTask ? { yieldTask: opts.yieldTask } : {}) });
  }

  /** What the JVM keeps outside its Java heap. */
  memoryStats(): JvmMemoryStats {
    const vfs = this.opts.vfs?.memoryStats();
    const zips = openZipStats(this);
    const classes = this.loader.classStats;
    return {
      bootJarBytes: this.opts.bootJars.reduce((n, b) => n + b.byteLength, 0),
      classes: classes.classes,
      classFileBytes: classes.retainedBytes,
      zipHandles: zips.handles,
      zipBytes: zips.bytes,
      vfsFiles: vfs?.memFiles ?? 0,
      vfsBytes: vfs?.memBytes ?? 0,
      vfsUsedBytes: vfs?.memUsed ?? 0,
      jdkFileBytes: vfs?.jdkCacheBytes ?? 0,
    };
  }

  /** Runs a static method on a new Java thread to completion; rejects with the uncaught exception's toString(). */
  async callStatic(cls: string, name: string, desc: string, args: readonly JValue[] = []): Promise<JValue | undefined> {
    let t: JThread;
    try {
      const c = this.loader.loadBoot(cls);
      if (!c) throw new Error(`java.lang.NoClassDefFoundError: ${cls}`);
      const m = c.methods.get(name + desc);
      if (!m?.isStatic) throw new Error(`java.lang.NoSuchMethodError: ${externalName(cls)}.${name}${desc}`);
      t = this.threads.spawn(this.mainThread, m, args);
      if (this.mainThread) this.mainThread.nativeData = t;
    } catch (e) {
      if (e instanceof JavaThrowable) throw new Error(this.describe(e.obj));
      throw e;
    }
    await this.drive(t, `${externalName(cls)}.${name}`);
    return t.result;
  }

  /** Runs the scheduler until `t` ends; rejects with its uncaught exception's toString(). */
  private async drive(t: JThread, what: string): Promise<void> {
    const ended = new AbortController();
    t.onTerminate = () => ended.abort();
    let outcome = t.state === 'terminated' ? 'idle' : await this.threads.run(ended.signal);
    while (outcome === 'idle' && t.state !== 'terminated' && this.threads.timersPending) {
      await this.threads.nextTimer();
      outcome = await this.threads.run(ended.signal);
    }
    t.onTerminate = null;
    if (t.uncaught) throw new Error(this.describe(t.uncaught));
    if (t.state !== 'terminated') throw new Error(`${what} did not finish (${outcome})`);
  }

  /**
   * JDK startup as HotSpot's Threads::create_vm does it: initialise String, System and ThreadGroup, create the system
   * and main thread groups and the `main` Thread (create_initial_thread_group, create_initial_thread), initialise
   * Class, then run System.initializeSystemClass.
   */
  async boot(): Promise<void> {
    const cls = (name: string): JClass => {
      const c = this.loader.loadBoot(name);
      if (!c) throw new Error(`${name} is not on the boot class path`);
      return c;
    };
    const method = (c: JClass, key: string): JMethod => {
      const m = c.methods.get(key);
      if (!m) throw new Error(`${c.name}.${key} is missing`);
      return m;
    };
    const threadGroup = cls('java/lang/ThreadGroup');
    const thread = cls('java/lang/Thread');
    const system = cls('java/lang/System');
    const t = this.threads.spawnWith(null, (t) => {
      const init = (names: readonly string[], k: () => NativeResult): NativeResult =>
        names.length === 0 ? k() : this.withInit(t, cls(names[0]!), () => init(names.slice(1), k));
      return init(['java/lang/String', 'java/lang/System', 'java/lang/ThreadGroup'], () => {
        const systemGroup = this.heap.newObject(threadGroup);
        const mainGroup = this.heap.newObject(threadGroup);
        return new Invoke(method(threadGroup, '<init>()V'), [systemGroup], () =>
          new Invoke(method(threadGroup, '<init>(Ljava/lang/ThreadGroup;Ljava/lang/String;)V'), [mainGroup, systemGroup, this.heap.intern('main')], () =>
            init(['java/lang/Thread'], () => {
              const main = this.heap.newObject(thread);
              this.setField(main, 'priority', 'I', 5);
              t.javaThread = main;
              main.nativeData = t;
              this.mainThread = main;
              return new Invoke(method(thread, '<init>(Ljava/lang/ThreadGroup;Ljava/lang/String;)V'), [main, mainGroup, this.heap.intern('main')], () => {
                this.setField(main, 'threadStatus', 'I', 5);
                return init(['java/lang/Class'], () => new Invoke(method(system, 'initializeSystemClass()V'), [], () => undefined));
              });
            }),
          ),
        );
      });
    });
    await this.drive(t, 'System.initializeSystemClass');
  }

  /** Runs `k` once `c` is initialised for thread `t` (JVM §5.5), waiting for or running its initialisers first. */
  withInit(t: JThread, c: JClass, k: () => NativeResult): NativeResult {
    const r = this.loader.initialize(t, c);
    return r === null ? k() : andThen(r, () => this.withInit(t, c, k));
  }

  /** The slot of java.lang.Thread.threadStatus. */
  get threadStatusSlot(): number {
    if (this.statusSlot < 0) this.statusSlot = this.loader.loadBoot('java/lang/Thread')!.declaredField('threadStatus', 'I')!.slot;
    return this.statusSlot;
  }

  /** The class a java.lang.Class instance stands for. */
  classOf(mirror: JObject): JClass {
    return mirror.nativeData as JClass;
  }

  /** A new array of `component` holding `items`. */
  newArray(component: JClass, items: readonly JValue[]): JArray {
    const arr = this.heap.newArray(this.loader.arrayOf(component), items.length);
    for (let i = 0; i < items.length; i++) (arr.data as JValue[])[i] = items[i]!;
    return arr;
  }

  /** A boot class that must exist. */
  bootClass(name: string): JClass {
    const c = this.loader.loadBoot(name);
    if (!c) throw new Error(`${name} is not on the boot class path`);
    return c;
  }

  /** Allocates a Throwable without running Java constructors, as HotSpot's own exceptions are. */
  throwNew(cls: string, message?: string): ThrowResult {
    const c = this.loader.loadBoot(cls);
    if (!c) throw new Error(`${cls} is not on the boot class path`);
    const e = this.heap.newObject(c);
    if (message !== undefined) this.setField(e, 'detailMessage', 'Ljava/lang/String;', this.heap.newString(message));
    this.setField(e, 'cause', 'Ljava/lang/Throwable;', e);
    const throwable = this.loader.loadBoot('java/lang/Throwable')!;
    if (throwable.state === 'initialized') {
      const sentinel = throwable.findField('SUPPRESSED_SENTINEL', 'Ljava/util/List;');
      if (sentinel) this.setField(e, 'suppressedExceptions', 'Ljava/util/List;', throwable.staticValues[sentinel.slot]!);
    }
    this.fillInStackTrace(e, this.currentThread);
    return new ThrowResult(e);
  }

  /**
   * Records the thread's frames in the Throwable, leaving out fillInStackTrace and the Throwable's own constructors
   * as HotSpot does; `backtrace` becomes non-null so getOurStackTrace builds the elements.
   */
  fillInStackTrace(e: JObject, t: JThread | null): void {
    const methods: JMethod[] = [];
    const pcs: number[] = [];
    const frames = t?.frames ?? [];
    let i = frames.length - 1;
    while (i >= 0 && frames[i]!.method.name.startsWith('fillInStackTrace')) i--;
    while (i >= 0 && frames[i]!.method.name === '<init>' && e.cls.isSubclassOf(frames[i]!.method.cls)) i--;
    for (; i >= 0 && methods.length < MAX_TRACE_DEPTH; i--) {
      methods.push(frames[i]!.method);
      pcs.push(frames[i]!.pc);
    }
    const trace: StackTrace = { methods, pcs };
    e.nativeData = trace;
    this.setField(e, 'backtrace', 'Ljava/lang/Object;', e);
  }

  /** The java.lang.Class instance for a class. */
  mirror(cls: JClass): JObject {
    if (!cls.mirror) {
      const classClass = this.loader.loadBoot('java/lang/Class');
      if (!classClass) throw new Error('java/lang/Class is not on the boot class path');
      const m = this.heap.newObject(classClass);
      m.nativeData = cls;
      const loaderField = classClass.findField('classLoader', 'Ljava/lang/ClassLoader;');
      if (loaderField) m.fields[loaderField.slot] = cls.loader;
      cls.mirror = m;
    }
    return cls.mirror;
  }

  getField(o: JObject, name: string, desc: string): JValue {
    const f = o.cls.findField(name, desc);
    if (!f || f.isStatic) throw new Error(`${o.cls.name} has no field ${name} ${desc}`);
    return o.fields[f.slot]!;
  }

  setField(o: JObject, name: string, desc: string, value: JValue): void {
    const f = o.cls.findField(name, desc);
    if (!f || f.isStatic) throw new Error(`${o.cls.name} has no field ${name} ${desc}`);
    o.fields[f.slot] = value;
  }

  /** Throwable.toString(), computed natively: the class name, then ': ' and the detail message if there is one. */
  describe(e: JObject): string {
    const message = this.heap.jsString(this.getField(e, 'detailMessage', 'Ljava/lang/String;') as JObject | null);
    return message === null ? externalName(e.cls.name) : `${externalName(e.cls.name)}: ${message}`;
  }
}
