// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ElementHdr, ElementQuery, EngineCommand, EngineEvent } from '../protocol';
import { ClockBlockWriter } from '../element/clock-block';
import { ELEMENT_TIME_OFFSET_US } from '../element/fmp4';
import {
  ElementVideoOutput,
  type MediaSourceLike,
  type SourceBufferLike,
  type VideoElementLike,
} from './element-output';

const OFFSET_S = ELEMENT_TIME_OFFSET_US / 1e6;

class FakeSourceBuffer implements SourceBufferLike {
  updating = false;
  ranges: Array<[number, number]> = [];
  appended: Uint8Array[] = [];
  removed: Array<[number, number]> = [];
  changed: string[] = [];
  aborts = 0;
  quotaThrows = 0;
  /** What the current append adds to `ranges` when it finishes. */
  nextRange: [number, number] | null = null;
  private listeners: Record<string, Array<() => void>> = {};
  private pendingRange: [number, number] | null = null;
  private pendingRemove: [number, number] | null = null;

  get buffered(): { length: number; start(i: number): number; end(i: number): number } {
    const r = this.ranges;
    return { length: r.length, start: (i) => r[i]![0], end: (i) => r[i]![1] };
  }
  appendBuffer(b: Uint8Array): void {
    if (this.updating) throw new Error('InvalidStateError: updating');
    if (this.quotaThrows > 0) {
      this.quotaThrows--;
      const e = new Error('full');
      e.name = 'QuotaExceededError';
      throw e;
    }
    this.appended.push(b);
    this.updating = true;
    this.pendingRange = this.nextRange;
    this.nextRange = null;
  }
  remove(start: number, end: number): void {
    if (this.updating) throw new Error('InvalidStateError: updating');
    this.removed.push([start, end]);
    this.updating = true;
    this.pendingRemove = [start, end];
  }
  abort(): void {
    this.aborts++;
    this.updating = false;
    this.pendingRange = null;
  }
  changeType(type: string): void {
    this.changed.push(type);
  }
  addEventListener(type: 'updateend' | 'error' | 'bufferedchange', fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: 'updateend' | 'error' | 'bufferedchange'): void {
    for (const fn of this.listeners[type] ?? []) fn();
  }
  /** Completes the in-flight operation and fires updateend. */
  finish(): void {
    this.updating = false;
    if (this.pendingRange) this.addRange(this.pendingRange);
    if (this.pendingRemove) {
      const [s, e] = this.pendingRemove;
      this.ranges = this.ranges
        .flatMap(([a, b]): Array<[number, number]> => {
          if (e <= a || s >= b) return [[a, b]];
          const out: Array<[number, number]> = [];
          if (a < s) out.push([a, s]);
          if (b > e) out.push([e, b]);
          return out;
        });
    }
    this.pendingRange = null;
    this.pendingRemove = null;
    this.fire('updateend');
  }
  private addRange([s, e]: [number, number]): void {
    const last = this.ranges[this.ranges.length - 1];
    if (last && Math.abs(last[1] - s) < 1e-9) last[1] = e;
    else this.ranges.push([s, e]);
  }
}

class FakeMediaSource implements MediaSourceLike {
  readyState = 'closed';
  buffers: FakeSourceBuffer[] = [];
  types: string[] = [];
  ended = 0;
  private open: Array<() => void> = [];
  addSourceBuffer(type: string): SourceBufferLike {
    this.types.push(type);
    const sb = new FakeSourceBuffer();
    this.buffers.push(sb);
    return sb;
  }
  endOfStream(): void {
    this.ended++;
    this.readyState = 'ended';
  }
  addEventListener(_type: 'sourceopen', fn: () => void): void {
    this.open.push(fn);
  }
  fireOpen(): void {
    this.readyState = 'open';
    for (const fn of this.open) fn();
  }
}

type FrameCb = (now: number, meta: { mediaTime: number; expectedDisplayTime: number }) => void;

class FakeVideo implements VideoElementLike {
  muted = false;
  playsInline = false;
  disableRemotePlayback = false;
  currentTime = 0;
  playbackRate = 1;
  src = '';
  paused = true;
  seeking = false;
  /** Writes of disableRemotePlayback and src, in order. */
  writes: string[] = [];
  plays = 0;
  /** What the next play() rejects with; null resolves. */
  playError: Error | null = null;
  pauses = 0;
  loads = 0;
  removedAttrs: string[] = [];
  rateWrites = 0;
  frames = new Map<number, FrameCb>();
  cancelled: number[] = [];
  quality = { totalVideoFrames: 0, droppedVideoFrames: 0 };
  private nextId = 1;
  private listeners: Record<string, Array<() => void>> = {};
  constructor() {
    let rate = 1;
    let src = '';
    let remote = false;
    Object.defineProperty(this, 'src', {
      get: () => src,
      set: (v: string) => {
        src = v;
        this.writes.push('src');
      },
    });
    Object.defineProperty(this, 'disableRemotePlayback', {
      get: () => remote,
      set: (v: boolean) => {
        remote = v;
        this.writes.push(`disableRemotePlayback=${v}`);
      },
    });
    Object.defineProperty(this, 'playbackRate', {
      get: () => rate,
      set: (v: number) => {
        rate = v;
        this.rateWrites++;
      },
    });
  }
  play(): Promise<void> {
    this.plays++;
    const error = this.playError;
    this.playError = null;
    if (error) return Promise.reject(error);
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.pauses++;
    this.paused = true;
  }
  requestVideoFrameCallback(cb: FrameCb): number {
    const id = this.nextId++;
    this.frames.set(id, cb);
    return id;
  }
  cancelVideoFrameCallback(id: number): void {
    this.cancelled.push(id);
    this.frames.delete(id);
  }
  getVideoPlaybackQuality(): { totalVideoFrames: number; droppedVideoFrames: number } {
    return this.quality;
  }
  addEventListener(type: 'waiting' | 'playing' | 'error', fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: 'waiting' | 'playing' | 'error'): void {
    for (const fn of this.listeners[type] ?? []) fn();
  }
  removeAttribute(name: string): void {
    this.removedAttrs.push(name);
    if (name === 'src') this.src = '';
  }
  load(): void {
    this.loads++;
  }
  /** Runs the pending frame callbacks once (playlist-time media, element-relative display time in ms). */
  presentFrame(mediaTimeS: number, expectedDisplayTime: number, now = expectedDisplayTime): void {
    const cbs = [...this.frames.values()];
    this.frames.clear();
    for (const cb of cbs) cb(now, { mediaTime: mediaTimeS, expectedDisplayTime });
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function setup(opts: { failAppends?: boolean; noMediaSource?: boolean; playable?: (query: ElementQuery) => boolean; noAnimationFrame?: boolean } = {}) {
  const video = new FakeVideo();
  const ms = new FakeMediaSource();
  const posted: EngineCommand[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const rafs: Array<{ fn: (now: number) => void; cancelled: boolean }> = [];
  let revoked = 0;
  let created = 0;
  const out = new ElementVideoOutput({
    video,
    createMediaSource: () => {
      if (opts.noMediaSource) return null;
      created++;
      return { source: ms, url: 'blob:ms', revoke: () => revoked++ };
    },
    ...(opts.failAppends ? { failAppends: true } : {}),
    playable: async (query) => (opts.playable ?? (() => true))(query),
    epochMs: () => 5000,
    timeOrigin: 1000,
    post: (c) => posted.push(c),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    ...(opts.noAnimationFrame
      ? {}
      : {
          animationFrame: (fn: (now: number) => void) => {
            const f = { fn, cancelled: false };
            rafs.push(f);
            return () => {
              f.cancelled = true;
            };
          },
        }),
  });
  const sb = (): FakeSourceBuffer => ms.buffers[ms.buffers.length - 1]!;
  const fireTimers = (): void => {
    const live = timers.filter((t) => !t.cancelled);
    timers.length = 0;
    for (const t of live) t.fn();
  };
  /** Runs the pending animation frames once, at page time `now` (ms). */
  const fireRaf = (now: number): void => {
    const live = rafs.filter((f) => !f.cancelled);
    rafs.length = 0;
    for (const f of live) f.fn(now);
  };
  return {
    out,
    video,
    ms,
    posted,
    sb,
    fireTimers,
    fireRaf,
    rafs,
    timers,
    revoked: () => revoked,
    created: () => created,
  };
}

const bytes = (n: number): Uint8Array => new Uint8Array([n]);
const init = (codec = 'avc1.640028'): EngineEvent => ({ type: 'videoInit', bytes: bytes(0), codec, width: 1920, height: 1080 });
const seg = (n: number, startUs: number, endUs: number): EngineEvent => ({ type: 'videoSegment', bytes: bytes(n), startUs, endUs });
const reset = (startUs: number, paused = false, generation = 1): EngineEvent => ({ type: 'videoReset', startUs, paused, generation });

/** A session opened at `startUs`, its init appended, the buffer ready. */
function opened(startUs = 0, paused = false, generation = 1) {
  const t = setup();
  t.out.handle(reset(startUs, paused, generation));
  t.out.handle(init());
  t.ms.fireOpen();
  t.sb().finish(); // init appended
  return t;
}

function appendSegment(t: ReturnType<typeof setup>, n: number, startS: number, endS: number): void {
  t.sb().nextRange = [startS + OFFSET_S, endS + OFFSET_S];
  t.out.handle(seg(n, startS * 1e6, endS * 1e6));
  t.sb().finish();
}

function commands<T extends EngineCommand['type']>(posted: EngineCommand[], type: T): Array<Extract<EngineCommand, { type: T }>> {
  return posted.filter((c): c is Extract<EngineCommand, { type: T }> => c.type === type);
}

describe('ElementVideoOutput', () => {
  it('answers a query through the page capability check', async () => {
    const seen: Array<[string, ElementHdr | null]> = [];
    const t = setup({ playable: ({ codec, hdr }) => (seen.push([codec, hdr]), codec.includes('hvc1')) });
    expect(t.out.handle({ type: 'videoElementQuery', codec: 'hvc1.2.4.L153.B0', hdr: { transfer: 'pq', mastering: true }, width: 3840, height: 2160 })).toBe(true);
    expect(t.out.handle({ type: 'videoElementQuery', codec: 'avc1.640028', hdr: null })).toBe(true);
    await flush();
    expect(seen).toEqual([
      ['hvc1.2.4.L153.B0', { transfer: 'pq', mastering: true }],
      ['avc1.640028', null],
    ]);
    expect(t.posted).toEqual([
      { type: 'videoElementAnswer', codec: 'hvc1.2.4.L153.B0', hdr: { transfer: 'pq', mastering: true }, width: 3840, height: 2160, playable: true },
      { type: 'videoElementAnswer', codec: 'avc1.640028', hdr: null, playable: false },
    ]);
  });

  it('asks the capability check once per codec, HDR facts and size', async () => {
    const seen: string[] = [];
    const t = setup({ playable: ({ codec }) => (seen.push(codec), true) });
    const q = (hdr: ElementHdr | null): EngineEvent => ({ type: 'videoElementQuery', codec: 'hvc1.2.4.L153.B0', hdr });
    t.out.handle(q(null));
    t.out.handle(q(null));
    t.out.handle(q({ transfer: 'pq', mastering: false }));
    t.out.handle(q({ transfer: 'pq', mastering: false }));
    t.out.handle(q({ transfer: 'hlg', mastering: false }));
    t.out.handle({ type: 'videoElementQuery', codec: 'hvc1.2.4.L153.B0', hdr: null, width: 3840, height: 2160 });
    await flush();
    expect(seen).toHaveLength(4);
    expect(t.posted).toHaveLength(6);
  });

  it('posts nothing for a query answered after dispose', async () => {
    const t = setup();
    t.out.handle({ type: 'videoElementQuery', codec: 'avc1.640028', hdr: null });
    t.out.dispose();
    await flush();
    expect(t.posted).toEqual([]);
  });

  it('leaves events that are not its own', () => {
    const t = setup();
    expect(t.out.handle({ type: 'playlistCleared' })).toBe(false);
    expect(t.posted).toEqual([]);
  });

  it('mutes the element and plays it inline, and gives a clock block', () => {
    const t = setup();
    expect(t.video.muted).toBe(true);
    expect(t.video.playsInline).toBe(true);
    expect(t.out.clock).toBeInstanceOf(SharedArrayBuffer);
  });

  it('opens a MediaSource on the first init and appends once it is open', () => {
    const t = setup();
    t.out.handle(reset(0));
    expect(t.out.handle(init())).toBe(true);
    expect(t.video.src).toBe('blob:ms');
    expect(t.ms.buffers).toHaveLength(0);
    t.ms.fireOpen();
    expect(t.ms.types).toEqual(['video/mp4; codecs="avc1.640028"']);
    expect(t.sb().appended).toEqual([bytes(0)]);
    // A second init with the same codec reuses the buffer and the source.
    t.sb().finish();
    t.out.handle(init());
    expect(t.created()).toBe(1);
    expect(t.ms.buffers).toHaveLength(1);
    expect(t.sb().changed).toEqual([]);
    expect(t.sb().appended).toHaveLength(2);
  });

  it('a new codec in videoInit goes through changeType', () => {
    const t = opened();
    t.out.handle(init('hvc1.2.4.L153.B0'));
    expect(t.ms.buffers).toHaveLength(1);
    expect(t.sb().changed).toEqual(['video/mp4; codecs="hvc1.2.4.L153.B0"']);
    expect(t.sb().appended).toHaveLength(2);
  });

  it('appends one at a time on updateend', () => {
    const t = opened();
    t.out.handle(seg(1, 0, 1_000_000));
    t.out.handle(seg(2, 1_000_000, 2_000_000));
    expect(t.sb().appended).toEqual([bytes(0), bytes(1)]);
    t.sb().finish();
    expect(t.sb().appended).toEqual([bytes(0), bytes(1), bytes(2)]);
  });

  it('places the playhead once the first segment after a reset is appended, and plays', () => {
    const t = setup();
    new ClockBlockWriter(t.out.clock).write(30_000_000, true, 2000);
    t.out.handle(reset(30_000_000, false));
    t.out.handle(init());
    t.ms.fireOpen();
    t.sb().finish();
    expect(t.video.currentTime).toBe(0);
    expect(t.video.plays).toBe(0);
    appendSegment(t, 1, 30, 32);
    expect(t.video.currentTime).toBeCloseTo(30 + OFFSET_S, 9);
    expect(t.video.plays).toBe(1);
    // A session resumed at 30 s reports the range holding the playhead.
    expect(commands(t.posted, 'videoBuffered')).toEqual([{ type: 'videoBuffered', endUs: 32_000_000, segments: 1, generation: 1 }]);
  });

  it('waits to play until the engine publishes its clock as running, so the element does not start ahead of the sound', () => {
    const t = setup();
    const clock = new ClockBlockWriter(t.out.clock);
    clock.write(0, false, 2000); // the engine plays, but its clock holds for the audio output's latency
    t.out.handle(reset(0, false));
    t.out.handle(init());
    t.ms.fireOpen();
    t.sb().finish();
    appendSegment(t, 1, 0, 2);
    expect(t.video.currentTime).toBeCloseTo(OFFSET_S, 9);
    expect(t.video.plays).toBe(0);
    t.fireTimers();
    expect(t.video.plays).toBe(0);
    clock.write(10_000, true, 2010);
    t.fireTimers();
    expect(t.video.plays).toBe(1);
    expect(t.timers.filter((x) => !x.cancelled && x.ms < 100)).toEqual([]); // no more looks at the clock
  });

  it('a pause while waiting for the clock never plays the element', () => {
    const t = setup();
    const clock = new ClockBlockWriter(t.out.clock);
    clock.write(0, false, 2000);
    t.out.handle(reset(0, false));
    t.out.handle(init());
    t.ms.fireOpen();
    t.sb().finish();
    appendSegment(t, 1, 0, 2);
    t.out.setPlaying(false);
    clock.write(10_000, true, 2010);
    t.fireTimers();
    expect(t.video.plays).toBe(0);
    expect(t.video.paused).toBe(true);
  });

  it('a paused reset leaves the element paused', () => {
    const t = opened(0, true);
    appendSegment(t, 1, 0, 2);
    expect(t.video.currentTime).toBeCloseTo(OFFSET_S, 9);
    expect(t.video.plays).toBe(0);
    expect(t.video.paused).toBe(true);
  });

  it('reports the end of the buffered range holding the playhead after each append', () => {
    const t = opened();
    appendSegment(t, 1, 0, 2);
    appendSegment(t, 2, 2, 4);
    t.sb().nextRange = [10 + OFFSET_S, 12 + OFFSET_S]; // a gap: the playhead's range is unchanged
    t.out.handle(seg(3, 10_000_000, 12_000_000));
    t.sb().finish();
    expect(commands(t.posted, 'videoBuffered').map((c) => c.endUs)).toEqual([2_000_000, 4_000_000, 4_000_000]);
  });

  it('removes what lies more than 10 s behind the playhead after an append', () => {
    const t = opened();
    appendSegment(t, 1, 0, 20);
    t.video.currentTime = 15 + OFFSET_S;
    appendSegment(t, 2, 20, 22);
    expect(t.sb().removed).toEqual([[OFFSET_S, 5 + OFFSET_S]]);
    t.sb().finish();
    expect(t.sb().ranges[0]![0]).toBeCloseTo(5 + OFFSET_S, 9);
  });

  it('QuotaExceededError removes what is behind and retries once', () => {
    const t = opened();
    appendSegment(t, 1, 0, 20);
    t.video.currentTime = 15 + OFFSET_S;
    t.sb().quotaThrows = 1;
    t.out.handle(seg(2, 20_000_000, 22_000_000));
    expect(t.sb().removed).toEqual([[OFFSET_S, 5 + OFFSET_S]]);
    expect(t.sb().appended).toHaveLength(2);
    t.sb().finish(); // the removal
    expect(t.sb().appended).toEqual([bytes(0), bytes(1), bytes(2)]);
    expect(commands(t.posted, 'videoElementFailed')).toEqual([]);
  });

  it('failAppends makes every append fail with an error the quota retry leaves alone, and the element fails', () => {
    const t = setup({ failAppends: true });
    t.out.handle(reset(0, false, 1));
    t.out.handle(init());
    t.ms.fireOpen();
    expect(t.sb().appended).toEqual([]);
    expect(commands(t.posted, 'videoElementFailed')).toHaveLength(1);
    expect(t.revoked()).toBe(1);
  });

  it('a second QuotaExceededError fails the element', () => {
    const t = opened();
    appendSegment(t, 1, 0, 20);
    t.video.currentTime = 15 + OFFSET_S;
    t.sb().quotaThrows = 2;
    t.out.handle(seg(2, 20_000_000, 22_000_000));
    t.sb().finish();
    expect(commands(t.posted, 'videoElementFailed')).toHaveLength(1);
    expect(t.revoked()).toBe(1);
  });

  it('videoReset aborts, removes everything and starts again', () => {
    const t = opened();
    appendSegment(t, 1, 0, 4);
    t.out.handle(seg(2, 4_000_000, 6_000_000)); // in flight
    t.out.handle(seg(3, 6_000_000, 8_000_000)); // queued
    t.out.handle(reset(60_000_000, false));
    expect(t.sb().aborts).toBe(1);
    expect(t.sb().removed).toEqual([[0, Infinity]]);
    t.out.handle(init());
    t.sb().finish(); // the removal
    t.sb().finish(); // the init
    appendSegment(t, 4, 60, 62);
    expect(t.sb().appended).toEqual([bytes(0), bytes(1), bytes(2), bytes(0), bytes(4)]);
    expect(t.video.currentTime).toBeCloseTo(60 + OFFSET_S, 9);
  });

  it("echoes the last reset's generation in videoBuffered and videoStalled, never an older one after a reset", () => {
    const t = opened(); // generation 1
    appendSegment(t, 1, 0, 2);
    t.out.setPlaying(true);
    t.video.currentTime = 1.96 + OFFSET_S; // run dry: one frame left
    t.video.fire('waiting');
    expect(commands(t.posted, 'videoBuffered').map((c) => c.generation)).toEqual([1, 1]); // after the append, and with the stall
    expect(commands(t.posted, 'videoStalled').map((c) => c.generation)).toEqual([1]);
    t.posted.length = 0;
    t.out.handle(reset(60_000_000, false, 2));
    t.out.handle(init());
    t.sb().finish(); // the removal
    t.sb().finish(); // the init
    appendSegment(t, 2, 60, 62);
    t.video.currentTime = 61.96 + OFFSET_S;
    t.video.fire('waiting');
    expect(commands(t.posted, 'videoBuffered').map((c) => c.generation)).toEqual([2, 2]);
    expect(commands(t.posted, 'videoStalled').map((c) => c.generation)).toEqual([2]);
  });

  it('videoEnded ends the stream after the queue drains', () => {
    const t = opened();
    t.out.handle(seg(1, 0, 1_000_000));
    t.out.handle({ type: 'videoEnded' });
    expect(t.ms.ended).toBe(0);
    t.sb().finish();
    expect(t.ms.ended).toBe(1);
  });

  it('videoElementStop mid-append leaves no append running', () => {
    const t = opened();
    t.out.handle(seg(1, 0, 1_000_000)); // in flight
    t.out.handle(seg(2, 1_000_000, 2_000_000)); // queued
    const before = t.posted.length;
    const buffer = t.sb();
    expect(t.out.handle({ type: 'videoElementStop' })).toBe(true);
    expect(t.video.removedAttrs).toEqual(['src']);
    expect(t.video.loads).toBe(1);
    expect(t.revoked()).toBe(1);
    expect(t.video.frames.size).toBe(0);
    buffer.updating = false;
    buffer.fire('updateend');
    expect(buffer.appended).toEqual([bytes(0), bytes(1)]);
    expect(t.posted.length).toBe(before);
  });

  it('dispose releases the element and cancels callbacks and timers', () => {
    const t = opened();
    t.out.dispose();
    expect(t.video.removedAttrs).toEqual(['src']);
    expect(t.revoked()).toBe(1);
    expect(t.video.frames.size).toBe(0);
    expect(t.video.cancelled.length).toBe(1);
    expect(t.timers.every((x) => x.cancelled)).toBe(true);
  });

  it("says once per reset when the element first shows a frame placed after it, paused or playing", () => {
    const t = opened(0, true, 3);
    // a frame shown before the first segment is placed is the previous generation's
    t.video.presentFrame(0.5 + OFFSET_S, 1000);
    expect(commands(t.posted, 'videoFrameShown')).toEqual([]);
    appendSegment(t, 1, 0, 4);
    t.video.presentFrame(OFFSET_S, 1000);
    t.video.presentFrame(0.04 + OFFSET_S, 1040);
    expect(commands(t.posted, 'videoFrameShown')).toEqual([{ type: 'videoFrameShown', generation: 3 }]);
    // a seek resets under a new generation: its first placed frame is reported too
    t.out.handle(reset(2_000_000, true, 4));
    t.sb().finish(); // the removal
    appendSegment(t, 2, 2, 4);
    t.video.presentFrame(2 + OFFSET_S, 1100);
    expect(commands(t.posted, 'videoFrameShown')).toEqual([{ type: 'videoFrameShown', generation: 3 }, { type: 'videoFrameShown', generation: 4 }]);
  });

  it("the first frame measured, 50 ms ahead of the clock, starts a catch-up at 25% slow", () => {
    const t = opened();
    appendSegment(t, 1, 0, 4);
    t.video.paused = false; // the element plays
    new ClockBlockWriter(t.out.clock).write(1_000_000, true, 2000);
    // Display at epoch 1000 + 1000 = 2000 ms, where the clock reads 1.0 s.
    t.video.presentFrame(1.05 + OFFSET_S, 1000);
    expect(t.video.playbackRate).toBeCloseTo(0.75, 9);
    // The callback is registered again for the next frame.
    expect(t.video.frames.size).toBe(1);
  });

  /** The clock read for a frame shown with WebKit's off-clock expectedDisplayTime, its callback at page time `now`. */
  const offClockOffset = (t: ReturnType<typeof setup>, now: number): number => {
    t.posted.length = 0;
    t.video.presentFrame(1 + OFFSET_S, -1_415_423_273.6, now);
    t.fireTimers();
    return commands(t.posted, 'videoSync')[0]!.offsetsUs.at(-1)!; // clock minus frame time
  };

  it("takes the callback's time plus a 60 Hz refresh when the frame's display time is off the page's clock (WebKit)", () => {
    const t = setup({ noAnimationFrame: true });
    t.out.handle(reset(0, false));
    t.out.handle(init());
    t.ms.fireOpen();
    t.sb().finish();
    appendSegment(t, 1, 0, 4);
    t.video.paused = false; // the element plays
    // the clock reads 1.0 s at page time 1000 ms (epoch 2000); believed, WebKit's display time would put it days off
    // and seek the element to a negative time
    new ClockBlockWriter(t.out.clock).write(1_000_000, true, 2000);
    expect(offClockOffset(t, 1000)).toBeCloseTo(16_667, 0); // shown a refresh after the callback
    expect(t.video.currentTime).toBeCloseTo(OFFSET_S, 9); // no seek
  });

  it('measures the refresh from animation frames once a display time is off the clock (a 120 Hz display)', () => {
    const t = opened();
    appendSegment(t, 1, 0, 4);
    t.video.paused = false; // the element plays
    new ClockBlockWriter(t.out.clock).write(1_000_000, true, 2000);
    expect(t.rafs).toHaveLength(0); // nothing measured while display times are on the clock
    expect(offClockOffset(t, 1000)).toBeCloseTo(16_667, 0); // 60 Hz until measured
    for (let i = 0; i <= 31; i++) t.fireRaf(500 + i * (1000 / 120));
    expect(offClockOffset(t, 1000)).toBeCloseTo(8_333, 0);
    // a stray long interval (a dropped frame) does not move the median
    t.fireRaf(800);
    expect(offClockOffset(t, 1000)).toBeCloseTo(8_333, 0);
  });

  it("starts the element at the rate that catches up the clock's lead and play()'s start-up, counted as a catch-up", () => {
    const t = setup();
    const clock = new ClockBlockWriter(t.out.clock);
    clock.write(0, false, 5000);
    t.out.handle(reset(0, false));
    t.out.handle(init());
    t.ms.fireOpen();
    t.sb().finish();
    appendSegment(t, 1, 0, 2);
    // the placed frame shown while the element waits for the clock measures nothing
    t.video.presentFrame(OFFSET_S, 3000);
    // the clock moves: 30 ms past the element when it starts, and play() takes about 15 ms more
    clock.write(30_000, true, 5000);
    t.fireTimers();
    expect(t.video.plays).toBe(1);
    expect(t.video.playbackRate).toBeCloseTo(1.25, 9);
    t.video.presentFrame(0.04 + OFFSET_S, 3020); // a frame to report
    t.fireTimers();
    const sync = commands(t.posted, 'videoSync');
    expect(sync.flatMap((c) => c.offsetsUs)).toHaveLength(1); // the waiting frame was not measured
    expect(sync.at(-1)!.catchUps).toBe(1);
  });

  it('leaves playbackRate alone when the change is under 0.0002', () => {
    const t = opened();
    appendSegment(t, 1, 0, 4);
    t.video.paused = false; // the element plays
    new ClockBlockWriter(t.out.clock).write(1_000_000, true, 2000);
    t.video.presentFrame(1.0002 + OFFSET_S, 1000); // 0.2 ms ahead: rate 1 − 0.00005
    expect(t.video.rateWrites).toBe(0);
    expect(t.video.playbackRate).toBe(1);
  });

  it('a frame far from the clock seeks the element to it', () => {
    const t = opened();
    appendSegment(t, 1, 0, 10);
    t.video.paused = false; // the element plays
    new ClockBlockWriter(t.out.clock).write(5_000_000, true, 2000);
    t.video.presentFrame(1 + OFFSET_S, 1000);
    expect(t.video.currentTime).toBeCloseTo(5 + OFFSET_S, 9);
    expect(t.video.playbackRate).toBe(1);
  });

  it('batches sync offsets every 250 ms with the playback quality', () => {
    const t = opened();
    appendSegment(t, 1, 0, 4);
    expect(t.timers.some((x) => x.ms === 250 && !x.cancelled)).toBe(true);
    t.video.paused = false; // the element plays
    new ClockBlockWriter(t.out.clock).write(1_000_000, true, 2000);
    t.video.presentFrame(1.02 + OFFSET_S, 1000);
    t.video.presentFrame(1.06 + OFFSET_S, 1040);
    t.video.quality = { totalVideoFrames: 12, droppedVideoFrames: 2 };
    t.fireTimers();
    const sync = commands(t.posted, 'videoSync');
    expect(sync).toHaveLength(1);
    expect(sync[0]!.offsetsUs.map((o) => Math.round(o))).toEqual([-20_000, -20_000]);
    expect(sync[0]!.presented).toBe(10);
    expect(sync[0]!.dropped).toBe(2);
    expect(sync[0]!.catchUps).toBe(1); // 20 ms ahead at the start's first frame: one catch-up
    // The timer is armed again.
    expect(t.timers.some((x) => x.ms === 250 && !x.cancelled)).toBe(true);
  });

  it('reports a real stall and its resume once each, only while playing', () => {
    const t = opened(0, true);
    appendSegment(t, 1, 0, 2);
    t.video.fire('waiting');
    expect(commands(t.posted, 'videoStalled')).toEqual([]);
    new ClockBlockWriter(t.out.clock).write(0, true, 2000);
    t.out.setPlaying(true);
    expect(t.video.plays).toBe(1);
    t.video.currentTime = 1.96 + OFFSET_S;
    t.video.fire('waiting');
    t.video.fire('waiting');
    expect(commands(t.posted, 'videoStalled')).toHaveLength(1);
    t.video.fire('playing');
    t.video.fire('playing');
    expect(commands(t.posted, 'videoResumed')).toHaveLength(1);
    t.out.setPlaying(false);
    expect(t.video.paused).toBe(true);
  });

  it('follows a videoStalled at once with the buffered report of the same generation (no append may follow)', () => {
    const t = opened(0, false, 3);
    appendSegment(t, 1, 0, 2);
    t.posted.length = 0;
    t.video.currentTime = 1.96 + OFFSET_S;
    t.video.fire('waiting');
    expect(t.posted.map((c) => c.type)).toEqual(['videoStalled', 'videoBuffered']);
    expect(t.posted[1]).toEqual({ type: 'videoBuffered', endUs: 2_000_000, segments: 1, generation: 3 });
  });

  it('waiting with more than a quarter second buffered ahead is a hiccup, not a stall', () => {
    const t = opened(0, false);
    appendSegment(t, 1, 0, 2);
    t.video.currentTime = 1.7 + OFFSET_S; // 0.3 s ahead
    t.video.fire('waiting');
    expect(commands(t.posted, 'videoStalled')).toEqual([]);
    t.video.currentTime = 1.8 + OFFSET_S; // 0.2 s ahead: run dry
    t.video.fire('waiting');
    expect(commands(t.posted, 'videoStalled')).toHaveLength(1);
  });

  it('waiting while seeking posts nothing', () => {
    const t = opened(0, false);
    appendSegment(t, 1, 0, 2);
    t.video.seeking = true;
    t.video.fire('waiting');
    expect(commands(t.posted, 'videoStalled')).toEqual([]);
  });

  it('waiting before the first segment is placed posts nothing', () => {
    const t = opened(0, false);
    t.video.fire('waiting');
    expect(commands(t.posted, 'videoStalled')).toEqual([]);
  });

  it('playing without a prior stall posts nothing', () => {
    const t = opened(0, false);
    appendSegment(t, 1, 0, 2);
    t.video.fire('playing');
    expect(commands(t.posted, 'videoResumed')).toEqual([]);
  });

  it('turns remote playback off before setting src', () => {
    const t = setup();
    t.out.handle(reset(0));
    t.out.handle(init());
    expect(t.video.writes).toEqual(['disableRemotePlayback=true', 'src']);
  });

  it('a source that never opens fails after 5 s and appends nothing', () => {
    const t = setup();
    t.out.handle(reset(0));
    t.out.handle(init());
    t.out.handle(seg(1, 0, 1_000_000));
    const open = t.timers.find((x) => x.ms === 5000 && !x.cancelled);
    expect(open).toBeDefined();
    open!.fn();
    const failed = commands(t.posted, 'videoElementFailed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.message).toMatch(/did not open/);
    expect(t.ms.buffers).toHaveLength(0);
    expect(t.revoked()).toBe(1);
    expect(t.video.removedAttrs).toEqual(['src']);
  });

  it('an opened source cancels the open timeout', () => {
    const t = opened();
    expect(t.timers.find((x) => x.ms === 5000)!.cancelled).toBe(true);
  });

  it('an element error fails the element', () => {
    const t = opened();
    t.video.fire('error');
    expect(commands(t.posted, 'videoElementFailed')).toHaveLength(1);
  });

  it('fails when no MediaSource can be made', () => {
    const t = setup({ noMediaSource: true });
    t.out.handle(reset(0));
    t.out.handle(init());
    expect(commands(t.posted, 'videoElementFailed')).toHaveLength(1);
  });

  it('a play() the browser refuses fails the element, with the reason and the generation', async () => {
    const t = opened(0, false, 4);
    new ClockBlockWriter(t.out.clock).write(0, true, 2000);
    const refused = new Error('play() can only be initiated by a user gesture');
    refused.name = 'NotAllowedError';
    t.video.playError = refused;
    appendSegment(t, 1, 0, 2);
    expect(t.video.plays).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    const failed = commands(t.posted, 'videoElementFailed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.message).toMatch(/refused to play.*NotAllowedError/);
    expect(failed[0]!.generation).toBe(4);
    expect(t.revoked()).toBe(1);
  });

  it('a play() aborted by a pause is no failure', async () => {
    const t = opened(0, false);
    new ClockBlockWriter(t.out.clock).write(0, true, 2000);
    const aborted = new Error('The play() request was interrupted by a call to pause()');
    aborted.name = 'AbortError';
    t.video.playError = aborted;
    appendSegment(t, 1, 0, 2);
    await Promise.resolve();
    await Promise.resolve();
    expect(commands(t.posted, 'videoElementFailed')).toEqual([]);
  });

  it('a play() refused after the element was released posts nothing more', async () => {
    const t = opened(0, false);
    new ClockBlockWriter(t.out.clock).write(0, true, 2000);
    const refused = new Error('refused');
    refused.name = 'NotAllowedError';
    t.video.playError = refused;
    appendSegment(t, 1, 0, 2);
    t.out.handle({ type: 'videoElementStop' });
    await Promise.resolve();
    await Promise.resolve();
    expect(commands(t.posted, 'videoElementFailed')).toEqual([]);
  });

  it('a source that never opens, an element error and an append error all report the generation they failed in', () => {
    const never = setup();
    never.out.handle(reset(0, false, 7));
    never.out.handle(init());
    never.timers.find((x) => x.ms === 5000)!.fn();
    expect(commands(never.posted, 'videoElementFailed')[0]).toMatchObject({ generation: 7 });
    const errored = opened(0, false, 8);
    errored.video.fire('error');
    expect(commands(errored.posted, 'videoElementFailed')[0]).toMatchObject({ generation: 8 });
    const append = opened(0, false, 9);
    append.sb().fire('error');
    expect(commands(append.posted, 'videoElementFailed')[0]).toMatchObject({ generation: 9 });
  });

  it('reports the playhead itself when it sits in a gap between buffered ranges', () => {
    const t = opened(0, false, 2);
    appendSegment(t, 1, 0, 2);
    appendSegment(t, 2, 5, 7); // a later range, with nothing between 2 s and 5 s
    t.posted.length = 0;
    t.video.currentTime = 3 + OFFSET_S;
    t.sb().fire('bufferedchange');
    expect(commands(t.posted, 'videoBuffered')).toEqual([{ type: 'videoBuffered', endUs: 3_000_000, segments: 2, generation: 2 }]);
  });

  it('after a stall, an eviction below the playhead is reported at once on bufferedchange, with the playhead as the end', () => {
    const t = opened(0, false, 5);
    new ClockBlockWriter(t.out.clock).write(0, true, 2000);
    t.out.setPlaying(true);
    appendSegment(t, 1, 0, 4);
    appendSegment(t, 2, 4, 8);
    t.video.currentTime = 7.9 + OFFSET_S;
    t.video.fire('waiting'); // ran dry at the end of what it holds
    expect(commands(t.posted, 'videoStalled')).toHaveLength(1);
    t.posted.length = 0;
    // a ManagedMediaSource evicts under memory pressure: what held the playhead is gone, only a range behind it is left
    t.sb().ranges = [[OFFSET_S, 3 + OFFSET_S]];
    t.sb().fire('bufferedchange');
    expect(commands(t.posted, 'videoBuffered')).toEqual([{ type: 'videoBuffered', endUs: 7_900_000, segments: 2, generation: 5 }]);
  });

  it('reports after a removal too, and nothing while the first segment after a reset is still to be placed', () => {
    const t = opened(0, false);
    appendSegment(t, 1, 0, 20);
    t.video.currentTime = 15 + OFFSET_S;
    appendSegment(t, 2, 20, 22); // queues the removal of what lies 10 s behind
    t.posted.length = 0;
    t.sb().finish(); // the removal
    expect(commands(t.posted, 'videoBuffered')).toEqual([{ type: 'videoBuffered', endUs: 22_000_000, segments: 2, generation: 1 }]);
    t.posted.length = 0;
    t.out.handle(reset(60_000_000, false, 2));
    t.sb().finish(); // the reset's removal of everything
    t.sb().fire('bufferedchange');
    expect(commands(t.posted, 'videoBuffered')).toEqual([]);
  });

  it('reads the position just before pausing, so a browser that pauses at its last read position pauses where it is', () => {
    const t = opened(0, false);
    new ClockBlockWriter(t.out.clock).write(0, true, 2000);
    t.out.setPlaying(true);
    appendSegment(t, 1, 0, 2);
    expect(t.video.paused).toBe(false);
    const ops: string[] = [];
    let time = 1 + OFFSET_S;
    Object.defineProperty(t.video, 'currentTime', {
      get: () => {
        ops.push('read');
        return time;
      },
      set: (v: number) => {
        time = v;
      },
    });
    const pause = t.video.pause.bind(t.video);
    t.video.pause = () => {
      ops.push('pause');
      pause();
    };
    t.out.setPlaying(false);
    expect(ops.slice(-2)).toEqual(['read', 'pause']);
  });
});
