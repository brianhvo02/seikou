// SPDX-License-Identifier: LGPL-3.0-or-later

/*
 * The block the engine (in its worker) publishes its clock through to the page, which drives the video element from it.
 * Layout: an Int32 sequence counter at byte 0 (odd while a write is under way), then three Float64 values from byte 8:
 * the clock in playlist microseconds, 1 or 0 for running, and the epoch milliseconds the clock was read at.
 */
const BYTES = 32;
const RETRIES = 4;
/** How far back ClockLine looks for the readings it draws its line through. */
const LINE_WINDOW_MS = 500;
/**
 * A reading just after a step lies under ClockLine's line by at most the time between two render ticks (17 ms at
 * 60 Hz); one further under is a step back hidden in a step forward.
 */
const LINE_STEP_BACK_US = 25_000;
/**
 * How long (ms) a playing clock may hold without a step before it is published as not running: over three of Chrome's
 * 43 ms steps, so only a real hold (a still at the end of a play item, the sound run dry) stops the element.
 */
const LINE_HOLD_MS = 150;

/**
 * A new, zeroed clock block; it reads as null until a writer has written.
 * @internal
 */
export function createClockBlock(): SharedArrayBuffer {
  return new SharedArrayBuffer(BYTES);
}

/**
 * One reading of the clock block: the clock's playlist time in microseconds, whether it advances, and the epoch
 * milliseconds (`performance.timeOrigin + performance.now()`) it was taken at.
 * @internal
 */
export interface ClockReading {
  readonly clockUs: number;
  readonly running: boolean;
  readonly atEpochMs: number;
}

/**
 * The engine's side of the clock block: publishes the clock under a sequence counter that is odd while writing.
 * @internal
 */
export class ClockBlockWriter {
  private readonly seq: Int32Array;
  private readonly values: Float64Array;

  /** Wraps `sab`, made by createClockBlock. */
  constructor(sab: SharedArrayBuffer) {
    this.seq = new Int32Array(sab, 0, 1);
    this.values = new Float64Array(sab, 8, 3);
  }

  /** Publishes the clock (playlist microseconds), whether it is running, and the epoch milliseconds it was read at. */
  write(clockUs: number, running: boolean, atEpochMs: number): void {
    const start = Atomics.load(this.seq, 0);
    Atomics.store(this.seq, 0, start + 1);
    this.values[0] = clockUs;
    this.values[1] = running ? 1 : 0;
    this.values[2] = atEpochMs;
    Atomics.store(this.seq, 0, start + 2);
  }
}

/**
 * The page's side of the clock block: reads a consistent reading, or null.
 * @internal
 */
export class ClockBlockReader {
  private readonly seq: Int32Array;
  private readonly values: Float64Array;

  /** Wraps `sab`, made by createClockBlock. */
  constructor(sab: SharedArrayBuffer) {
    this.seq = new Int32Array(sab, 0, 1);
    this.values = new Float64Array(sab, 8, 3);
  }

  /** The last reading, retried up to 4 times when a write tears it; null if none was ever written or no clean read came. */
  read(): ClockReading | null {
    for (let i = 0; i < RETRIES; i++) {
      const before = Atomics.load(this.seq, 0);
      if (before === 0) return null;
      if (before % 2 === 1) continue;
      const clockUs = this.values[0]!;
      const running = this.values[1] === 1;
      const atEpochMs = this.values[2]!;
      if (Atomics.load(this.seq, 0) === before) return { clockUs, running, atEpochMs };
    }
    return null;
  }

  /** The clock at `epochMs`: the last reading extrapolated while running, as it was while not; null without a reading. */
  clockAt(epochMs: number): number | null {
    const r = this.read();
    if (!r) return null;
    return r.running ? r.clockUs + (epochMs - r.atEpochMs) * 1000 : r.clockUs;
  }
}

/**
 * Turns the engine's clock, read at render ticks, into what the clock block publishes: a line the page can
 * extrapolate, and whether it runs. The audio clock moves in steps (one per audio callback, 21 to 43 ms in Chrome on
 * macOS) and holds between them, so a reading published with the tick's time is behind the clock by however long ago
 * the last step came: up to a whole step, about half of one on average, and the video element would be kept that far
 * ahead of the sound. While the clock runs, the clock at a tick is `epoch + k` for the largest `k = clockUs - epoch`
 * of the readings in the last 0.5 s taken just after a step: the reading closest after a step. A stop, or a step back
 * (a seek, or the output's latency growing, which moves the audio clock back), starts a new line. Once started, the
 * audio clock also holds at its start for the output's latency, until the first sound is heard; it is published as not
 * running until it first moves, so the element does not start ahead of the sound, and likewise once it has held for
 * longer than a step while the engine plays (a still held at a play item's end), until it moves again.
 * @internal
 */
export class ClockLine {
  private readings: { readonly epochMs: number; readonly k: number }[] = [];
  /** The clock read at the previous running tick, or null when the clock was not running then. */
  private prevUs: number | null = null;
  private moved = false;
  /** When (epoch ms) the clock last moved while running. */
  private movedAtMs = 0;

  /** What to publish at `epochMs`, from the engine's clock `clockUs` read then and whether the engine plays. */
  at(clockUs: number, running: boolean, epochMs: number): { clockUs: number; running: boolean } {
    const prev = this.prevUs;
    if (!running) {
      this.readings = [];
      this.prevUs = null;
      this.moved = false;
      return { clockUs, running: false };
    }
    this.prevUs = clockUs;
    if (this.moved && clockUs === prev && epochMs - this.movedAtMs > LINE_HOLD_MS) {
      // the engine plays but its clock holds: published as stopped at the held clock, and started again once it moves
      this.moved = false;
      this.readings = [];
    }
    if (!this.moved) {
      if (prev === null || clockUs === prev) return { clockUs, running: false };
      this.moved = true;
    }
    if (clockUs !== prev) this.movedAtMs = epochMs;
    const k = clockUs - epochMs * 1000;
    while (this.readings.length > 0 && this.readings[0]!.epochMs < epochMs - LINE_WINDOW_MS) this.readings.shift();
    let line = -Infinity;
    for (const r of this.readings) line = Math.max(line, r.k);
    if (clockUs !== prev) {
      // the clock never steps back by itself: a step back is a seek or a new output latency, and starts a new line; so
      // does a step landing well under the line (a step forward and a step back in one tick)
      if (clockUs < prev! || k < line - LINE_STEP_BACK_US) {
        this.readings = [];
        line = -Infinity;
      }
      this.readings.push({ epochMs, k });
    }
    return { clockUs: epochMs * 1000 + Math.max(line, k), running: true };
  }
}
