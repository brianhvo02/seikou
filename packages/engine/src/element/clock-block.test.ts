// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ClockBlockReader, ClockBlockWriter, ClockLine, createClockBlock } from './clock-block';

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

describe('clock line', () => {
  /** An audio clock that steps every 43 ms, read at 60 Hz ticks: what the engine publishes. */
  const stepped = (epochMs: number, startMs: number): number => Math.max(0, Math.floor((epochMs - startMs) / 43) * 43_000);

  it('publishes the stepped clock as the line through its steps, not behind them', () => {
    const line = new ClockLine();
    let worst = 0;
    for (let t = 1000; t < 3000; t += 1000 / 60) {
      const published = line.at(stepped(t, 1000), true, t);
      if (t > 1100) {
        expect(published.running).toBe(true);
        worst = Math.max(worst, Math.abs(published.clockUs - (t - 1000) * 1000));
      }
    }
    // the raw reading lags by up to a whole step (43 ms); the line is within one tick of the true clock
    expect(worst).toBeLessThan(17_000);
  });

  it('is not running while the started clock holds for the output latency, and draws no line from the hold', () => {
    const line = new ClockLine();
    // the engine plays from 0.1 s; the first sound is heard 60 ms later, then the clock steps every 43 ms
    const clockAt = (t: number): number => 5_000_000 + stepped(t, 1060);
    for (let t = 1000; t < 1060; t += 1000 / 60) expect(line.at(clockAt(t), true, t)).toEqual({ clockUs: 5_000_000, running: false });
    let worst = 0;
    for (let t = 1060 + 1000 / 60; t < 2000; t += 1000 / 60) {
      const published = line.at(clockAt(t), true, t);
      if (clockAt(t) === 5_000_000) continue; // still holding until the first step lands
      expect(published.running).toBe(true);
      worst = Math.max(worst, Math.abs(published.clockUs - (5_000_000 + (t - 1060) * 1000)));
    }
    expect(worst).toBeLessThan(17_000);
  });

  it('passes the clock through while it does not run, and starts a new line after a jump back', () => {
    const line = new ClockLine();
    for (let t = 0; t < 400; t += 16) line.at(5_000_000 + t * 1000, true, t);
    expect(line.at(5_400_000, false, 420)).toEqual({ clockUs: 5_400_000, running: false });
    for (let t = 500; t < 700; t += 16) line.at(9_000_000 + (t - 500) * 1000, true, t);
    // a seek back from 9.2 s to 2 s with no stop between: the new reading is taken at once, not held under the old line
    expect(line.at(2_000_000, true, 700)).toEqual({ clockUs: 2_000_000, running: true });
    expect(line.at(2_016_000, true, 716)).toEqual({ clockUs: 2_016_000, running: true });
  });

  it('starts a new line when the clock steps back by less than a step (the output latency grew)', () => {
    const line = new ClockLine();
    for (let t = 1000; t < 1400; t += 1000 / 60) line.at(stepped(t, 1000), true, t);
    // at 1.4 s the latency grows by 35 ms: the clock reads 35 ms less from then on
    let worst = 0;
    for (let t = 1400; t < 1800; t += 1000 / 60) {
      const published = line.at(stepped(t, 1000) - 35_000, true, t);
      if (t > 1450) worst = Math.max(worst, Math.abs(published.clockUs - ((t - 1000) * 1000 - 35_000)));
    }
    expect(worst).toBeLessThan(17_000);
  });

  it('follows a jump forward at once', () => {
    const line = new ClockLine();
    for (let t = 0; t < 200; t += 16) line.at(t * 1000, true, t);
    expect(line.at(4_000_000, true, 208)).toEqual({ clockUs: 4_000_000, running: true });
  });

  it('stops running when the playing clock holds longer than a step (a held still), and runs again once it moves', () => {
    const line = new ClockLine();
    // steps every 43 ms until 2.97 s, then holds (the end of a held play item: no more sound), then moves on at 5 s
    const clockAt = (t: number): number => (t < 3970 ? stepped(t, 1000) : t < 6000 ? stepped(3970, 1000) : stepped(3970, 1000) + stepped(t, 6000));
    let lastRunningAt = 0;
    let stopped: { clockUs: number; running: boolean } | null = null;
    for (let t = 1000; t < 5900; t += 1000 / 60) {
      const published = line.at(clockAt(t), true, t);
      if (published.running) lastRunningAt = t;
      else if (t > 2000) stopped = published;
    }
    // published as stopped within a few steps of the hold, at the held clock: nothing to extrapolate past it
    expect(lastRunningAt).toBeLessThan(3970 + 200);
    expect(stopped).toEqual({ clockUs: stepped(3970, 1000), running: false });
    let movedAgain = false;
    for (let t = 6000; t < 6300; t += 1000 / 60) movedAgain ||= line.at(clockAt(t), true, t).running;
    expect(movedAgain).toBe(true);
  });
});
