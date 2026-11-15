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

describe('ElementSync', () => {
  it('gives a small rate nudge for a small offset', () => {
    const a = new ElementSync().onFrame(1_005_000, 1_000_000, true);
    expect(a.rate).toBeCloseTo(0.99875, 6);
    expect(a.seekToUs).toBeNull();
    expect(a.offsetUs).toBe(5000);
  });

  it('nudges the rate against the offset, clamped at 0.005', () => {
    expect(new ElementSync().onFrame(1_050_000, 1_000_000, true).rate).toBeCloseTo(0.995, 6);
    expect(new ElementSync().onFrame(950_000, 1_000_000, true).rate).toBeCloseTo(1.005, 6);
    expect(new ElementSync().onFrame(1_030_000, 1_000_000, true).rate).toBeCloseTo(0.995, 6);
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

  it('leaves the two frames after a seek uncorrected, then corrects again', () => {
    const s = new ElementSync();
    expect(s.onFrame(1_150_000, 1_000_000, true).seekToUs).toBe(1_000_000);
    for (let i = 0; i < 2; i++) {
      expect(s.onFrame(1_050_000, 1_000_000, true)).toEqual({ rate: 1, seekToUs: null, offsetUs: 50_000 });
    }
    expect(s.onFrame(1_050_000, 1_000_000, true).rate).toBeCloseTo(0.995, 6);
  });

  it('reset clears the settle state', () => {
    const s = new ElementSync();
    s.onFrame(1_150_000, 1_000_000, true);
    s.reset();
    expect(s.onFrame(1_050_000, 1_000_000, true).rate).toBeCloseTo(0.995, 6);
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
