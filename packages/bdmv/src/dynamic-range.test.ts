// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { buildClpi } from '../../../tests/helpers/bdmv-builders';
import { parseClpi, type Clpi } from './clpi-parser';
import { dynamicRangeOf } from './dynamic-range';
import { CodingType } from './stream-types';

type StreamOpts = { pid: number; codingType: number; dynamicRange?: number; hdrPlus?: boolean };

function clip(...streams: StreamOpts[]): Clpi {
  return parseClpi(
    buildClpi({
      numSourcePackets: 1000,
      streams,
      presentationStart: 0,
      presentationEnd: 450_000,
      epMaps: [{ pid: streams[0]!.pid, entries: [{ pts: 0, spn: 0 }] }],
    }),
  );
}

const hevc = (dynamicRange: number, hdrPlus = false, pid = 0x1011): StreamOpts => ({ pid, codingType: CodingType.HEVC, dynamicRange, hdrPlus });

describe('dynamicRangeOf', () => {
  it('is null for no clips, an SDR HEVC clip and an H.264 clip', () => {
    expect(dynamicRangeOf([])).toBeNull();
    expect(dynamicRangeOf([clip(hevc(0))])).toBeNull();
    expect(dynamicRangeOf([clip({ pid: 0x1011, codingType: CodingType.AVC })])).toBeNull();
  });

  it('reads HDR10 and HDR10+', () => {
    expect(dynamicRangeOf([clip(hevc(1))])).toBe('hdr10');
    expect(dynamicRangeOf([clip(hevc(1, true))])).toBe('hdr10plus');
  });

  it('is Dolby Vision when a later clip carries the enhancement layer behind an HDR10 base layer', () => {
    expect(dynamicRangeOf([clip(hevc(1)), clip(hevc(1), hevc(2, false, 0x1015))])).toBe('dv');
  });

  it('prefers Dolby Vision over HDR10+ across clips', () => {
    expect(dynamicRangeOf([clip(hevc(1, true)), clip(hevc(2))])).toBe('dv');
  });
});
