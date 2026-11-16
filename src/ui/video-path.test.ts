// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { initialVideoPath } from './video-path';

describe('initialVideoPath', () => {
  it('is auto without the flag, so HDR streams take the video element', () => {
    expect(initialVideoPath(new URLSearchParams(''))).toBe('auto');
  });

  it('takes ?videopath= when it names a path, and ignores anything else', () => {
    expect(initialVideoPath(new URLSearchParams('videopath=element'))).toBe('element');
    expect(initialVideoPath(new URLSearchParams('videopath=canvas'))).toBe('canvas');
    expect(initialVideoPath(new URLSearchParams('videopath=auto'))).toBe('auto');
    expect(initialVideoPath(new URLSearchParams('videopath=webgl'))).toBe('auto');
  });
});
