// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { hdrOverlayOptions } from './hdr-overlay-flags';

describe('hdrOverlayOptions', () => {
  it('reads the gain and the test-only display flag', () => {
    expect(hdrOverlayOptions('')).toEqual({});
    expect(hdrOverlayOptions('?hdrgain=2.5')).toEqual({ gain: 2.5 });
    expect(hdrOverlayOptions('?hdrgain=&displayhdr=1')).toEqual({ displayHdr: true });
    expect(hdrOverlayOptions('?hdrgain=bright&displayhdr=0')).toEqual({});
  });
});
