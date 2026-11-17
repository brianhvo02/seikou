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
 * A pixel's comb test: it differs from both rows of the other field around it in the same direction by more than
 * this many 8-bit levels (coding noise stays under it) …
 */
export const COMB_LEVEL = 12;

/**
 * … and is closer to the mean of its own field's rows two above and below than to either of those other-field rows
 * (so a horizontal line one pixel high, which no field pairing explains, doesn't pass). Answers 1 when the pixel
 * passes standing above its other-field neighbours, -1 below, 0 when it doesn't pass.
 */
function combSign(c: number, up: number, down: number, up2: number, down2: number): -1 | 0 | 1 {
  const du = c - up;
  const dd = c - down;
  if ((du > 0) !== (dd > 0) || du === 0 || dd === 0) return 0;
  const apart = Math.min(Math.abs(du), Math.abs(dd));
  if (apart <= COMB_LEVEL) return 0;
  if (Math.abs(2 * c - up2 - down2) >= 2 * apart) return 0;
  return du > 0 ? 1 : -1;
}

/** The side of the square cells comb pixels are counted in, in pixels; comb values are read over 2x2 cells. */
export const COMB_CELL = 64;

/** The comb counts of one pairing: the whole picture's, and the largest of any window of 2x2 cells. */
interface CombCounts {
  readonly total: number;
  readonly windowMax: number;
}

/**
 * Counts the pixels that comb in the picture made of `a`'s rows of parity `aParity` (0 the top field's rows, 1 the
 * bottom's) and `b`'s other rows. A pixel combs when it and the pixels left and right of it all pass the comb test
 * the same way up (combing teeth run along a moving edge; texture and grain pass it pixel by pixel, rarely three in a
 * row). Rows 0, 1 and the last two, and the first and last columns, are not measured. The count is kept in all and
 * per `COMB_CELL` cell from the top left (part cells at the right and bottom edge hold what falls in them), and the
 * largest sum over 2x2 neighbouring cells, the windows starting at every cell but the last column and row of cells
 * (a picture one cell wide or high has windows of one column or row), is the window maximum.
 */
function combCounts(a: Plane, aParity: 0 | 1, b: Plane): CombCounts {
  const { width, height } = a;
  if (height < 5 || width < 3) return { total: 0, windowMax: 0 };
  const across = Math.ceil(width / COMB_CELL);
  const down = Math.ceil(height / COMB_CELL);
  const cells = new Uint32Array(across * down);
  const at = (y: number, x: number): number => ((y & 1) === aParity ? a.data[y * a.stride + x]! : b.data[y * b.stride + x]!);
  const sign = (y: number, x: number): number => combSign(at(y, x), at(y - 1, x), at(y + 1, x), at(y - 2, x), at(y + 2, x));
  let total = 0;
  for (let y = 2; y < height - 2; y++) {
    const cellRow = Math.floor(y / COMB_CELL) * across;
    let left = sign(y, 0);
    let mid = sign(y, 1);
    for (let x = 1; x < width - 1; x++) {
      const right = sign(y, x + 1);
      if (mid !== 0 && left === mid && right === mid) {
        total++;
        cells[cellRow + Math.floor(x / COMB_CELL)]!++;
      }
      left = mid;
      mid = right;
    }
  }
  const cell = (j: number, i: number): number => (j < down && i < across ? cells[j * across + i]! : 0);
  let windowMax = 0;
  for (let j = 0; j < Math.max(1, down - 1); j++) {
    for (let i = 0; i < Math.max(1, across - 1); i++) {
      windowMax = Math.max(windowMax, cell(j, i) + cell(j, i + 1) + cell(j + 1, i) + cell(j + 1, i + 1));
    }
  }
  return { total, windowMax };
}

/** A window's pixels: 2x2 cells. */
const WINDOW_PIXELS = 4 * COMB_CELL * COMB_CELL;

/**
 * The comb value of a pairing as `FrameMetrics` defines it: the largest count of combing pixels in any window of 2x2
 * `COMB_CELL` cells of the picture made of `a`'s rows of parity `aParity` (0 the top field's, 1 the bottom's) and
 * `b`'s other rows, divided by a whole window's pixels, 0 to 1.
 */
export function combShare(a: Plane, aParity: 0 | 1, b: Plane): number {
  return combCounts(a, aParity, b).windowMax / WINDOW_PIXELS;
}

/** The share of the whole picture's pixels that comb under a pairing (for the field-order evidence). */
function wholeShare(c: CombCounts, p: Plane): number {
  return c.total / (p.width * p.height);
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
 * `bff`. Comb values are the densest window's (`combShare`); the field-order evidence uses whole-frame shares, since
 * it compares the same pixels under two orders. A pairing with a missing neighbour (the first or last frame) measures
 * as the woven frame, so it neither wins nor sets the scale, and `diffPrev` with no previous frame is 1 (nothing before it to repeat). Field-order evidence
 * compares the combing of the field pairs half a frame apart under each order with the neighbours present: the true
 * order pairs fields one field apart, the wrong one fields three apart, which comb more where anything moves.
 */
export function frameMetrics(prev: Plane | null, cur: Plane, next: Plane | null, fieldOrder: 'tff' | 'bff'): FrameMetrics {
  const first: 0 | 1 = fieldOrder === 'tff' ? 0 : 1;
  const windowShare = (c: CombCounts): number => c.windowMax / WINDOW_PIXELS;
  const combWoven = windowShare(combCounts(cur, 0, cur));
  // Top of `cur` with the bottom of `prev`, and so on: each pairing joins one top and one bottom field.
  const topPrev = prev ? combCounts(cur, 0, prev) : null;
  const bottomPrev = prev ? combCounts(cur, 1, prev) : null;
  const topNext = next ? combCounts(cur, 0, next) : null;
  const bottomNext = next ? combCounts(cur, 1, next) : null;
  const firstPrev = first === 0 ? topPrev : bottomPrev;
  const secondNext = first === 0 ? bottomNext : topNext;
  const whole = (c: CombCounts | null): number => (c ? wholeShare(c, cur) : 0);
  return {
    combWoven,
    combMatchPrev: firstPrev ? windowShare(firstPrev) : combWoven,
    combMatchNext: secondNext ? windowShare(secondNext) : combWoven,
    diffPrev: prev ? meanDifference(cur, prev) : 1,
    // Top first: the previous bottom field comes just before this top, the next top just after this bottom.
    motionTff: whole(topPrev) + whole(bottomNext),
    motionBff: whole(bottomPrev) + whole(topNext),
  };
}
