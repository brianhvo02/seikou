import { describe, expect, it } from 'vitest';
import { applyMat3, type Mat3 } from './transform';
import { gridSize, triangleAffine, warpError } from './warp';

/** A perspective matrix like calc_transform_matrix's for a \fry rotation (26.6 in and out). */
function fry(deg: number): Mat3 {
  const a = (deg * Math.PI) / 180;
  const dist = 20000;
  // x' = (x cos a) / (1 + x sin a / dist) around the origin, then placed at (960, 540) px
  return [Math.cos(a) * dist, 0, 960 * 64 * dist, 0, dist, 540 * 64 * dist, Math.sin(a), 0, dist] as unknown as Mat3;
}

describe('triangleAffine', () => {
  it('maps each source corner to its destination exactly', () => {
    const src: [number, number][] = [[0, 0], [10, 0], [0, 7]];
    const dst: [number, number][] = [[3, 4], [20, 9], [1, 30]];
    const t = triangleAffine(src, dst);
    for (let k = 0; k < 3; k++) {
      const [x, y] = src[k]!;
      expect(t.a * x + t.c * y + t.e).toBeCloseTo(dst[k]![0], 9);
      expect(t.b * x + t.d * y + t.f).toBeCloseTo(dst[k]![1], 9);
    }
  });
});

describe('gridSize', () => {
  it('is 1 for an affine matrix and grows with the angle, up to 32', () => {
    const affine: Mat3 = [64, 0, 0, 0, 64, 0, 0, 0, 1];
    expect(gridSize(affine, 400, 100)).toBe(1);
    const g30 = gridSize(fry(30), 400, 100);
    const g70 = gridSize(fry(70), 400, 100);
    expect(g30).toBeGreaterThan(1);
    expect(g70).toBeGreaterThanOrEqual(g30);
    expect(g70).toBeLessThanOrEqual(32);
  });

  it('keeps the piecewise-affine map within a quarter pixel of the projective one', () => {
    const m = fry(60);
    const n = gridSize(m, 100, 40);
    expect(warpError(m, 100, 40, n)).toBeLessThan(0.25);
    // and the true map is what applyMat3 gives (px = 26.6 / 64)
    const [x] = applyMat3(m, 0, 0);
    expect(x / 64).toBeCloseTo(960, 9);
  });
});
