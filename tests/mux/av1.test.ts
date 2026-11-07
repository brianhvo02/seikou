// SPDX-License-Identifier: LGPL-3.0-or-later
import { createReadStream } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitObus, ObuType } from '../../src/mux/av1';
import { BitReader } from '../../src/mux/bit-reader';
import { readIvf } from '../../src/mux/ivf';

describe('av1', () => {
  it('parses the sequence header and builds av1C', async () => {
    const { info, av1C } = await (await readIvf(createReadStream('fixtures/small.ivf')))
      .sequenceHeader;
    expect(info).toMatchObject({
      seqProfile: 0,
      highBitdepth: true,
      twelveBit: false,
      monoChrome: false,
      subsamplingX: 1,
      subsamplingY: 1,
    });
    expect(av1C[0]).toBe(0x81);
    expect(av1C[1]).toBe(info.seqLevelIdx0); // profile 0 in the top bits
    expect(av1C[2]).toBe((info.seqTier0 << 7) | 0x40 | 0x08 | 0x04 | info.chromaSamplePosition);
    expect(av1C[3]).toBe(0);
    expect(av1C.length).toBeGreaterThan(8);
  });

  it('splits a temporal unit into OBUs', () => {
    // TD (type 2, has_size, size 0) + padding (type 15, has_size, size 2)
    const tu = new Uint8Array([0x12, 0x00, 0x7a, 0x02, 0xaa, 0xbb]);
    const obus = splitObus(tu);
    expect(obus.map((o) => o.type)).toEqual([ObuType.TEMPORAL_DELIMITER, ObuType.PADDING]);
    expect(Array.from(obus[1]!.header)).toEqual([0x7a, 0x02]);
    expect(Array.from(obus[1]!.payload)).toEqual([0xaa, 0xbb]);
  });
});

describe('BitReader', () => {
  it('f, uvlc, leb128', () => {
    expect(new BitReader(new Uint8Array([0b10100000])).f(3)).toBe(5);
    expect(new BitReader(new Uint8Array([0b00100000])).uvlc()).toBe(3);
    expect(new BitReader(new Uint8Array([0xe5, 0x8e, 0x26])).leb128()).toBe(624485);
  });
});
