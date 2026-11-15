// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ElementSync } from './element-sync';

function trimOf(s: ElementSync): number {
  return (s as unknown as { trim: number }).trim;
}

function simulate(opts: {
  drift: number;
  frames: number;
  fps?: number;
  startOffsetUs?: number;
  jitterUs?: number;
}) {
  const s = new ElementSync();
  const frame = 1e6 / (opts.fps ?? 24);
  let clock = 1_000_000;
  let media = 1_000_000 + (opts.startOffsetUs ?? 0);
  let rate = 1;
  let seeks = 0;
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const offsets: number[] = [];
  for (let i = 0; i < opts.frames; i++) {
    clock += frame;
    media += frame * opts.drift * rate;
    const jitter = opts.jitterUs ? (rand() * 2 - 1) * opts.jitterUs : 0;
    const a = s.onFrame(media, clock + jitter, true);
    rate = a.rate;
    if (a.seekToUs !== null) {
      seeks++;
      media = a.seekToUs - jitter;
    }
    offsets.push(media - clock);
  }
  return { offsets, seeks };
}

const maxAbs = (xs: number[]): number => Math.max(...xs.map(Math.abs));

/** A controller past its start window: a second of frames in sync, so the next frame is the steady loop's. */
function steadySync(): ElementSync {
  const s = new ElementSync();
  for (let i = 0; i < 24; i++) s.onFrame(i * 41_667, i * 41_667, true);
  return s;
}

describe('ElementSync', () => {
  it('gives a small rate nudge for a small offset', () => {
    const a = steadySync().onFrame(1_005_000, 1_000_000, true);
    expect(a.rate).toBeCloseTo(1 - 0.25 * 0.0005, 6); // the smoothed offset moves a tenth of the way to 5 ms
    expect(a.seekToUs).toBeNull();
    expect(a.offsetUs).toBe(5000);
  });

  it('nudges the rate against the offset, clamped at 0.005', () => {
    // 18 ms held for six seconds: below the 20 ms slip, so the loop alone, which saturates at half a percent
    const held = (offsetUs: number): number => {
      const s = steadySync();
      let rate = 1;
      for (let i = 24; i < 168; i++) rate = s.onFrame(i * 41_667 + offsetUs, i * 41_667, true).rate;
      return rate;
    };
    expect(held(18_000)).toBeCloseTo(0.995, 6);
    expect(held(-18_000)).toBeCloseTo(1.005, 6);
  });

  it('seeks to the clock beyond the seek threshold', () => {
    expect(new ElementSync().onFrame(1_150_000, 1_000_000, true)).toEqual({
      rate: 1,
      seekToUs: 1_000_000,
      offsetUs: 150_000,
    });
  });

  it('does nothing while not playing or without a clock', () => {
    const idle = { rate: 1, seekToUs: null, offsetUs: null };
    expect(new ElementSync().onFrame(1_150_000, 1_000_000, false)).toEqual(idle);
    expect(new ElementSync().onFrame(1_150_000, null, true)).toEqual(idle);
  });

  it('leaves the two frames after a seek uncorrected, then catches up from the first it measures', () => {
    const s = steadySync();
    expect(s.onFrame(1_150_000, 1_000_000, true).seekToUs).toBe(1_000_000);
    for (let i = 0; i < 2; i++) {
      expect(s.onFrame(1_050_000, 1_000_000, true)).toEqual({ rate: 1, seekToUs: null, offsetUs: 50_000 });
    }
    expect(s.onFrame(1_050_000, 1_000_000, true)).toEqual({ rate: 0.75, seekToUs: null, offsetUs: 50_000, catchUp: true });
  });

  it('reset clears the settle state; the next frame is a start', () => {
    const s = steadySync();
    s.onFrame(1_150_000, 1_000_000, true);
    s.reset();
    expect(s.onFrame(1_050_000, 1_000_000, true)).toMatchObject({ rate: 0.75, catchUp: true });
  });

  it("plans a start's catch-up from the lag the page expects, and re-plans it from the first frame it measures", () => {
    const s = steadySync();
    // the clock is 20 ms past the element as it starts, plus play()'s expected 15 ms
    const start = s.restart(35_000);
    expect(start.catchUp).toBe(true);
    expect(start.rate).toBeCloseTo(1.25, 9);
    // the first frame shows the element only 12 ms behind: re-planned at 10% fast, not counted again
    expect(s.onFrame(1_988_000, 2_000_000, true)).toEqual({ rate: 1.1, seekToUs: null, offsetUs: -12_000 });
  });

  it("drops a planned start catch-up when the first frame finds the element within 10 ms", () => {
    const s = steadySync();
    s.restart(35_000);
    const a = s.onFrame(1_995_000, 2_000_000, true);
    expect(a.catchUp).toBeUndefined();
    expect(Math.abs(a.rate - 1)).toBeLessThanOrEqual(0.005);
  });

  it('starts at rate 1 (less the trim) when the expected lag is within 10 ms', () => {
    expect(steadySync().restart(8_000)).toEqual({ rate: 1, catchUp: false });
  });

  it.each([1.002, 0.998])('converges when the element drifts at %s', (drift) => {
    const { offsets, seeks } = simulate({ drift, frames: 240 });
    expect(seeks).toBe(0);
    expect(maxAbs(offsets.slice(-48))).toBeLessThanOrEqual(10_000);
  });

  it('settles a +60 ms step and the swing shrinks', () => {
    const { offsets, seeks } = simulate({ drift: 1, frames: 24 * 300, startOffsetUs: 60_000 });
    expect(seeks).toBe(0);
    expect(Math.min(...offsets)).toBeGreaterThan(-20_000);
    expect(maxAbs(offsets.slice(-24 * 60))).toBeLessThan(1000);
  });

  it.each([-25_000, 40_000])('catches up a %s us start in well under a second, then the loop holds it', (startOffsetUs) => {
    const { offsets, seeks } = simulate({ drift: 1, frames: 24 * 10, startOffsetUs });
    expect(seeks).toBe(0);
    // one frame to measure, then at up to 25% a few frames to remove the step
    expect(maxAbs(offsets.slice(16))).toBeLessThanOrEqual(5_000);
  });

  it('catches up at the rate that removes the averaged offset in about 0.12 s of media, then hands back to the loop', () => {
    const s = new ElementSync();
    const frame = 41_667;
    const rates: number[] = [];
    for (let i = 0; i < 2; i++) rates.push(s.onFrame(1_000_000 + i * frame - 18_000, 1_000_000 + i * frame, true).rate);
    expect(rates[0]).toBeCloseTo(1.15, 9); // 18 ms behind at the start's first frame: 15% fast
    // 18 ms at 15% fast is 18 / (1 − 1/1.15) ≈ 138 ms of media, between three and four frames; then rate 1 less the trim
    let n = 0;
    let rate = rates[1]!;
    while (rate > 1.05 && n < 20) {
      n++;
      rate = s.onFrame(1_000_000 + (1 + n) * frame - 18_000, 1_000_000 + (1 + n) * frame, true).rate; // open loop: the offsets seen meanwhile do not count
    }
    expect(n).toBe(3);
    expect(Math.abs(rate - 1)).toBeLessThanOrEqual(0.005);
  });

  it.each([
    [12_000, 0.9],
    [-24_000, 1.2],
    [60_000, 0.75],
  ])('sets a catch-up for %s us to remove it in 0.12 s of media, at most 25%', (offsetUs, expected) => {
    const s = new ElementSync();
    expect(s.onFrame(1_000_000 + offsetUs, 1_000_000, true).rate).toBeCloseTo(expected, 9);
  });

  /** Frames at a constant offset after `skip` frames in sync; the actions of the offset frames. */
  const steady = (s: ElementSync, from: number, frames: number, offsetUs: number) => {
    const out = [];
    for (let i = 0; i < frames; i++) out.push(s.onFrame(1_000_000 + (from + i) * 41_667 + offsetUs, 1_000_000 + (from + i) * 41_667, true));
    return out;
  };

  it.each([12_000, 15_000, -15_000])('runs no catch-up in steady state at a %s us mean: the loop alone, at most 0.5%', (offsetUs) => {
    const s = new ElementSync();
    steady(s, 0, 48, 0); // two seconds in sync: past the start window
    const actions = steady(s, 48, 48, offsetUs);
    expect(actions.some((a) => a.catchUp)).toBe(false);
    for (const a of actions) expect(Math.abs(a.rate - 1)).toBeLessThanOrEqual(0.005);
  });

  it('catches up a steady-state slip of more than 20 ms (eight frames), counted once', () => {
    const s = new ElementSync();
    steady(s, 0, 48, 0);
    const actions = steady(s, 48, 8, -30_000);
    expect(actions.filter((a) => a.catchUp)).toHaveLength(1);
    // it fires once the eight-frame mean passes 20 ms (six of the eight at −30 ms), at the rate that removes that mean
    expect(actions.at(-1)!.rate).toBeCloseTo(1 + 22_500 / 1e6 / 0.12, 9);
  });

  it('catches up after a seek, in the seek\'s own start window', () => {
    const s = new ElementSync();
    steady(s, 0, 48, 0);
    expect(s.onFrame(1_000_000 + 48 * 41_667 + 150_000, 1_000_000 + 48 * 41_667, true).seekToUs).not.toBeNull();
    steady(s, 49, 2, 0); // the two settle frames
    const actions = steady(s, 51, 2, 14_000);
    expect(actions[0]!.catchUp).toBe(true); // the first frame measured after the seek
    expect(actions[0]!.rate).toBeCloseTo(1 - 0.014 / 0.12, 9);
  });

  /**
   * Plays `frames` frames from a restart with the element `startOffsetUs` off, applying each rate, with the element
   * slipping `slipUs` a frame for the first `slipFrames` frames (a start that keeps falling behind); the offsets and
   * the catch-ups counted.
   */
  const fromRestart = (s: ElementSync, opts: { startOffsetUs: number; frames: number; slipUs?: number; slipFrames?: number }) => {
    const frame = 41_667;
    let clock = 10_000_000;
    let media = clock + opts.startOffsetUs;
    let rate = s.restart().rate;
    let catchUps = 0;
    const offsets: number[] = [];
    for (let i = 0; i < opts.frames; i++) {
      clock += frame;
      media += frame * rate - (i < (opts.slipFrames ?? 0) ? (opts.slipUs ?? 0) : 0);
      const a = s.onFrame(media, clock, true);
      if (a.catchUp) catchUps++;
      rate = a.rate;
      offsets.push(media - clock);
    }
    return { offsets, catchUps };
  };

  it('catches up after a resume (restart), once when that removes the offset', () => {
    const s = new ElementSync();
    steady(s, 0, 48, 0);
    expect(steady(s, 48, 8, 14_000).some((a) => a.catchUp)).toBe(false); // steady state: below 20 ms
    const { offsets, catchUps } = fromRestart(s, { startOffsetUs: -30_000, frames: 24 });
    expect(catchUps).toBe(1);
    expect(maxAbs(offsets.slice(6))).toBeLessThanOrEqual(10_000);
  });

  it('keeps catching up in the start window while a starting element keeps slipping', () => {
    const s = new ElementSync();
    steady(s, 0, 48, 0);
    // as Chrome under load does: the first frames come late, 6 ms more each for six frames
    const { offsets, catchUps } = fromRestart(s, { startOffsetUs: -5_000, frames: 24, slipUs: 6_000, slipFrames: 6 });
    expect(catchUps).toBeGreaterThanOrEqual(2);
    expect(maxAbs(offsets.slice(12))).toBeLessThanOrEqual(10_000);
  });

  it('stays within 10 ms under clock jitter and drift', () => {
    const { offsets, seeks } = simulate({ drift: 1.002, frames: 60 * 120, fps: 60, jitterUs: 5000 });
    expect(seeks).toBe(0);
    expect(maxAbs(offsets.slice(60 * 20))).toBeLessThanOrEqual(10_000);
  });

  it('integrates nothing for a repeated or backwards media time', () => {
    const s = new ElementSync();
    s.onFrame(1_020_000, 1_000_000, true);
    s.onFrame(1_061_667, 1_041_667, true);
    const before = trimOf(s);
    s.onFrame(1_061_667, 1_041_667, true);
    s.onFrame(1_050_000, 1_041_667, true);
    expect(trimOf(s)).toBe(before);
  });

  it('resets the trim after a seek and keeps it while not playing', () => {
    const s = new ElementSync();
    for (let i = 0; i < 10; i++) s.onFrame(1_010_000 + i * 41_667, 1_000_000 + i * 41_667, true);
    const learned = trimOf(s);
    expect(learned).not.toBe(0);
    s.onFrame(0, 1_000_000, false);
    expect(trimOf(s)).toBe(learned);
    s.onFrame(1_200_000, 1_000_000, true);
    expect(trimOf(s)).toBe(0);
  });

  it('keeps the trim within the rate bound', () => {
    const s = new ElementSync();
    for (let i = 0; i < 2000; i++) s.onFrame(1_090_000 + i * 41_667, 1_000_000 + i * 41_667, true);
    expect(Math.abs(trimOf(s))).toBeLessThanOrEqual(0.005);
  });
});
