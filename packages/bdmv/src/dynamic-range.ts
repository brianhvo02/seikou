// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * A disc title's HDR format, from its clips' CLPI stream attributes.
 */
import type { Clpi } from './clpi-parser';
import { CodingType } from './stream-types';

/**
 * A title's HDR format: Dolby Vision, HDR10+ or HDR10. A title with none is SDR (null where it is asked for).
 * @internal
 */
export type DynamicRange = 'dv' | 'hdr10plus' | 'hdr10';

/** CLPI `dynamic_range_type` values (libbluray `bd_dynamic_range_type_e`). */
const HDR10 = 1;
const DOLBY_VISION = 2;

/**
 * The HDR format of a title made of `clips`: Dolby Vision when any HEVC stream says so (on a UHD disc the
 * enhancement layer's stream does, behind an HDR10 base layer), else HDR10+ when an HDR10 stream has the HDR10+ flag,
 * else HDR10 when one is HDR10; null for SDR, other codings and no clips.
 * @internal
 */
export function dynamicRangeOf(clips: readonly Clpi[]): DynamicRange | null {
  let best: DynamicRange | null = null;
  for (const clip of clips) {
    for (const program of clip.programs) {
      for (const s of program.streams) {
        if (s.codingType !== CodingType.HEVC) continue;
        if (s.dynamicRange === DOLBY_VISION) return 'dv';
        if (s.dynamicRange === HDR10) best = s.hdrPlus || best === 'hdr10plus' ? 'hdr10plus' : 'hdr10';
      }
    }
  }
  return best;
}
