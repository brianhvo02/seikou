import { describe, expect, it } from 'vitest';
import { ParseError } from '../byte-reader';
import { analyzeHevc, hevcCodecString, hevcCodecStrings } from './hevc';

// Escaped SPS prefixes (emulation-prevention bytes included, as on disc).
const MAIN_SPS = new Uint8Array([0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0x90, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x00, 0x5d]);
const MAIN10_SPS = new Uint8Array([0x42, 0x01, 0x01, 0x02, 0x20, 0x00, 0x00, 0x03, 0x00, 0x90, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x00, 0x78]);

function au(...nals: number[][]): Uint8Array {
  return new Uint8Array(nals.flatMap((n) => [0, 0, 0, 1, ...n]));
}

describe('HEVC analysis', () => {
  it('rejects a truncated SPS instead of producing a bogus codec string', () => {
    expect(() => hevcCodecString(MAIN_SPS.subarray(0, 10))).toThrow(ParseError);
  });

  it('derives codec strings from escaped SPS bytes', () => {
    expect(hevcCodecString(MAIN_SPS)).toBe('hev1.1.6.L93.90');
    expect(hevcCodecString(MAIN10_SPS)).toBe('hev1.2.4.L120.90');
  });

  it('offers the hvc1 form before the hev1 form', () => {
    const expected = 'hev1.1.6.L93.90';
    expect(hevcCodecStrings(MAIN_SPS)).toEqual([expected.replace(/^hev1/, 'hvc1'), expected]);
  });

  it('classifies IRAP pictures', () => {
    const idr = analyzeHevc(au([0x46, 0x01, 0x10], Array.from(MAIN_SPS), [0x26, 0x01, 0xaf]));
    expect(idr).toMatchObject({ key: true, idr: true });
    expect(idr.sps?.[0]).toBe(0x42);
    expect(analyzeHevc(au([0x2a, 0x01, 0xaf]))).toMatchObject({ key: true, idr: false });
    expect(analyzeHevc(au([0x02, 0x01, 0xd0]))).toMatchObject({ key: false, idr: false, sps: null });
  });
});
