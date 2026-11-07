import { describe, expect, it } from 'vitest';
import { contentHash, md5Hex } from './content-hash';

describe('md5Hex', () => {
  it('matches the RFC 1321 test suite', () => {
    const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);
    expect(md5Hex(ascii(''))).toBe('D41D8CD98F00B204E9800998ECF8427E');
    expect(md5Hex(ascii('abc'))).toBe('900150983CD24FB0D6963F7D28E17F72');
    expect(md5Hex(ascii('12345678901234567890123456789012345678901234567890123456789012345678901234567890'))).toBe('57EDF4A22BE3C955AC49DA2E2107B67A');
  });
});

describe('contentHash', () => {
  it('hashes one size as an int64 little-endian, as the reference C# does', () => {
    // MD5 of 01 00 00 00 00 00 00 00 (BitConverter.GetBytes(1L)), as HashingExtensions.CalculateHash returns it.
    expect(contentHash([{ name: '00000.m2ts', size: 1 }])).toBe('33CDECCCCEBE80329F1FDBEE7F5874CB');
  });

  it('matches a TheDiscDB manifest, whatever order the files come in', () => {
    // TheDiscDb/data: data/movie/What Dreams May Come (1998)/2026-collectors-edition-shout-select/disc01.odm.json
    const streams = [
      { name: '00005.m2ts', size: 82648774656 },
      { name: '00001.m2ts', size: 259405824 },
      { name: '00003.m2ts', size: 93431808 },
    ];
    expect(contentHash(streams)).toBe('052D14F335879C7C054068C6229E0FD5');
  });

  it('ignores files other than .m2ts and orders by the upper-cased name', () => {
    const a = contentHash([
      { name: '00001.M2TS', size: 259405824 },
      { name: '00003.m2ts', size: 93431808 },
      { name: '00005.m2ts', size: 82648774656 },
      { name: '00002.ssif', size: 7 },
    ]);
    expect(a).toBe('052D14F335879C7C054068C6229E0FD5');
  });

  it('throws for a size that is not a safe non-negative integer', () => {
    for (const size of [-1, 1.5, 2 ** 53, Number.NaN, Infinity]) expect(() => contentHash([{ name: '00001.m2ts', size }]), String(size)).toThrow(RangeError);
    expect(contentHash([{ name: '00001.m2ts', size: 2 ** 53 - 1 }])).toMatch(/^[0-9A-F]{32}$/);
  });

  it('is null without .m2ts files', () => {
    expect(contentHash([])).toBeNull();
    expect(contentHash([{ name: 'index.bdmv', size: 10 }])).toBeNull();
  });
});
