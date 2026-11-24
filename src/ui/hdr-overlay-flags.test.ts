// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { hdrOverlayOptions } from './hdr-overlay-flags';

describe('hdrOverlayOptions', () => {
  it('reads the gain', () => {
    expect(hdrOverlayOptions('')).toEqual({});
    expect(hdrOverlayOptions('?telemetry=1&hdrgain=2.5')).toEqual({ gain: 2.5 });
    expect(hdrOverlayOptions('?hdrgain=')).toEqual({});
    expect(hdrOverlayOptions('?hdrgain=bright')).toEqual({});
  });
});
