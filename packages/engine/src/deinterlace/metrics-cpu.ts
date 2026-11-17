// SPDX-License-Identifier: LGPL-3.0-or-later
// The CPU reference of the per-frame field measurements the cadence detector reads (`FrameMetrics`): our own
// definitions, written so the GPU version can be checked against them and so tests can feed the detector real frames.

import type { FrameMetrics } from './cadence';

/** One 8-bit picture plane (the luma, for the measurements): `stride` bytes from one row's start to the next. */
export interface Plane {
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly data: Uint8Array;
}

/**
 * A pixel combs when it differs from both rows of the other field around it in the same direction by more than this
 * many 8-bit levels (coding noise stays under it) …
 */
export const COMB_LEVEL = 12;

/**
 * … and is closer to the mean of its own field's rows two above and below than to either of those other-field rows
 * (so a horizontal line one pixel high, which no field pairing explains, isn't combing).
 */
function combs(c: number, up: number, down: number, up2: number, down2: number): boolean {
  const du = c - up;
  const dd = c - down;
  if ((du > 0) !== (dd > 0) || du === 0 || dd === 0) return false;
  const apart = Math.min(Math.abs(du), Math.abs(dd));
  if (apart <= COMB_LEVEL) return false;
  return Math.abs(2 * c - up2 - down2) < 2 * apart;
}

/**
 * The share of pixels that comb in the picture made of `a`'s rows of parity `aParity` (0 the top field's rows, 1 the
 * bottom's) and `b`'s other rows, 0 to 1. The two rows at either edge, which lack a row two away, are not measured.
 */
export function combShare(a: Plane, aParity: 0 | 1, b: Plane): number {
  const { width, height } = a;
  if (height < 5) return 0;
  const row = (y: number): number => y * a.stride;
  const brow = (y: number): number => y * b.stride;
  const at = (y: number, x: number): number => ((y & 1) === aParity ? a.data[row(y) + x]! : b.data[brow(y) + x]!);
  let count = 0;
  for (let y = 2; y < height - 2; y++) {
    for (let x = 0; x < width; x++) {
      if (combs(at(y, x), at(y - 1, x), at(y + 1, x), at(y - 2, x), at(y + 2, x))) count++;
    }
  }
  return count / (width * (height - 4));
}

/** Mean absolute difference of two planes of the same size, 0 to 1. */
export function meanDifference(a: Plane, b: Plane): number {
  let sum = 0;
  for (let y = 0; y < a.height; y++) {
    const ra = y * a.stride;
    const rb = y * b.stride;
    for (let x = 0; x < a.width; x++) sum += Math.abs(a.data[ra + x]! - b.data[rb + x]!);
  }
  return sum / (a.width * a.height * 255);
}

/**
 * The measurements of `cur` (luma planes of one size) with its neighbours, as `FrameMetrics` defines them. The match
 * pairings follow `fieldOrder`, the stream's: the first parity is the top field's rows for `tff`, the bottom's for
 * `bff`. A pairing with a missing neighbour (the first or last frame) measures as the woven frame, so it neither wins
 * nor sets the scale, and `diffPrev` with no previous frame is 1 (nothing before it to repeat). Field-order evidence
 * compares the combing of the field pairs half a frame apart under each order with the neighbours present: the true
 * order pairs fields one field apart, the wrong one fields three apart, which comb more where anything moves.
 */
export function frameMetrics(prev: Plane | null, cur: Plane, next: Plane | null, fieldOrder: 'tff' | 'bff'): FrameMetrics {
  const first: 0 | 1 = fieldOrder === 'tff' ? 0 : 1;
  const second: 0 | 1 = first === 0 ? 1 : 0;
  const combWoven = combShare(cur, 0, cur);
  // Top of `cur` with the bottom of `prev`, and so on: each pairing joins one top and one bottom field.
  const topPrev = prev ? combShare(cur, 0, prev) : null;
  const bottomPrev = prev ? combShare(cur, 1, prev) : null;
  const topNext = next ? combShare(cur, 0, next) : null;
  const bottomNext = next ? combShare(cur, 1, next) : null;
  const firstPrev = first === 0 ? topPrev : bottomPrev;
  const secondNext = second === 0 ? topNext : bottomNext;
  return {
    combWoven,
    combMatchPrev: firstPrev ?? combWoven,
    combMatchNext: secondNext ?? combWoven,
    diffPrev: prev ? meanDifference(cur, prev) : 1,
    // Top first: the previous bottom field comes just before this top, the next top just after this bottom.
    motionTff: (topPrev ?? 0) + (bottomNext ?? 0),
    motionBff: (bottomPrev ?? 0) + (topNext ?? 0),
  };
}
