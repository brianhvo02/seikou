import { describe, expect, it } from 'vitest';
import { joinAnnexB, splitAnnexB, unescapeRbsp } from './nal';

describe('NAL helpers', () => {
  it('splits 3- and 4-byte start codes and trims trailing zeros', () => {
    const data = new Uint8Array([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x67, 0x64, 0x00, 0, 0, 0, 1, 0x65, 0x88]);
    expect(splitAnnexB(data).map((n) => Array.from(n))).toEqual([[0x09, 0xf0], [0x67, 0x64], [0x65, 0x88]]);
  });

  it('removes emulation prevention bytes', () => {
    expect(Array.from(unescapeRbsp(new Uint8Array([1, 0, 0, 3, 0, 0, 0, 3, 1, 0, 0, 3])))).toEqual([1, 0, 0, 0, 0, 0, 1, 0, 0]);
  });

  it('joins NAL units with 4-byte start codes', () => {
    const joined = joinAnnexB([new Uint8Array([0x09, 0xf0]), new Uint8Array([0x65])]);
    expect(Array.from(joined)).toEqual([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x65]);
    expect(splitAnnexB(joined).length).toBe(2);
  });
});
