// SPDX-License-Identifier: LGPL-3.0-or-later

/*
 * The block the engine (in its worker) publishes its clock through to the page, which drives the video element from it.
 * Layout: an Int32 sequence counter at byte 0 (odd while a write is under way), then three Float64 values from byte 8:
 * the clock in playlist microseconds, 1 or 0 for running, and the epoch milliseconds the clock was read at.
 */
const BYTES = 32;
const RETRIES = 4;

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
