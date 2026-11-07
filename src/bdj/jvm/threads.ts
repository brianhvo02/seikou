/*
 * Original code for bluray-web: the green-thread scheduler of the BD-J virtual machine (Java threads, monitors,
 * wait/notify, sleep, interrupt and parking), all on one JS thread.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { JavaThrowable } from './values';
import type { JObject, JValue } from './values';
import type { JClass, JMethod } from './loader';
import type { Jvm } from './jvm';
import { BLOCKED, Invoke, Suspend, ThrowResult, andThen, complete, execute } from './interpreter';
import type { Frame, NativeResult } from './interpreter';
import { dropPerClassFastPaths } from './natives/intrinsics/common';

export type ThreadState =
  | 'runnable'
  | 'blocked-monitor'
  | 'waiting'
  | 'timed-waiting'
  | 'sleeping'
  | 'parked'
  | 'suspended-native'
  | 'terminated';

/** java.lang.Thread.threadStatus values (JVMTI state bits), as HotSpot's java_lang_Thread::ThreadStatus sets them. */
const STATUS_RUNNABLE = 0x0005;
const STATUS_BLOCKED = 0x0401;
const STATUS_WAIT = 0x0191;
const STATUS_TIMED_WAIT = 0x01a1;
const STATUS_SLEEPING = 0x00e1;
const STATUS_PARKED = 0x0291;
const STATUS_PARKED_TIMED = 0x02a1;
const STATUS_TERMINATED = 0x0002;

export class JThread {
  readonly frames: Frame[] = [];
  private current: ThreadState = 'runnable';
  interrupted = false;
  uncaught: JObject | null = null;
  /** What the thread's first method returned. */
  result: JValue | undefined = undefined;
  /** The slot of java.lang.Thread.threadStatus in `javaThread`, when the scheduler keeps it in sync; else -1. */
  statusSlot = -1;
  /** A 'sleeping' thread that only yielded, which Java sees as RUNNABLE. */
  yielding = false;
  parkTimed = false;
  /** The thread has run its exit sequence; Thread.isAlive is false from here on. */
  exited = false;
  /** Called when the thread terminates, so a caller waiting for it can stop the scheduler while others run on. */
  onTerminate: (() => void) | null = null;
  /** The object whose monitor the thread last blocked or waited on (thread dumps only; stale once it runs). */
  blocker: JObject | null = null;
  constructor(
    readonly id: number,
    public javaThread: JObject | null,
  ) {}

  get state(): ThreadState {
    return this.current;
  }

  set state(s: ThreadState) {
    this.current = s;
    if (s !== 'sleeping') this.yielding = false;
    if (this.statusSlot >= 0 && this.javaThread) this.javaThread.fields[this.statusSlot] = this.status();
    if (s === 'terminated') this.onTerminate?.();
  }

  /** Starts keeping `javaThread`'s threadStatus field in sync with the scheduler's state. */
  syncStatus(slot: number): void {
    this.statusSlot = slot;
    this.state = this.current;
  }

  private status(): number {
    switch (this.current) {
      case 'runnable':
      case 'suspended-native':
        return STATUS_RUNNABLE;
      case 'blocked-monitor':
        return STATUS_BLOCKED;
      case 'waiting':
        return STATUS_WAIT;
      case 'timed-waiting':
        return STATUS_TIMED_WAIT;
      case 'sleeping':
        return this.yielding ? STATUS_RUNNABLE : STATUS_SLEEPING;
      case 'parked':
        return this.parkTimed ? STATUS_PARKED_TIMED : STATUS_PARKED;
      case 'terminated':
        return STATUS_TERMINATED;
    }
  }
}

export interface Monitor {
  owner: JThread | null;
  count: number;
  readonly entrySet: JThread[];
  readonly waitSet: JThread[];
}

export interface SchedulerOptions {
  readonly slice: number;
  readonly nowMs: () => number;
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  /**
   * A turn of the event loop for the scheduler's periodic yield; setTimer(0) by default, which browsers clamp to
   * 4 ms once timers nest.
   */
  readonly yieldTask?: () => Promise<void>;
}

/** Slices between yields to the event loop, so that I/O promises settle. */
const YIELD_EVERY = 50;
/** setTimeout's largest delay; a longer timed wait wakes early, which Java allows. */
const MAX_TIMER_MS = 0x7fffffff;

type Settled = JValue | undefined | ThrowResult;

interface Waiting {
  readonly o: JObject;
  /** The recursion count to reacquire; 0 for a wait on another thread's class initialisation. */
  readonly count: number;
}

const blocked = (): Suspend => new Suspend(BLOCKED);

export class Scheduler {
  private nextId = 1;
  private threads: JThread[] = [];
  private readonly queue: JThread[] = [];
  private readonly queued = new Set<JThread>();
  /** What a thread does when it next runs: a wakeup's result, or an Invoke to retry. */
  private readonly pending = new Map<JThread, () => NativeResult>();
  /** The continuation of a thread's Suspend. */
  private readonly conts = new Map<JThread, (r: Settled) => NativeResult>();
  private readonly timers = new Map<JThread, () => void>();
  private readonly waiting = new Map<JThread, Waiting>();
  /** Woken waiters queued in a monitor's entry set, with the count to take it back with. */
  private readonly reacquiring = new Map<JThread, { readonly count: number; readonly result: () => NativeResult }>();
  private readonly permits = new Set<JThread>();
  private readonly yielded: JThread[] = [];
  private timerWaiters: (() => void)[] = [];
  private io = 0;
  private wake: (() => void) | null = null;
  private failure: { readonly error: unknown } | null = null;
  private running = false;
  private halted = false;
  /** Set by preempt(): the running thread stops at its next call or return. */
  preempted = false;
  /** The thread that was running when a JS error escaped the interpreter. */
  faulted: JThread | null = null;
  /** Bytecodes per turn; tests shrink it to force preemption at awkward points. */
  slice: number;

  constructor(
    private readonly jvm: Jvm,
    private readonly opts: SchedulerOptions,
  ) {
    this.slice = opts.slice;
  }

  get live(): readonly JThread[] {
    return this.threads.filter((t) => t.state !== 'terminated');
  }

  /** Some thread sleeps, parks or waits with a timeout. */
  get timersPending(): boolean {
    return this.timers.size > 0;
  }

  /** Settles when the next sleep, park or timed wait times out. */
  nextTimer(): Promise<void> {
    return new Promise((r) => this.timerWaiters.push(r));
  }

  /** A static method's class is initialised first, as invokestatic would. */
  spawn(javaThread: JObject | null, method: JMethod, args: readonly JValue[]): JThread {
    return this.spawnWith(javaThread, (t) => {
      const call = (): Invoke =>
        new Invoke(method, args, (ret) => {
          t.result = ret;
          return undefined;
        });
      const start = (): NativeResult => {
        const init = method.isStatic ? this.jvm.loader.initialize(t, method.cls) : null;
        return init === null ? call() : andThen(init, start);
      };
      return start();
    });
  }

  /** A new thread whose work is `start`'s result, usually an Invoke chain. */
  spawnWith(javaThread: JObject | null, start: (t: JThread) => NativeResult): JThread {
    const t = new JThread(this.nextId++, javaThread);
    if (this.halted) {
      t.state = 'terminated';
      return t;
    }
    this.threads.push(t);
    this.inThread(t, () => complete(this.jvm, t, start(t)));
    if (t.state === 'runnable') this.enqueue(t);
    return t;
  }

  monitorEnter(t: JThread, o: JObject): boolean {
    const m = monitorOf(o);
    if (m.owner === null) {
      m.owner = t;
      m.count = 1;
      return true;
    }
    if (m.owner === t) {
      m.count++;
      return true;
    }
    t.state = 'blocked-monitor';
    t.blocker = o;
    if (!m.entrySet.includes(t)) m.entrySet.push(t);
    return false;
  }

  monitorExit(t: JThread, o: JObject): void {
    const m = o.monitor;
    if (m?.owner !== t) throw this.illegalMonitorState();
    if (--m.count === 0) this.release(m);
  }

  wait(t: JThread, o: JObject, ms: number): NativeResult {
    const m = o.monitor;
    if (m?.owner !== t) return this.jvm.throwNew('java/lang/IllegalMonitorStateException');
    if (ms < 0) return this.jvm.throwNew('java/lang/IllegalArgumentException', 'timeout value is negative');
    if (takeInterrupt(t)) return this.jvm.throwNew('java/lang/InterruptedException');
    this.waiting.set(t, { o, count: m.count });
    t.blocker = o;
    m.waitSet.push(t);
    t.state = ms > 0 ? 'timed-waiting' : 'waiting';
    this.release(m);
    if (ms > 0) this.after(t, ms, () => this.endWait(t, () => undefined));
    return blocked();
  }

  notify(o: JObject, all: boolean, t: JThread): void {
    const m = o.monitor;
    if (m?.owner !== t) throw this.illegalMonitorState();
    this.wakeWaiters(m, all);
  }

  private wakeWaiters(m: Monitor, all: boolean): void {
    const waiters = m.waitSet.filter((w) => this.waiting.get(w)!.count > 0);
    for (const w of all ? waiters : waiters.slice(0, 1)) this.endWait(w, () => undefined);
  }

  sleep(t: JThread, ms: number): NativeResult {
    if (ms < 0) return this.jvm.throwNew('java/lang/IllegalArgumentException', 'timeout value is negative');
    if (takeInterrupt(t)) return this.jvm.throwNew('java/lang/InterruptedException', 'sleep interrupted');
    if (ms === 0) return undefined;
    t.state = 'sleeping';
    this.after(t, ms, () => this.resume(t, () => undefined));
    return blocked();
  }

  /** Thread.yield: the thread goes to the back of the run queue. */
  yield(t: JThread): NativeResult {
    t.yielding = true;
    t.state = 'sleeping';
    this.pending.set(t, () => undefined);
    this.yielded.push(t);
    return blocked();
  }

  /** Unsafe.park: `time` is a deadline in ms when absolute, otherwise a timeout in ns (0: none). */
  park(t: JThread, absolute: boolean, time: bigint): NativeResult {
    if (this.permits.delete(t) || t.interrupted) return undefined;
    let ms = 0;
    if (absolute) {
      ms = Number(time) - this.opts.nowMs();
      if (ms <= 0) return undefined;
    } else if (time < 0n) {
      return undefined;
    } else if (time > 0n) {
      ms = Math.max(1, Math.ceil(Number(time) / 1e6));
    }
    t.parkTimed = ms > 0;
    t.state = 'parked';
    if (ms > 0) this.after(t, ms, () => this.resume(t, () => undefined));
    return blocked();
  }

  unpark(t: JThread): void {
    if (t.state === 'parked') this.resume(t, () => undefined);
    else this.permits.add(t);
  }

  /** A sleeping or waiting thread throws InterruptedException and the flag clears; a parked one just returns. */
  interrupt(t: JThread): void {
    t.interrupted = true;
    if (t.state === 'sleeping' && this.timers.has(t)) {
      t.interrupted = false;
      this.resume(t, () => this.jvm.throwNew('java/lang/InterruptedException', 'sleep interrupted'));
    } else if (this.waiting.get(t)?.count) {
      t.interrupted = false;
      this.endWait(t, () => this.jvm.throwNew('java/lang/InterruptedException'));
    } else if (t.state === 'parked') {
      this.resume(t, () => undefined);
    }
  }

  /** JVM §5.5 step 2: waits on the class's monitor until the initialising thread finishes; the caller then retries. */
  awaitInit(t: JThread, c: JClass): NativeResult {
    const o = this.jvm.mirror(c);
    monitorOf(o).waitSet.push(t);
    this.waiting.set(t, { o, count: 0 });
    t.blocker = o;
    t.state = 'waiting';
    return blocked();
  }

  /** Wakes the threads waiting for the class's initialisation, which has just completed or failed. */
  initFinished(c: JClass): void {
    const m = c.mirror?.monitor;
    if (!m) return;
    for (const w of m.waitSet.filter((x) => this.waiting.get(x)!.count === 0)) this.endWait(w, () => undefined);
  }

  suspendOn(t: JThread, p: Promise<JValue | undefined>): void {
    this.suspend(t, new Suspend(p));
  }

  /** Parks the thread on a Suspend; a BLOCKED one is woken by the scheduler instead of its promise. */
  suspend(t: JThread, s: Suspend): void {
    if (s.k) this.conts.set(t, s.k);
    if (s.promise === BLOCKED) return;
    t.state = 'suspended-native';
    this.io++;
    s.promise.then(
      (v) => {
        this.io--;
        this.resume(t, () => v);
      },
      (e: unknown) => {
        this.io--;
        if (e instanceof JavaThrowable) {
          this.resume(t, () => new ThrowResult(e.obj));
        } else {
          this.failure ??= { error: e };
          this.wake?.();
        }
      },
    );
  }

  /** Runtime.halt: every thread ends where it is; run() returns 'idle' and later wakeups are ignored. */
  halt(): void {
    this.halted = true;
    for (const t of this.threads) {
      this.cancelTimer(t);
      t.frames.length = 0;
      t.state = 'terminated';
    }
    this.queue.length = 0;
    this.queued.clear();
    dropPerClassFastPaths();
    this.pending.clear();
    this.conts.clear();
    this.waiting.clear();
    this.reacquiring.clear();
    this.yielded.length = 0;
    this.wake?.();
  }

  /** Ends the running thread's slice at its next method call or return (a native that must stop the run now). */
  preempt(): void {
    if (this.running) this.preempted = true;
  }

  get isHalted(): boolean {
    return this.halted;
  }

  /** The thread, already blocked, does `r` when it next runs. */
  later(t: JThread, r: NativeResult): void {
    this.pending.set(t, () => r);
  }

  /** The thread, already blocked, computes its result with `fn` when it next runs (to retry a monitor entry). */
  onWake(t: JThread, fn: () => NativeResult): void {
    this.pending.set(t, fn);
  }

  /**
   * A thread dump for diagnostics (no effect on the threads): the scheduler's counts, then each live thread's id,
   * name, state, what it waits on and who owns that monitor, and its top `depth` frames, innermost first.
   */
  dump(frameText: (m: JMethod, pc: number) => string, depth = 8): string[] {
    const lines = [
      `threads: ${this.live.length} live, ${this.queue.length} queued, ${this.yielded.length} yielded, ${this.io} on I/O, ${this.timers.size} timed, ` +
        `${this.timerWaiters.length} timer waiters${this.running ? ', running' : ''}${this.halted ? ', halted' : ''}`,
    ];
    for (const t of this.live) {
      let on = '';
      const o = t.blocker;
      if (o && (t.state === 'blocked-monitor' || t.state === 'waiting' || t.state === 'timed-waiting')) {
        const owner = o.monitor?.owner;
        on = ` on ${objectText(o)}${this.waiting.get(t)?.count === 0 ? ' (class initialisation)' : ''}${owner ? `, owned by #${owner.id}` : ''}`;
      }
      const flags = `${this.timers.has(t) ? ', timer' : ''}${this.queued.has(t) ? ', queued' : ''}${this.pending.has(t) ? ', woken' : ''}${this.permits.has(t) ? ', permit' : ''}`;
      lines.push(`#${t.id} "${this.threadName(t)}" ${t.yielding ? 'yielding' : t.state}${on}${flags}`);
      for (const f of t.frames.slice(-depth).reverse()) lines.push(`    at ${frameText(f.method, f.pc)}`);
      if (t.frames.length > depth) lines.push(`    ... ${t.frames.length - depth} more`);
    }
    return lines;
  }

  private threadName(t: JThread): string {
    const o = t.javaThread;
    if (!o) return '(attached)';
    const f = o.cls.findField('name', 'Ljava/lang/String;') ?? o.cls.findField('name', '[C');
    const v = f && !f.isStatic ? o.fields[f.slot] : null;
    if (!v || typeof v !== 'object') return '?';
    if ('data' in v && v.data instanceof Uint16Array) return String.fromCharCode(...v.data);
    return this.jvm.heap.jsString(v) ?? '?';
  }

  /**
   * Runs until no thread can make progress; resolves 'idle' (no live thread, or some thread waits on a timer) or
   * 'deadlock' (every live thread blocked on a monitor or untimed wait). Rejects if a suspension fails with a JS error.
   */
  async run(signal?: AbortSignal): Promise<'idle' | 'deadlock' | 'aborted'> {
    if (this.running) throw new Error('Scheduler.run is already running');
    this.running = true;
    const onAbort = (): void => this.wake?.();
    signal?.addEventListener('abort', onAbort);
    try {
      let slices = 0;
      for (;;) {
        if (this.halted) return 'idle';
        if (this.failure) {
          const { error } = this.failure;
          this.failure = null;
          throw error;
        }
        if (signal?.aborted) return 'aborted';
        for (const y of this.yielded.splice(0)) this.makeRunnable(y);
        const t = this.queue.shift();
        if (t) {
          this.queued.delete(t);
          if (t.state === 'runnable') {
            try {
              this.step(t);
            } catch (e) {
              this.faulted = t;
              throw e;
            } finally {
              this.preempted = false;
            }
            if (t.state === 'runnable') this.enqueue(t);
          }
          if (++slices % YIELD_EVERY === 0) await (this.opts.yieldTask ? this.opts.yieldTask() : new Promise<void>((r) => this.opts.setTimer(0, r)));
          continue;
        }
        if (this.io > 0) {
          await new Promise<void>((r) => (this.wake = r));
          this.wake = null;
          continue;
        }
        return this.timers.size > 0 || this.live.length === 0 ? 'idle' : 'deadlock';
      }
    } finally {
      this.running = false;
      this.wake = null;
      signal?.removeEventListener('abort', onAbort);
      this.threads = this.live.slice();
    }
  }

  private step(t: JThread): void {
    const result = this.pending.get(t);
    if (result) {
      this.pending.delete(t);
      const k = this.conts.get(t);
      this.conts.delete(t);
      this.inThread(t, () => {
        let r: NativeResult;
        let v: NativeResult = undefined;
        let thrown: ThrowResult | null = null;
        try {
          v = result();
        } catch (e) {
          if (!(e instanceof JavaThrowable)) throw e;
          thrown = new ThrowResult(e.obj);
        }
        try {
          if (thrown) r = k ? k(thrown) : thrown;
          else r = !k ? v : v instanceof Invoke || v instanceof Suspend ? andThen(v, k, (e) => k(new ThrowResult(e))) : k(v);
        } catch (e) {
          if (!(e instanceof JavaThrowable)) throw e;
          r = new ThrowResult(e.obj);
        }
        complete(this.jvm, t, r);
      });
      if (t.state !== 'runnable') return;
    }
    execute(this.jvm, t, this.slice);
  }

  private inThread(t: JThread, fn: () => void): void {
    const previous = this.jvm.currentThread;
    this.jvm.currentThread = t;
    try {
      fn();
    } finally {
      this.jvm.currentThread = previous;
    }
  }

  private enqueue(t: JThread): void {
    if (this.queued.has(t)) return;
    this.queued.add(t);
    this.queue.push(t);
  }

  private makeRunnable(t: JThread): void {
    if (this.halted) return;
    t.state = 'runnable';
    t.blocker = null; // woken, or given its monitor back
    this.enqueue(t);
    this.wake?.();
  }

  private resume(t: JThread, result: () => NativeResult): void {
    this.cancelTimer(t);
    this.pending.set(t, result);
    this.makeRunnable(t);
  }

  /**
   * Frees a monitor and hands it on: to a waiter woken by notify (it takes the monitor back), or to the first thread
   * blocked entering. Ruling R19: either way the releasing thread's slice ends here (preempt), so the thread handed the
   * monitor runs before the releaser goes on, as on HotSpot, where it runs in parallel at once. Without it, a MediaTracker
   * waiter woken by an image's "complete" only ran after the fetcher had also reported its late error.
   */
  private release(m: Monitor): void {
    m.owner = null;
    m.count = 0;
    const next = m.entrySet.shift();
    if (!next) return;
    const re = this.reacquiring.get(next);
    if (!re) {
      this.makeRunnable(next);
      this.preempt();
      return;
    }
    this.reacquiring.delete(next);
    m.owner = next;
    m.count = re.count;
    this.resume(next, re.result);
    this.preempt();
  }

  private endWait(t: JThread, result: () => NativeResult): void {
    const w = this.waiting.get(t);
    if (!w) return;
    this.waiting.delete(t);
    this.cancelTimer(t);
    const m = w.o.monitor!;
    m.waitSet.splice(m.waitSet.indexOf(t), 1);
    if (w.count === 0) {
      this.resume(t, result);
    } else if (m.owner === null) {
      m.owner = t;
      m.count = w.count;
      this.resume(t, result);
    } else {
      t.state = 'blocked-monitor';
      m.entrySet.push(t);
      this.reacquiring.set(t, { count: w.count, result });
    }
  }

  private after(t: JThread, ms: number, fn: () => void): void {
    this.cancelTimer(t);
    let cancel: () => void = () => {};
    const fire = (): void => {
      if (this.timers.get(t) !== cancel) return;
      this.timers.delete(t);
      fn();
      const waiters = this.timerWaiters;
      this.timerWaiters = [];
      for (const w of waiters) w();
    };
    cancel = this.opts.setTimer(Math.min(ms, MAX_TIMER_MS), fire);
    this.timers.set(t, cancel);
  }

  private cancelTimer(t: JThread): void {
    const cancel = this.timers.get(t);
    if (!cancel) return;
    this.timers.delete(t);
    cancel();
  }

  private illegalMonitorState(): JavaThrowable {
    return new JavaThrowable(this.jvm.throwNew('java/lang/IllegalMonitorStateException').exception);
  }
}

/** An object as a thread dump names it: its class and identity hash, or the class a mirror stands for. */
function objectText(o: JObject): string {
  const c = o.nativeData as JClass | null | undefined;
  if (o.cls.name === 'java/lang/Class' && c && typeof c === 'object' && 'name' in c) return `class ${c.name.replace(/\//g, '.')}`;
  return `${o.cls.name.replace(/\//g, '.')}@${(o.hash >>> 0).toString(16)}`;
}

function monitorOf(o: JObject): Monitor {
  return (o.monitor ??= { owner: null, count: 0, entrySet: [], waitSet: [] });
}

function takeInterrupt(t: JThread): boolean {
  const was = t.interrupted;
  t.interrupted = false;
  return was;
}
