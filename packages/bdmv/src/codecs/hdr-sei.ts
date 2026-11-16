// SPDX-License-Identifier: LGPL-3.0-or-later
import { unescapeRbsp } from './nal';

/**
 * The mastering display colour volume SEI of H.265 (payload type 137, §D.2.28), as coded: chromaticities in units
 * of 0.00002 and luminance in units of 0.0001 cd/m².
 * @internal
 */
export interface MasteringDisplay {
  /** The x and y of the green, blue and red primaries, in that order (the order the SEI codes them). */
  primaries: [x: number, y: number][];
  /** The x and y of the white point. */
  whitePoint: [number, number];
  /** The maximum display luminance, in units of 0.0001 cd/m². */
  maxLuminance: number;
  /** The minimum display luminance, in units of 0.0001 cd/m². */
  minLuminance: number;
}

/**
 * The content light level SEI of H.265 (payload type 144, §D.2.35), in cd/m².
 * @internal
 */
export interface ContentLight {
  /** The maximum content light level. */
  maxCll: number;
  /** The maximum frame-average light level. */
  maxFall: number;
}

const PREFIX_SEI_NUT = 39;
const MASTERING_DISPLAY = 137;
const CONTENT_LIGHT_LEVEL = 144;

function u16(d: Uint8Array, o: number): number {
  return (d[o] << 8) | d[o + 1];
}

function u32(d: Uint8Array, o: number): number {
  return d[o] * 0x1000000 + (d[o + 1] << 16) + (d[o + 2] << 8) + d[o + 3];
}

/**
 * Finds the mastering display and content light level SEI messages in H.265 NAL units (each with its NAL unit
 * header, as `splitNalUnits` gives them). Only prefix SEI NAL units are read; a message that is missing or too
 * short gives null, and the first message of each kind wins.
 * @internal
 */
export function readHdrSei(nals: readonly Uint8Array[]): { mastering: MasteringDisplay | null; light: ContentLight | null } {
  let mastering: MasteringDisplay | null = null;
  let light: ContentLight | null = null;
  for (const nal of nals) {
    if (nal.length < 3 || ((nal[0] >> 1) & 0x3f) !== PREFIX_SEI_NUT) continue;
    const d = unescapeRbsp(nal.subarray(2));
    let o = 0;
    // sei_message()s run until the rbsp trailing bits, which are a lone 0x80 byte.
    while (o + 2 <= d.length && !(d[o] === 0x80 && o === d.length - 1)) {
      let type = 0;
      while (o < d.length && d[o] === 0xff) { type += 255; o++; }
      if (o >= d.length) break;
      type += d[o++];
      let size = 0;
      while (o < d.length && d[o] === 0xff) { size += 255; o++; }
      if (o >= d.length) break;
      size += d[o++];
      if (o + size > d.length) break;
      if (type === MASTERING_DISPLAY && size >= 24 && !mastering) {
        mastering = {
          primaries: [0, 1, 2].map((i): [number, number] => [u16(d, o + 4 * i), u16(d, o + 4 * i + 2)]),
          whitePoint: [u16(d, o + 12), u16(d, o + 14)],
          maxLuminance: u32(d, o + 16),
          minLuminance: u32(d, o + 20),
        };
      } else if (type === CONTENT_LIGHT_LEVEL && size >= 4 && !light) {
        light = { maxCll: u16(d, o), maxFall: u16(d, o + 2) };
      }
      o += size;
    }
  }
  return { mastering, light };
}
