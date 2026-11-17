import { describe, expect, it } from 'vitest';
import { INTERLACED_SPS, PROGRESSIVE_SPS, TEST_PPS, TEST_SPS, avcAu } from '../../../../tests/helpers/h264-units';
import { ParseError } from '../byte-reader';
import { execFileSync } from 'node:child_process';
import { encodeTestVideo, splitAccessUnits } from '../../../../scripts/x264';
import { analyzeAvc, avcCodecString, avcIsInterlaced, avcPicStruct, avcPpsId, avcTiming } from './h264';
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

describe('H.264 picture structure', () => {
  const picStructs = (aus: Uint8Array[]): (number | null)[] => {
    const timing = avcTiming(analyzeAvc(aus[0]).sps as Uint8Array);
    return aus.map((au) => avcPicStruct(au, timing));
  };
  const encode = (params: string): Uint8Array[] =>
    encodeTestVideo(12, '320x180', ['-x264-params', params], '30000/1001');

  it('reads pic_struct 3 (top field, then bottom) from top-field-first interlaced units', () => {
    const aus = encode('interlaced=1:tff=1:pic-struct=1');
    expect(avcTiming(analyzeAvc(aus[0]).sps as Uint8Array).picStructPresent).toBe(true);
    expect(picStructs(aus)).toEqual(Array(12).fill(3));
  });

  it('reads pic_struct 4 (bottom field, then top) from bottom-field-first interlaced units', () => {
    expect(picStructs(encode('interlaced=1:bff=1:pic-struct=1'))).toEqual(Array(12).fill(4));
  });

  it('gives null for a progressive stream written without picture timing', () => {
    const aus = encode('pic-struct=0');
    expect(avcTiming(analyzeAvc(aus[0]).sps as Uint8Array).picStructPresent).toBe(false);
    expect(picStructs(aus)).toEqual(Array(12).fill(null));
  });

  it('reads the repeating soft pulldown sequence 5 4 6 3 that the x264 command line writes', () => {
    // ffmpeg's libx264 ignores pulldown, so the standalone encoder makes the stream; ffprobe reports the same
    // (top_field_first, repeat_pict) per frame: (1,1) (0,0) (0,1) (1,0).
    const y4m = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24000/1001',
      '-frames:v', '12', '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', '-'], { maxBuffer: 1 << 28 });
    const h264 = execFileSync('x264', ['--demuxer', 'y4m', '--profile', 'high', '--crf', '30', '--keyint', '24', '--bframes', '0',
      '--aud', '--pulldown', '32', '--pic-struct', '--output', '-', '-'], { input: y4m, maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'ignore'] });
    const aus = splitAccessUnits(new Uint8Array(h264));
    expect(picStructs(aus)).toEqual([5, 4, 6, 3, 5, 4, 6, 3, 5, 4, 6, 3]);
  });

  it('skips the HRD delays before pic_struct when the SPS carries HRD parameters', () => {
    const aus = encode('interlaced=1:tff=1:pic-struct=1:nal-hrd=vbr:bitrate=2000:vbv-maxrate=2000:vbv-bufsize=2000');
    const timing = avcTiming(analyzeAvc(aus[0]).sps as Uint8Array);
    expect(timing.hrdPresent).toBe(true);
    expect(picStructs(aus)).toEqual(Array(12).fill(3));
  });
});
