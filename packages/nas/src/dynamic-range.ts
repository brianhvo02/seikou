// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A disc's or title's HDR format, as the NAS library lists it.
 */

/** An HDR format read from a disc's CLPI: Dolby Vision, HDR10+ or HDR10. SDR is null where one is asked for. */
export type DynamicRange = 'dv' | 'hdr10plus' | 'hdr10';

const RANK: Readonly<Record<DynamicRange, number>> = { hdr10: 1, hdr10plus: 2, dv: 3 };

/**
 * The best of `ranges` (Dolby Vision over HDR10+ over HDR10), for a title that holds discs of several kinds; null when
 * none is HDR. Missing values (from a NAS that sends none) count as SDR.
 * @example ../examples/best-dynamic-range.ts
 */
export function bestDynamicRange(ranges: Iterable<DynamicRange | null | undefined>): DynamicRange | null {
  let best: DynamicRange | null = null;
  for (const r of ranges) if (r && (best === null || RANK[r] > RANK[best])) best = r;
  return best;
}
