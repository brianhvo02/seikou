// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ascii, uint, vint, vintFixed8, voidElement } from '../../src/mux/ebml';
import { Id } from '../../src/mux/mkv-ids';

describe('ebml', () => {
  it('encodes vints and elements', () => {
    expect([...vint(8)]).toEqual([0x88]);
    expect([...vint(127)]).toEqual([0x40, 0x7f]);
    expect([...vint(300)]).toEqual([0x41, 0x2c]);
    expect([...vintFixed8(5)]).toEqual([0x01, 0, 0, 0, 0, 0, 0, 0x05]);
    expect([...uint(Id.TrackNumber, 1)]).toEqual([0xd7, 0x81, 0x01]);
    expect([...ascii(Id.CodecID, 'V_AV1')]).toEqual([0x86, 0x85, 0x56, 0x5f, 0x41, 0x56, 0x31]);
    expect(voidElement(10)).toHaveLength(10);
  });
});
