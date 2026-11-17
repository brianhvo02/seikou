// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { chooseClip, frameRateOf, middleSpn, type ClipCandidate } from './decode-rate';

const clip = (name: string, size: number): ClipCandidate => ({ clip: name, pid: 0x1011, rateCode: 1, entries: [], size });

describe('decode-rate helpers', () => {
  it('frameRateOf maps the Blu-ray frame rate codes and falls back to 23.976', () => {
    expect(frameRateOf(1)).toBeCloseTo(23.976, 3);
    expect(frameRateOf(2)).toBe(24);
    expect(frameRateOf(3)).toBe(25);
    expect(frameRateOf(4)).toBeCloseTo(29.97, 2);
    expect(frameRateOf(6)).toBe(50);
    expect(frameRateOf(7)).toBeCloseTo(59.94, 2);
    expect(frameRateOf(0)).toBeCloseTo(23.976, 3);
  });

  it('chooseClip takes the largest stream file, or null', () => {
    expect(chooseClip([clip('00001', 10), clip('00002', 30), clip('00003', 20)])?.clip).toBe('00002');
    expect(chooseClip([])).toBeNull();
  });

  it('middleSpn takes the EP entry halfway through, or 0 without entries', () => {
    expect(middleSpn([])).toBe(0);
    expect(middleSpn([{ pts: 0, spn: 0 }, { pts: 1, spn: 100 }, { pts: 2, spn: 200 }])).toBe(100);
    expect(middleSpn([{ pts: 0, spn: 0 }, { pts: 1, spn: 100 }])).toBe(100);
  });
});
