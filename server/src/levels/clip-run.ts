import type { Readable } from 'node:stream';
import { KeptStreams, PesCoreFilter } from './audio-core';
import { ClipEncoder, IntervalDoesNotFit, encodeIntervalAt, runWindow, MAX_INTERVALS_PER_RUN, type ClipEncoderOptions, type ClipReader, type EncoderBackend } from './encoder';
import { SOURCE_PACKET_BYTES, type IntervalPlan } from './levels';
import { IntervalCollector, remuxInterval, shedGraphics, type EncodedPes, type GraphicsByNumber, type IntervalSource, type RemuxInput } from './remux';
import type { SegmentCache } from './segment-cache';

/** Time and timers, injectable for tests. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** What a level keeps of a clip besides its video (the `KeptStreams` of each run). */
export interface KeptConfig {
  /** Pass-through PIDs: the kept audio, every PG and IG, the PAT, and a PCR PID of its own. */
  readonly keepPids: readonly number[];
  /** Audio PID → its coding on the disc, for the kept audio that travels as its core (TrueHD, DTS-HD). */
  readonly coreFilters: ReadonlyMap<number, number>;
  /** The clip's PMT PIDs (CLPI program_map_PID). */
  readonly pmtPids: readonly number[];
  /** The level's video stream_type in the regenerated PMT (0x1B or 0x24). */
  readonly videoStreamType: number;
  /** The source's PCR PID (CLPI STC sequence). */
  readonly pcrPid: number;
  /** The kept PG and IG PIDs by stream number: what the last resort drops (`shedGraphics`). */
  readonly graphics?: GraphicsByNumber;
}

/** Clips whose PG drops were logged: once per clip (an IG drop, a menu lost, is logged every time). */
const pgShedLogged = new WeakSet<ClipRunPlan>();

/**
 * Intervals that fit their budget at no rate (`IntervalDoesNotFit`), per segment cache, by `<cache key>#<index>` (the
 * cache key holds the plan's hash): a later read, by any viewing, gets the error at once instead of a re-encode every
 * `FAILURE_BACKOFF_MS`. In memory, so a restart tries again; bounded.
 */
const unfittableByCache = new WeakMap<SegmentCache, Map<string, Error>>();
const UNFITTABLE_MAX = 1024;

function unfittableOf(cache: SegmentCache): Map<string, Error> {
  let map = unfittableByCache.get(cache);
  if (!map) unfittableByCache.set(cache, (map = new Map()));
  return map;
}

function rememberUnfittable(cache: SegmentCache, key: string, err: Error): void {
  const map = unfittableOf(cache);
  map.set(key, err);
  for (const oldest of map.keys()) {
    if (map.size <= UNFITTABLE_MAX) break;
    map.delete(oldest);
  }
}

/** One clip at one level and audio stream: its plan, where its bytes come from, and how it is encoded. */
export interface ClipRunPlan {
  readonly intervals: readonly IntervalPlan[];
  /** The segment cache key (`SegmentCache.key`); it waits for the clip's scan probe, and rejects when that fails. */
  readonly cacheKey: () => Promise<string>;
  /** The source clip's bytes, fed to the kept-stream filter. */
  readonly read: ClipReader;
  /** The encoder's options but `interlaced` and `frameTicks`, which `scan()` answers (one ffprobe per clip). */
  readonly encoder: Omit<ClipEncoderOptions, 'interlaced' | 'frameTicks' | 'maxIntervalsPerRun'>;
  readonly scan: () => Promise<{ readonly interlaced: boolean; readonly frameTicks: number }>;
  readonly kept: KeptConfig;
  /** Names the clip in the log: `disc <id> clip <clip> at <level>, audio <n>`. */
  readonly label?: string;
}

export interface ClipRunDeps {
  readonly backend: EncoderBackend;
  readonly cache: SegmentCache;
  readonly clock: Clock;
  /** Film the encoder runs ahead of the latest read (spec §6.1: 120 s). */
  readonly readAheadMs: number;
  /** A read at most this much film ahead of the running encoder waits for it (10 s); one further ahead restarts it. */
  readonly waitFilmMs: number;
  /** No read for this long stops the encoder (spec §6.1: 60 s). */
  readonly idleMs: number;
  /** Called once the runner went idle and stopped; the service forgets it. */
  readonly onIdle: () => void;
  readonly log: (message: string) => void;
}

/** How far (in intervals) the source reader may run ahead of the re-muxer before it pauses. */
const SOURCE_LEAD_INTERVALS = 8;
/** Encoded intervals held for the re-muxer before ffmpeg's output is paused. */
const VIDEO_LEAD_INTERVALS = 8;
/** After a failed run, no new one starts for this long; reads are asked to retry. */
export const FAILURE_BACKOFF_MS = 5_000;

/**
 * A read should be retried shortly: the encoder was restarted elsewhere for another read of the same viewing, it is
 * backing off after a failure, or the runner was closed. The service answers it with `retryAfter`.
 */
export class RetryLater extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryLater';
  }
}
const MS_PER_45KHZ = 1 / 45;

interface Waiter {
  readonly promise: Promise<Buffer>;
  readonly resolve: (bytes: Buffer) => void;
  readonly reject: (err: Error) => void;
  refs: number;
  settled: boolean;
  /** Not in the cache: it waits for the encoder. */
  encoding: boolean;
}

function waiter(): Waiter {
  let resolve!: (bytes: Buffer) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<Buffer>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A waiter nobody awaits any more (its reads timed out or were aborted) may still be rejected.
  promise.catch(() => {});
  return { promise, resolve, reject, refs: 0, settled: false, encoding: false };
}

/**
 * Serves one clip's intervals at a level (spec §6.1): from the segment cache, else from the clip's encoder run.
 *
 * - A read of an interval the running encoder will reach within `waitFilmMs` of film waits for it; any other (a seek,
 *   or an interval produced before and since evicted) restarts the encoder at that interval. Intervals already in the
 *   cache stay valid across restarts.
 * - A run covers one window (`runWindow`: one STC sequence, at most 300 intervals), sized to end `readAheadMs` of film
 *   past the latest read. When it ends, the next run starts at the first interval not cached once the lead over the
 *   latest read has fallen under half of `readAheadMs` (or a read waits past the window); until then the encoder idles.
 * - A restart fails the reads waiting for intervals the new run won't reach with `RetryLater` (they come back, and are
 *   served from the cache or decide again), so no read hangs on a run that was stopped.
 * - A failed run fails the reads waiting for the encoder; for `FAILURE_BACKOFF_MS` no run starts and reads that need
 *   one get `RetryLater`.
 * - `idleMs` after the last read, the run stops and `onIdle` is called.
 */
export class ClipRunner {
  private run: Run | null = null;
  private readonly waiters = new Map<number, Waiter>();
  /** Intervals just produced, until the cache has them. */
  private readonly recent = new Map<number, Buffer>();
  /** Film time (ms) at each interval's start, from the clip's start. */
  private readonly film: number[];
  private head = 0;
  private idleTimer: unknown = null;
  private pumping = false;
  private closed = false;
  private failedAt: number | null = null;

  constructor(
    private readonly plan: ClipRunPlan,
    private readonly deps: ClipRunDeps,
  ) {
    let at = 0;
    this.film = plan.intervals.map((iv) => {
      const start = at;
      at += (iv.endPts45 - iv.startPts45) * MS_PER_45KHZ;
      return start;
    });
  }

  get intervals(): readonly IntervalPlan[] {
    return this.plan.intervals;
  }

  /** A read starts at interval `index`: the encoder's lead is measured from it, and the idle timer restarts. */
  noteRead(index: number): void {
    if (this.closed) return;
    this.head = index;
    if (this.idleTimer !== null) this.deps.clock.clearTimeout(this.idleTimer);
    this.idleTimer = this.deps.clock.setTimeout(() => this.idle(), this.deps.idleMs);
    void this.pump();
  }

  /** Interval `index`'s bytes at the level. Aborting `signal` stops this caller's wait; the encoder carries on. */
  interval(index: number, signal: AbortSignal): Promise<Buffer> {
    if (signal.aborted) return Promise.reject(signal.reason as Error);
    if (this.closed) return Promise.reject(new RetryLater('levels: the clip runner is closed'));
    const recent = this.recent.get(index);
    if (recent) return Promise.resolve(recent);
    let w = this.waiters.get(index);
    if (!w) {
      w = waiter();
      this.waiters.set(index, w);
      void this.find(index, w);
    }
    const shared = w;
    shared.refs++;
    return new Promise<Buffer>((resolve, reject) => {
      const done = (): void => {
        signal.removeEventListener('abort', onAbort);
        shared.refs--;
      };
      const onAbort = (): void => {
        done();
        if (shared.refs === 0 && !shared.settled && this.waiters.get(index) === shared) this.waiters.delete(index);
        reject(signal.reason as Error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      shared.promise.then(
        (bytes) => {
          done();
          resolve(bytes);
        },
        (err: Error) => {
          done();
          reject(err);
        },
      );
    });
  }

  /**
   * Stops the encoder; waiting reads fail with `RetryLater` (the runner was closed by a moved lease, a rebuilt version, a
   * release or idling; a retry finds the cache or a new runner).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer !== null) this.deps.clock.clearTimeout(this.idleTimer);
    this.stopRun();
    this.rejectAll(new RetryLater('levels: the clip runner was closed'));
  }

  private idle(): void {
    this.idleTimer = null;
    this.close();
    this.deps.onIdle();
  }

  /** The cache first; else the running encoder, or a new run. */
  private async find(index: number, w: Waiter): Promise<void> {
    let key: string;
    try {
      key = await this.plan.cacheKey();
    } catch (err) {
      if (!w.settled && this.waiters.get(index) === w) this.reject(index, new Error(`levels: probing the clip's scan failed: ${(err as Error).message}`));
      return;
    }
    let bytes: Buffer | null;
    try {
      bytes = await this.deps.cache.get(key, index);
    } catch (err) {
      this.deps.log(`levels: the segment cache failed: ${(err as Error).message}`);
      bytes = null;
    }
    if (w.settled || this.waiters.get(index) !== w) return;
    if (bytes) {
      this.settle(index, bytes);
      // A later read may have held back for this one; with nothing to encode here, it is its turn.
      void this.pump();
      return;
    }
    const failed = unfittableOf(this.deps.cache).get(`${key}#${index}`);
    if (failed) {
      this.reject(index, failed);
      void this.pump();
      return;
    }
    if (this.closed) return;
    w.encoding = true;
    const run = this.run;
    if (run && this.reachesSoon(run, index)) return;
    if (this.backingOff()) {
      this.reject(index, new RetryLater(`levels: encoding failed less than ${FAILURE_BACKOFF_MS / 1000} s ago`));
      return;
    }
    // Reads that come together (a player's read-ahead) look the cache up in any order: a run started here for a later
    // interval would be restarted at once by the earlier one. The earlier read starts the run, or pumps once its
    // interval turns out cached.
    if (this.earlierLooking(index)) return;
    this.startRun(index);
  }

  /** Whether a read before `index` is still looking the cache up (neither answered nor waiting on the encoder). */
  private earlierLooking(index: number): boolean {
    for (const [i, w] of this.waiters) if (i < index && !w.settled && !w.encoding) return true;
    return false;
  }

  private backingOff(): boolean {
    return this.failedAt !== null && this.deps.clock.now() - this.failedAt < FAILURE_BACKOFF_MS;
  }

  /** Whether `run` will produce `index` soon enough to wait for: within `waitFilmMs` of film of where it is. */
  private reachesSoon(run: { readonly next: number }, index: number): boolean {
    if (index < run.next) return false; // produced already, and since gone from the cache
    return this.film[index]! - this.film[run.next]! <= this.deps.waitFilmMs;
  }

  private startRun(from: number): void {
    this.stopRun();
    const { intervals } = this.plan;
    const until = Math.max(this.film[this.head] ?? 0, this.film[from]!) + this.deps.readAheadMs;
    let count = 1;
    while (from + count < intervals.length && count < MAX_INTERVALS_PER_RUN && this.film[from + count]! < until) count++;
    const run = new Run(from, count, this.plan, this.deps, {
      produced: (index, bytes) => this.produced(index, bytes),
      ended: () => {
        if (this.run !== run) return;
        this.run = null;
        void this.pump();
      },
      failed: (err) => {
        if (this.run !== run) return;
        this.run = null;
        this.failedAt = this.deps.clock.now();
        this.deps.log(`levels: encoding from interval ${from} failed: ${err.message}`);
        for (const [index, w] of this.waiters) if (w.encoding) this.reject(index, err);
      },
    });
    this.run = run;
    // Reads waiting for intervals this run won't produce come back later rather than wait on nothing.
    for (const [index, w] of this.waiters) {
      if (w.encoding && (index < from || index >= from + count)) this.reject(index, new RetryLater(`levels: the encoder moved to interval ${from}`));
    }
    run.start();
  }

  private stopRun(): void {
    this.run?.stop();
    this.run = null;
  }

  /** With no run: starts one at the first interval not cached, when a read waits or the lead fell under half the window. */
  private async pump(): Promise<void> {
    if (this.pumping || this.run || this.closed || this.backingOff()) return;
    this.pumping = true;
    try {
      const { intervals } = this.plan;
      const cacheKey = await this.plan.cacheKey();
      let from = this.head;
      while (from < intervals.length && (this.recent.has(from) || unfittableOf(this.deps.cache).has(`${cacheKey}#${from}`) || (await this.deps.cache.has(cacheKey, from)))) from++;
      if (this.run || this.closed) return;
      let waiting: number | null = null;
      for (const [index, w] of this.waiters) if (w.encoding && !w.settled && (waiting === null || index < waiting)) waiting = index;
      if (waiting !== null) from = Math.min(from, waiting);
      if (from >= intervals.length) return;
      if (this.earlierLooking(from)) return; // that read starts the run, or pumps again
      const lead = this.film[from]! - (this.film[this.head] ?? 0);
      if (waiting !== null || lead < this.deps.readAheadMs / 2) this.startRun(from);
    } catch (err) {
      this.deps.log(`levels: the segment cache failed: ${(err as Error).message}`);
    } finally {
      this.pumping = false;
    }
  }

  private produced(index: number, bytes: Uint8Array): void {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.recent.set(index, buffer);
    this.settle(index, buffer);
    this.plan
      .cacheKey()
      .then((key) => this.deps.cache.put(key, index, bytes))
      .catch((err: Error) => this.deps.log(`levels: storing interval ${index} failed: ${err.message}`))
      .finally(() => this.recent.delete(index));
  }

  private settle(index: number, bytes: Buffer): void {
    const w = this.waiters.get(index);
    if (!w) return;
    this.waiters.delete(index);
    w.settled = true;
    w.resolve(bytes);
  }

  private reject(index: number, err: Error): void {
    const w = this.waiters.get(index);
    if (!w) return;
    this.waiters.delete(index);
    w.settled = true;
    w.reject(err);
  }

  private rejectAll(err: Error): void {
    for (const index of [...this.waiters.keys()]) this.reject(index, err);
  }
}

interface RunHooks {
  produced(index: number, bytes: Uint8Array): void;
  ended(): void;
  failed(err: Error): void;
}

/**
 * One encoder run over a window of intervals: ffmpeg encodes the video while the source clip is read from the window's
 * first interval through `KeptStreams` into an `IntervalCollector`; each interval's encoded video and collected packets
 * are re-muxed to its budget (re-encoded smaller on overflow) and handed over in order.
 */
class Run {
  /** The next interval to hand over. */
  next: number;
  readonly last: number;
  private readonly collector: IntervalCollector;
  private readonly videos = new Map<number, EncodedPes[]>();
  private options: ClipEncoderOptions | null = null;
  private encoder: ClipEncoder | null = null;
  private stream: Readable | null = null;
  private paused = false;
  /** The SPN of the next source packet. */
  private spn = 0;
  private partial: Uint8Array = new Uint8Array(0);
  private encoderEnded = false;
  private busy = false;
  private stopped = false;
  /** Aborted by `stop()`: stops an over-budget re-encode still running. */
  private readonly stopping = new AbortController();

  constructor(
    private readonly from: number,
    private readonly count: number,
    private readonly plan: ClipRunPlan,
    private readonly deps: ClipRunDeps,
    private readonly hooks: RunHooks,
  ) {
    const { window } = runWindow(plan.intervals, from, plan.encoder.stcStarts ?? [], count);
    this.next = from;
    this.last = window.at(-1)!.index;
    const { kept, encoder } = plan;
    const filters = new Map([...kept.coreFilters].map(([pid, coding]) => [pid, new PesCoreFilter(coding)]));
    const streams = new KeptStreams(new Set(kept.keepPids), filters, {
      pmtPids: kept.pmtPids,
      video: { pid: encoder.videoPid, streamType: kept.videoStreamType },
    });
    this.collector = new IntervalCollector(streams, {
      videoPid: encoder.videoPid,
      pcrPid: kept.pcrPid,
      intervals: plan.intervals,
      ...(encoder.stcStarts ? { stcStarts: encoder.stcStarts } : {}),
    });
  }

  start(): void {
    this.plan.scan().then(
      ({ interlaced, frameTicks }) => {
        if (this.stopped) return;
        this.options = { ...this.plan.encoder, interlaced, frameTicks, maxIntervalsPerRun: this.count };
        const encoder = new ClipEncoder(this.deps.backend, this.options);
        this.encoder = encoder;
        encoder.on('interval', (index, video) => {
          this.videos.set(index, video);
          if (this.videos.size > VIDEO_LEAD_INTERVALS) encoder.pause();
          void this.process();
        });
        encoder.on('error', (err) => this.fail(err));
        encoder.on('end', () => {
          this.encoderEnded = true;
          void this.process();
        });
        encoder.start(this.from);
        this.readSource();
      },
      (err: Error) => this.fail(new Error(`levels: probing the clip's scan failed: ${err.message}`)),
    );
  }

  stop(): void {
    this.stopped = true;
    this.stopping.abort();
    this.encoder?.stop();
    this.encoder = null;
    this.stream?.destroy();
    this.stream = null;
  }

  private fail(err: Error): void {
    if (this.stopped) return;
    this.stop();
    this.hooks.failed(err);
  }

  private readSource(): void {
    const first = this.plan.intervals[this.from]!;
    this.spn = first.srcSpnStart;
    const stream = this.plan.read(first.srcSpnStart * SOURCE_PACKET_BYTES);
    this.stream = stream;
    const lastPlan = this.plan.intervals[this.last]!;
    stream.on('data', (chunk: Buffer) => {
      if (this.stopped) return;
      this.feed(chunk);
      if (this.collector.ready(lastPlan)) this.closeSource();
      else if (this.tooFarAhead()) {
        this.paused = true;
        stream.pause();
      }
      void this.process();
    });
    stream.on('end', () => {
      if (this.stopped) return;
      this.collector.finish();
      this.stream = null;
      void this.process();
    });
    stream.on('error', (err) => this.fail(new Error(`levels: reading the clip failed: ${err.message}`)));
  }

  private feed(chunk: Buffer): void {
    let data = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (this.partial.length > 0) {
      const joined = new Uint8Array(this.partial.length + data.length);
      joined.set(this.partial);
      joined.set(data, this.partial.length);
      data = joined;
    }
    const whole = data.length - (data.length % SOURCE_PACKET_BYTES);
    // Views into the chunk: the collector copies the few packets it keeps.
    for (let at = 0; at < whole; at += SOURCE_PACKET_BYTES) this.collector.push(data.subarray(at, at + SOURCE_PACKET_BYTES), this.spn++);
    this.partial = data.slice(whole);
  }

  private closeSource(): void {
    this.stream?.destroy();
    this.stream = null;
  }

  private tooFarAhead(): boolean {
    const limit = this.plan.intervals[Math.min(this.next + SOURCE_LEAD_INTERVALS, this.last)]!;
    return this.spn > limit.srcSpnEnd;
  }

  /** Hands over every interval whose video and kept packets are both in, in order. */
  private async process(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      while (!this.stopped && this.next <= this.last) {
        const plan = this.plan.intervals[this.next]!;
        const video = this.videos.get(this.next);
        if (!video || !this.collector.ready(plan)) break;
        const source = this.collector.take(plan);
        this.videos.delete(this.next);
        if (this.videos.size <= VIDEO_LEAD_INTERVALS) this.encoder?.resume();
        if (this.paused && !this.tooFarAhead()) {
          this.paused = false;
          this.stream?.resume();
        }
        const bytes = await this.remux(plan, source, video);
        if (this.stopped) return;
        this.next++;
        this.hooks.produced(plan.index, bytes);
      }
      if (!this.stopped && this.next > this.last && this.encoderEnded) {
        this.stop();
        this.hooks.ended();
      }
    } catch (err) {
      this.fail(err as Error);
    } finally {
      this.busy = false;
    }
  }

  /** The interval's bytes at its budget; an encode that overflows it is re-encoded smaller first (Review Focus 1). */
  private async remux(plan: IntervalPlan, source: IntervalSource, video: readonly EncodedPes[]): Promise<Uint8Array> {
    const { encoder, kept } = this.plan;
    const input = (v: readonly EncodedPes[]): RemuxInput => ({
      plan,
      kept: source.kept,
      video: v,
      videoPid: encoder.videoPid,
      videoTimeline: source.videoTimeline,
      pcr: source.pcr,
      ...(source.endAts === undefined ? {} : { endAts: source.endAts }),
      pmtPids: kept.pmtPids,
    });
    const first = remuxInterval(input(video));
    if ('bytes' in first) return first.bytes;
    const options = this.options!;
    const rateBps = options.rateBps ?? options.level.targetBps;
    const where = `${this.plan.label ?? 'a clip'}, interval ${plan.index}`;
    let dropped = '';
    const lastResort = (v: readonly EncodedPes[]): { bytes: Uint8Array } | null => {
      const shed = shedGraphics(input(v), kept.graphics ?? { pg: [], ig: [] });
      if (!shed) return null;
      const names = (kind: 'pg' | 'ig'): string => shed.dropped.filter((d) => d.kind === kind).map((d) => `0x${d.pid.toString(16)}`).join(', ');
      const pg = names('pg');
      const ig = names('ig');
      dropped = `; dropped the PES of ${[pg && `PG ${pg}`, ig && `IG ${ig}`].filter(Boolean).join(' and ')}`;
      if (ig) this.deps.log(`levels: ${where} didn't fit even with its video at the floor: dropped the menu PES of IG ${ig}${pg ? ` and of PG ${pg}` : ''}`);
      else if (!pgShedLogged.has(this.plan)) {
        pgShedLogged.add(this.plan);
        this.deps.log(`levels: ${where} didn't fit even with its video at the floor: dropped the subtitle PES of PG ${pg} (PG drops are logged once per clip)`);
      }
      return shed;
    };
    let retried: { bytes: Uint8Array; rateBps: number };
    try {
      retried = await encodeIntervalAt(this.deps.backend, options, plan.index, { rateBps, overflowBytes: first.overflow }, (v) => remuxInterval(input(v)), this.stopping.signal, lastResort);
    } catch (err) {
      if (err instanceof IntervalDoesNotFit) {
        const named = new Error(`${err.message} (${where})`);
        const key = await this.plan.cacheKey().catch(() => null);
        if (key !== null) rememberUnfittable(this.deps.cache, `${key}#${plan.index}`, named);
        throw named;
      }
      throw err;
    }
    this.deps.log(`levels: ${where} overflowed its budget by ${first.overflow} bytes; re-encoded at ${retried.rateBps} bps${dropped}`);
    return retried.bytes;
  }
}
