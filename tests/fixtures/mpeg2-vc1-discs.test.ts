// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseClpi } from '@seikou/bdmv/clpi-parser';
import { PesAssembler, type PesPacket } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import { parseMpls } from '@seikou/bdmv/mpls-parser';
import { CodingType } from '@seikou/bdmv/stream-types';
import { openDisc } from '@seikou/engine/disc/open-disc';
import { loadVideoWasm, WasmPictureDecoder, WasmVideoCodec, type DecodedPicture } from '@seikou/engine/decode/wasm-video';
import { fixtureDiscFiles } from '../helpers/fixture-disc';
import { syntheticSource, VIDEO_PID } from '../helpers/synthetic-disc';

interface Expected {
  readonly disc: string;
  readonly playlist: string;
  readonly codingType: number;
  /** The video format of the CLPI and STN: 4 is 1080i, 1 is 480i, 6 is 1080p. */
  readonly format: number;
  /** The frame rate code: 4 is 29.97, 1 is 23.976. */
  readonly rate: number;
}

const EXPECTED: readonly Expected[] = [
  { disc: 'disc-mpeg2-interlaced', playlist: '00000', codingType: CodingType.MPEG2_VIDEO, format: 4, rate: 4 },
  { disc: 'disc-mpeg2-interlaced', playlist: '00001', codingType: CodingType.MPEG2_VIDEO, format: 4, rate: 4 },
  { disc: 'disc-mpeg2-interlaced', playlist: '00002', codingType: CodingType.MPEG2_VIDEO, format: 4, rate: 4 },
  { disc: 'disc-mpeg2-interlaced', playlist: '00003', codingType: CodingType.MPEG2_VIDEO, format: 1, rate: 4 },
  { disc: 'disc-mpeg2-interlaced', playlist: '00004', codingType: CodingType.MPEG2_VIDEO, format: 6, rate: 1 },
  { disc: 'disc-vc1', playlist: '00000', codingType: CodingType.VC1, format: 4, rate: 4 },
];

type Files = ReturnType<typeof fixtureDiscFiles>;

/** The video PES packets of a playlist's one clip, in stream order. */
function videoPackets(files: Files, playlist: string): PesPacket[] {
  const mpls = parseMpls(files.get(`BDMV/PLAYLIST/${playlist}.mpls`)!);
  const m2ts = files.get(`BDMV/STREAM/${mpls.playItems[0]!.clipId}.m2ts`)!;
  const out: PesPacket[] = [];
  const asm = new PesAssembler((pes) => {
    if (pes.pid === VIDEO_PID) out.push(pes);
  });
  for (let o = 0; o + 192 <= m2ts.length; o += 192) {
    const pkt = parseSourcePacket(m2ts, o);
    if (pkt && pkt.pid === VIDEO_PID) asm.push(pkt);
  }
  asm.flush();
  return out;
}

/** The (top_field_first, repeat_first_field) of each picture coding extension in `payload`. */
function pictureFlags(payload: Uint8Array): Array<{ tff: boolean; rff: boolean }> {
  const out: Array<{ tff: boolean; rff: boolean }> = [];
  for (let i = 0; i + 8 < payload.length; i++) {
    if (payload[i] !== 0 || payload[i + 1] !== 0 || payload[i + 2] !== 1 || payload[i + 3] !== 0xb5) continue;
    if (payload[i + 4]! >> 4 !== 8) continue;
    const b = payload[i + 7]!;
    out.push({ tff: (b & 0x80) !== 0, rff: (b & 0x02) !== 0 });
  }
  return out;
}

describe('the MPEG-2 and VC-1 discs', () => {
  it("the MPEG-2 and VC-1 discs' playlists carry their codings and formats", async () => {
    for (const e of EXPECTED) {
      const files = fixtureDiscFiles(e.disc);
      const mpls = parseMpls(files.get(`BDMV/PLAYLIST/${e.playlist}.mpls`)!);
      const item = mpls.playItems[0]!;
      expect(item.stn.video[0], `${e.disc} ${e.playlist} STN`).toMatchObject({ codingType: e.codingType, format: e.format, rate: e.rate });
      const clpi = parseClpi(files.get(`BDMV/CLIPINF/${item.clipId}.clpi`)!);
      const video = clpi.programs[0]!.streams.find((s) => s.pid === VIDEO_PID)!;
      expect(video, `${e.disc} ${e.playlist} CLPI`).toMatchObject({ codingType: e.codingType, format: e.format, rate: e.rate });
      expect(clpi.epMaps[0]!.entries.length).toBeGreaterThan(0);
    }
    for (const disc of ['disc-mpeg2-interlaced', 'disc-vc1']) {
      const model = await openDisc(syntheticSource(fixtureDiscFiles(disc)));
      expect(model.summaries.every((s) => s.playable), disc).toBe(true);
    }
    expect(EXPECTED.filter((e) => e.disc === 'disc-mpeg2-interlaced')).toHaveLength(5);
  });

  it('carries VC-1 in a 0xFD PES with the extension 0x55', () => {
    const packets = videoPackets(fixtureDiscFiles('disc-vc1'), '00000');
    expect(packets.length).toBeGreaterThan(100);
    for (const p of packets) expect([p.streamId, p.streamIdExtension]).toEqual([0xfd, 0x55]);
    // Every unit is a frame: it holds a frame start code 0x0D.
    for (const p of packets) expect(p.payload.some((b, i) => b === 1 && p.payload[i - 1] === 0 && p.payload[i - 2] === 0 && p.payload[i + 1] === 0x0d)).toBe(true);
  });

  it("the soft pulldown stream's flags repeat in 3:2", () => {
    const flags = videoPackets(fixtureDiscFiles('disc-mpeg2-interlaced'), '00003').flatMap((p) => pictureFlags(p.payload));
    expect(flags).toHaveLength(96);
    const cycle = [
      { tff: true, rff: true },
      { tff: false, rff: false },
      { tff: false, rff: true },
      { tff: true, rff: false },
    ];
    flags.forEach((f, i) => expect(f, `picture ${i}`).toEqual(cycle[i % 4]));
  });

  it("the WASM decoder decodes each disc's video to the pictures it holds", async () => {
    const wasm = await loadVideoWasm(readFileSync(fileURLToPath(new URL('../../packages/engine/wasm/video/video.wasm', import.meta.url))));
    const decode = (disc: string, playlist: string, codec: number): DecodedPicture[] => {
      const d = new WasmPictureDecoder(wasm, codec as 1 | 2);
      const out: DecodedPicture[] = [];
      for (const p of videoPackets(fixtureDiscFiles(disc), playlist)) {
        d.push(p.payload, ((p.pts ?? 0) * 1000) / 90);
        out.push(...d.drain());
      }
      out.push(...d.flush());
      d.close();
      return out;
    };
    const cases: Array<[string, string, number, number, number, number, boolean, 'tff' | 'bff' | null]> = [
      // disc, playlist, codec, pictures, width, height, interlaced, field order
      ['disc-mpeg2-interlaced', '00000', WasmVideoCodec.MPEG2, 120, 1920, 1080, true, 'tff'],
      ['disc-mpeg2-interlaced', '00001', WasmVideoCodec.MPEG2, 120, 1920, 1080, true, 'bff'],
      ['disc-mpeg2-interlaced', '00002', WasmVideoCodec.MPEG2, 120, 1920, 1080, true, 'tff'],
      ['disc-mpeg2-interlaced', '00003', WasmVideoCodec.MPEG2, 96, 720, 480, false, null],
      ['disc-mpeg2-interlaced', '00004', WasmVideoCodec.MPEG2, 96, 1920, 1080, false, null],
      ['disc-vc1', '00000', WasmVideoCodec.VC1, 120, 1920, 1080, true, 'tff'],
    ];
    for (const [disc, playlist, codec, count, width, height, interlaced, order] of cases) {
      const pictures = decode(disc, playlist, codec);
      const label = `${disc} ${playlist}`;
      expect(pictures, label).toHaveLength(count);
      expect([pictures[0]!.width, pictures[0]!.height], label).toEqual([width, height]);
      expect(pictures.every((p) => !p.flags.progressive === interlaced), label).toBe(true);
      if (order) expect(pictures.every((p) => p.flags.fieldOrder === order), label).toBe(true);
    }
  });
});
