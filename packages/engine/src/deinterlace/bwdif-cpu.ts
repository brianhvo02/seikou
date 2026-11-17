/*
 * Ported from FFmpeg libavfilter/bwdifdsp.c (ff_bwdif_filter_intra_c, ff_bwdif_filter_line_c,
 * ff_bwdif_filter_edge_c) and libavfilter/vf_bwdif.c (filter_slice), FFmpeg n9.0.2
 * BobWeaver Deinterlacing Filter
 * Copyright (C) 2016 Thomas Mundt <loudmax@yahoo.de>
 * Based on YADIF (Yet Another Deinterlacing Filter)
 * Copyright (C) 2006-2011 Michael Niedermayer <michaelni@gmx.at>
 *               2010      James Darnley <james.darnley@gmail.com>
 * With use of Weston 3 Field Deinterlacing Filter algorithm
 * Copyright (C) 2012 British Broadcasting Corporation, All Rights Reserved
 * Author of de-interlace algorithm: Jim Easterbrook for BBC R&D
 * Based on the process described by Martin Weston for BBC R&D
 * Ported to TypeScript (8-bit planes only) and modified for Seikou, 2026.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

// The CPU reference of bwdif, which the GPU deinterlacer's interpolation is checked against: byte for byte what
// ffmpeg's `bwdif` writes for one 8-bit plane. The C macros FILTER_INTRA, FILTER1, SPAT_CHECK, FILTER_LINE,
// FILTER_EDGE and FILTER2 are written out in the functions that use them; pointers become a buffer and an offset.

import type { Plane } from './metrics-cpu';

/*
 * Filter coefficients coef_lf and coef_hf taken from BBC PH-2071 (Weston 3 Field Deinterlacer).
 * Used when there is spatial and temporal interpolation.
 * Filter coefficients coef_sp are used when there is spatial interpolation only.
 * Adjusted for matching visual sharpness impression of spatial and temporal interpolation.
 */
const COEF_LF = [4309, 213] as const;
const COEF_HF = [5570, 3801, 1016] as const;
const COEF_SP = [5077, 981] as const;

const CLIP_MAX = 255;

function clip(v: number): number {
  return v < 0 ? 0 : v > CLIP_MAX ? CLIP_MAX : v;
}

/** bwdifdsp.c ff_bwdif_filter_intra_c (FILTER_INTRA): spatial interpolation only, for a field with no neighbours. */
function filterIntra(
  dst: Uint8Array,
  d: number,
  cur: Uint8Array,
  c: number,
  w: number,
  prefs: number,
  mrefs: number,
  prefs3: number,
  mrefs3: number,
): void {
  for (let x = 0; x < w; x++) {
    const interpol = (COEF_SP[0] * (cur[c + mrefs]! + cur[c + prefs]!) - COEF_SP[1] * (cur[c + mrefs3]! + cur[c + prefs3]!)) >> 13;
    dst[d] = clip(interpol);
    d++;
    c++;
  }
}

/** The rows a line filter reads: the three frames at one offset (they share a stride), and the output. */
interface LineRefs {
  readonly dst: Uint8Array;
  readonly d: number;
  readonly prev: Uint8Array;
  readonly cur: Uint8Array;
  readonly next: Uint8Array;
  /** The offset of the row in `prev`, `cur` and `next`. */
  readonly o: number;
  readonly w: number;
}

/**
 * bwdifdsp.c ff_bwdif_filter_line_c and ff_bwdif_filter_edge_c, which share FILTER1, SPAT_CHECK and FILTER2: `edge`
 * null is filter_line (FILTER_LINE between them), else filter_edge (FILTER_EDGE) with its `spat` flag.
 */
function filterLineOrEdge(
  r: LineRefs,
  prefs: number,
  mrefs: number,
  prefs2: number,
  mrefs2: number,
  prefs3: number,
  mrefs3: number,
  prefs4: number,
  mrefs4: number,
  parity: number,
  edge: { readonly spat: boolean } | null,
): void {
  const { dst, prev, cur, next, w } = r;
  // prev2 = parity ? prev : cur; next2 = parity ? cur : next
  const prev2 = parity ? prev : cur;
  const next2 = parity ? cur : next;
  let d = r.d;
  let o = r.o;
  for (let x = 0; x < w; x++, d++, o++) {
    // FILTER1
    const c = cur[o + mrefs]!;
    const dd = (prev2[o]! + next2[o]!) >> 1;
    const e = cur[o + prefs]!;
    const temporalDiff0 = Math.abs(prev2[o]! - next2[o]!);
    const temporalDiff1 = (Math.abs(prev[o + mrefs]! - c) + Math.abs(prev[o + prefs]! - e)) >> 1;
    const temporalDiff2 = (Math.abs(next[o + mrefs]! - c) + Math.abs(next[o + prefs]! - e)) >> 1;
    let diff = Math.max(temporalDiff0 >> 1, temporalDiff1, temporalDiff2);

    if (!diff) {
      dst[d] = dd;
      continue;
    }
    let interpol: number;
    if (edge === null || edge.spat) {
      // SPAT_CHECK
      const b = ((prev2[o + mrefs2]! + next2[o + mrefs2]!) >> 1) - c;
      const f = ((prev2[o + prefs2]! + next2[o + prefs2]!) >> 1) - e;
      const dc = dd - c;
      const de = dd - e;
      const max = Math.max(de, dc, Math.min(b, f));
      const min = Math.min(de, dc, Math.max(b, f));
      diff = Math.max(diff, min, -max);
    }
    if (edge === null) {
      // FILTER_LINE
      if (Math.abs(c - e) > temporalDiff0) {
        interpol =
          (((COEF_HF[0] * (prev2[o]! + next2[o]!) -
            COEF_HF[1] * (prev2[o + mrefs2]! + next2[o + mrefs2]! + prev2[o + prefs2]! + next2[o + prefs2]!) +
            COEF_HF[2] * (prev2[o + mrefs4]! + next2[o + mrefs4]! + prev2[o + prefs4]! + next2[o + prefs4]!)) >>
            2) +
            COEF_LF[0] * (c + e) -
            COEF_LF[1] * (cur[o + mrefs3]! + cur[o + prefs3]!)) >>
          13;
      } else {
        interpol = (COEF_SP[0] * (c + e) - COEF_SP[1] * (cur[o + mrefs3]! + cur[o + prefs3]!)) >> 13;
      }
    } else {
      // FILTER_EDGE
      interpol = (c + e) >> 1;
    }

    // FILTER2
    if (interpol > dd + diff) interpol = dd + diff;
    else if (interpol < dd - diff) interpol = dd - diff;
    dst[d] = clip(interpol);
  }
}

/** The plane with its rows `stride` apart (a copy when they aren't already). */
function withStride(p: Plane, stride: number): Plane {
  if (p.stride === stride) return p;
  const data = new Uint8Array(stride * p.height);
  for (let y = 0; y < p.height; y++) data.set(p.data.subarray(y * p.stride, y * p.stride + p.width), y * stride);
  return { width: p.width, height: p.height, stride, data };
}

/**
 * vf_bwdif.c filter_slice for one 8-bit plane, the whole height in one slice: the rows of field `parity` (0 top, 1
 * bottom) are copied from `cur`, the others interpolated, with filter_intra when `intra` (the first field of a
 * stream, YADIF_FIELD_END), filter_edge in the four rows at either edge, and filter_line between.
 */
function filterPlane(prev: Plane, cur: Plane, next: Plane, parity: 0 | 1, tff: boolean, intra: boolean): Plane {
  const stride = cur.stride;
  const [p, n] = [withStride(prev, stride), withStride(next, stride)];
  const { width: w, height: h } = cur;
  const out = new Uint8Array(w * h);
  const refs = stride;
  const dspParity = parity ^ (tff ? 1 : 0);
  for (let y = 0; y < h; y++) {
    const o = y * stride;
    const d = y * w;
    if ((y ^ parity) & 1) {
      if (intra) {
        filterIntra(
          out,
          d,
          cur.data,
          o,
          w,
          y + 1 < h ? refs : -refs,
          y > 0 ? -refs : refs,
          y + 3 < h ? 3 * refs : -refs,
          y > 2 ? -3 * refs : refs,
        );
        continue;
      }
      const r: LineRefs = { dst: out, d, prev: p.data, cur: cur.data, next: n.data, o, w };
      if (y < 4 || y + 5 > h) {
        filterLineOrEdge(r, y + 1 < h ? refs : -refs, y > 0 ? -refs : refs, refs << 1, -(refs << 1), 0, 0, 0, 0, dspParity, {
          spat: !(y < 2 || y + 3 > h),
        });
      } else {
        filterLineOrEdge(r, refs, -refs, refs << 1, -(refs << 1), 3 * refs, -3 * refs, refs << 2, -(refs << 2), dspParity, null);
      }
    } else {
      out.set(cur.data.subarray(o, o + w), d);
    }
  }
  return { width: w, height: h, stride: w, data: out };
}

function checkSizes(...planes: Plane[]): void {
  const [a] = planes;
  for (const p of planes) {
    if (p.width !== a!.width || p.height !== a!.height) throw new Error('bwdif: planes of different sizes');
  }
  if (a!.width < 3 || a!.height < 4) throw new Error('bwdif: a plane needs at least 3 columns and 4 rows');
}

/**
 * One picture of ffmpeg's `bwdif` (send_field) for field `parity` of `cur` (0 the top field, 1 the bottom): that
 * field's rows kept, the other rows interpolated from it and from the frames around it. `tff` is the stream's field
 * order, which says whether the field's time lies nearer `prev` or `next`. The planes are 8-bit and of one size; the
 * picture comes back with its rows packed (`stride` equal to `width`).
 */
export function bwdifField(prev: Plane, cur: Plane, next: Plane, parity: 0 | 1, tff: boolean): Plane {
  checkSizes(prev, cur, next);
  return filterPlane(prev, cur, next, parity, tff, false);
}

/**
 * The picture ffmpeg's `bwdif` makes of a stream's very first field, which has no previous frame: field `parity` of
 * `cur` kept and the other rows interpolated from it alone (filter_intra). Later fields of the stream use
 * `bwdifField` (the first frame's second field with `cur` as its own previous frame, as ffmpeg does).
 */
export function bwdifIntraField(cur: Plane, parity: 0 | 1): Plane {
  checkSizes(cur);
  return filterPlane(cur, cur, cur, parity, true, true);
}
