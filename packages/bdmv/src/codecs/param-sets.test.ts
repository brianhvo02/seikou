// SPDX-License-Identifier: LGPL-3.0-or-later
import { PesAssembler } from '../demux/pes-assembler';
import { parseSourcePacket } from '../demux/ts-packet';
import { describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from '../../../../tests/helpers/fixture-disc';
import { VIDEO_PID } from '../../../../tests/helpers/synthetic-disc';
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
  });

  it('reads the H.264 SPS facts of disc1 (640x360, cropped from 368)', () => {
    const sets = findParameterSets(firstAccessUnit('disc1'), 'avc');
    expect(sets.sps.length).toBe(1);
    expect(sets.pps.length).toBe(1);
    expect(readAvcSps(sets.sps[0])).toMatchObject({ profileIdc: 100, width: 640, height: 360 });
  });

  it('splits Annex B units', () => {
    const units = splitNalUnits(new Uint8Array([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x67, 0x64]));
    expect(units.map((u) => Array.from(u))).toEqual([[0x09, 0xf0], [0x67, 0x64]]);
  });
});
