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

/** The picture_coding_type (1 I, 2 P, 3 B), temporal_reference and whether a GOP header precedes it, of each picture in `payload`. */
function pictureHeaders(payload: Uint8Array): Array<{ type: number; tr: number; gop: boolean }> {
  const out: Array<{ type: number; tr: number; gop: boolean }> = [];
  let gop = false;
  for (let i = 0; i + 5 < payload.length; i++) {
    if (payload[i] !== 0 || payload[i + 1] !== 0 || payload[i + 2] !== 1) continue;
    if (payload[i + 3] === 0xb8) gop = true;
    else if (payload[i + 3] === 0) {
      out.push({ type: (payload[i + 5]! >> 3) & 7, tr: (payload[i + 4]! << 2) | (payload[i + 5]! >> 6), gop });
      gop = false;
    }
  }
  return out;
}

/** The index of each PES packet's picture in presentation order, from its temporal_reference counted across GOPs. */
function presentationOrder(packets: readonly PesPacket[]): number[] {
  let base = 0;
  let inGop = 0;
  return packets.map((p) => {
    const h = pictureHeaders(p.payload)[0]!;
    if (h.gop) {
      base += inGop;
      inGop = 0;
    }
    inGop++;
    return base + h.tr;
  });
}

/**
 * A test that decodes a clip's video in WASM: about a second here, several on a slow CI runner (the six playlists in one
 * test outran the default 5 s there), so each gets the time the heavier BD-J and trace tests give theirs.
 */
const DECODE_TIMEOUT_MS = 60_000;

let wasmModule: ReturnType<typeof loadVideoWasm> | null = null;
/** The engine's video WASM module, loaded once for the file. */
function videoWasm(): ReturnType<typeof loadVideoWasm> {
  wasmModule ??= loadVideoWasm(readFileSync(fileURLToPath(new URL('../../packages/engine/wasm/video/video.wasm', import.meta.url))));
  return wasmModule;
}

/** Every picture `codec`'s decoder gives for `packets`, flushed at the end. */
function decodeAll(wasm: Awaited<ReturnType<typeof loadVideoWasm>>, codec: 1 | 2, packets: readonly PesPacket[]): DecodedPicture[] {
  const d = new WasmPictureDecoder(wasm, codec);
  const out: DecodedPicture[] = [];
  for (const p of packets) {
    d.push(p.payload, ((p.pts ?? 0) * 1000) / 90);
    out.push(...d.drain());
  }
  out.push(...d.flush());
  d.close();
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
      const entries = clpi.epMaps[0]!.entries;
      // The VC-1 disc has an EP entry at each group of pictures (frames 0, 60 and 120); the MPEG-2 ones at each 12-frame GOP.
      if (e.disc === 'disc-vc1') expect(entries, `${e.disc} EP map`).toHaveLength(3);
      else expect(entries.length, `${e.disc} ${e.playlist} EP map`).toBeGreaterThanOrEqual(7);
      for (let i = 1; i < entries.length; i++) expect(entries[i]!.spn).toBeGreaterThan(entries[i - 1]!.spn);
    }
    for (const disc of ['disc-mpeg2-interlaced', 'disc-vc1']) {
      const model = await openDisc(syntheticSource(fixtureDiscFiles(disc)));
      expect(model.summaries.every((s) => s.playable), disc).toBe(true);
    }
    expect(EXPECTED.filter((e) => e.disc === 'disc-mpeg2-interlaced')).toHaveLength(5);
  });

  it('carries VC-1 in a 0xFD PES with the extension 0x55', () => {
    const packets = videoPackets(fixtureDiscFiles('disc-vc1'), '00000');
    expect(packets).toHaveLength(180);
    for (const p of packets) expect([p.streamId, p.streamIdExtension]).toEqual([0xfd, 0x55]);
    // Every unit is a frame: it holds a frame start code 0x0D.
    for (const p of packets) expect(p.payload.some((b, i) => b === 1 && p.payload[i - 1] === 0 && p.payload[i - 2] === 0 && p.payload[i + 1] === 0x0d)).toBe(true);
  });

  it('the MPEG-2 clips are coded with B pictures in open GOPs, and their PES headers carry DTS', () => {
    for (const playlist of ['00000', '00001', '00002', '00003', '00004']) {
      const packets = videoPackets(fixtureDiscFiles('disc-mpeg2-interlaced'), playlist);
      const headers = packets.flatMap((p) => pictureHeaders(p.payload));
      expect(headers.some((h) => h.type === 3), `${playlist} has B pictures`).toBe(true);
      // Open GOPs: a later GOP starts with an I picture whose temporal_reference is above 0 (B pictures that show before it follow it).
      expect(headers.filter((h) => h.gop && h.type === 1).some((h) => h.tr > 0), `${playlist} has open GOPs`).toBe(true);
      expect(packets.some((p) => p.dts !== undefined && p.dts < p.pts!), `${playlist} has DTS`).toBe(true);
      // Decode order is not presentation order, and the presentation order the temporal_references give matches the PTS order.
      const order = presentationOrder(packets);
      expect(order).not.toEqual([...order].sort((x, y) => x - y));
      const byPts = packets.map((_, i) => i).sort((x, y) => packets[x]!.pts! - packets[y]!.pts!);
      expect(byPts.map((i) => order[i])).toEqual(packets.map((_, i) => i));
      packets.forEach((p) => expect(p.dts ?? p.pts).toBeLessThanOrEqual(p.pts!));
    }
  });

  it("the soft pulldown stream's flags repeat in 3:2", () => {
    const packets = videoPackets(fixtureDiscFiles('disc-mpeg2-interlaced'), '00003');
    const order = presentationOrder(packets);
    const decoded = packets.flatMap((p) => pictureFlags(p.payload));
    expect(decoded).toHaveLength(96);
    // The 3:2 pattern is in presentation order.
    const flags = new Array<{ tff: boolean; rff: boolean }>(96);
    decoded.forEach((f, i) => (flags[order[i]!] = f));
    const cycle = [
      { tff: true, rff: true },
      { tff: false, rff: false },
      { tff: false, rff: true },
      { tff: true, rff: false },
    ];
    flags.forEach((f, i) => expect(f, `picture ${i}`).toEqual(cycle[i % 4]));
  });

  // Each playlist is its own test: decoding 96 to 180 pictures of 1080 lines in WASM takes about a second here, and
  // several times that on a slow CI runner, so all six in one test outran the default 5 s there.
  const decodeCases: Array<[string, string, number, number, number, number, boolean, 'tff' | 'bff' | null]> = [
    // disc, playlist, codec, pictures, width, height, interlaced, field order
    ['disc-mpeg2-interlaced', '00000', WasmVideoCodec.MPEG2, 120, 1920, 1080, true, 'tff'],
    ['disc-mpeg2-interlaced', '00001', WasmVideoCodec.MPEG2, 120, 1920, 1080, true, 'bff'],
    ['disc-mpeg2-interlaced', '00002', WasmVideoCodec.MPEG2, 120, 1920, 1080, true, 'tff'],
    ['disc-mpeg2-interlaced', '00003', WasmVideoCodec.MPEG2, 96, 720, 480, false, null],
    ['disc-mpeg2-interlaced', '00004', WasmVideoCodec.MPEG2, 96, 1920, 1080, false, null],
    ['disc-vc1', '00000', WasmVideoCodec.VC1, 180, 1920, 1080, true, 'tff'],
  ];
  for (const [disc, playlist, codec, count, width, height, interlaced, order] of decodeCases) {
    it(`the WASM decoder decodes ${disc} ${playlist}'s video to the pictures it holds`, async () => {
      const pictures = decodeAll(await videoWasm(), codec as 1 | 2, videoPackets(fixtureDiscFiles(disc), playlist));
      const label = `${disc} ${playlist}`;
      expect(pictures, label).toHaveLength(count);
      // In presentation order: B pictures came out after the references that followed them in the stream.
      for (let i = 1; i < pictures.length; i++) expect(pictures[i]!.ptsUs, `${label} picture ${i}`).toBeGreaterThan(pictures[i - 1]!.ptsUs);
      expect([pictures[0]!.width, pictures[0]!.height], label).toEqual([width, height]);
      expect(pictures.every((p) => !p.flags.progressive === interlaced), label).toBe(true);
      if (order) expect(pictures.every((p) => p.flags.fieldOrder === order), label).toBe(true);
    }, DECODE_TIMEOUT_MS);
  }

  it('the WASM decoder cases cover every playlist of both discs', () => {
    expect(decodeCases.map(([disc, playlist]) => `${disc} ${playlist}`)).toEqual(EXPECTED.map((e) => `${e.disc} ${e.playlist}`));
  });

  it('decodes from the second VC-1 entry point (headers, then frames 60 on) with no error', async () => {
    const packets = videoPackets(fixtureDiscFiles('disc-vc1'), '00000');
    // The unit at frame 60 begins with the sequence header (00 00 01 0F) and the entry point header (00 00 01 0E).
    expect([...packets[60]!.payload.subarray(0, 4)]).toEqual([0, 0, 1, 0x0f]);
    expect(packets[60]!.payload.indexOf(0x0e, 4)).toBeGreaterThan(0);
    const out = decodeAll(await videoWasm(), WasmVideoCodec.VC1, packets.slice(60));
    expect(out).toHaveLength(120);
    expect(out[0]!.keyFrame).toBe(true);
    expect(out.every((p) => !p.flags.progressive && p.width === 1920 && p.height === 1080)).toBe(true);
  }, DECODE_TIMEOUT_MS);

  it('decodes from an MPEG-2 open GOP, dropping the B pictures that lead its I picture', async () => {
    const packets = videoPackets(fixtureDiscFiles('disc-mpeg2-interlaced'), '00000');
    const start = packets.findIndex((p, i) => i > 0 && p.payload[3] === 0xb3);
    expect(start).toBeGreaterThan(0);
    const leading = pictureHeaders(packets[start + 1]!.payload)[0]!;
    expect(leading.type).toBe(3);
    const out = decodeAll(await videoWasm(), WasmVideoCodec.MPEG2, packets.slice(start));
    expect(out[0]!.keyFrame).toBe(true);
    // The two B pictures after the I picture show before it and need the GOP before: they are not output.
    expect(out).toHaveLength(packets.length - start - 2);
    for (let i = 1; i < out.length; i++) expect(out[i]!.ptsUs).toBeGreaterThan(out[i - 1]!.ptsUs);
  }, DECODE_TIMEOUT_MS);
});
