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
 * Ported to GLSL ES 3.00 (8-bit planes only, one fragment per output pixel) and modified for Seikou, 2026.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

// bwdif as a WebGL2 fragment shader, computing what `bwdif-cpu.ts` computes (and so what ffmpeg's `bwdif` writes) for
// one 8-bit plane, in integers: the planes are unsigned-integer textures read with texelFetch. The C macros
// FILTER_INTRA, FILTER1, SPAT_CHECK, FILTER_LINE, FILTER_EDGE and FILTER2 are written out in the functions that use
// them; a row offset (prefs, mrefs, ...) is a number of rows rather than of bytes.

/**
 * Which plane a bwdif program filters: the luma (one R8UI texture a frame), I420 chroma (U and V, an R8UI texture
 * each) or NV12 chroma (one RG8UI texture). Chroma programs write both chroma components to an RG8UI target.
 */
export type BwdifPlane = 'luma' | 'i420' | 'nv12';

/**
 * The fragment shader of one bwdif picture of a plane. Uniforms: `p0`, `c0`, `n0` the previous, current and next
 * frame's texture of the plane (`p1`, `c1`, `n1` the V plane's for `i420`), `u_size` the plane's size, `u_parity` the
 * kept field (0 top, 1 bottom: its rows are copied, the others interpolated), `u_dspParity` that parity xor top field
 * first (vf_bwdif.c's `parity ^ tff`), and `u_intra` for a stream's first field (spatial interpolation only).
 * The output row is the plane row (`gl_FragCoord.y`, rows from the top), drawn at the plane's size.
 */
export function bwdifFragment(plane: BwdifPlane): string {
  const components = plane === 'luma' ? 1 : 2;
  const fetch =
    plane === 'luma'
      ? (tex: string) => `int(texelFetch(${tex}0, ivec2(x, y), 0).r)`
      : plane === 'i420'
        ? (tex: string) => `int(c == 0 ? texelFetch(${tex}0, ivec2(x, y), 0).r : texelFetch(${tex}1, ivec2(x, y), 0).r)`
        : (tex: string) => `int(c == 0 ? texelFetch(${tex}0, ivec2(x, y), 0).r : texelFetch(${tex}0, ivec2(x, y), 0).g)`;
  return `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D p0, c0, n0;
${plane === 'i420' ? 'uniform usampler2D p1, c1, n1;' : ''}
uniform ivec2 u_size;
uniform int u_parity;
uniform int u_dspParity;
uniform bool u_intra;
out uvec4 o;

/*
 * Filter coefficients coef_lf and coef_hf taken from BBC PH-2071 (Weston 3 Field Deinterlacer).
 * Used when there is spatial and temporal interpolation.
 * Filter coefficients coef_sp are used when there is spatial interpolation only.
 * Adjusted for matching visual sharpness impression of spatial and temporal interpolation.
 */
const int COEF_LF0 = 4309;
const int COEF_LF1 = 213;
const int COEF_HF0 = 5570;
const int COEF_HF1 = 3801;
const int COEF_HF2 = 1016;
const int COEF_SP0 = 5077;
const int COEF_SP1 = 981;

int P(int c, int x, int y) { return ${fetch('p')}; }
int C(int c, int x, int y) { return ${fetch('c')}; }
int N(int c, int x, int y) { return ${fetch('n')}; }
// prev2 = parity ? prev : cur; next2 = parity ? cur : next
int PREV2(int c, int x, int y) { return u_dspParity != 0 ? P(c, x, y) : C(c, x, y); }
int NEXT2(int c, int x, int y) { return u_dspParity != 0 ? C(c, x, y) : N(c, x, y); }

// bwdifdsp.c ff_bwdif_filter_intra_c (FILTER_INTRA)
int filterIntra(int c, int x, int y, int prefs, int mrefs, int prefs3, int mrefs3) {
  int interpol = (COEF_SP0 * (C(c, x, y + mrefs) + C(c, x, y + prefs)) - COEF_SP1 * (C(c, x, y + mrefs3) + C(c, x, y + prefs3))) >> 13;
  return clamp(interpol, 0, 255);
}

// bwdifdsp.c ff_bwdif_filter_line_c (mode 0) and ff_bwdif_filter_edge_c (mode 1 with spat, mode 2 without), which
// share FILTER1, SPAT_CHECK and FILTER2.
int filterLine(int c, int x, int y, int prefs, int mrefs, int prefs2, int mrefs2, int prefs3, int mrefs3, int prefs4, int mrefs4, int mode) {
  // FILTER1
  int cc = C(c, x, y + mrefs);
  int d = (PREV2(c, x, y) + NEXT2(c, x, y)) >> 1;
  int e = C(c, x, y + prefs);
  int temporalDiff0 = abs(PREV2(c, x, y) - NEXT2(c, x, y));
  int temporalDiff1 = (abs(P(c, x, y + mrefs) - cc) + abs(P(c, x, y + prefs) - e)) >> 1;
  int temporalDiff2 = (abs(N(c, x, y + mrefs) - cc) + abs(N(c, x, y + prefs) - e)) >> 1;
  int diff = max(max(temporalDiff0 >> 1, temporalDiff1), temporalDiff2);
  if (diff == 0) return d;
  if (mode != 2) {
    // SPAT_CHECK
    int b = ((PREV2(c, x, y + mrefs2) + NEXT2(c, x, y + mrefs2)) >> 1) - cc;
    int f = ((PREV2(c, x, y + prefs2) + NEXT2(c, x, y + prefs2)) >> 1) - e;
    int dc = d - cc;
    int de = d - e;
    int mx = max(max(de, dc), min(b, f));
    int mn = min(min(de, dc), max(b, f));
    diff = max(max(diff, mn), -mx);
  }
  int interpol;
  if (mode == 0) {
    // FILTER_LINE
    if (abs(cc - e) > temporalDiff0) {
      interpol = (((COEF_HF0 * (PREV2(c, x, y) + NEXT2(c, x, y))
          - COEF_HF1 * (PREV2(c, x, y + mrefs2) + NEXT2(c, x, y + mrefs2) + PREV2(c, x, y + prefs2) + NEXT2(c, x, y + prefs2))
          + COEF_HF2 * (PREV2(c, x, y + mrefs4) + NEXT2(c, x, y + mrefs4) + PREV2(c, x, y + prefs4) + NEXT2(c, x, y + prefs4))) >> 2)
          + COEF_LF0 * (cc + e) - COEF_LF1 * (C(c, x, y + mrefs3) + C(c, x, y + prefs3))) >> 13;
    } else {
      interpol = (COEF_SP0 * (cc + e) - COEF_SP1 * (C(c, x, y + mrefs3) + C(c, x, y + prefs3))) >> 13;
    }
  } else {
    // FILTER_EDGE
    interpol = (cc + e) >> 1;
  }
  // FILTER2
  if (interpol > d + diff) interpol = d + diff;
  else if (interpol < d - diff) interpol = d - diff;
  return clamp(interpol, 0, 255);
}

// vf_bwdif.c filter_slice for one pixel: the kept field's rows copied, filter_intra for a stream's first field,
// filter_edge in the four rows at either edge, filter_line between.
int pixel(int c, int x, int y) {
  int h = u_size.y;
  if (((y ^ u_parity) & 1) == 0) return C(c, x, y);
  if (u_intra) return filterIntra(c, x, y, y + 1 < h ? 1 : -1, y > 0 ? -1 : 1, y + 3 < h ? 3 : -1, y > 2 ? -3 : 1);
  if (y < 4 || y + 5 > h) return filterLine(c, x, y, y + 1 < h ? 1 : -1, y > 0 ? -1 : 1, 2, -2, 0, 0, 0, 0, (y < 2 || y + 3 > h) ? 2 : 1);
  return filterLine(c, x, y, 1, -1, 2, -2, 3, -3, 4, -4, 0);
}

void main() {
  int x = int(gl_FragCoord.x);
  int y = int(gl_FragCoord.y);
  o = uvec4(uint(pixel(0, x, y)), ${components === 2 ? 'uint(pixel(1, x, y))' : '0u'}, 0u, 1u);
}
`;
}
