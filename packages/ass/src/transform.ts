/*
 * The 3D transform libass applies to each glyph (rotation about the origin, shear, perspective) as a 3×3
 * projective matrix from outline coordinates to frame coordinates (both 26.6).
 *
 * Ported from libass 0.17.5 (ass_render.c): calc_transform_matrix, calculate_rotation_params. The matrix is used
 * exactly; of quantize_transform only the position rounding is ported (raster.ts). libass is ISC-licensed; see
 * src/engine/NOTICE. Modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

import { doubleToD6, type GlyphInfo } from './events';
import { basePoint, x2scr, y2scr } from './layout';
import type { RenderState } from './state';

/** Row-major 3×3. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** calc_transform_matrix: uses the glyph's device position (pos) and its offset from the rotation centre (shift). */
export function transformMatrix(s: RenderState, info: GlyphInfo): Mat3 {
  const frx = (Math.PI / 180) * info.frx;
  const fry = (Math.PI / 180) * info.fry;
  const frz = (Math.PI / 180) * info.frz;
  const sx = -Math.sin(frx);
  const cx = Math.cos(frx);
  const sy = Math.sin(fry);
  const cy = Math.cos(fry);
  const sz = -Math.sin(frz);
  const cz = Math.cos(frz);
  const fax = (info.fax * info.scaleX) / info.scaleY;
  const fay = (info.fay * info.scaleY) / info.scaleX;
  const x1 = [1, fax, info.shiftX + info.asc * fax];
  const y1 = [fay, 1, info.shiftY];
  const x2 = [0, 0, 0];
  const y2 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    x2[i] = x1[i]! * cz - y1[i]! * sz;
    y2[i] = x1[i]! * sz + y1[i]! * cz;
  }
  const y3 = y2.map((v) => v * cx);
  const z3 = y2.map((v) => v * sx);
  const x4 = x2.map((v, i) => v * cy - z3[i]! * sy);
  const z4 = x2.map((v, i) => v * sy + z3[i]! * cy);
  const dist = 20000 * s.blurScaleY;
  z4[2]! += dist;
  const scaleX = dist * s.parScaleX;
  const offsX = info.posX - info.shiftX * s.parScaleX;
  const offsY = info.posY - info.shiftY;
  const m: number[] = new Array(9);
  for (let i = 0; i < 3; i++) {
    m[i] = z4[i]! * offsX + x4[i]! * scaleX;
    m[3 + i] = z4[i]! * offsY + y3[i]! * dist;
    m[6 + i] = z4[i]!;
  }
  return m as unknown as Mat3;
}

export function applyMat3(m: Mat3, x: number, y: number): readonly [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** No perspective: the bottom row is (0, 0, w). */
export function isAffine(m: Mat3): boolean {
  return Math.abs(m[6]) <= 1e-12 * Math.abs(m[8]) && Math.abs(m[7]) <= 1e-12 * Math.abs(m[8]);
}

/** m scaled so m[8] is 1 (the trace's normal form). */
export function normalize(m: Mat3): Mat3 {
  const w = m[8] || 1;
  return m.map((v) => v / w) as unknown as Mat3;
}

/** calculate_rotation_params: each glyph's offset (26.6) from the rotation centre, \org or the alignment point. */
export function rotationParams(s: RenderState, glyphs: readonly GlyphInfo[], bbox: readonly [number, number, number, number], deviceX: number, deviceY: number): void {
  let cx: number;
  let cy: number;
  if (s.haveOrigin) {
    cx = x2scr(s, s.orgX);
    cy = y2scr(s, s.orgY);
  } else {
    const [bx, by] = basePoint(bbox, s.alignment);
    cx = deviceX + bx;
    cy = deviceY + by;
  }
  for (const info of glyphs) {
    info.shiftX = info.posX + doubleToD6(deviceX - cx + (info.shadowX * s.borderScaleX) / s.parScaleX);
    info.shiftY = info.posY + doubleToD6(deviceY - cy + info.shadowY * s.borderScaleY);
  }
}
