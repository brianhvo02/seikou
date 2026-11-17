// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { readHdrSei } from './hdr-sei';

function be(n: number, bytes: number): number[] {
  const out: number[] = [];
  for (let i = bytes - 1; i >= 0; i--) out.push(Math.floor(n / 256 ** i) & 0xff);
  return out;
}

function sei(...messages: [number, number[]][]): Uint8Array {
  const body = messages.flatMap(([type, payload]) => [type, payload.length, ...payload]);
  return new Uint8Array([0x4e, 0x01, ...body, 0x80]);
}

const MASTERING = [
  ...[13250, 34500, 7500, 3000, 34000, 16000, 15635, 16450].flatMap((v) => be(v, 2)),
  ...be(10000000, 4),
  ...be(1, 4),
];

describe('readHdrSei', () => {
  it('reads the mastering display and content light level', () => {
    expect(readHdrSei([sei([137, MASTERING], [144, [...be(1000, 2), ...be(400, 2)]])])).toEqual({
      mastering: { primaries: [[13250, 34500], [7500, 3000], [34000, 16000]], whitePoint: [15635, 16450], maxLuminance: 10000000, minLuminance: 1 },
      light: { maxCll: 1000, maxFall: 400 },
    });
  });

  it('gives nulls without those messages', () => {
    expect(readHdrSei([sei([5, [1, 2, 3]]), new Uint8Array([0x40, 0x01, 0x00])])).toEqual({ mastering: null, light: null });
  });

  it('removes emulation prevention bytes inside a payload', () => {
    // maxCll 0 and maxFall 3 code as 00 00 00 03; the encoder escapes the 00 00 00 as 00 00 03 00.
    const escaped = new Uint8Array([0x4e, 0x01, 144, 4, 0x00, 0x00, 0x03, 0x00, 0x03, 0x80]);
    expect(readHdrSei([escaped]).light).toEqual({ maxCll: 0, maxFall: 3 });
  });
});
