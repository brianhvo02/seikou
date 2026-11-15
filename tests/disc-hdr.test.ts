import { analyzeHevc, hevcCodecStrings } from '@seikou/bdmv/codecs/hevc';
import { parseClpi } from '@seikou/bdmv/clpi-parser';
import { PesAssembler } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import { CodingType } from '@seikou/bdmv/stream-types';
import { describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from './helpers/fixture-disc';
import { VIDEO_PID } from './helpers/synthetic-disc';

/**
 * The offset of a stream's attribute block (its coding type byte) in a CLPI, found by walking the layout the parser
 * reads: the ProgramInfo start address at byte 12, then each program's streams as PID (2), length (1) and attributes.
 */
function streamAttributeOffset(clpi: Uint8Array, pid: number): number {
  const view = new DataView(clpi.buffer, clpi.byteOffset, clpi.byteLength);
  let o = view.getUint32(12);
  o += 4 + 1; // length, reserved
  const programs = view.getUint8(o++);
  for (let p = 0; p < programs; p++) {
    o += 4 + 2; // spn_program_sequence_start, program_map_pid
    const streams = view.getUint8(o++);
    o++; // num_groups
    for (let s = 0; s < streams; s++) {
      const streamPid = view.getUint16(o);
      const length = view.getUint8(o + 2);
      if (streamPid === pid) return o + 3;
      o += 3 + length;
    }
  }
  throw new Error(`no stream with PID ${pid}`);
}

describe('the HDR synthetic disc', () => {
  it('is an HDR10 HEVC Main10 disc', () => {
    const files = fixtureDiscFiles('disc-hdr');
    const clpiBytes = files.get('BDMV/CLIPINF/00001.clpi')!;
    const clpi = parseClpi(clpiBytes);
    const video = clpi.programs[0].streams.find((s) => s.pid === VIDEO_PID)!;
    expect(video.codingType).toBe(CodingType.HEVC);

    // dynamic_range_type (high nibble) and color_space (low nibble) are the third byte after the coding type, as
    // libbluray's _parse_stream_attr reads them.
    const attr = streamAttributeOffset(clpiBytes, VIDEO_PID);
    expect(clpiBytes[attr]).toBe(CodingType.HEVC);
    const byte2 = clpiBytes[attr + 3];
    expect(byte2 >> 4).toBe(1);
    expect(byte2 & 0xf).toBe(2);

    const m2ts = files.get('BDMV/STREAM/00001.m2ts')!;
    let first: Uint8Array | null = null;
    const asm = new PesAssembler((pes) => {
      if (pes.pid === VIDEO_PID) first ??= pes.payload;
    });
    for (let o = 0; o + 192 <= m2ts.length && !first; o += 192) {
      const pkt = parseSourcePacket(m2ts, o);
      if (pkt && pkt.pid === VIDEO_PID) asm.push(pkt);
    }
    if (!first) asm.flush();
    expect(first).not.toBeNull();
    const info = analyzeHevc(first!);
    expect(info.idr).toBe(true);
    expect(hevcCodecStrings(info.sps!)[0].startsWith('hvc1.2.4.')).toBe(true);
  });
});
