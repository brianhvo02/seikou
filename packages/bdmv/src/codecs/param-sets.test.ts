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
    expect(info.colour === null || typeof info.colour.transfer === 'number').toBe(true);
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

  it('splits Annex B units', () => {
    const units = splitNalUnits(new Uint8Array([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x67, 0x64]));
    expect(units.map((u) => Array.from(u))).toEqual([[0x09, 0xf0], [0x67, 0x64]]);
  });
});
