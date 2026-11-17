// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createGlDeinterlaceBackend, metricsFromCounts } from './gl-backend';
import { COMB_CELL, combShare, frameMetrics, meanDifference, type Plane } from './metrics-cpu';

const SIZE = COMB_CELL;

/** A one-cell picture whose fields show a bright box moving 6 px a field, so the pairings comb differently. */
function frame(index: number): Plane {
  const data = new Uint8Array(SIZE * SIZE).fill(40);
  for (let y = 0; y < SIZE; y++) {
    const field = 2 * index + (y & 1);
    const left = 4 + 6 * field;
    for (let x = left; x < Math.min(SIZE, left + 16); x++) if (y >= 16 && y < 48) data[y * SIZE + x] = 220;
  }
  return { width: SIZE, height: SIZE, stride: SIZE, data };
}

/** The picture of `a`'s rows of parity `p` and `b`'s others. */
function paired(a: Plane, p: 0 | 1, b: Plane): Plane {
  const data = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) data.set(((y & 1) === p ? a : b).data.subarray(y * SIZE, (y + 1) * SIZE), y * SIZE);
  return { width: SIZE, height: SIZE, stride: SIZE, data };
}

/**
 * The integers the GPU's final pass reads back, from the CPU reference. On a one-cell picture the window count is
 * the whole picture's count, so `combShare` gives both.
 */
function counts(prev: Plane | null, cur: Plane, next: Plane | null): Uint32Array {
  const count = (a: Plane, p: 0 | 1, b: Plane | null): number => (b ? Math.round(combShare(a, p, b) * 4 * SIZE * SIZE) : 0);
  const woven = count(cur, 0, cur);
  const [tp, bp, tn, bn] = [count(cur, 0, prev), count(cur, 1, prev), count(cur, 0, next), count(cur, 1, next)];
  const diff = prev ? Math.round(meanDifference(cur, prev) * SIZE * SIZE * 255) : 0;
  return Uint32Array.from([woven, tp, bp, tn, bn, tp, bp, tn, bn, diff, 0, 0]);
}

describe('metricsFromCounts', () => {
  const [a, b, c] = [frame(0), frame(1), frame(2)];

  it('the test pictures comb under some pairings and not others', () => {
    expect(combShare(b, 0, b)).toBeGreaterThan(0);
    expect(combShare(paired(b, 0, a), 0, paired(b, 0, a))).toBeGreaterThan(0);
  });

  for (const order of ['tff', 'bff'] as const) {
    it(`gives what the CPU reference gives, ${order}, with and without neighbours`, () => {
      const pixels = SIZE * SIZE;
      for (const [prev, next] of [
        [a, c],
        [null, c],
        [a, null],
        [null, null],
      ] as const) {
        const got = metricsFromCounts(counts(prev, b, next), { prev: prev !== null, next: next !== null, fieldOrder: order }, pixels);
        const want = frameMetrics(prev, b, next, order);
        expect(got.combWoven).toBeCloseTo(want.combWoven, 12);
        expect(got.combMatchPrev).toBeCloseTo(want.combMatchPrev, 12);
        expect(got.combMatchNext).toBeCloseTo(want.combMatchNext, 12);
        expect(got.diffPrev).toBeCloseTo(want.diffPrev, 12);
        expect(got.motionTff).toBeCloseTo(want.motionTff, 12);
        expect(got.motionBff).toBeCloseTo(want.motionBff, 12);
      }
    });
  }
});

describe('createGlDeinterlaceBackend', () => {
  it('is null without WebGL2 (here, without OffscreenCanvas)', () => {
    expect(createGlDeinterlaceBackend(1920, 1080, 12)).toBeNull();
  });
});
