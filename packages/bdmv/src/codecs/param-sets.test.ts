// SPDX-License-Identifier: LGPL-3.0-or-later
import { PesAssembler } from '../demux/pes-assembler';
import { parseSourcePacket } from '../demux/ts-packet';
import { describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from '../../../../tests/helpers/fixture-disc';
import { VIDEO_PID } from '../../../../tests/helpers/synthetic-disc';
import { readHdrSei } from './hdr-sei';
import { findParameterSets, readAvcSps, readHevcSps, splitNalUnits } from './param-sets';

function firstAccessUnit(disc: string): Uint8Array {
  const m2ts = fixtureDiscFiles(disc).get('BDMV/STREAM/00001.m2ts')!;
  let first: Uint8Array | null = null;
  const asm = new PesAssembler((pes) => {
    if (pes.pid === VIDEO_PID) first ??= pes.payload;
  });
  for (let o = 0; o + 192 <= m2ts.length && !first; o += 192) {
    const pkt = parseSourcePacket(m2ts, o);
    if (pkt && pkt.pid === VIDEO_PID) asm.push(pkt);
  }
  if (!first) asm.flush();
  return first!;
}

const u = (n: number, v: number): string => v.toString(2).padStart(n, '0');
const ue = (v: number): string => { const b = (v + 1).toString(2); return '0'.repeat(b.length - 1) + b; };
const se = (v: number): string => ue(v > 0 ? 2 * v - 1 : -2 * v);

/** An HEVC SPS using every path before the VUI: two sub-layers, a conformance window, scaling list data, PCM, inter-predicted RPS and long-term pictures. */
function richHevcSps(): Uint8Array {
  const ptlGeneral = u(2, 0) + u(1, 0) + u(5, 2) + u(32, 0x20000000) + u(48, 0x900000000000) + u(8, 153);
  const ptlSub = u(1, 1) + u(1, 1) + u(2, 0).repeat(7) // sub-layer 0: profile and level present, then reserved_zero_2bits for i = 1..7
    + u(2, 0) + u(1, 0) + u(5, 2) + u(32, 0x20000000) + u(48, 0x900000000000) + u(8, 150);
  let scaling = '';
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
      if ((sizeId + matrixId) % 2 === 0) {
        scaling += '1';
        if (sizeId > 1) scaling += se(5);
        const n = Math.min(64, 1 << (4 + (sizeId << 1)));
        for (let i = 0; i < n; i++) scaling += se(((i * 7) % 11) - 5);
      } else scaling += '0' + ue(matrixId === 0 ? 0 : 1);
    }
  }
  const rps0 = ue(2) + ue(1) + (ue(0) + '1') + (ue(1) + '0') + (ue(0) + '1'); // 2 negative, 1 positive
  const rps1 = '1' + '0' + ue(0) + '1' + '01' + '1' + '00'; // predicted from rps0 with +1: -1 becomes 0 and is dropped, leaving -2 and +2
  const rps2 = '1' + '1' + ue(1) + '1' + '1' + '01'; // predicted from rps1, whose 0 difference was dropped: 2 entries, 3 flags
  const body = u(4, 0) + u(3, 1) + u(1, 1) + ptlGeneral + ptlSub
    + ue(0) + ue(1) + ue(1928) + ue(1088) + '1' + ue(2) + ue(2) + ue(0) + ue(4) // 1928x1088 less 4+4 by 0+8
    + ue(2) + ue(2) // 10-bit
    + ue(4) // log2_max_pic_order_cnt_lsb_minus4 → 8 bits
    + '1' + (ue(4) + ue(2) + ue(0)) + (ue(5) + ue(3) + ue(1))
    + ue(0) + ue(3) + ue(0) + ue(3) + ue(2) + ue(2)
    + '1' + '1' + scaling
    + '1' + '1'
    + '1' + u(4, 7) + u(4, 7) + ue(0) + ue(1) + '0' // PCM
    + ue(3) + rps0 + rps1 + rps2
    + '1' + ue(2) + (u(8, 17) + '1') + (u(8, 200) + '0') // long-term pictures
    + '1' + '1'
    + '1' // VUI
    + '1' + u(8, 255) + u(16, 16) + u(16, 11)
    + '0'
    + '1' + u(3, 5) + '0' + '1' + u(8, 9) + u(8, 16) + u(8, 9)
    + '0000000' + '0'; // the rest of the VUI off, then sps_extension_present_flag
  return nal([0x42, 0x01], body);
}

/** A NAL unit with `header` and the RBSP `body` (a bit string), trailing bits and emulation prevention added. */
function nal(header: number[], body: string): Uint8Array {
  const bits = body + '1';
  const rbsp = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i] === '1') rbsp[i >> 3] |= 0x80 >> (i & 7);
  const out = [...header];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array(out);
}

describe('parameter sets', () => {
  it('reads the HEVC parameter sets and SPS facts of the HDR disc', () => {
    const sets = findParameterSets(firstAccessUnit('disc-hdr'), 'hevc');
    expect([sets.vps.length, sets.sps.length, sets.pps.length]).toEqual([1, 1, 1]);
    expect(readHevcSps(sets.sps[0])).toMatchObject({
      profileIdc: 2, chromaFormatIdc: 1, bitDepthLuma: 10, bitDepthChroma: 10, width: 1920, height: 1080,
    });
    expect(readHevcSps(sets.sps[0])).toMatchObject({ colour: { primaries: 9, transfer: 16, matrix: 9, fullRange: false }, sar: { width: 1, height: 1 } });
  });

  it('reads the HDR SEI x265 was given for the HDR disc', () => {
    expect(readHdrSei(splitNalUnits(firstAccessUnit('disc-hdr')))).toEqual({
      mastering: { primaries: [[13250, 34500], [7500, 3000], [34000, 16000]], whitePoint: [15635, 16450], maxLuminance: 10000000, minLuminance: 1 },
      light: { maxCll: 1000, maxFall: 400 },
    });
  });

  it('reads the H.264 SPS facts of disc1 (640x360, cropped from 368)', () => {
    const sets = findParameterSets(firstAccessUnit('disc1'), 'avc');
    expect(sets.sps.length).toBe(1);
    expect(sets.pps.length).toBe(1);
    expect(readAvcSps(sets.sps[0])).toMatchObject({ profileIdc: 100, chromaFormatIdc: 1, bitDepthLuma: 8, bitDepthChroma: 8, width: 640, height: 360 });
    const info = readAvcSps(sets.sps[0]);
    expect(info.sar).toEqual({ width: 1, height: 1 });
    // libx264 writes no colour description unless asked (ffprobe: unknown primaries, transfer and matrix)
    expect(info.colour).toBeNull();
  });

  it('reads an explicit sample aspect ratio and colour description from an H.264 VUI', () => {
    const head = '01000010' + '00000000' + '00011110' + '1' + '1' + '011' + '010' + '0' + '1' + '1' + '1' + '1' + '0';
    const ar = '1' + '11111111' + (4).toString(2).padStart(16, '0') + (3).toString(2).padStart(16, '0');
    const sig = '0' + '1' + '101' + '1' + '1' + (1).toString(2).padStart(8, '0') + (13).toString(2).padStart(8, '0') + (6).toString(2).padStart(8, '0');
    const bits = head + '1' + ar + sig + '1';
    const bytes = new Uint8Array(Math.ceil(bits.length / 8) + 1);
    bytes[0] = 0x67;
    for (let i = 0; i < bits.length; i++) if (bits[i] === '1') bytes[1 + (i >> 3)] |= 0x80 >> (i & 7);
    expect(readAvcSps(bytes)).toMatchObject({ width: 16, height: 16, sar: { width: 4, height: 3 }, colour: { primaries: 1, transfer: 13, matrix: 6, fullRange: true } });
  });

  it('reads the VUI of an HEVC SPS past sub-layers, scaling list data, PCM, predicted short-term and long-term reference pictures', () => {
    // the same bits through ffmpeg's trace_headers give 1928x1088 with a 2, 2, 0, 4 window, SAR 16:11 and 9/16/9
    expect(readHevcSps(richHevcSps())).toMatchObject({
      width: 1920, height: 1080, bitDepthLuma: 10, levelIdc: 153,
      sar: { width: 16, height: 11 }, colour: { primaries: 9, transfer: 16, matrix: 9, fullRange: false },
    });
  });

  it('splits Annex B units', () => {
    const units = splitNalUnits(new Uint8Array([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x67, 0x64]));
    expect(units.map((u) => Array.from(u))).toEqual([[0x09, 0xf0], [0x67, 0x64]]);
  });
});
