/*
 * The BD-J runtime: boots libbluray's Java stack on our JVM and passes it events. Ported from libbluray
 * src/libbluray/bdj/bdj.c (bdj_open, _create_jvm's properties and class path, _bdj_init, bdj_process_event,
 * bdj_close) and bluray.c (_start_bdj, _stop_bdj).
 * Copyright (C) 2010  William Hahne
 * Copyright (C) 2010-2019  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { ByteSource } from '@seikou/bdmv/byte-source';
import { BdjError } from './errors';
import { enqueueBdjEvent, type Coalesce, type QueuedBdjEvent } from './input';
import type { FreeType } from './fonts/freetype';
import { DEFAULT_FONT_PATH, systemFontFiles } from './fonts/system-fonts';
import type { BdjErrorCode } from './errors';
import type { BdjHost, TraceEntry } from './host';
import { Jvm } from './jvm/jvm';
import { externalName } from './jvm/loader';
import type { JMethod } from './jvm/loader';
import { lineNumber } from './jvm/natives/lang';
import type { NativeTable } from './jvm/natives/index';
import { registerHaviNatives } from './jvm/natives/havi';
import { registerLibblurayNatives } from './jvm/natives/libbluray';
import type { StackTrace } from './jvm/jvm';
import type { JThread } from './jvm/threads';
import { JavaThrowable } from './jvm/values';
import type { JObject, JValue } from './jvm/values';
import { Vfs, type VfsChange } from './jvm/vfs';
import { ZipArchive } from './jvm/zip';

export interface ClassLibrarySource {
  readonly rt: Uint8Array;
  readonly libbluray: Uint8Array;
  readonly libblurayAwt: Uint8Array;
}

export interface BdjRuntimeDeps {
  /** The disc, with its normalised file list (FileSource.paths()) for the VFS. */
  readonly disc: ByteSource & { paths(): Iterable<string> };
  /** bdj_open's bdj_disc_id: the disc's CERTIFICATE/id.bdmv disc ID (readBdid); none or '' passes 32 zeros. */
  readonly discId?: string | null;
  readonly classLibrary: ClassLibrarySource;
  /** The runtime passes its own start, and a hook it uses to watch the host's trace. */
  readonly host: (startTitle: (title: number) => void, onTrace: (e: TraceEntry) => void) => BdjHost;
  readonly nowMs: () => number;
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  /** The JVM scheduler's periodic turn of the event loop (SchedulerOptions.yieldTask). */
  readonly yieldTask?: () => Promise<void>;
  /** JvmOptions.extraIntrinsics: the class library's intrinsics, which the engine does not carry. */
  readonly extraIntrinsics?: (table: NativeTable) => void;
  readonly log: (line: string) => void;
  /**
   * Text: FreeType for the font natives and the bundled fallback font (packages/ass/src/default-font.ttf) as the JRE's
   * font files, both fetched when text first needs them. Without it, BD-J runs as libbluray built without FreeType.
   */
  readonly fonts?: BdjFontSources;
  /** The memory profile's BD-J budgets; none by default. */
  readonly memory?: BdjMemoryBudgets;
  /** A change on /tmp/, /persistent/ or /buda/ (VfsOptions.onChange): the storage scopes' saves (store/scope-sync.ts). */
  readonly onVfsChange?: (path: string, change: VfsChange, to?: string) => void;
  /** A write refused for room, by the memory budget or a scope's quota (VfsOptions.onFull). */
  readonly onVfsFull?: (path: string) => void;
}

/** The memory profile's budgets the BD-J worker applies (memory-profile.ts, bdjClassCacheBytes and bdjVfsCacheBytes). */
export interface BdjMemoryBudgets {
  /** Class-file bytes the classes keep: going over is logged once. */
  readonly classBytes: number;
  /** The memory mounts' capacity: a write beyond it fails as on a full disk. */
  readonly vfsBytes: number;
}

export interface BdjFontSources {
  readonly loadFreeType: () => Promise<FreeType>;
  /** The bytes of packages/ass/src/default-font.ttf. */
  readonly loadDefaultFont: () => Promise<Uint8Array>;
}

export type RunOutcome = 'idle' | 'until' | 'aborted' | 'deadlock';

export const BdjEvent = {
  NONE: 0,
  START: 1,
  STOP: 2,
  PSR102: 3,
  PLAYLIST: 4,
  PLAYITEM: 5,
  CHAPTER: 6,
  MARK: 7,
  PTS: 8,
  END_OF_PLAYLIST: 9,
  SEEK: 10,
  RATE: 11,
  ANGLE: 12,
  AUDIO_STREAM: 13,
  SUBTITLE: 14,
  SECONDARY_STREAM: 15,
  VK_KEY: 16,
  UO_MASKED: 17,
  MOUSE: 18,
} as const;

const EVENT_NAMES = Object.keys(BdjEvent);
const BDJ_EVENT_LAST = BdjEvent.MOUSE;
const LIBBLURAY = 'org/videolan/Libbluray';
/** _bdj_init's disc ID when AACS gives none. */
const NO_DISC_ID = '00000000000000000000000000000000';
const DISC_ROOT = '/disc/';
const PERSISTENT_ROOT = '/persistent/';
const BUDA_ROOT = '/buda/';
const STOP_TIMEOUT_MS = 5000;

/** _create_jvm's -D options for a Java 8 JVM. */
const JVM_PROPERTIES: ReadonlyMap<string, string> = new Map([
  ['awt.toolkit', 'java.awt.BDToolkit'],
  ['java.awt.graphicsenv', 'java.awt.BDGraphicsEnvironment'],
  ['java.awt.headless', 'false'],
  ['javax.accessibility.assistive_technologies', ' '],
]);

const ERROR_CODES: readonly (readonly [string, BdjErrorCode])[] = [
  ['java/lang/NoClassDefFoundError', 'class-not-found'],
  ['java/lang/ClassNotFoundException', 'class-not-found'],
  ['java/lang/UnsatisfiedLinkError', 'unsatisfied-link'],
  ['java/lang/ClassFormatError', 'verify'],
  ['java/lang/VerifyError', 'verify'],
];

export class BdjRuntime {
  readonly host: BdjHost;
  readonly jvm: Jvm;
  private booted = false;
  private booting: Promise<void> | null = null;
  private jdkBooting: Promise<void> | null = null;
  private until: ((e: TraceEntry) => boolean) | null = null;
  private matched = false;
  /** Aborts the drive in progress (run, or stop's). */
  private driving: AbortController | null = null;
  private active: Promise<unknown> | null = null;
  private readonly events: QueuedBdjEvent[] = [];
  private eventThread: JThread | null = null;
  /** The drive in progress checks whether it is done. */
  private settle: (() => void) | null = null;
  private vfsFullLogged = false;
  private readonly quotaFullLogged = new Set<string>();

  constructor(private readonly deps: BdjRuntimeDeps) {
    const inner = deps.host(
      (title) => this.playBdj(title),
      (e) => this.onTrace(e),
    );
    this.host = inner;
    const lib = deps.classLibrary;
    const fonts = deps.fonts;
    this.jvm = new Jvm({
      bootJars: [lib.libbluray, lib.libblurayAwt, lib.rt],
      nowMs: deps.nowMs,
      setTimer: deps.setTimer,
      ...(deps.yieldTask ? { yieldTask: deps.yieldTask } : {}),
      ...(deps.extraIntrinsics ? { extraIntrinsics: deps.extraIntrinsics } : {}),
      stdout: (s) => this.output(s),
      stderr: (s) => this.output(s),
      ...(deps.memory ? { classBytesBudget: deps.memory.classBytes } : {}),
      warn: (line) => deps.log(line),
      vfs: new Vfs({
        disc: deps.disc,
        discPaths: deps.disc.paths(),
        jdkLib: ZipArchive.open(lib.rt),
        nowMs: deps.nowMs,
        ...(deps.memory ? { memLimitBytes: deps.memory.vfsBytes } : {}),
        onFull: (path, limit, quotaDir) => this.vfsFull(path, limit, quotaDir),
        ...(deps.onVfsChange ? { onChange: deps.onVfsChange } : {}),
        ...(fonts ? { jdkLazy: systemFontFiles(fonts.loadDefaultFont) } : {}),
      }),
      systemProperties: JVM_PROPERTIES,
    });
    const host = this.logging(inner);
    registerLibblurayNatives(
      this.jvm.natives,
      host,
      fonts ? { loadFreeType: fonts.loadFreeType, fallbackFontPath: DEFAULT_FONT_PATH, log: deps.log } : { log: deps.log },
    );
    registerHaviNatives(this.jvm.natives, host);
  }

  /**
   * The memory mounts' limit or a storage scope's quota refused a write (ENOSPC for Java): logged the first time only
   * for each.
   */
  private vfsFull(path: string, limit: number, quotaDir: string | null): void {
    this.deps.onVfsFull?.(path);
    const mb = (limit / (1024 * 1024)).toFixed(1);
    if (quotaDir !== null) {
      if (this.quotaFullLogged.has(quotaDir)) return;
      this.quotaFullLogged.add(quotaDir);
      this.deps.log(`BD-J: no room to write ${path}: the saved data under ${quotaDir} is at its quota of ${mb} MB (No space left on device)`);
      return;
    }
    if (this.vfsFullLogged) return;
    this.vfsFullLogged = true;
    this.deps.log(`BD-J: no room to write ${path}: the BD-J files in memory are at the budget of ${mb} MB (No space left on device)`);
  }

  /** Runtime.halt's status, once Java has halted the JVM; nothing runs after that. */
  get exitStatus(): number | null {
    return this.jvm.exitStatus;
  }

  /** bdj_open without JVM discovery: JDK startup, then _bdj_init (Libbluray.init). */
  boot(): Promise<void> {
    return (this.booting ??= this.open());
  }

  /**
   * Starts JDK startup on its own, which reaches no host native, so a caller can load what the host needs meanwhile;
   * boot() goes on from it and reports its failure.
   */
  bootJdk(): Promise<void> {
    return (this.jdkBooting ??= this.jvm.boot());
  }

  private async open(): Promise<void> {
    try {
      await this.bootJdk();
      const heap = this.jvm.heap;
      await this.call('init', '(JLjava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V', [
        1n,
        heap.newString(this.deps.discId || NO_DISC_ID),
        heap.newString(DISC_ROOT),
        heap.newString(PERSISTENT_ROOT),
        heap.newString(BUDA_ROOT),
      ]);
    } catch (e) {
      // bdj_open closes the VM when _bdj_init fails
      this.jvm.threads.halt();
      throw this.bootError(e);
    }
    this.booted = true;
  }

  /** _start_bdj */
  start(title: number): void {
    this.processEvent(BdjEvent.START, title);
  }

  /** The host's title start, after its native has returned: _play_bdj logs a title it cannot start. */
  private playBdj(title: number): void {
    try {
      this.start(title);
    } catch (e) {
      this.deps.log(`Can't play BD-J title ${title}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * bdj_process_event: queues Libbluray.processEvent, which the next run() executes on a fresh Java thread. Events
   * run one at a time in order, as libbluray's synchronous calls under bd->mutex do.
   */
  processEvent(ev: number, param: number, coalesce?: Coalesce): void {
    this.checkRunning();
    this.logEvent(ev, param);
    // libbluray's caller waits for Java; ours does not, so held keys and pointer moves are bounded (input.ts)
    enqueueBdjEvent(this.events, { ev: ev | 0, param: param | 0, ...(coalesce ? { coalesce } : {}) });
    this.pump();
  }

  /** Events waiting for the event before them to return (tests). */
  get pendingEvents(): number {
    return this.events.length;
  }

  /** Starts the next queued event once the previous one has returned. */
  private pump(): void {
    while (this.eventThread === null && this.events.length > 0) {
      if (this.jvm.threads.isHalted) {
        this.events.length = 0;
        return;
      }
      const { ev, param } = this.events.shift()!;
      const t = this.spawn('processEvent', '(II)Z', [ev, param]);
      const finished = (): void => {
        if (t.uncaught) this.deps.log(`bdj_process_event(${ev >>> 0},${param >>> 0}) failed (uncaught exception): ${this.jvm.describe(t.uncaught)}`);
      };
      if (t.state === 'terminated') {
        finished();
        continue;
      }
      this.eventThread = t;
      t.onTerminate = () => {
        this.eventThread = null;
        finished();
        this.pump();
        this.settle?.();
      };
    }
  }

  private get eventsDone(): boolean {
    return this.eventThread === null && this.events.length === 0;
  }

  private logEvent(ev: number, param: number): void {
    if (ev > BDJ_EVENT_LAST) this.deps.log(`bdj_process_event(${ev},${param}): unknown event`);
    // PTS and pointer moves come many times a second (libbluray logs all of them at debug level)
    else if (ev !== BdjEvent.PTS && ev !== BdjEvent.MOUSE) this.deps.log(`bdj_process_event(${EVENT_NAMES[ev]},${param})`);
  }

  /**
   * Runs the Java threads until none can make progress, `until` matches a trace entry, `signal` aborts or every
   * live thread deadlocks. Waits for sleeping threads on the injected clock. Rejects with BdjError('internal') when
   * the interpreter or the host fails, after which the runtime is stopped.
   */
  run(opts: { readonly signal?: AbortSignal; readonly until?: (e: TraceEntry) => boolean } = {}): Promise<RunOutcome> {
    return this.exclusive(async () => {
      this.until = opts.until ?? null;
      this.matched = false;
      try {
        return await this.drive(opts.signal, () => this.matched);
      } finally {
        this.until = null;
      }
    });
  }

  /**
   * _stop_bdj behind any queued events, then bdj_close (Libbluray.shutdown); threads still running after `timeoutMs`
   * are halted.
   */
  async stop(timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
    this.driving?.abort();
    await this.exclusive(async () => {
      if (!this.booted || this.jvm.threads.isHalted) return;
      const expired = new AbortController();
      const cancel = this.deps.setTimer(timeoutMs, () => expired.abort());
      try {
        this.processEvent(BdjEvent.STOP, 0);
        await this.drive(expired.signal, () => this.eventsDone);
        if (!expired.signal.aborted) {
          const t = this.spawnWatched('shutdown', '()V', []);
          await this.drive(expired.signal, () => t.state === 'terminated');
          if (t.uncaught) this.deps.log(`Failed to shutdown BD-J (uncaught exception): ${this.jvm.describe(t.uncaught)}`);
        }
      } finally {
        cancel();
        this.jvm.threads.halt();
      }
    });
  }

  /** A thread dump of the Java threads (diagnostics: the boot timeout, a deadlock), with the events still queued. */
  threadDump(): string[] {
    const lines = this.jvm.threads.dump(frameText);
    lines.push(`events: ${this.events.length} queued${this.eventThread ? `, #${this.eventThread.id} running one` : ''}`);
    return lines;
  }

  private onTrace(e: TraceEntry): void {
    if (!this.until || this.matched || !this.until(e)) return;
    this.matched = true;
    this.jvm.threads.preempt();
    this.driving?.abort();
  }

  private output(s: string): void {
    for (const line of s.split('\n')) if (line !== '') this.deps.log(line);
  }

  /** The host the natives see: its log also reaches the runtime's log, as bdpriv_debug prints Logger.logN lines. */
  private logging(inner: BdjHost): BdjHost {
    const log = (file: string | null, line: number, msg: string, error: boolean): void => {
      inner.log(file, line, msg, error);
      this.deps.log(`${file ?? 'JVM'}:${line}: ${msg}`);
    };
    return new Proxy(inner, {
      get: (target, key) => {
        if (key === 'log') return log;
        const v: unknown = Reflect.get(target, key);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }

  private checkRunning(): void {
    if (this.jvm.exitStatus !== null) throw new BdjError('internal', `the JVM has halted with status ${this.jvm.exitStatus}`);
    if (this.jvm.threads.isHalted) throw new BdjError('internal', 'the BD-J runtime has stopped');
    if (!this.booted) throw new BdjError('internal', 'the BD-J runtime has not booted');
  }

  /** A static Libbluray method on a new Java thread, attached as the main thread as a JNI caller's would be. */
  private spawn(name: string, desc: string, args: readonly JValue[]): JThread {
    const m = this.method(name, desc);
    const t = this.jvm.threads.spawn(this.jvm.mainThread, m, args);
    if (this.jvm.mainThread) this.jvm.mainThread.nativeData = t;
    return t;
  }

  /** A call whose end the drive in progress has to notice. */
  private spawnWatched(name: string, desc: string, args: readonly JValue[]): JThread {
    const t = this.spawn(name, desc, args);
    t.onTerminate = () => this.settle?.();
    return t;
  }

  private method(name: string, desc: string): JMethod {
    const cls = this.jvm.loader.loadBoot(LIBBLURAY);
    if (!cls) throw new BdjError('class-not-found', `${LIBBLURAY} is missing from the boot class path (needed by bdj_open)`);
    const m = cls.methods.get(name + desc);
    if (!m?.isStatic) throw new BdjError('class-not-found', `${externalName(LIBBLURAY)}.${name}${desc} is missing`);
    return m;
  }

  /** _bdj_init's CallStaticVoidMethod: runs until its thread ends; an uncaught exception fails the boot. */
  private async call(name: string, desc: string, args: readonly JValue[]): Promise<void> {
    const t = this.withJava(() => this.spawnWatched(name, desc, args));
    await this.drive(undefined, () => t.state === 'terminated');
    if (this.jvm.exitStatus !== null) throw new BdjError('internal', `the JVM halted with status ${this.jvm.exitStatus} during ${name}`);
    if (t.uncaught) throw this.javaError(t.uncaught, `Failed to initialize BD-J (uncaught exception): `);
    if (t.state !== 'terminated') throw new BdjError('internal', `${externalName(LIBBLURAY)}.${name} did not finish`);
  }

  /** Converts a Java exception thrown while setting up a call (class loading, initialisation) to a BdjError. */
  private withJava<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      throw this.bootError(e);
    }
  }

  private bootError(e: unknown): BdjError {
    if (e instanceof BdjError) return e;
    if (e instanceof JavaThrowable) return this.javaError(e.obj, '');
    const message = e instanceof Error ? e.message : String(e);
    for (const [cls, code] of ERROR_CODES) if (message.startsWith(externalName(cls))) return new BdjError(code, message);
    return new BdjError('internal', message);
  }

  private javaError(exc: JObject, prefix: string): BdjError {
    let code: BdjErrorCode = 'internal';
    for (const [name, c] of ERROR_CODES) {
      const cls = this.jvm.loader.loadBoot(name);
      if (cls && exc.cls.isSubclassOf(cls)) {
        code = c;
        break;
      }
    }
    const stack = this.exceptionStack(exc);
    const where = stack[0] ? ` (in ${stack[0]})` : '';
    return new BdjError(code, `${prefix}${this.jvm.describe(exc)}${where}`, stack);
  }

  private exceptionStack(exc: JObject): string[] {
    const trace = exc.nativeData as StackTrace | null | undefined;
    if (!trace?.methods) return [];
    return trace.methods.map((m, i) => frameText(m, trace.pcs[i]!));
  }

  /** One drive at a time: run() and stop() take turns on the scheduler. */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active) await this.active.catch(() => undefined);
    const p = fn();
    this.active = p;
    try {
      return await p;
    } finally {
      if (this.active === p) this.active = null;
    }
  }

  /**
   * Runs the scheduler until `done` (checked when a watched thread ends), an abort, a deadlock or true idleness:
   * Scheduler.run returns 'idle' while threads sleep, so this waits for the next timer and goes on (rulings R19/R20).
   */
  private async drive(signal: AbortSignal | undefined, done: () => boolean): Promise<RunOutcome> {
    const threads = this.jvm.threads;
    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) ac.abort();
    this.driving = ac;
    this.settle = () => {
      if (done()) ac.abort();
    };
    try {
      if (done()) return 'until';
      for (;;) {
        let outcome: Awaited<ReturnType<typeof threads.run>>;
        try {
          outcome = await threads.run(ac.signal);
        } catch (e) {
          throw this.internal(e);
        }
        if (done()) return 'until';
        if (threads.isHalted) return 'idle';
        if (outcome === 'aborted') return 'aborted';
        if (outcome === 'deadlock') return 'deadlock';
        if (!threads.timersPending) return 'idle';
        await new Promise<void>((resolve) => {
          const stopWaiting = (): void => resolve();
          ac.signal.addEventListener('abort', stopWaiting, { once: true });
          void threads.nextTimer().then(() => {
            ac.signal.removeEventListener('abort', stopWaiting);
            resolve();
          });
        });
      }
    } finally {
      if (this.driving === ac) this.driving = null;
      this.settle = null;
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** An interpreter or host failure: the runtime stops, and the error carries the Java stack of the thread at fault. */
  private internal(e: unknown): BdjError {
    const t = this.jvm.threads.faulted;
    const stack = t ? [...t.frames].reverse().map((f) => frameText(f.method, f.pc)) : [];
    this.jvm.threads.halt();
    if (e instanceof BdjError) return e;
    const message = e instanceof Error ? e.message : String(e);
    return new BdjError('internal', stack[0] ? `${message} (in ${stack[0]})` : message, stack);
  }
}

/** A frame as StackTraceElement.toString prints it. */
function frameText(m: JMethod, pc: number): string {
  const line = lineNumber(m, pc);
  const file = m.cls.file?.sourceFile;
  const where = m.isNative ? 'Native Method' : file ? (line >= 0 ? `${file}:${line}` : file) : 'Unknown Source';
  return `${externalName(m.cls.name)}.${m.name}(${where})`;
}
