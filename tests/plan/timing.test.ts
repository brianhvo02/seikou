// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { frameAt, framesToNs, sampleAt } from '../../src/plan/timing';

const v = { firstPts90: 900000, fpsNum: 24000, fpsDen: 1001 };

describe('timing', () => {
  it('maps 45 kHz times to frames and samples', () => {
    expect(frameAt(450000, v)).toBe(0);
    expect(frameAt(630000, v)).toBe(96);
    expect(frameAt(451000, v)).toBe(1); // 2000 ticks at 90k = 0.53 frames, rounds to 1
    expect(sampleAt(540000, { firstPts90: 900000, sampleRate: 48000 })).toBe(96000);
    expect(framesToNs(96, v)).toBe(4004000000n);
  });
});
