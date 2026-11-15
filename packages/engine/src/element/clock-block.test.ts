// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ClockBlockReader, ClockBlockWriter, createClockBlock } from './clock-block';

describe('clock block', () => {
  it('reads back what was written', () => {
    const sab = createClockBlock();
    const writer = new ClockBlockWriter(sab);
    const reader = new ClockBlockReader(sab);
    expect(reader.read()).toBeNull(); // nothing written yet
    writer.write(5_000_000, true, 1234.5);
    expect(reader.read()).toEqual({ clockUs: 5_000_000, running: true, atEpochMs: 1234.5 });
  });

  it('extrapolates while running and holds while not', () => {
    const sab = createClockBlock();
    const writer = new ClockBlockWriter(sab);
    const reader = new ClockBlockReader(sab);
    writer.write(5_000_000, true, 1000);
    expect(reader.clockAt(1040)).toBe(5_040_000);
    writer.write(5_000_000, false, 1000);
    expect(reader.clockAt(1040)).toBe(5_000_000);
  });

  it('gives null when the sequence stays odd (a write in progress)', () => {
    const sab = createClockBlock();
    new ClockBlockWriter(sab).write(1, true, 1);
    const seq = new Int32Array(sab, 0, 1);
    seq[0] = seq[0]! + 1; // odd: a writer stopped mid-write
    const reader = new ClockBlockReader(sab);
    expect(reader.read()).toBeNull();
    expect(reader.clockAt(10)).toBeNull();
  });
});
