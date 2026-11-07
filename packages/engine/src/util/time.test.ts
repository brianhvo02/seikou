import { describe, expect, it } from 'vitest';
import { PTS_WRAP, pts90ToUs, ptsDelta90, ticks45ToUs, usToTicks45 } from './time';

describe('time units', () => {
  it('converts 45 kHz ticks, 90 kHz PTS and microseconds', () => {
    expect(ticks45ToUs(45_000)).toBe(1_000_000);
    expect(usToTicks45(2_000_000)).toBe(90_000);
    expect(pts90ToUs(90_000)).toBe(1_000_000);
    expect(ticks45ToUs(1)).toBe(22);
  });

  it('computes signed PTS differences across the 33-bit wrap', () => {
    expect(ptsDelta90(1000, 400)).toBe(600);
    expect(ptsDelta90(400, 1000)).toBe(-600);
    expect(ptsDelta90(100, PTS_WRAP - 100)).toBe(200);
    expect(ptsDelta90(PTS_WRAP - 100, 100)).toBe(-200);
  });
});
