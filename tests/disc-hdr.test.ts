import { analyzeHevc, hevcCodecStrings } from '@seikou/bdmv/codecs/hevc';
import { parseClpi } from '@seikou/bdmv/clpi-parser';
import { PesAssembler } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import { CodingType } from '@seikou/bdmv/stream-types';
import { describe, expect, it } from 'vitest';
import { fixtureDiscFiles } from './helpers/fixture-disc';
import { VIDEO_PID } from './helpers/synthetic-disc';

describe('the HDR synthetic disc', () => {
  it('is an HDR10 HEVC Main10 disc', () => {
    const files = fixtureDiscFiles('disc-hdr');
    const clpiBytes = files.get('BDMV/CLIPINF/00001.clpi')!;
    const clpi = parseClpi(clpiBytes);
    const video = clpi.programs[0].streams.find((s) => s.pid === VIDEO_PID)!;
    expect(video.codingType).toBe(CodingType.HEVC);

    // The parser keeps no byte offsets, so find the stream entry by its PID, length (5) and coding type, which must occur
    // exactly once. After them: format/rate (1), then the aspect byte (aspect, oc_flag, cr_flag), then dynamic_range_type
    // (high nibble) and color_space (low nibble), as libbluray's _parse_stream_attr reads them.
    const hits: number[] = [];
    for (let i = 0; i + 3 < clpiBytes.length; i++) {
      if (clpiBytes[i] === VIDEO_PID >> 8 && clpiBytes[i + 1] === (VIDEO_PID & 0xff) && clpiBytes[i + 2] === 5 && clpiBytes[i + 3] === CodingType.HEVC) hits.push(i);
    }
    expect(hits).toHaveLength(1);
    const byte2 = clpiBytes[hits[0] + 6];
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
