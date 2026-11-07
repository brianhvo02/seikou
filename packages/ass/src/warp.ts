/*
 * Draws a canvas through a projective (3D-rotation) matrix, which Canvas2D cannot do: the source is cut into a
 * grid of triangles, each drawn with the affine map of its corners, fine enough that the result stays within a
 * quarter pixel of the true projection.
 *
 * Original implementation for bluray-web, 2026; contains no libass, libbluray or FFmpeg code.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { applyMat3, isAffine, type Mat3 } from './transform';

export interface Affine2D { a: number; b: number; c: number; d: number; e: number; f: number }

const MAX_GRID = 32;
const TOLERANCE = 0.25;

/** Source px → device px: m works on 26.6 coordinates. */
const project = (m: Mat3, u: number, v: number): [number, number] => {
  const [x, y] = applyMat3(m, 64 * u, 64 * v);
  return [x / 64, y / 64];
};

/** The affine map taking the three source points to the three destination points. */
export function triangleAffine(src: readonly (readonly [number, number])[], dst: readonly (readonly [number, number])[]): Affine2D {
  const [[x0, y0], [x1, y1], [x2, y2]] = src as [[number, number], [number, number], [number, number]];
  const [[u0, v0], [u1, v1], [u2, v2]] = dst as [[number, number], [number, number], [number, number]];
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det;
  const c = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / det;
  const b = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / det;
  const d = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / det;
  return { a, b, c, d, e: u0 - a * x0 - c * y0, f: v0 - b * x0 - d * y0 };
}

/** The largest distance (px) between the projection and its n×n piecewise-affine approximation, sampled. */
export function warpError(m: Mat3, w: number, h: number, n: number): number {
  let worst = 0;
  const cw = w / n;
  const ch = h / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = i * cw;
      const y = j * ch;
      const corners: [number, number][] = [[x, y], [x + cw, y], [x, y + ch]];
      const t = triangleAffine(corners, corners.map(([u, v]) => project(m, u, v)));
      for (const [fu, fv] of [[1 / 3, 1 / 3], [0.5, 0], [0, 0.5], [0.5, 0.5]] as const) {
        const u = x + fu * cw;
        const v = y + fv * ch;
        const [px, py] = project(m, u, v);
        worst = Math.max(worst, Math.hypot(t.a * u + t.c * v + t.e - px, t.b * u + t.d * v + t.f - py));
      }
    }
  }
  return worst;
}

/** The smallest grid (1, 2, 4 … 32) keeping the error under a quarter pixel. */
export function gridSize(m: Mat3, w: number, h: number): number {
  if (isAffine(m)) return 1;
  for (let n = 2; n < MAX_GRID; n *= 2) if (warpError(m, w, h, n) < TOLERANCE) return n;
  return MAX_GRID;
}

/** Draws `source` (px u,v) onto `target` at project(m, u, v) − origin. */
export function drawWarped(target: OffscreenCanvasRenderingContext2D, source: OffscreenCanvas, m: Mat3, originX: number, originY: number): void {
  const w = source.width;
  const h = source.height;
  const n = gridSize(m, w, h);
  const cw = w / n;
  const ch = h / n;
  const at = (u: number, v: number): [number, number] => {
    const [x, y] = project(m, u, v);
    return [x - originX, y - originY];
  };
  const visible = (u: number, v: number): boolean => m[6] * 64 * u + m[7] * 64 * v + m[8] > 0; // in front of the camera
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = i * cw;
      const y = j * ch;
      const quad: [number, number][] = [[x, y], [x + cw, y], [x + cw, y + ch], [x, y + ch]];
      if (!quad.every(([u, v]) => visible(u, v))) continue;
      for (const tri of [[quad[0]!, quad[1]!, quad[3]!], [quad[1]!, quad[2]!, quad[3]!]]) {
        const dst = tri.map(([u, v]) => at(u, v));
        const t = triangleAffine(tri, dst);
        // clip to the destination triangle, grown by half a pixel so neighbours overlap instead of leaving seams
        const cx = (dst[0]![0] + dst[1]![0] + dst[2]![0]) / 3;
        const cy = (dst[0]![1] + dst[1]![1] + dst[2]![1]) / 3;
        target.save();
        target.beginPath();
        dst.forEach(([px, py], k) => {
          const len = Math.hypot(px - cx, py - cy) || 1;
          const gx = px + (0.5 * (px - cx)) / len;
          const gy = py + (0.5 * (py - cy)) / len;
          if (k === 0) target.moveTo(gx, gy);
          else target.lineTo(gx, gy);
        });
        target.closePath();
        target.clip();
        target.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
        target.drawImage(source, 0, 0);
        target.restore();
      }
    }
  }
}
