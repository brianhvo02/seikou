// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { bestDynamicRange } from './dynamic-range';

describe('bestDynamicRange', () => {
  it('prefers Dolby Vision, then HDR10+, then HDR10', () => {
    expect(bestDynamicRange(['hdr10', 'dv', 'hdr10plus'])).toBe('dv');
    expect(bestDynamicRange([null, 'hdr10', 'hdr10plus'])).toBe('hdr10plus');
    expect(bestDynamicRange([undefined, 'hdr10', null])).toBe('hdr10');
  });

  it('is null for none, SDR and missing values', () => {
    expect(bestDynamicRange([])).toBeNull();
    expect(bestDynamicRange([null, undefined])).toBeNull();
  });
});
