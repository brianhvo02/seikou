import { describe, expect, it } from 'vitest';
import { INTERLACED_SPS, PROGRESSIVE_SPS, TEST_PPS, TEST_SPS, avcAu } from '../../../tests/helpers/h264-units';
import { ParseError } from '@seikou/bdmv/byte-reader';
import { analyzeAvc, avcCodecString, avcIsInterlaced, avcPpsId } from './h264';
import { splitAnnexB } from './nal';

describe('H.264 analysis', () => {
  it('rejects a truncated SPS instead of producing a bogus codec string', () => {
    expect(() => avcCodecString(new Uint8Array([0x67, 0x64]))).toThrow(ParseError);
  });

  it('derives the codec string from the SPS', () => {
    expect(avcCodecString(TEST_SPS)).toBe('avc1.640028');
  });

  it('marks IDR access units as key and returns the SPS', () => {
    const info = analyzeAvc(avcAu({ idr: true }));
    expect(info.key).toBe(true);
    expect(info.idr).toBe(true);
    expect(Array.from(info.sps ?? [])).toEqual(Array.from(TEST_SPS));
  });

  it('marks recovery-point I-frames as key but not IDR', () => {
    const info = analyzeAvc(avcAu({ recovery: true, sps: true }));
    expect(info.key).toBe(true);
    expect(info.idr).toBe(false);
  });

  it('marks plain slices as non-key', () => {
    const info = analyzeAvc(avcAu());
    expect(info.key).toBe(false);
    expect(info.sps).toBeNull();
  });

  it('strips MVC NAL units (types 14, 15, 20)', () => {
    const info = analyzeAvc(avcAu({ idr: true, mvc: true }));
    const types = splitAnnexB(info.data).map((n) => n[0] & 0x1f);
    expect(types).toEqual([9, 7, 8, 5]);
  });

  it('returns the original buffer when there is nothing to strip', () => {
    const au = avcAu({ idr: true });
    expect(analyzeAvc(au).data).toBe(au);
  });

  it('reads frame_mbs_only_flag: an interlaced (MBAFF) SPS', () => {
    expect(avcIsInterlaced(INTERLACED_SPS)).toBe(true);
  });

  it('reads frame_mbs_only_flag: a progressive SPS', () => {
    expect(avcIsInterlaced(PROGRESSIVE_SPS)).toBe(false);
  });

  it('treats an SPS too short to read the flag as progressive', () => {
    expect(avcIsInterlaced(TEST_SPS)).toBe(false);
  });

  it('returns the PPS NAL units of the access unit', () => {
    expect(analyzeAvc(avcAu({ idr: true })).pps.map((n) => Array.from(n))).toEqual([TEST_PPS]);
    expect(analyzeAvc(avcAu()).pps).toEqual([]);
  });

  it('reads pic_parameter_set_id', () => {
    expect(avcPpsId(new Uint8Array([0x68, 0xee, 0x35, 0x25]))).toBe(0);
    expect(avcPpsId(new Uint8Array([0x68, 0x5e, 0x3c, 0xb0]))).toBe(1);
    expect(avcPpsId(new Uint8Array([0x68]))).toBeNull();
  });
});
