// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  clampGain,
  DEFAULT_HDR_OVERLAY_GAIN,
  graphicsWhiteGain,
  GRAPHICS_WHITE_NITS,
  hlgDisplayLuminance,
  pqEotf,
  scalePremultiplied,
  srgbDecode,
  srgbEncode,
} from './hdr-overlay';

describe('HDR overlay colour maths', () => {
  it('puts graphics white at 203 cd/m² in PQ and in HLG on a 1000 cd/m² display', () => {
    expect(GRAPHICS_WHITE_NITS).toBe(203);
    expect(pqEotf(0.5806)).toBeCloseTo(203, 0);
    expect(pqEotf(1)).toBeCloseTo(10000, 3);
    expect(pqEotf(0)).toBe(0);
    expect(Math.abs(hlgDisplayLuminance(0.75) - 203)).toBeLessThan(2);
    expect(hlgDisplayLuminance(1)).toBeCloseTo(1000, 3);
  });

  it('scales SDR white to graphics white from the SDR white level', () => {
    expect(graphicsWhiteGain()).toBeCloseTo(2.03, 10);
    expect(DEFAULT_HDR_OVERLAY_GAIN).toBeCloseTo(2.03, 10);
    expect(graphicsWhiteGain(203)).toBe(1);
    expect(graphicsWhiteGain(80)).toBeCloseTo(2.5375, 10);
  });

  it('decodes and encodes sRGB, extended and sign-preserving', () => {
    expect(srgbDecode(1)).toBeCloseTo(1, 12);
    expect(srgbDecode(0.5)).toBeCloseTo(0.214041, 5);
    expect(srgbDecode(0.04045)).toBeCloseTo(0.04045 / 12.92, 12);
    expect(srgbEncode(srgbDecode(0.73))).toBeCloseTo(0.73, 12);
    expect(srgbEncode(2.03)).toBeCloseTo(1.362, 3);
    expect(srgbEncode(-0.5)).toBeCloseTo(-srgbEncode(0.5), 12);
    expect(srgbDecode(-0.5)).toBeCloseTo(-srgbDecode(0.5), 12);
  });

  it('scales premultiplied pixels in linear light', () => {
    const white = scalePremultiplied([1, 1, 1, 1], 2.03);
    expect(white[0]).toBeCloseTo(1.362, 3);
    expect(white[3]).toBe(1);
    expect(scalePremultiplied([0, 0, 0, 1], 2.03)).toEqual([0, 0, 0, 1]);
    expect(scalePremultiplied([0, 0, 0, 0], 2.03)).toEqual([0, 0, 0, 0]);
    const half = scalePremultiplied([0.5, 0.5, 0.5, 0.5], 2.03);
    expect(half[0]).toBeCloseTo(0.681, 3);
    expect(half[3]).toBe(0.5);
    // a gain of 1 leaves a pixel as it is
    const grey = scalePremultiplied([0.3, 0.2, 0.1, 0.6], 1);
    expect(grey[0]).toBeCloseTo(0.3, 12);
    expect(grey[2]).toBeCloseTo(0.1, 12);
  });

  it('keeps a tuned gain within 1 to 10, and falls back to the default', () => {
    expect(clampGain(2.5)).toBe(2.5);
    expect(clampGain(0.4)).toBe(1);
    expect(clampGain(50)).toBe(10);
    expect(clampGain(Number.NaN)).toBe(DEFAULT_HDR_OVERLAY_GAIN);
    expect(clampGain(undefined)).toBe(DEFAULT_HDR_OVERLAY_GAIN);
    expect(clampGain(Infinity)).toBe(DEFAULT_HDR_OVERLAY_GAIN);
  });
});
