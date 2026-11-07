import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClpi } from '@seikou/bdmv/clpi-parser';
import { CodingType } from '@seikou/bdmv/stream-types';
import { AudioFramer } from '../../../src/engine/decode/audio-frames';
import { PesAssembler, type PesPacket } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import { KeptStreams, PesCoreFilter, audioWireBps, fallbackAudioBps, mpegCrc32, nominalAudioBps, pmtFor, type KeptPacket } from './audio-core';
import { LEVELS, planClip } from './levels';

/** The fixtures' EP intervals as they are: their GOPs are shorter than the plan's merge threshold. */
const RAW_PLAN = { minInterval45: 0 };

const DISC = join(import.meta.dirname, '../../../fixtures/synthetic/disc-levels/BDMV');
const PACKET = 192;

function packetsOf(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at + PACKET <= bytes.length; at += PACKET) out.push(bytes.subarray(at, at + PACKET));
  return out;
}

function demux(packets: readonly Uint8Array[]): { pes: PesPacket[]; continuityErrors: number } {
  const pes: PesPacket[] = [];
  const assembler = new PesAssembler((p) => pes.push(p));
  for (const p of packets) {
    const ts = parseSourcePacket(p, 0);
    if (ts) assembler.push(ts);
  }
  assembler.flush();
  return { pes, continuityErrors: assembler.continuityErrors };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Filters `packets`, the first at source packet number `firstSpn`, and flushes. */
function run(kept: KeptStreams, packets: readonly Uint8Array[], firstSpn = 0): KeptPacket[] {
  return [...packets.flatMap((p, i) => kept.filter(p, firstSpn + i)), ...kept.flush()];
}

function runAll(kept: KeptStreams, packets: readonly Uint8Array[]): Uint8Array[] {
  return run(kept, packets).map((k) => k.bytes);
}

/** Splits packets at each unit start; checks the continuity counter steps by one inside each run. */
function ccContinuousWithinUnits(packets: readonly Uint8Array[]): boolean {
  for (let i = 1; i < packets.length; i++) {
    const p = packets[i]!;
    if (p[5]! & 0x40) continue;
    if ((p[7]! & 0x0f) !== (((packets[i - 1]![7]! & 0x0f) + 1) & 0x0f)) return false;
  }
  return true;
}

const truehdKept = (): KeptStreams =>
  new KeptStreams(new Set([0x1200, 0x1201]), new Map([[0x1100, new PesCoreFilter(CodingType.TRUEHD)]]), {
    video: { pid: 0x1011, streamType: CodingType.AVC },
  });

const pidOf = (p: Uint8Array): number => ((p[5]! & 0x1f) << 8) | p[6]!;

/** A PES with a PTS, and stream_id_extension when given (as the fixture muxer writes it). */
function buildPes(streamId: number, payload: Uint8Array, ext?: number): Uint8Array {
  const headerData = ext === undefined ? 5 : 8;
  const out = new Uint8Array(9 + headerData + payload.length);
  out.set([0, 0, 1, streamId]);
  const length = out.length - 6;
  out[4] = length >> 8;
  out[5] = length & 0xff;
  out[6] = 0x80;
  out[7] = 0x80 | (ext === undefined ? 0 : 0x01);
  out[8] = headerData;
  out.set([0x21, 0x00, 0x01, 0x00, 0x01], 9);
  if (ext !== undefined) out.set([0x01, 0x81, ext], 14);
  out.set(payload, 9 + headerData);
  return out;
}

/** Splits a PES onto 192-byte source packets of `pid`, ATS = index × 100. */
function packetize(pid: number, pes: Uint8Array, firstCc = 0, firstAts = 0): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0, i = 0; at < pes.length; i++) {
    const take = Math.min(184, pes.length - at);
    const p = new Uint8Array(PACKET);
    const ats = firstAts + i * 100;
    p.set([(ats >>> 24) & 0x3f, (ats >>> 16) & 0xff, (ats >>> 8) & 0xff, ats & 0xff, 0x47, (at === 0 ? 0x40 : 0) | (pid >> 8), pid & 0xff], 0);
    const cc = (firstCc + i) & 0x0f;
    if (take < 184) {
      const af = 183 - take;
      p[7] = 0x30 | cc;
      p[8] = af;
      if (af > 0) {
        p[9] = 0;
        p.fill(0xff, 10, 9 + af);
      }
      p.set(pes.subarray(at, at + take), 9 + af);
    } else {
      p[7] = 0x10 | cc;
      p.set(pes.subarray(at, at + 184), 8);
    }
    out.push(p);
    at += take;
  }
  return out;
}

/** A DTS core frame of `fsize` bytes holding 512 samples (16 blocks), filled with a pattern after the header. */
function dtsCore(fsize: number): Uint8Array {
  const f = new Uint8Array(fsize);
  f.set([0x7f, 0xfe, 0x80, 0x01]);
  const nblks = 15;
  const fs = fsize - 1;
  f[4] = 0xfc | (nblks >> 6);
  f[5] = ((nblks & 0x3f) << 2) | (fs >> 12);
  f[6] = (fs >> 4) & 0xff;
  f[7] = (fs & 0x0f) << 4;
  for (let i = 8; i < fsize; i++) f[i] = (i * 7) & 0xff;
  return f;
}

/** A DTS-HD extension substream frame of `fsize` bytes (narrow header). */
function dtsExss(fsize: number): Uint8Array {
  const f = new Uint8Array(fsize).fill(0x5a);
  f.set([0x64, 0x58, 0x20, 0x25]);
  // UserDefinedBits(8), nExtSSIndex(2), bHeaderSizeType(1) = 0, nuExtSSHeaderSize(8), nuExtSSFsize(16) = fsize − 1
  const bits: number[] = [];
  const put = (n: number, v: number): void => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1);
  };
  put(8, 0);
  put(2, 0);
  put(1, 0);
  put(8, 15);
  put(16, fsize - 1);
  f.fill(0, 4, 4 + Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) f[4 + (i >> 3)] |= 0x80 >> (i & 7);
  return f;
}

/** One source packet of `pid` carrying `payload` (at most 184 bytes), stuffed with an adaptation field. */
function rawPacket(pid: number, start: boolean, cc: number, payload: Uint8Array): Uint8Array {
  const p = new Uint8Array(PACKET);
  p.set([0, 0, 0, 0, 0x47, (start ? 0x40 : 0) | (pid >> 8), pid & 0xff], 0);
  if (payload.length === 184) {
    p[7] = 0x10 | cc;
    p.set(payload, 8);
    return p;
  }
  const af = 183 - payload.length;
  p[7] = 0x30 | cc;
  p[8] = af;
  if (af > 0) {
    p[9] = 0;
    p.fill(0xff, 10, 9 + af);
  }
  p.set(payload, 9 + af);
  return p;
}

/** The ES_info length of each stream in a PMT section. */
function pmtDescriptorLengths(section: Uint8Array): Map<number, number> {
  const programInfo = ((section[10]! & 0x0f) << 8) | section[11]!;
  const end = 3 + (((section[1]! & 0x0f) << 8) | section[2]!) - 4;
  const out = new Map<number, number>();
  for (let o = 12 + programInfo; o < end; ) {
    const len = ((section[o + 3]! & 0x0f) << 8) | section[o + 4]!;
    out.set(((section[o + 1]! & 0x1f) << 8) | section[o + 2]!, len);
    o += 5 + len;
  }
  return out;
}

/** The ES loop of a PMT section. */
function pmtStreams(section: Uint8Array): Array<{ pid: number; streamType: number }> {
  const programInfo = ((section[10]! & 0x0f) << 8) | section[11]!;
  const end = 3 + (((section[1]! & 0x0f) << 8) | section[2]!) - 4;
  const out: Array<{ pid: number; streamType: number }> = [];
  for (let o = 12 + programInfo; o < end; ) {
    out.push({ streamType: section[o]!, pid: ((section[o + 1]! & 0x1f) << 8) | section[o + 2]! });
    o += 5 + (((section[o + 3]! & 0x0f) << 8) | section[o + 4]!);
  }
  return out;
}

/** A PSI section on one source packet (pointer_field 0, stuffed with 0xFF). */
function psiPacket(pid: number, section: Uint8Array, cc = 0): Uint8Array {
  const p = new Uint8Array(PACKET).fill(0xff);
  p.set([0, 0, 0, 0, 0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10 | cc, 0], 0);
  p.set(section, 9);
  return p;
}

function withCrc(body: number[]): Uint8Array {
  const s = new Uint8Array(body.length + 4);
  s.set(body);
  const crc = mpegCrc32(s.subarray(0, body.length));
  s.set([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff], body.length);
  return s;
}

function patSection(pmtPid: number): Uint8Array {
  const body = [0x00, 0xb0, 0, 0x00, 0x00, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (pmtPid >> 8), pmtPid & 0xff];
  body[2] = body.length - 3 + 4;
  return withCrc(body);
}

/** A PMT as a disc writes it: every stream of the clip, an HDMV registration descriptor per stream. */
function discPmt(streams: Array<{ pid: number; streamType: number }>): Uint8Array {
  const body = [0x02, 0xb0, 0, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xf0, 0x01, 0xf0, 0x06, 0x05, 0x04, 0x48, 0x44, 0x4d, 0x56];
  for (const s of streams) body.push(s.streamType, 0xe0 | (s.pid >> 8), s.pid & 0xff, 0xf0, 0x06, 0x05, 0x04, 0x48, 0x44, 0x4d, 0x56);
  body[2] = body.length - 3 + 4;
  return withCrc(body);
}

describe('PesCoreFilter', () => {
  it('keeps the AC-3 substream of a TrueHD PID and drops the MLP units', () => {
    const filter = new PesCoreFilter(CodingType.TRUEHD);
    const core = buildPes(0xfd, new Uint8Array([0x0b, 0x77, 1, 2, 3]), 0x76);
    expect(filter.push(core)).toBe(core);
    expect(filter.push(buildPes(0xfd, new Uint8Array([0xf8, 0x72, 0x6f, 0xba]), 0x72))).toBeNull();
  });

  it('keeps a DTS-HD PES core bytes exactly, without its extension substream, and fixes PES_packet_length', () => {
    const core = dtsCore(1004);
    const pes = buildPes(0xbd, concat([core, dtsExss(1500)]));
    const out = new PesCoreFilter(CodingType.DTSHD_MASTER).push(pes);
    expect(out).not.toBeNull();
    const [parsed] = demux(packetize(0x1100, out!)).pes;
    expect(parsed!.payload).toEqual(core);
    expect((out![4]! << 8) | out![5]!).toBe(out!.length - 6);
    expect(out!.subarray(0, 14)).toEqual(Uint8Array.from([...pes.subarray(0, 4), out![4]!, out![5]!, ...pes.subarray(6, 14)]));
  });

  it('drops a DTS-HD PES that holds only an extension substream', () => {
    expect(new PesCoreFilter(CodingType.DTSHD).push(buildPes(0xbd, dtsExss(800)))).toBeNull();
  });

  it('passes other codings through', () => {
    const pes = buildPes(0xbd, new Uint8Array([0x0b, 0x77, 9, 9]));
    expect(new PesCoreFilter(CodingType.AC3).push(pes)).toBe(pes);
  });
});

describe('KeptStreams on disc-levels', () => {
  const m2ts = readFileSync(join(DISC, 'STREAM/00001.m2ts'));
  const packets = packetsOf(new Uint8Array(m2ts.buffer, m2ts.byteOffset, m2ts.byteLength));

  it('the TrueHD PID filtered yields only AC-3 frames the engine framer accepts, every one of the core', () => {
    const kept = new KeptStreams(new Set([0x1100]), new Map([[0x1100, new PesCoreFilter(CodingType.TRUEHD)]]));
    const out = runAll(kept, packets);
    expect(new Set(out.map(pidOf))).toEqual(new Set([0x1100]));
    expect(out.every((b) => packets.includes(b))).toBe(true); // the core's packets pass bit-exact, counters included
    expect(ccContinuousWithinUnits(out)).toBe(true);
    const { pes } = demux(out);
    expect(pes.every((p) => p.streamIdExtension === 0x76)).toBe(true);

    const coreIn = demux(packets).pes.filter((p) => p.pid === 0x1100 && p.streamIdExtension === 0x76);
    expect(pes.length).toBe(coreIn.length);
    const bytes = concat(pes.map((p) => p.payload));
    expect(bytes).toEqual(concat(coreIn.map((p) => p.payload)));
    const frames = new AudioFramer('ac3').push(bytes, 0);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.reduce((n, f) => n + f.data.length, 0)).toBe(bytes.length);
    expect(pes.map((p) => p.pts)).toEqual(coreIn.map((p) => p.pts));
  });

  it('passes kept PIDs bit-exact and drops the commentary, the picture-in-picture video and the nulls', () => {
    const kept = new KeptStreams(new Set([0x1200, 0x1201]), new Map());
    const out = runAll(kept, packets);
    const expected = packets.filter((p) => pidOf(p) === 0x1200 || pidOf(p) === 0x1201);
    expect(out).toEqual(expected);
    expect(out.some((p) => [0x1101, 0x1b00, 0x1fff].includes(pidOf(p)))).toBe(false);
  });

  it('regenerates the PMT with only the kept PIDs, the video at its level coding and the TrueHD as AC-3', () => {
    const clpi = parseClpi(readFileSync(join(DISC, 'CLIPINF/00001.clpi')));
    const all = clpi.programs[0]!.streams.map((s) => ({ pid: s.pid, streamType: s.codingType }));
    expect(all.map((s) => s.pid)).toEqual(expect.arrayContaining([0x1011, 0x1100, 0x1101, 0x1b00, 0x1200, 0x1201]));
    const kept = new KeptStreams(new Set([0x1200, 0x1201]), new Map([[0x1100, new PesCoreFilter(CodingType.TRUEHD)]]), {
      video: { pid: 0x1011, streamType: CodingType.HEVC },
    });
    const pat = psiPacket(0, patSection(0x100));
    const out = runAll(kept, [pat, psiPacket(0x100, discPmt(all)), psiPacket(0x100, discPmt(all), 1)]);
    expect(out[0]).toEqual(pat);
    const pmts = out.slice(1);
    expect(pmts.map(pidOf)).toEqual([0x100, 0x100]);
    expect(pmts.map((p) => p[7]! & 0x0f)).toEqual([0, 1]);
    const section = pmts[0]!.subarray(9);
    const length = 3 + (((section[1]! & 0x0f) << 8) | section[2]!);
    expect(mpegCrc32(section.subarray(0, length))).toBe(0); // CRC over a section including its CRC is 0
    expect(pmtStreams(section)).toEqual([
      { pid: 0x1011, streamType: 0x24 },
      { pid: 0x1100, streamType: 0x81 },
      { pid: 0x1200, streamType: 0x90 },
      { pid: 0x1201, streamType: 0x90 },
    ]);
    expect((((section[8]! & 0x1f) << 8) | section[9]!)).toBe(0x1001);
    expect(pmtDescriptorLengths(section)).toEqual(new Map([[0x1011, 0], [0x1100, 0], [0x1200, 6], [0x1201, 6]]));
  });

  it("drops the video's descriptors even when the level keeps its stream_type", () => {
    const kept = new KeptStreams(new Set([0x1200]), new Map(), { video: { pid: 0x1011, streamType: CodingType.AVC } });
    const [pmt] = runAll(kept, [psiPacket(0x100, discPmt([{ pid: 0x1011, streamType: 0x1b }, { pid: 0x1200, streamType: 0x90 }]))]);
    expect(pmtDescriptorLengths(pmt!.subarray(9))).toEqual(new Map([[0x1011, 0], [0x1200, 6]]));
  });

  it('reads a PMT section whose first packet holds fewer than 3 of its bytes', () => {
    const section = discPmt([{ pid: 0x1011, streamType: 0x1b }, { pid: 0x1200, streamType: 0x90 }]);
    const first = new Uint8Array(184).fill(0xff);
    first[0] = 182; // pointer_field: the section starts at the packet's last byte
    first[183] = section[0]!;
    const rest = new Uint8Array(184).fill(0xff);
    rest.set(section.subarray(1));
    const kept = new KeptStreams(new Set([0x1200]), new Map(), { video: { pid: 0x1011, streamType: CodingType.HEVC } });
    const out = runAll(kept, [rawPacket(0x100, true, 0, first), rawPacket(0x100, false, 1, rest)]);
    expect(out).toHaveLength(1);
    expect(pmtStreams(out[0]!.subarray(9))).toEqual([{ pid: 0x1011, streamType: 0x24 }, { pid: 0x1200, streamType: 0x90 }]);
  });
});

describe('KeptStreams on odd PES', () => {
  const ac3 = (n: number): Uint8Array => {
    const b = new Uint8Array(n).fill(0x11);
    b.set([0x0b, 0x77]);
    return b;
  };

  it('reads PES_packet_length from the next packet when the unit start holds fewer than 6 payload bytes', () => {
    const pes = buildPes(0xfd, ac3(300), 0x76);
    const packets = [rawPacket(0x1100, true, 0, pes.subarray(0, 4)), ...packetize(0x1100, pes.subarray(4), 1).map((p) => (p[5]! &= ~0x40, p))];
    const kept = new KeptStreams(new Set(), new Map([[0x1100, new PesCoreFilter(CodingType.TRUEHD)]]));
    const out = packets.flatMap((p, i) => kept.filter(p, i)); // no flush: a declared PES is handed over at its last packet
    expect(out.map((k) => k.bytes)).toEqual(packets);
    expect(demux(out.map((k) => k.bytes)).pes[0]!.payload).toEqual(ac3(300));
  });

  it('reports the SPN of the earliest unit still open', () => {
    const pes = buildPes(0xfd, ac3(300), 0x76);
    const packets = packetize(0x1100, pes, 0);
    const kept = new KeptStreams(new Set(), new Map([[0x1100, new PesCoreFilter(CodingType.TRUEHD)]]));
    expect(kept.openSince()).toBeNull();
    kept.filter(packets[0]!, 7);
    expect(kept.openSince()).toBe(7);
    kept.filter(packets[1]!, 9);
    expect(kept.openSince()).toBeNull();
  });

  it('drops an unbounded PES on a filtered PID that grows past 64 KiB, and keeps the next one', () => {
    const big = buildPes(0xbd, ac3(70_000));
    big[4] = 0;
    big[5] = 0;
    const small = buildPes(0xbd, ac3(500));
    const bigPackets = packetize(0x1100, big);
    const smallPackets = packetize(0x1100, small, bigPackets.length);
    const kept = new KeptStreams(new Set(), new Map([[0x1100, new PesCoreFilter(CodingType.TRUEHD)]]));
    const out = runAll(kept, [...bigPackets, ...smallPackets]);
    expect(out).toEqual(smallPackets);
  });
});

describe('KeptStreams on a DTS-HD PID', () => {
  it('re-packetizes a shrunk PES onto the same PID with continuous counters, reusing the original ATS from the first packet', () => {
    const pid = 0x1100;
    const cores = [dtsCore(1004), dtsCore(1004)];
    const input = [
      ...packetize(pid, buildPes(0xbd, concat([cores[0]!, dtsExss(2000)])), 5, 1000),
      ...packetize(pid, buildPes(0xbd, concat([cores[1]!, dtsExss(2000)])), 5 + 17, 9000),
    ];
    const kept = new KeptStreams(new Set(), new Map([[pid, new PesCoreFilter(CodingType.DTSHD_MASTER)]]));
    const out = runAll(kept, input);
    expect(out.length).toBeLessThan(input.length);
    expect(out.every((p) => p.length === PACKET && p[4] === 0x47 && pidOf(p) === pid)).toBe(true);
    expect(demux(out).pes.map((p) => p.payload)).toEqual(cores);
    expect(out[0]!.subarray(0, 4)).toEqual(input[0]!.subarray(0, 4));
    const secondStart = out.findIndex((p, i) => i > 0 && (p[5]! & 0x40) !== 0);
    expect(out[secondStart]!.subarray(0, 4)).toEqual(input[17]!.subarray(0, 4));
    // Counters run on from each PES's first original packet, so they don't depend on what came before it.
    expect(ccContinuousWithinUnits(out)).toBe(true);
    expect(out[0]![7]! & 0x0f).toBe(5);
    expect(out[secondStart]![7]! & 0x0f).toBe((5 + 17) & 0x0f);
    expect(run(new KeptStreams(new Set(), new Map([[pid, new PesCoreFilter(CodingType.DTSHD_MASTER)]])), input).map((k) => k.spn)).toEqual(
      out.map((_, i) => (i < secondStart ? 0 : 17)),
    );
  });
});

describe('KeptStreams intervals (ruling L-R4)', () => {
  const m2ts = readFileSync(join(DISC, 'STREAM/00001.m2ts'));
  const packets = packetsOf(new Uint8Array(m2ts.buffer, m2ts.byteOffset, m2ts.byteLength));
  const clpi = parseClpi(readFileSync(join(DISC, 'CLIPINF/00001.clpi')));
  const { intervals } = planClip(clpi, LEVELS['h264-1080'], 192_000, RAW_PLAN);
  const k3 = intervals[3]!.srcSpnStart;

  // The fixture has no PSI: a PAT and a PMT go in front of each interval's first packet, fed at that packet's SPN.
  const pat = psiPacket(0, patSection(0x100));
  const all = clpi.programs[0]!.streams.map((s) => ({ pid: s.pid, streamType: s.codingType }));
  const input: Array<{ bytes: Uint8Array; spn: number }> = [];
  packets.forEach((bytes, spn) => {
    const k = intervals.findIndex((iv) => iv.srcSpnStart === spn);
    if (k >= 0) input.push({ bytes: pat, spn }, { bytes: psiPacket(0x100, discPmt(all), k & 0x0f), spn });
    input.push({ bytes, spn });
  });

  /** A run of the filter that starts at `from`, as an encode restarted there would feed it. */
  function feed(from: number): KeptPacket[] {
    const kept = truehdKept();
    return [...input.filter((p) => p.spn >= from).flatMap((p) => kept.filter(p.bytes, p.spn)), ...kept.flush()];
  }

  function expectSameFrom(startSpn: number): void {
    const fromStart = feed(0).filter((k) => k.spn >= startSpn);
    const fromK = feed(startSpn);
    expect(fromK.length).toBeGreaterThan(0);
    expect(fromK.map((k) => k.spn)).toEqual(fromStart.map((k) => k.spn));
    expect(fromK.map((k) => k.bytes)).toEqual(fromStart.map((k) => k.bytes));
  }

  /** The SPN of the second packet of the first multi-packet AC-3 core PES at or after `from`. */
  function insideCorePes(from: number): number {
    for (let i = from; i < packets.length; i++) {
      const p = packets[i]!;
      if (pidOf(p) !== 0x1100 || !(p[5]! & 0x40)) continue;
      const rest = packets.map((q, j) => ({ q, j })).filter(({ q, j }) => j > i && pidOf(q) === 0x1100);
      const end = rest.findIndex(({ q }) => (q[5]! & 0x40) !== 0);
      const tail = rest.slice(0, end < 0 ? rest.length : end);
      const [pes] = demux([p, ...tail.map(({ q }) => q)]).pes;
      if (tail.length > 0 && pes?.streamIdExtension === 0x76) return tail[0]!.j;
    }
    throw new Error('no multi-packet AC-3 core PES');
  }

  it("gives interval 3 and later the same bytes from a run started at the clip's start or at interval 3", () => {
    expect(intervals.length).toBeGreaterThan(4);
    expectSameFrom(k3);
  });

  it('assigns a TrueHD core PES that straddles the run start to its first packet, in both runs', () => {
    const boundary = insideCorePes(k3);
    expectSameFrom(boundary);
    const second = packets[boundary]!;
    const whole = feed(0).find((k) => k.bytes === second);
    expect(whole).toBeDefined();
    expect(whole!.spn).toBeLessThan(boundary); // kept whole by the earlier run, at its first packet's SPN
    expect(feed(boundary).some((k) => k.bytes === second)).toBe(false); // and absent from the run started inside it
  });

  it('carries a filtered PES at its first packet and an unfiltered packet at its own SPN', () => {
    const spnOf = new Map(packets.map((p, i) => [p, i] as const));
    for (const k of feed(0)) {
      const own = spnOf.get(k.bytes);
      if (pidOf(k.bytes) === 0x1100) {
        expect(own).toBeDefined();
        expect(own!).toBeGreaterThanOrEqual(k.spn);
        if (k.bytes[5]! & 0x40) expect(k.spn).toBe(own);
      } else if (pidOf(k.bytes) === 0x1200 || pidOf(k.bytes) === 0x1201) {
        expect(k.spn).toBe(own);
      }
    }
  });
});

describe('pmtFor', () => {
  it('lists exactly the given streams, with a valid CRC', () => {
    const section = pmtFor([
      { pid: 0x1011, streamType: 0x1b },
      { pid: 0x1100, streamType: 0x82 },
      { pid: 0x1400, streamType: 0x91 },
    ]);
    expect(section[0]).toBe(0x02);
    expect(mpegCrc32(section)).toBe(0);
    expect(pmtStreams(section)).toEqual([
      { pid: 0x1011, streamType: 0x1b },
      { pid: 0x1100, streamType: 0x82 },
      { pid: 0x1400, streamType: 0x91 },
    ]);
    expect((((section[8]! & 0x1f) << 8) | section[9]!)).toBe(0x1011);
  });
});

describe('nominalAudioBps', () => {
  it('reads 640000 from an AC-3 640 kbps header', () => {
    const frame = new Uint8Array(2560);
    frame.set([0x0b, 0x77, 0, 0, 0x00 | 36, 8 << 3, 0]);
    expect(nominalAudioBps(CodingType.AC3, frame)).toBe(640_000);
    expect(nominalAudioBps(CodingType.TRUEHD, frame)).toBe(640_000);
  });

  it('reads the AC-3 core of the disc-levels TrueHD PID (192 kbps)', () => {
    const m2ts = readFileSync(join(DISC, 'STREAM/00001.m2ts'));
    const first = demux(packetsOf(new Uint8Array(m2ts.buffer, m2ts.byteOffset, m2ts.byteLength))).pes.find(
      (p) => p.pid === 0x1100 && p.streamIdExtension === 0x76,
    );
    expect(nominalAudioBps(CodingType.TRUEHD, first!.payload)).toBe(192_000);
  });

  it('reads a DTS-HD core rate from the core frame size, ignoring the extension', () => {
    expect(nominalAudioBps(CodingType.DTSHD_MASTER, concat([dtsCore(2013), dtsExss(4000)]))).toBe(1_509_750);
  });

  it('reads LPCM from its header: stored channels × rate × bits', () => {
    // 5.1 (assignment 9, stored as 6), 48 kHz, 24-bit
    expect(nominalAudioBps(CodingType.LPCM, new Uint8Array([0x0d, 0x80, (9 << 4) | 1, 3 << 6]))).toBe(6 * 48_000 * 24);
  });

  it('throws on a frame it cannot read', () => {
    expect(() => nominalAudioBps(CodingType.AC3, new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow();
  });
});

describe('audioWireBps', () => {
  /** A PES of `payload` with the 5-byte PTS of every Blu-ray audio PES (a 14-byte header). */
  const pesOf = (streamId: number, payload: Uint8Array): Uint8Array => {
    const length = 8 + payload.length;
    return concat([new Uint8Array([0, 0, 1, streamId, length >> 8, length & 0xff, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1]), payload]);
  };
  /** 5 ms of LPCM (240 samples a channel) behind its 4-byte header: stereo (assignment 3) at 48 kHz. */
  const lpcm5ms = (bits: 16 | 24): Uint8Array => {
    const samples = new Uint8Array(4 + 240 * 2 * (bits / 8));
    samples.set([(240 * 2 * (bits / 8)) >> 8, (240 * 2 * (bits / 8)) & 0xff, (3 << 4) | 1, (bits === 16 ? 1 : 3) << 6]);
    return samples;
  };

  it('counts LPCM at the source packets it takes: 24-bit stereo 2.304 Mb/s → 2.4576 (8 packets for 1440 bytes)', () => {
    // The music disc's LPCM measured 2.458 Mb/s on the wire against its nominal 2.304.
    expect(audioWireBps(CodingType.LPCM, pesOf(0xbd, lpcm5ms(24)))).toBe(2_457_600);
  });

  it('counts 16-bit stereo LPCM 1.536 Mb/s as 1.8432 (6 packets for 960 bytes)', () => {
    expect(audioWireBps(CodingType.LPCM, pesOf(0xbd, lpcm5ms(16)))).toBe(1_843_200);
  });

  it('counts an AC-3 640 kb/s frame in its 14 packets plus the one its PES header spills into', () => {
    const frame = new Uint8Array(2560);
    frame.set([0x0b, 0x77, 0, 0, 0x00 | 36, 8 << 3, 0]);
    // 2574 bytes: 14 packets of 184 bytes (2576) hold it.
    expect(audioWireBps(CodingType.AC3, pesOf(0xbd, frame))).toBe(Math.ceil((640_000 * 14 * 192) / 2560));
  });

  it('counts a DTS core at its own packets', () => {
    // 2013 + 14 bytes: 12 packets. The DTS-HD discs' cores measured 1.727 Mb/s on the wire.
    expect(audioWireBps(CodingType.DTS, pesOf(0xbd, dtsCore(2013)))).toBe(Math.ceil((1_509_750 * 12 * 192) / 2013));
  });

  it('throws on a PES it cannot read', () => {
    expect(() => audioWireBps(CodingType.AC3, new Uint8Array([0, 0, 1, 0xbd, 0, 3, 0x80, 0x80]))).toThrow();
    expect(() => audioWireBps(CodingType.AC3, pesOf(0xbd, new Uint8Array([1, 2, 3, 4, 5, 6])))).toThrow();
  });
});

describe('fallbackAudioBps', () => {
  it('gives each coding’s nominal rate × 1.25 for its packets: AC-3 640k, DTS 1509k, LPCM from the CLPI, else 1.5 Mbps', () => {
    expect(fallbackAudioBps(CodingType.AC3, null)).toBe(800_000);
    expect(fallbackAudioBps(CodingType.TRUEHD, null)).toBe(800_000); // carried as its AC-3 core
    expect(fallbackAudioBps(CodingType.DTS, null)).toBe(Math.ceil(1_509_000 * 1.25));
    expect(fallbackAudioBps(CodingType.DTSHD_MASTER, null)).toBe(Math.ceil(1_509_000 * 1.25)); // carried as its DTS core
    expect(fallbackAudioBps(CodingType.EAC3, null)).toBe(1_875_000);
    // LPCM: stereo (3) at 48 kHz (1), 24-bit; multi-channel (6) at 96 kHz (4) stored as 8 channels
    expect(fallbackAudioBps(CodingType.LPCM, { format: 3, rate: 1 })).toBe(2 * 48_000 * 24 * 1.25);
    expect(fallbackAudioBps(CodingType.LPCM, { format: 6, rate: 4 })).toBe(8 * 96_000 * 24 * 1.25);
    expect(fallbackAudioBps(CodingType.LPCM, null)).toBe(8 * 48_000 * 24 * 1.25);
  });
});
