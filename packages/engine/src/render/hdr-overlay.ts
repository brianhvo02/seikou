// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The colour maths of HDR overlays: subtitles and menus drawn over HDR video at BT.2408's graphics white instead of the
 * display's SDR white. The overlay is drawn in sRGB as always; the HDR presenter decodes it to linear light, multiplies
 * it by a gain and encodes it again with the extended sRGB transfer, where 1.0 is the display's SDR white and values
 * above it are brighter. {@link scalePremultiplied} is that step for one pixel, the reference the presenter's shader
 * follows.
 * @internal
 */

/** BT.2408's graphics white (and HDR reference white), in cd/m²: where subtitles and menus go over HDR video. */
export const GRAPHICS_WHITE_NITS = 203;

/**
 * The SDR white, in cd/m², that the overlay gain assumes the browser shows extended-range 1.0 at when it presents PQ and
 * HLG video absolutely: BT.2408's SDR reference, and Apple's EDR mapping of HDR10.
 */
export const DEFAULT_SDR_WHITE_NITS = 100;

/** The linear factor that takes SDR white to graphics white when the display's SDR white is `sdrWhiteNits` cd/m². */
export function graphicsWhiteGain(sdrWhiteNits: number = DEFAULT_SDR_WHITE_NITS): number {
  return GRAPHICS_WHITE_NITS / sdrWhiteNits;
}

/** The overlay gain used unless the page tunes it: graphics white over a 100 cd/m² SDR white (2.03). */
export const DEFAULT_HDR_OVERLAY_GAIN = graphicsWhiteGain();

/** Bounds of a tuned gain: never dimmer than SDR, and 10 is far past any display's headroom. */
const MIN_GAIN = 1;
const MAX_GAIN = 10;

/** A gain the page asked for, kept within 1 to 10; anything that isn't a finite number gives the default. */
export function clampGain(gain: number | undefined): number {
  if (gain === undefined || !Number.isFinite(gain)) return DEFAULT_HDR_OVERLAY_GAIN;
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain));
}

// SMPTE ST 2084 (PQ) constants
const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;

/** The luminance in cd/m² of a PQ code value in [0, 1] (SMPTE ST 2084's EOTF). */
export function pqEotf(code: number): number {
  const p = Math.pow(Math.max(0, code), 1 / PQ_M2);
  return 10000 * Math.pow(Math.max(0, p - PQ_C1) / (PQ_C2 - PQ_C3 * p), 1 / PQ_M1);
}

// BT.2100 HLG constants
const HLG_A = 0.17883277;
const HLG_B = 1 - 4 * HLG_A;
const HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A);

/**
 * The luminance in cd/m² of an achromatic HLG signal in [0, 1] on a display of `peakNits` (BT.2100: the inverse OETF,
 * then the OOTF with the system gamma for that peak, 1.2 at 1000 cd/m²).
 */
export function hlgDisplayLuminance(signal: number, peakNits = 1000): number {
  const s = Math.max(0, signal);
  const scene = s <= 0.5 ? (s * s) / 3 : (Math.exp((s - HLG_C) / HLG_A) + HLG_B) / 12;
  const gamma = 1.2 + 0.42 * Math.log10(peakNits / 1000);
  return peakNits * Math.pow(scene, gamma);
}

/** Linear light from an sRGB-encoded value, extended past [0, 1] and mirrored for negatives (CSS Color 4). */
export function srgbDecode(v: number): number {
  const a = Math.abs(v);
  const lin = a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4);
  return v < 0 ? -lin : lin;
}

/** The sRGB encoding of linear light, extended past [0, 1] and mirrored for negatives (CSS Color 4). */
export function srgbEncode(v: number): number {
  const a = Math.abs(v);
  const enc = a <= 0.0031308 ? a * 12.92 : 1.055 * Math.pow(a, 1 / 2.4) - 0.055;
  return v < 0 ? -enc : enc;
}

/**
 * One premultiplied sRGB pixel scaled by `gain` in linear light and encoded again, still premultiplied: what the HDR
 * presenter's shader does to every pixel of the overlay. Transparent pixels stay transparent; alpha is kept.
 */
export function scalePremultiplied(rgba: readonly [number, number, number, number], gain: number): [number, number, number, number] {
  const a = rgba[3];
  if (a <= 0) return [0, 0, 0, 0];
  const out = (c: number): number => srgbEncode(srgbDecode(c / a) * gain) * a;
  return [out(rgba[0]), out(rgba[1]), out(rgba[2]), a];
}
