/*
 * Original code for bluray-web: filling a NAS disc's read-ahead cache ahead of the play position (buffer first).
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { ByteRange } from './read-ahead-cache';

/** Range requests the fill keeps in flight. */
export const FILL_IN_FLIGHT = 2;

/**
 * A failed fill read is tried again after these delays (then every 10 s) for as long as the disc is open: on WebRTC
 * over cellular the link flaps, and a read that succeeds after a reconnect resumes the fill where it stopped.
 */
export const FILL_RETRY_MS: readonly number[] = [1_000, 2_000, 4_000, 10_000];
/** A fill whose reads have failed without a break for this long stops ('failed'). */
export const FILL_GIVE_UP_MS = 120_000;

/** Why a fill ended early: a read or a cache write failed, or there is no cache on this device. */
export type FillStop = 'failed' | 'no-cache';

export interface FillProgress {
  /** Bytes held ahead of the play position (the lead). */
  readonly bytes: number;
  /** The fill's target, or all there is ahead when that is less. */
  readonly targetBytes: number;
  /** The network's rate over the fill so far. */
  readonly mbps: number;
  readonly stopped?: FillStop;
}

export interface CacheFillDeps {
  readonly remote: {
    readonly chunkBytes: number;
    fillChunk(path: string, offset: number, signal: AbortSignal): Promise<number>;
    /** The chunk is being fetched already (by playback's reads or the fill). */
    isFetching(path: string, offset: number): boolean;
    /** A playback read is waiting on the network: the fill then keeps one request in flight, not two. */
    readonly playbackWaiting: boolean;
  };
  readonly cache: {
    coveredEnd(path: string, offset: number): number | null;
    heldBytes(path: string, start: number, end: number): number;
    evictOutside(keep: readonly ByteRange[]): Promise<void>;
    write?(path: string, offset: number, bytes: Uint8Array): Promise<void>;
  };
  /**
   * The stream ranges still to play, from the play position on, in playback order; null while the fill should idle
   * (another playlist plays): no fetches, nothing freed, until a kick finds ranges again.
   */
  ranges(): readonly ByteRange[] | null;
  /**
   * Keep going to the end of the playlist, following the play position and freeing what it has passed, until stopped
   * (a bufferFirst open); otherwise stop once the target is held.
   */
  readonly follow: boolean;
  readonly targetBytes: number;
  /**
   * Following, the most it holds ahead of the play position (the target plus a segment): fetching pauses there and
   * goes on as playback uses the lead up (a paused player, a link faster than the probe).
   */
  readonly leadCapBytes?: number;
  /** The cache's segment size: a full disk lowers the lead cap to a segment under the lead it held then. */
  readonly segmentBytes?: number;
  progress(p: FillProgress): void;
  nowMs(): number;
  /** One-shot timer for the retries, cancelled by the returned function. */
  setTimer(ms: number, fn: () => void): () => void;
  /** A failure no retry can mend (the disc changed on the NAS, this device is no longer paired): the fill stops at once. */
  permanent(err: unknown): boolean;
}

interface Fetch {
  readonly path: string;
  readonly offset: number;
  readonly controller: AbortController;
  /** Order of starting, so a fetch started before a failure doesn't count as the link coming back. */
  readonly seq: number;
}

/**
 * Fetches the playlist's bytes into the cache in playback order from the play position, FILL_IN_FLIGHT chunks at a
 * time, skipping what the cache holds or playback is fetching. Every time a chunk lands or the position moves (kick),
 * it looks again from the position: a seek abandons fetches that are no longer ahead and starts from the new place.
 */
export class CacheFill {
  /** The lead reached the target, or the fill ended. */
  readonly reached: Promise<void>;
  private resolveReached!: () => void;
  private wake: (() => void) | null = null;
  /** Something happened while the loop wasn't waiting: it looks again at once. */
  private woken = false;
  private stopped = false;
  private readonly inFlight = new Map<string, Fetch>();
  private failure = false;
  /** Failed rounds in a row (a round: from a failure to its retry), and when the first of them failed. */
  private failures = 0;
  private failingSinceMs: number | null = null;
  /** Waiting to try again: no fetch starts until the timer ends it. */
  private cancelRetry: (() => void) | null = null;
  private seq = 0;
  /** A full disk (QuotaExceededError) lowered the lead cap to this. */
  private quotaCap = Infinity;
  /** The lead at the last pass, for the full-disk cap. */
  private lead = 0;
  /** Bytes of playback's reads being written to the cache (keep). */
  private landing = 0;
  /** The last fetch started when a read last failed. */
  private failedAtSeq = -1;
  private networkBytes = 0;
  private last = '';

  constructor(private readonly deps: CacheFillDeps) {
    this.reached = new Promise((resolve) => (this.resolveReached = resolve));
  }

  /**
   * A chunk playback read from the network (write-through): stored in the cache when the fill would fetch it now, ahead
   * of the play position with the lead (counting writes still landing) under its cap; dropped otherwise.
   */
  keep(path: string, offset: number, bytes: Uint8Array): void {
    if (this.stopped || !this.deps.cache.write) return;
    const ranges = this.deps.ranges();
    if (ranges === null || !ranges.some((r) => r.path === path && r.start <= offset && offset < r.end)) return;
    const cap = this.deps.follow ? Math.min(this.deps.leadCapBytes ?? Infinity, this.quotaCap) : Infinity;
    const lead = ranges.reduce((sum, r) => sum + this.deps.cache.heldBytes(r.path, r.start, r.end), 0);
    if (lead + this.landing + bytes.length > cap) return;
    this.landing += bytes.length;
    this.deps.cache
      .write(path, offset, bytes)
      .catch(() => undefined)
      .finally(() => (this.landing -= bytes.length));
  }

  /** The play position moved (a seek, or playback went on): look again. */
  kick(): void {
    this.poke();
  }

  private poke(): void {
    this.woken = true;
    this.wake?.();
  }

  /** Ends the fill; what the cache holds stays. */
  stop(): void {
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
    for (const f of this.inFlight.values()) f.controller.abort(new DOMException('the fill stopped', 'AbortError'));
    this.inFlight.clear();
    this.poke();
    this.resolveReached();
  }

  async run(): Promise<void> {
    const { remote, cache } = this.deps;
    const cb = remote.chunkBytes;
    const startedMs = this.deps.nowMs();
    try {
      while (!this.stopped) {
        this.woken = false;
        const ranges = this.deps.ranges();
        if (ranges === null) {
          // another playlist plays: wait for this one to play again (a kick)
          if (!this.woken) await new Promise<void>((resolve) => (this.wake = resolve));
          this.wake = null;
          continue;
        }
        // a fetch no longer ahead (a seek) gives its place to one that is
        for (const [key, f] of this.inFlight) {
          if (ranges.some((r) => r.path === f.path && r.start <= f.offset && f.offset < r.end)) continue;
          f.controller.abort(new DOMException('no longer ahead', 'AbortError'));
          this.inFlight.delete(key);
        }
        if (this.deps.follow) await cache.evictOutside(ranges);
        const total = ranges.reduce((sum, r) => sum + r.end - r.start, 0);
        const targetBytes = Math.min(Math.max(0, this.deps.targetBytes), total);
        const bytes = ranges.reduce((sum, r) => sum + cache.heldBytes(r.path, r.start, r.end), 0);
        this.lead = bytes;
        if (this.failure) {
          this.report({ bytes, targetBytes, mbps: this.mbps(startedMs), stopped: 'failed' });
          return;
        }
        this.report({ bytes, targetBytes, mbps: this.mbps(startedMs) });
        if (bytes >= targetBytes) {
          this.resolveReached();
          if (!this.deps.follow) return;
        }
        // following, the lead is capped (counting what is in flight); playback reads waiting on the network go first
        const cap = this.deps.follow ? Math.min(this.deps.leadCapBytes ?? Infinity, this.quotaCap) : Infinity;
        const capped = (): boolean => bytes + this.landing + this.inFlight.size * cb >= cap;
        const inFlightMax = remote.playbackWaiting ? 1 : FILL_IN_FLIGHT;
        while (this.inFlight.size < inFlightMax && !this.cancelRetry && !capped()) {
          const next = this.nextMissing(ranges, cb);
          if (!next) break;
          this.start(next.path, next.offset);
        }
        if (bytes >= this.quotaCap) this.resolveReached(); // a full disk: the open waits no longer for a lead it can't hold
        if (this.inFlight.size === 0 && !this.cancelRetry && !capped()) {
          this.resolveReached(); // all there is ahead is held
          if (!this.deps.follow) return;
        }
        if (!this.woken) await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = null;
      }
    } finally {
      this.stop();
    }
  }

  private start(path: string, offset: number): void {
    const key = `${path}\n${offset}`;
    const f: Fetch = { path, offset, controller: new AbortController(), seq: this.seq++ };
    this.inFlight.set(key, f);
    this.deps.remote.fillChunk(path, offset, f.controller.signal).then(
      (n) => {
        this.networkBytes += n;
        if (f.seq > this.failedAtSeq) {
          // a read started after the last failure came through: the link is back
          this.failures = 0;
          this.failingSinceMs = null;
        }
      },
      (err: unknown) => {
        if (!f.controller.signal.aborted && !this.stopped) this.failed(err);
      },
    ).finally(() => {
      if (this.inFlight.get(key) === f) this.inFlight.delete(key);
      this.poke();
    });
  }

  /**
   * A read (or a cache write) failed: a failure no retry mends, or two minutes of them, stops the fill; otherwise it
   * waits FILL_RETRY_MS and fetches the same chunk again (the first one missing ahead).
   */
  private failed(err: unknown): void {
    if ((err as { name?: unknown } | null)?.name === 'QuotaExceededError') {
      // a full disk is no flap: hold a segment under the lead held now, and go on once playback has freed room; with
      // no lead to hold, or not following (no playback frees room), it stops as failed
      const segment = this.deps.segmentBytes ?? this.deps.remote.chunkBytes;
      if (!this.deps.follow || this.lead < segment) this.failure = true;
      else this.quotaCap = Math.min(this.quotaCap, this.lead - segment);
      return;
    }
    const now = this.deps.nowMs();
    this.failingSinceMs ??= now;
    this.failedAtSeq = this.seq - 1;
    if (this.deps.permanent(err) || now - this.failingSinceMs >= FILL_GIVE_UP_MS) {
      this.failure = true;
      return;
    }
    if (this.cancelRetry) return; // this round is already waiting
    const delay = FILL_RETRY_MS[Math.min(this.failures, FILL_RETRY_MS.length - 1)]!;
    this.failures++;
    this.cancelRetry = this.deps.setTimer(delay, () => {
      this.cancelRetry = null;
      this.poke();
    });
  }

  /** The first chunk ahead that is neither held nor being fetched. */
  private nextMissing(ranges: readonly ByteRange[], cb: number): { path: string; offset: number } | null {
    for (const r of ranges) {
      let off = Math.floor(r.start / cb) * cb;
      while (off < r.end) {
        const chunkEnd = Math.min(off + cb, r.end);
        const covered = this.deps.cache.coveredEnd(r.path, off);
        if (covered !== null && covered >= chunkEnd) {
          off = Math.max(off + cb, Math.floor(covered / cb) * cb);
          continue;
        }
        if (this.inFlight.has(`${r.path}\n${off}`) || this.deps.remote.isFetching(r.path, off)) {
          off += cb;
          continue;
        }
        return { path: r.path, offset: off };
      }
    }
    return null;
  }

  private mbps(startedMs: number): number {
    return (this.networkBytes * 8) / 1e6 / (Math.max(this.deps.nowMs() - startedMs, 1) / 1000);
  }

  /** Progress, when the lead, the target or the outcome changed. */
  private report(p: FillProgress): void {
    const key = `${p.bytes}/${p.targetBytes}/${p.stopped ?? ''}`;
    if (key === this.last) return;
    this.last = key;
    this.deps.progress(p);
  }
}
