// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ElementSync } from './element-sync';

describe('ElementSync', () => {
  it('keeps rate 1 inside the dead band', () => {
    const s = new ElementSync();
    expect(s.onFrame(1_005_000, 1_000_000, true)).toEqual({ rate: 1, seekToUs: null, offsetUs: 5000 });
  });

  it('nudges the rate against the offset', () => {
    expect(new ElementSync().onFrame(1_050_000, 1_000_000, true).rate).toBeCloseTo(0.995, 6);
    expect(new ElementSync().onFrame(950_000, 1_000_000, true).rate).toBeCloseTo(1.005, 6);
    expect(new ElementSync().onFrame(1_030_000, 1_000_000, true).rate).toBeCloseTo(0.997, 6);
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

  it('stays bounded, with no seeks, when the element runs 0.2% fast', () => {
    const s = new ElementSync();
    const frame = 41_667;
    let clock = 1_000_000;
    let media = 1_000_000;
    let rate = 1;
    const offsets: number[] = [];
    let seeks = 0;
    for (let i = 0; i < 240; i++) {
      clock += frame;
      media += frame * 1.002 * rate;
      const a = s.onFrame(media, clock, true);
      rate = a.rate;
      if (a.seekToUs !== null) {
        seeks++;
        media = a.seekToUs;
      }
      offsets.push(media - clock);
    }
    // A proportional controller with gain 0.1 settles where 1.002 * rate = 1,
    // an offset of 20 ms, so the last 48 frames stay under that, not 10 ms.
    expect(seeks).toBe(0);
    for (const o of offsets.slice(-48)) expect(Math.abs(o)).toBeLessThanOrEqual(20_000);
  });
});
