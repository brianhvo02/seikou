// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { buildClpi } from '../../../../tests/helpers/bdmv-builders';
import { parseClpi, type Clpi } from '@seikou/bdmv/clpi-parser';
import { CodingType } from '@seikou/bdmv/stream-types';
import { elementQuery, elementQueryKey, frameRateOf, streamIsHdr } from './element-query';

type StreamOpts = { pid: number; codingType: number; dynamicRange?: number };

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

const hevc = (dynamicRange: number, pid = 0x1011): StreamOpts => ({ pid, codingType: CodingType.HEVC, dynamicRange });
const sps = (transfer: number | null) => ({ colour: transfer === null ? null : { primaries: 9, transfer, matrix: 9, fullRange: false } });

describe('streamIsHdr', () => {
  it('is true when the clip info says HDR10 or Dolby Vision', () => {
    expect(streamIsHdr([clip(hevc(1))], sps(1))).toBe(true);
    expect(streamIsHdr([clip(hevc(2))], null)).toBe(true);
  });

  it('is true when only the enhancement layer (0x1015) says Dolby Vision', () => {
    expect(streamIsHdr([clip(hevc(0), hevc(2, 0x1015))], sps(1))).toBe(true);
  });

  it('is true for an HEVC stream with no HDR in the clip info whose SPS says PQ or HLG', () => {
    expect(streamIsHdr([clip(hevc(0))], sps(16))).toBe(true);
    expect(streamIsHdr([clip(hevc(0))], sps(18))).toBe(true);
  });

  it('is false for SDR: no HDR in the clip info and an SPS without PQ or HLG', () => {
    expect(streamIsHdr([clip(hevc(0))], sps(1))).toBe(false);
    expect(streamIsHdr([clip(hevc(0))], sps(null))).toBe(false);
    expect(streamIsHdr([clip({ pid: 0x1011, codingType: CodingType.AVC })], null)).toBe(false);
    expect(streamIsHdr([], null)).toBe(false);
  });
});

describe('elementQuery', () => {
  const track = { codec: 'hvc1.2.4.L153.B0', width: 3840, height: 2160, colour: sps(16).colour, mastering: {} as never };

  it('carries the HDR facts, the coded size and the frame rate', () => {
    expect(elementQuery(track, [clip(hevc(1))], 1)).toEqual({
      codec: 'hvc1.2.4.L153.B0',
      hdr: { transfer: 'pq', mastering: true },
      width: 3840,
      height: 2160,
      frameRate: 24_000 / 1001,
    });
  });

  it('says hlg for an HLG SPS, no mastering without the SEI, and leaves out an unknown rate', () => {
    const q = elementQuery({ ...track, colour: sps(18).colour, mastering: null }, [clip(hevc(0))], 0);
    expect(q).toEqual({ codec: 'hvc1.2.4.L153.B0', hdr: { transfer: 'hlg', mastering: false }, width: 3840, height: 2160 });
  });

  it('a Dolby Vision clip with an SPS that names no transfer is PQ', () => {
    expect(elementQuery({ ...track, colour: null, mastering: null }, [clip(hevc(2))], 2).hdr).toEqual({ transfer: 'pq', mastering: false });
  });

  it('has no HDR facts for an SDR stream', () => {
    expect(elementQuery({ ...track, codec: 'avc1.640028', width: 1920, height: 1080, colour: null, mastering: null }, [clip(hevc(0))], 2).hdr).toBeNull();
  });
});

describe('elementQueryKey', () => {
  it('tells apart the codec, the HDR facts and the size', () => {
    const base = { codec: 'hvc1.2.4.L153.B0', hdr: null };
    const keys = [
      base,
      { ...base, codec: 'hvc1.2.4.L150.B0' },
      { ...base, hdr: { transfer: 'pq', mastering: true } as const },
      { ...base, hdr: { transfer: 'pq', mastering: false } as const },
      { ...base, hdr: { transfer: 'hlg', mastering: false } as const },
      { ...base, width: 3840, height: 2160 },
      { ...base, width: 3840, height: 2160, frameRate: 24 },
    ].map(elementQueryKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(elementQueryKey({ ...base, hdr: { transfer: 'pq', mastering: true } })).toBe(elementQueryKey({ codec: base.codec, hdr: { mastering: true, transfer: 'pq' } }));
  });
});

describe('frameRateOf', () => {
  it('maps the clip info rate codes to frames per second', () => {
    expect(frameRateOf(1)).toBeCloseTo(23.976, 3);
    expect(frameRateOf(2)).toBe(24);
    expect(frameRateOf(3)).toBe(25);
    expect(frameRateOf(4)).toBeCloseTo(29.97, 2);
    expect(frameRateOf(6)).toBe(50);
    expect(frameRateOf(7)).toBeCloseTo(59.94, 2);
    expect(frameRateOf(0)).toBeUndefined();
  });
});
