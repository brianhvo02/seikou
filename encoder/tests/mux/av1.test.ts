// SPDX-License-Identifier: LGPL-3.0-or-later
import { createReadStream } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSequenceHeader, splitObus, ObuType } from '../../src/mux/av1';
import { BitReader } from '../../src/mux/bit-reader';
import { readIvf } from '../../src/mux/ivf';
import { fx } from '../paths';

describe('av1', () => {
  it('parses the sequence header and builds av1C', async () => {
    const { info, av1C } = await (await readIvf(createReadStream(fx('fixtures/small.ivf'))))
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

class BitWriter {
  private bits: number[] = [];
  f(n: number, value: number): this {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
    return this;
  }
  uvlc(value: number): this {
    const v = value + 1;
    const len = Math.floor(Math.log2(v));
    return this.f(len, 0).f(len + 1, v);
  }
  leb128(value: number): this {
    let v = value;
    do {
      const byte = v & 0x7f;
      v = Math.floor(v / 128);
      this.f(8, v > 0 ? byte | 0x80 : byte);
    } while (v > 0);
    return this;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => {
      out[i >> 3]! |= b << (7 - (i & 7));
    });
    return out;
  }
}

/** Writes everything from frame_width_bits to enable_restoration for a simple non-reduced header. */
function commonTools(w: BitWriter): void {
  w.f(4, 7).f(4, 7).f(8, 63).f(8, 63); // frame size bits and max sizes
  w.f(1, 0); // frame_id_numbers_present_flag
  w.f(3, 0); // 128 sb, filter intra, intra edge
  w.f(4, 0); // interintra, masked, warped, dual filter
  w.f(1, 0); // enable_order_hint
  w.f(1, 1).f(1, 1); // seq_choose_screen_content_tools, then seq_choose_integer_mv
  w.f(1, 1).f(1, 1); // superres, cdef (then restoration below)
  w.f(1, 1);
}

describe('parseSequenceHeader branches', () => {
  it('handles timing info, decoder model, operating points and screen content tools', () => {
    const w = new BitWriter();
    w.f(3, 0).f(1, 0).f(1, 0); // profile 0, still_picture, reduced
    w.f(1, 1); // timing_info_present_flag
    w.f(32, 1001).f(32, 24000).f(1, 1).uvlc(5); // timing_info with equal_picture_interval
    w.f(1, 1); // decoder_model_info_present_flag
    w.f(5, 9).f(32, 7).f(5, 4).f(5, 6); // buffer_delay_length_minus_1 = 9 (10 bit delays)
    w.f(1, 1); // initial_display_delay_present_flag
    w.f(5, 1); // operating_points_cnt_minus_1
    w.f(12, 0x101).f(5, 12).f(1, 1); // op 0: level 12, tier 1
    w.f(1, 1).f(10, 0x155).f(10, 0x2aa).f(1, 1); // decoder_model_present, op params
    w.f(1, 0); // initial_display_delay_present_for_this_op = 0
    w.f(12, 0x001).f(5, 3); // op 1: level 3, no tier bit
    w.f(1, 0); // decoder_model_present_for_this_op = 0
    w.f(1, 1).f(4, 5); // initial display delay present, value
    w.f(4, 7).f(4, 7).f(8, 63).f(8, 63);
    w.f(1, 1).f(4, 3).f(3, 2); // frame_id_numbers_present_flag and its fields
    w.f(3, 0); // 128 sb, filter intra, intra edge
    w.f(4, 0); // interintra, masked, warped, dual filter
    w.f(1, 1).f(1, 1).f(1, 0); // enable_order_hint, jnt_comp, ref_frame_mvs
    w.f(1, 0).f(1, 1); // seq_choose_screen_content_tools = 0, seq_force = 1
    w.f(1, 0).f(1, 1); // seq_choose_integer_mv = 0, seq_force_integer_mv = 1
    w.f(3, 6); // order_hint_bits_minus_1
    w.f(3, 0); // superres, cdef, restoration
    w.f(1, 0); // high_bitdepth
    w.f(1, 0); // mono_chrome
    w.f(1, 0); // color_description_present_flag
    w.f(1, 1); // color_range
    w.f(2, 2); // chroma_sample_position
    const info = parseSequenceHeader(w.bytes());
    expect(info).toMatchObject({
      seqProfile: 0,
      seqLevelIdx0: 12,
      seqTier0: 1,
      highBitdepth: false,
      twelveBit: false,
      monoChrome: false,
      subsamplingX: 1,
      subsamplingY: 1,
      chromaSamplePosition: 2,
      reducedStillPictureHeader: false,
    });
  });

  function colorHeader(primaries: number, transfer: number, matrix: number): BitWriter {
    const w = new BitWriter();
    w.f(3, 0).f(1, 0).f(1, 0).f(1, 0); // profile 0, not reduced, no timing info
    w.f(1, 0).f(5, 0); // initial_display_delay_present, one operating point
    w.f(12, 0).f(5, 4); // idc, level 4
    commonTools(w);
    w.f(1, 1); // high_bitdepth
    w.f(1, 0); // mono_chrome
    w.f(1, 1).f(8, primaries).f(8, transfer).f(8, matrix);
    return w;
  }

  it('sRGB identity matrix: 4:4:4 and no color_range or chroma_sample_position bits', () => {
    const w = colorHeader(1, 13, 0);
    const bytes = w.bytes();
    // Trim any padding bytes: the last byte holds the end of the matrix field, and nothing follows.
    const info = parseSequenceHeader(bytes);
    expect(info).toMatchObject({ subsamplingX: 0, subsamplingY: 0, chromaSamplePosition: 0 });
  });

  it('sRGB-like primaries and transfer with BT.709 matrix reads color_range and position', () => {
    const w = colorHeader(1, 13, 1);
    w.f(1, 1); // color_range
    w.f(2, 3); // chroma_sample_position
    const info = parseSequenceHeader(w.bytes());
    expect(info).toMatchObject({ subsamplingX: 1, subsamplingY: 1, chromaSamplePosition: 3 });
    expect(info.highBitdepth).toBe(true);
  });

  it('reduced_still_picture_header', () => {
    const w = new BitWriter();
    w.f(3, 0).f(1, 1).f(1, 1); // profile 0, still_picture, reduced
    w.f(5, 9); // seq_level_idx[0]
    w.f(4, 7).f(4, 7).f(8, 63).f(8, 63);
    w.f(3, 0); // 128 sb, filter intra, intra edge
    w.f(3, 0); // superres, cdef, restoration
    w.f(1, 0).f(1, 0).f(1, 0); // high_bitdepth, mono_chrome, color_description_present
    w.f(1, 0).f(2, 1); // color_range, chroma_sample_position
    const info = parseSequenceHeader(w.bytes());
    expect(info).toMatchObject({
      reducedStillPictureHeader: true,
      seqLevelIdx0: 9,
      seqTier0: 0,
      chromaSamplePosition: 1,
    });
  });
});
