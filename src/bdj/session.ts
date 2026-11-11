/*
 * Original code for Seikou: the engine side of a BD-J worker. It boots the worker, answers Java's calls through
 * PlayerBdjHost, passes title starts and BD-J events in, and stops the worker on any failure, after which the player
 * falls back to the title picker (errors and fallback in docs/superpowers/specs/2026-10-16-m5c-bdj-playback-design.md).
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import type { DiscSpec } from '@seikou/engine/disc/disc-spec';
import type { BdjSessionDeps, BdjSessionLike, ClassLibrarySource, Coalesce } from '@seikou/engine/bdj-types';
import { bootTransfer, type BdjCallName, type BdjFailureCode, type BdjWireValue, type FromBdj, type ToBdj } from './worker-protocol';

export type { BdjFailureCode, BdjSessionDeps, WorkerLike } from '@seikou/engine/bdj-types';

/**
 * The start-up timeout: a BD-J title that has neither selected a playlist nor shown anything (a visible plane, a
 * background still) this long after boot is taken as hung, and the player falls back to the picker. A menu that waits
 * for input over a still or an empty video plane is alive, not hung, so a visible plane or a still counts as well as
 * a selected playlist.
 */
export const SELECT_PLAYLIST_TIMEOUT_MS = 20_000;

/**
 * The start-up timeout counts only time the page is visible and the host awake, since Java gets no time to run while
 * a hidden page's timers are throttled or the device sleeps. It is spent in ticks of at most this long; a hidden page
 * spends nothing.
 */
export const STARTUP_TICK_MS = 1_000;

/**
 * A tick that comes this much later than it was set for means the host slept (or the engine did not run): the
 * timeout starts over rather than firing at the wake for time Java never had.
 */
export const STARTUP_SLEEP_GAP_MS = 5_000;

/**
 * Waiting on the worker's own I/O pauses the start-up timeout (a cold first open over the NAS can spend most of 20 s
 * waiting on JAR and resource reads with nothing hung), but for at most this long in all per boot. Past
 * it the time counts as usual, so a disc that hangs reading in a loop (or retrying a read that keeps failing) still
 * falls back, 20 s of counted time later, with the thread dump. The legitimate waits measured on the NAS were 8–18 s.
 */
export const IO_PAUSE_CEILING_MS = 120_000;

/** At the start-up timeout, how long the worker has to log its thread dump before it is stopped. */
export const DUMP_WAIT_MS = 1_000;

/** At a stop with unsaved storage changes, how long the worker has to save them before it is terminated. */
export const STOP_SAVE_WAIT_MS = 3_000;

/**
 * The engine worker's side of one BD-J worker: it boots it, relays Java's calls to the host and the replies back,
 * holds title starts and events behind the reply they must follow, runs the start-up timeout, and stops the worker
 * on a failure or when BD-J stops. Nothing the worker sends after a stop is acted on.
 */
export class BdjSession implements BdjSessionLike {
  private stopped = false;
  private bootDone: (() => void) | null = null;
  private startedAt: number | null = null;
  /** The pending start-up tick (null: the timeout is not running, or it has fired or been cancelled). */
  private cancelTimeout: (() => void) | null = null;
  /** What is left of the start-up timeout, and when it was last counted. */
  private budget = { left: 0, at: 0, interval: 0 };
  /** The start-up timeout is running: armed, and neither fired nor cancelled (it sets no tick while hidden). */
  private ticking = false;
  private hidden: boolean;
  /**
   * The worker waits on its own I/O (its `io` message): that time is not counted either, since a slow link is not a
   * hang, up to IO_PAUSE_CEILING_MS in all. A worker that dies without an `onerror` while this is set sends no `io: false`:
   * such a session falls back only through that ceiling, 20 s of counted time after it.
   */
  private ioPending = false;
  /** IO_PAUSE_CEILING_MS has been reached: waiting on I/O counts from now on. */
  private ioCeilingReached = false;
  /** Of the time since the timeout was armed: what it counted, and what it passed over while the worker waited on I/O. */
  private counted = 0;
  private ioWaitMs = 0;
  /** The call whose synchronous handling is under way. */
  private callInHand: number | null = null;
  /** Starts (and what follows them) wait for the reply to this call. */
  private holdFor: number | null = null;
  private readonly held: ToBdj[] = [];
  private activityCount = 0;
  /** Calls the engine is answering (diagnostics). */
  private readonly answering = new Map<number, BdjCallName>();
  /** The start-up timeout has fired: the session fails once the worker's thread dump is in (or DUMP_WAIT_MS on). */
  private timedOut: (() => void) | null = null;
  /** The worker has storage scopes (it sent `unsaved`): a stop and a flush go to it. */
  private storage = false;
  private stopping: Promise<void> | null = null;

  constructor(private readonly deps: BdjSessionDeps) {
    this.hidden = deps.hidden ?? false;
    deps.worker.onmessage = (e) => this.receive(e.data);
    deps.worker.onerror = (e) => this.fail('internal', `the BD-J worker failed: ${e.message}`);
  }

  /** Settles once the worker has booted, or once the session has ended. */
  boot(disc: DiscSpec, readAheadBytes: number, discId: string | null, classLibrary: ClassLibrarySource): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) return resolve();
      this.armTimeout();
      this.bootDone = resolve;
      const { memory, memoryStatsMs } = this.deps;
      this.post({
        type: 'boot',
        registers: this.deps.regs,
        status: this.deps.status.buffer,
        plane: this.deps.plane,
        disc,
        readAheadBytes,
        discId,
        classLibrary,
        ...(memory ? { memory } : {}),
        ...(memoryStatsMs ? { memoryStatsMs } : {}),
      });
    });
  }

  /** A fresh session token for the worker's NAS reads. */
  setToken(token: string): void {
    if (!this.stopped) this.post({ type: 'remoteToken', token });
  }

  /**
   * Starts BD-J title `title` (BDJ_EVENT_START). A start asked for while a call is being handled waits for that
   * call's reply, so Java hears them in libbluray's order. Arms the start-up timeout if no boot did.
   */
  start(title: number): void {
    if (this.stopped) return;
    this.armTimeout();
    if (this.holdFor === null && this.callInHand !== null) this.holdFor = this.callInHand;
    this.send({ type: 'start', title });
  }

  /** The first-playlist timeout runs from boot (or the first start, without a boot), so a hung boot falls back too. */
  private armTimeout(): void {
    if (this.startedAt !== null) return;
    this.startedAt = this.deps.nowMs();
    this.budget = { left: this.timeoutMs, at: this.wallMs(), interval: 0 };
    this.counted = 0;
    this.ioWaitMs = 0;
    this.ioCeilingReached = false;
    this.ticking = true;
    this.tick();
  }

  private wallMs(): number {
    return (this.deps.wallMs ?? Date.now)();
  }

  private get timeoutMs(): number {
    return this.deps.selectTimeoutMs ?? SELECT_PLAYLIST_TIMEOUT_MS;
  }

  /**
   * Counts the time since the budget was last counted: none while hidden, none while the worker waits on its own
   * reads (a slow link is not a hang) until IO_PAUSE_CEILING_MS of such waiting, and none across
   * a host sleep, found as a wall-clock gap of STARTUP_SLEEP_GAP_MS or more beyond the tick's interval, which restarts
   * the budget.
   */
  private count(): void {
    const now = this.wallMs();
    const elapsed = Math.max(0, now - this.budget.at); // a wall clock set back counts nothing
    this.budget.at = now;
    if (this.hidden) return;
    if (elapsed - this.budget.interval >= STARTUP_SLEEP_GAP_MS) {
      this.budget.left = this.timeoutMs;
      this.counted = 0;
      this.deps.onLog?.(`BD-J start-up timeout restarted: the host did not run for ${Math.round(elapsed / 1000)} s`, false);
      return;
    }
    let active = elapsed;
    if (this.ioPending && !this.ioCeilingReached) {
      const waited = Math.min(elapsed, IO_PAUSE_CEILING_MS - this.ioWaitMs);
      this.ioWaitMs += waited;
      active -= waited;
      if (this.ioWaitMs >= IO_PAUSE_CEILING_MS) {
        this.ioCeilingReached = true;
        this.deps.onLog?.(`BD-J start-up timeout: the worker has waited on its reads for ${IO_PAUSE_CEILING_MS / 1000} s in all; waiting counts from now on`, true);
      }
    }
    this.budget.left -= active;
    this.counted += active;
  }

  /**
   * Fires the start-up timeout once the budget is spent; otherwise sets the next tick (none while hidden). Ticks go on
   * while the worker waits on I/O, so IO_PAUSE_CEILING_MS is noticed while a read stays pending.
   */
  private tick(): void {
    this.cancelTimeout = null;
    if (this.budget.left <= 0) {
      this.ticking = false;
      this.timeout(`no playlist was selected and nothing was shown within ${this.timeoutMs / 1000} s`);
      return;
    }
    if (this.hidden) return; // setHidden(false) sets the next tick
    const ms = Math.min(STARTUP_TICK_MS, this.budget.left);
    this.budget.interval = ms;
    this.cancelTimeout = this.deps.setTimer(ms, () => {
      this.count();
      this.tick();
    });
  }

  /**
   * The page was hidden or shown (the engine's `visibility` command). Hidden time is not counted, and a shown page
   * sets a fresh tick at once, since browsers throttle a hidden page's timers.
   */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    // shown again: a NAS disc's write-ahead copy goes to the NAS now, as the hide's flush may not have got it there
    // (browsers drop work started during pagehide)
    if (!hidden) this.flush();
    this.pause(() => (this.hidden = hidden));
  }

  /** The worker started or stopped waiting on its own I/O (its `io` message). */
  private setIoPending(pending: boolean): void {
    if (pending !== this.ioPending) this.pause(() => (this.ioPending = pending));
  }

  /** Changes what pauses the budget: the time up to now counts as the state it was spent in, then a fresh tick. */
  private pause(change: () => void): void {
    if (!this.ticking || this.stopped) {
      change();
      return;
    }
    this.cancelTimeout?.();
    this.count();
    this.budget.interval = 0;
    change();
    this.tick();
  }

  /** The start-up timeout: the engine's side and the worker's thread dump go to the log, then the session fails. */
  private timeout(message: string): void {
    if (this.stopped) return;
    this.cancelTimeout = null;
    const calls = [...this.answering].map(([id, name]) => `${name}#${id}`);
    this.deps.onLog?.(
      `BD-J start-up timeout: ${this.bootDone ? 'not booted' : 'booted'}, ${calls.length ? `the engine is answering ${calls.join(', ')}` : 'no call in the engine'}, ` +
        `${this.held.length} messages held${this.holdFor !== null ? ` for the reply to #${this.holdFor}` : ''}`,
      true,
    );
    const cancel = this.deps.setTimer(DUMP_WAIT_MS, () => {
      if (this.stopped) return;
      this.deps.onLog?.(`BD-J worker sent no thread dump within ${DUMP_WAIT_MS} ms (its event loop is blocked)`, true);
      this.timedOut?.();
    });
    this.timedOut = () => {
      cancel();
      this.timedOut = null;
      this.fail('timeout', message);
    };
    this.post({ type: 'dump', reason: 'start-up timeout' });
  }

  /** Queues a BDJ_EVENT_* for Java (behind a held start, if any); `coalesce` lets a full queue merge it (input.ts). */
  event(ev: number, param: number, coalesce?: Coalesce): void {
    if (!this.stopped) this.send({ type: 'event', ev, param, ...(coalesce ? { coalesce } : {}) });
  }

  /**
   * Counts what Java sent that shows it acted: every call (playback control, register writes, titles, sounds...) and
   * every background still. Only its changes matter (the ignored-tap rule, input.ts).
   */
  get activity(): number {
    return this.activityCount;
  }

  /** The page is going away (pagehide) or is shown again: the worker saves its storage changes now. */
  flush(): void {
    if (!this.stopped && this.storage) this.post({ type: 'flush' });
  }

  /**
   * Terminates the worker; nothing it sent afterwards is acted on. When it has storage scopes, it first saves them
   * (stop, then stopped; at most STOP_SAVE_WAIT_MS), even if no unsaved change has been heard of yet (one may be on its
   * way). Settles once the worker is terminated.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.ticking = false;
    this.cancelTimeout?.();
    this.cancelTimeout = null;
    this.bootDone?.();
    this.bootDone = null;
    const worker = this.deps.worker;
    worker.onerror = null;
    if (!this.storage) {
      worker.onmessage = null;
      worker.terminate();
      return (this.stopping = Promise.resolve());
    }
    return (this.stopping = new Promise<void>((resolve) => {
      const done = (): void => {
        cancel();
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        resolve();
      };
      const cancel = this.deps.setTimer(STOP_SAVE_WAIT_MS, () => {
        this.deps.onLog?.(`BD-J worker did not save its storage within ${STOP_SAVE_WAIT_MS} ms of the stop`, true);
        done();
      });
      worker.onmessage = (e) => {
        if (e.data.type === 'stopped') done();
        else if (e.data.type === 'log') this.deps.onLog?.(e.data.line, e.data.error);
      };
      worker.onerror = () => done();
      this.post({ type: 'stop' });
    }));
  }

  private receive(m: FromBdj): void {
    if (this.stopped) return;
    // after the start-up timeout only the dump is waited for: Java is refused as after stop() (nothing it sends is
    // acted on), so a playlist it selects now does not play behind the fallback
    if (this.timedOut && m.type !== 'log' && m.type !== 'dumped' && m.type !== 'unsaved') return;
    switch (m.type) {
      case 'booted':
        this.deps.onLog?.(`BD-J booted in ${Math.round(m.bootMs)} ms`, false);
        this.bootDone?.();
        this.bootDone = null;
        break;
      case 'call':
        this.activityCount++;
        void this.answer(m.id, m.name, m.args);
        break;
      case 'log':
        this.deps.onLog?.(m.line, m.error);
        break;
      case 'background':
        this.activityCount++;
        if (m.image) this.alive('showed a background still');
        this.deps.onBackground?.(m.image, m.rect);
        break;
      case 'failed':
        this.fail(m.code, m.message);
        break;
      case 'memory':
        this.deps.onMemory?.(m);
        break;
      case 'remoteTokenNeeded':
        this.deps.onTokenNeeded?.();
        break;
      case 'dumped':
        this.timedOut?.();
        break;
      case 'unsaved':
        this.storage = true;
        break;
      case 'io':
        this.setIoPending(m.pending);
        break;
      case 'storageLost':
        this.deps.onStorageLost?.(m.reason);
        break;
      case 'stopped':
        break;
    }
  }

  private async answer(id: number, name: BdjCallName, args: readonly BdjWireValue[]): Promise<void> {
    if (name === 'selectPlaylist' && Number(args[0]) >= 0) this.alive('selected its first playlist');
    let pending: Promise<number | string>;
    this.answering.set(id, name);
    this.callInHand = id;
    try {
      pending = this.deps.host.handle(name, args);
    } finally {
      this.callInHand = null;
    }
    // a call whose own handling stopped the session (selectTitle of an HDMV title: _play_hdmv → _stop_bdj) still has
    // its answer, as libbluray's native returns to Java; the reply goes to a terminated worker, where it is dropped
    const stoppedByThisCall = this.stopped;
    let value: number | string;
    try {
      value = await pending;
    } catch (e) {
      this.fail('internal', `${name} failed in the player: ${e instanceof Error ? e.message : String(e)}`);
      return;
    } finally {
      this.answering.delete(id);
    }
    if (stoppedByThisCall) {
      this.post({ type: 'reply', id, value });
      return;
    }
    if (this.stopped) return;
    if (name === 'selectPlaylist' || name === 'seek') this.deps.status.setTime45(this.deps.time45());
    this.post({ type: 'reply', id, value });
    if (this.holdFor === id) {
      this.holdFor = null;
      for (const m of this.held.splice(0)) this.post(m);
    }
  }

  /** The graphics plane turned visible: a menu on screen keeps the title alive without a playlist (SELECT_PLAYLIST_TIMEOUT_MS). */
  menuShown(): void {
    if (!this.stopped) this.alive('showed a menu');
  }

  /** Java showed it runs: the start-up timeout is cancelled, once. */
  private alive(what: string): void {
    if (!this.ticking || this.startedAt === null) return;
    this.count();
    this.ticking = false;
    this.cancelTimeout?.();
    this.cancelTimeout = null;
    this.deps.onLog?.(
      `BD-J ${what} ${Math.round(this.deps.nowMs() - this.startedAt)} ms after boot ` +
        `(${Math.round(this.counted)} ms of the start-up timeout counted; ${Math.round(this.ioWaitMs)} ms waiting on reads)`,
      false,
    );
  }

  private send(m: ToBdj): void {
    if (this.holdFor !== null) this.held.push(m);
    else this.post(m);
  }

  private post(m: ToBdj): void {
    this.deps.worker.postMessage(m, bootTransfer(m));
  }

  private fail(code: BdjFailureCode, message: string): void {
    if (this.stopped) return;
    this.stop();
    this.deps.onFailed(code, message);
  }
}
