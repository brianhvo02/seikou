import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClpi } from '@seikou/bdmv/clpi-parser';
import { CodingType } from '@seikou/bdmv/stream-types';
import { PesAssembler, type PesPacket } from '@seikou/bdmv/demux/pes-assembler';
import { parseSourcePacket } from '@seikou/bdmv/demux/ts-packet';
import { KeptStreams, PesCoreFilter, mpegCrc32, pmtFor, type KeptPacket } from './audio-core';
import { LEVELS, planClip, type IntervalPlan } from './levels';
import { IntervalCollector, PCR_PERIOD_27, atsOf, remuxInterval, shedGraphics, type EncodedPes, type IntervalSource, type RemuxInput } from './remux';

/** The fixtures' EP intervals as they are: their GOPs are shorter than the plan's merge threshold. */
const RAW_PLAN = { minInterval45: 0 };

const PACKET = 192;
const VIDEO = 0x1011;
const fixture = (disc: string): string => join(import.meta.dirname, '../../../fixtures/synthetic', disc, 'BDMV');

function packetsOf(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at + PACKET <= bytes.length; at += PACKET) out.push(bytes.subarray(at, at + PACKET));
  return out;
}

const pidOf = (p: Uint8Array): number => ((p[5]! & 0x1f) << 8) | p[6]!;

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

/** The whole PES on `pid`, as bytes, with the SPN of the first packet of each. */
function rawPes(packets: readonly Uint8Array[], pid: number): Array<{ spn: number; bytes: Uint8Array }> {
  const out: Array<{ spn: number; chunks: Uint8Array[] }> = [];
  packets.forEach((p, spn) => {
    const ts = parseSourcePacket(p, 0);
    if (!ts || ts.pid !== pid || !ts.hasPayload) return;
    if (ts.payloadUnitStart) out.push({ spn, chunks: [] });
    out.at(-1)?.chunks.push(ts.payload);
  });
  return out.map(({ spn, chunks }) => {
    const bytes = concat(chunks);
    const declared = (bytes[4]! << 8) | bytes[5]!;
    return { spn, bytes: declared ? bytes.subarray(0, 6 + declared) : bytes };
  });
}

/** One whole PES, parsed by the engine's demuxer. */
function parseRaw(pid: number, bytes: Uint8Array): PesPacket | undefined {
  const out: PesPacket[] = [];
  const a = new PesAssembler((p) => out.push(p));
  a.push({ pid, payloadUnitStart: true, continuityCounter: 0, hasPayload: true, payload: bytes });
  a.flush();
  return out[0];
}

/** The source's PES on `pid` whose first packet lies in the interval, parsed. */
function pesIn(packets: readonly Uint8Array[], pid: number, plan: IntervalPlan): PesPacket[] {
  const inside = rawPes(packets, pid).filter((r) => r.spn >= plan.srcSpnStart && r.spn < plan.srcSpnEnd);
  return inside.flatMap((r) => parseRaw(pid, r.bytes) ?? []);
}

/** The source's video PES of an interval, as a stand-in for the encoder's output. */
function videoOf(packets: readonly Uint8Array[], plan: IntervalPlan): EncodedPes[] {
  return rawPes(packets, VIDEO)
    .filter((r) => r.spn >= plan.srcSpnStart && r.spn < plan.srcSpnEnd)
    .map((r) => {
      const parsed = parseRaw(VIDEO, r.bytes)!;
      return { pes: r.bytes, dts90: parsed.dts ?? parsed.pts! };
    });
}

/** Runs a collector over the whole clip, in order, and takes every interval as soon as it is ready. */
function collectAll(
  packets: readonly Uint8Array[],
  intervals: readonly IntervalPlan[],
  streams: KeptStreams,
  pcrPid = 0x1001,
  stcStarts: readonly number[] = [],
): IntervalSource[] {
  const collector = new IntervalCollector(streams, { videoPid: VIDEO, pcrPid, intervals, stcStarts });
  const out: IntervalSource[] = [];
  let next = 0;
  packets.forEach((p, spn) => {
    collector.push(p, spn);
    while (next < intervals.length && collector.ready(intervals[next]!)) out.push(collector.take(intervals[next++]!));
  });
  collector.finish();
  while (next < intervals.length) out.push(collector.take(intervals[next++]!));
  return out;
}

function inputFor(plan: IntervalPlan, source: IntervalSource, video: EncodedPes[], extra: Partial<RemuxInput> = {}): RemuxInput {
  return { plan, kept: source.kept, video, videoPid: VIDEO, videoTimeline: source.videoTimeline, pcr: null, endAts: source.endAts, ...extra };
}

function bytesOf(result: ReturnType<typeof remuxInterval>): Uint8Array {
  if (!('bytes' in result)) throw new Error(`overflow ${result.overflow}`);
  return result.bytes;
}

const strip = (p: Uint8Array): Uint8Array => p.subarray(4);

interface Case {
  readonly disc: string;
  readonly streams: () => KeptStreams;
  readonly audioPid: number;
  /** The audio PES a level keeps from the source. */
  readonly keepAudio: (p: PesPacket) => boolean;
  readonly pgPids: readonly number[];
}

const cases: Case[] = [
  {
    disc: 'disc-levels',
    streams: () =>
      new KeptStreams(new Set([0x1200, 0x1201]), new Map([[0x1100, new PesCoreFilter(CodingType.TRUEHD)]]), {
        video: { pid: VIDEO, streamType: CodingType.AVC },
      }),
    audioPid: 0x1100,
    keepAudio: (p) => p.streamIdExtension === 0x76,
    pgPids: [0x1200, 0x1201],
  },
  {
    disc: 'disc-mpeg2',
    // AVC on purpose: the level's video is H.264 (the encoder's output), while the stand-in PES here are the source's MPEG-2.
    streams: () => new KeptStreams(new Set(), new Map([[0x1100, new PesCoreFilter(CodingType.AC3)]]), { video: { pid: VIDEO, streamType: CodingType.AVC } }),
    audioPid: 0x1100,
    keepAudio: () => true,
    pgPids: [],
  },
];

for (const c of cases) {
  // Whole-clip demux and re-mux of the fixture discs: a few seconds locally, up to ~10 s on CI runners.
  describe(`remuxInterval on ${c.disc}`, { timeout: 30_000 }, () => {
    const m2ts = readFileSync(join(fixture(c.disc), 'STREAM/00001.m2ts'));
    const packets = packetsOf(new Uint8Array(m2ts.buffer, m2ts.byteOffset, m2ts.byteLength));
    const clpi = parseClpi(readFileSync(join(fixture(c.disc), 'CLIPINF/00001.clpi')));
    const { intervals } = planClip(clpi, LEVELS['h264-1080'], 192_000, RAW_PLAN);
    const sources = collectAll(packets, intervals, c.streams());
    const outputs = intervals.map((plan, k) => bytesOf(remuxInterval(inputFor(plan, sources[k]!, videoOf(packets, plan)))));

    it('fills every interval to exactly its budget, with a sync byte at 4 + 192n', () => {
      expect(intervals.length).toBeGreaterThan(3);
      intervals.forEach((plan, k) => {
        const out = outputs[k]!;
        expect(out.length).toBe(plan.budgetBytes);
        for (let at = 4; at < out.length; at += PACKET) if (out[at] !== 0x47) throw new Error(`interval ${k}: no sync byte at ${at}`);
      });
    });

    it('never lets the ATS go back within an interval', () => {
      for (const out of outputs) {
        const ats = packetsOf(out).map(atsOf);
        expect(ats.every((a, i) => i === 0 || a >= ats[i - 1]!)).toBe(true);
      }
    });

    it('gives back the video PES (same bytes and DTS), the kept audio PES and the PG PES unchanged', () => {
      intervals.forEach((plan, k) => {
        const { pes } = demux(packetsOf(outputs[k]!));
        const on = (pid: number): PesPacket[] => pes.filter((p) => p.pid === pid);
        const video = on(VIDEO);
        const sourceVideo = pesIn(packets, VIDEO, plan);
        expect(video.length).toBeGreaterThan(0);
        expect(video.map((p) => [p.pts, p.dts])).toEqual(sourceVideo.map((p) => [p.pts, p.dts]));
        expect(video.map((p) => p.payload)).toEqual(sourceVideo.map((p) => p.payload));
        const audio = pesIn(packets, c.audioPid, plan).filter(c.keepAudio);
        expect(on(c.audioPid).map((p) => [p.pts, p.streamIdExtension, p.payload])).toEqual(audio.map((p) => [p.pts, p.streamIdExtension, p.payload]));
        for (const pid of c.pgPids) expect(on(pid)).toEqual(pesIn(packets, pid, plan));
        expect(new Set(pes.map((p) => p.pid))).toEqual(new Set([VIDEO, c.audioPid, ...c.pgPids].filter((pid) => on(pid).length > 0)));
      });
    });

    it('carries every kept packet exactly once, in the order of its assigned SPN', () => {
      intervals.forEach((_, k) => {
        const kept = packetsOf(outputs[k]!).filter((p) => pidOf(p) !== VIDEO && pidOf(p) !== 0x1fff);
        const expected = sources[k]!.kept.map((x, i) => ({ x, i })).sort((a, b) => a.x.spn - b.x.spn || a.i - b.i);
        expect(kept.map(strip)).toEqual(expected.map(({ x }) => strip(x.bytes)));
      });
    });

    it('interleaves the video with the kept packets by DTS, as the source did', () => {
      for (const out of outputs) {
        const kinds = packetsOf(out).filter((p) => pidOf(p) !== 0x1fff).map((p) => (pidOf(p) === VIDEO ? 'v' : 'k'));
        const firstVideo = kinds.indexOf('v');
        const lastVideo = kinds.lastIndexOf('v');
        expect(kinds.slice(firstVideo, lastVideo).includes('k')).toBe(true);
      }
    });

    it('keeps the video PID continuous from one interval to the next, so no frame is lost at a boundary', () => {
      for (const out of outputs) {
        const ccs = packetsOf(out).filter((p) => pidOf(p) === VIDEO).map((p) => p[7]! & 0x0f);
        expect(ccs[0]).toBe(0);
        expect(ccs.at(-1)).toBe(15);
      }
      const all = demux(outputs.flatMap(packetsOf));
      const video = all.pes.filter((p) => p.pid === VIDEO);
      expect(video.map((p) => p.payload)).toEqual(demux(packets).pes.filter((p) => p.pid === VIDEO).map((p) => p.payload));
    });
  });
}

describe('remuxInterval budgets and PSI', () => {
  const m2ts = readFileSync(join(fixture('disc-levels'), 'STREAM/00001.m2ts'));
  const packets = packetsOf(new Uint8Array(m2ts.buffer, m2ts.byteOffset, m2ts.byteLength));
  const clpi = parseClpi(readFileSync(join(fixture('disc-levels'), 'CLIPINF/00001.clpi')));
  const { intervals } = planClip(clpi, LEVELS['h264-1080'], 192_000, RAW_PLAN);
  const sources = collectAll(packets, intervals, cases[0]!.streams());

  it('reports the bytes past the budget, and no bytes, when the content does not fit (Review Focus 1)', () => {
    const plan = { ...intervals[2]!, budgetBytes: 6144 };
    const result = remuxInterval(inputFor(plan, sources[2]!, videoOf(packets, intervals[2]!)));
    expect(result).not.toHaveProperty('bytes');
    const fits = bytesOf(remuxInterval(inputFor(intervals[2]!, sources[2]!, videoOf(packets, intervals[2]!))));
    const content = packetsOf(fits).filter((p) => pidOf(p) !== 0x1fff).length * PACKET;
    expect(result).toEqual({ overflow: content - 6144 });
  });

  it('fits content of exactly the budget with no padding', () => {
    const fits = bytesOf(remuxInterval(inputFor(intervals[2]!, sources[2]!, videoOf(packets, intervals[2]!))));
    const content = packetsOf(fits).filter((p) => pidOf(p) !== 0x1fff).length * PACKET;
    const exact = bytesOf(remuxInterval(inputFor({ ...intervals[2]!, budgetBytes: content }, sources[2]!, videoOf(packets, intervals[2]!))));
    expect(packetsOf(exact).some((p) => pidOf(p) === 0x1fff)).toBe(false);
  });

  it("puts interval 0's leading PAT and PMT before any video, even when the video's ATS is earlier", () => {
    const pat = psiPacket(0, patSection(0x100), 40);
    const pmt = psiPacket(0x100, pmtFor([{ pid: VIDEO, streamType: 0x1b }, { pid: 0x1200, streamType: 0x90 }]), 41);
    const source = { ...sources[0]!, kept: [{ spn: 0, bytes: pat }, { spn: 0, bytes: pmt }, ...sources[0]!.kept] };
    const out = packetsOf(bytesOf(remuxInterval(inputFor(intervals[0]!, source, videoOf(packets, intervals[0]!)))));
    expect(out.slice(0, 2).map(pidOf)).toEqual([0, 0x100]);
    expect(out.findIndex((p) => pidOf(p) === VIDEO)).toBeGreaterThan(1);
    expect(out.map(atsOf).every((a, i, all) => i === 0 || a >= all[i - 1]!)).toBe(true);
  });

  it('places video of other DTS and PES count within the source video\'s arrival range, in order', () => {
    const plan = intervals[2]!;
    const source = pesIn(packets, VIDEO, plan);
    const d0 = source[0]!.dts ?? source[0]!.pts!;
    // Every third frame dropped, DTS stretched by 1.25 and started 50 ms early: some land before the first source PES
    // and some after the last.
    const video = source
      .filter((_, i) => i % 3 !== 2)
      .map((p, i) => {
        const dts = d0 - 4500 + Math.round(i * 1.25 * 3754 * 1.5);
        return { pes: videoPes(dts + 3003, dts, p.payload), dts90: dts };
      });
    expect(video.length).not.toBe(source.length);
    const timeline = sources[2]!.videoTimeline;
    expect(video[0]!.dts90).toBeLessThan(timeline[0]!.dts90);
    expect(video.at(-1)!.dts90).toBeGreaterThan(timeline.at(-1)!.dts90);
    const out = packetsOf(bytesOf(remuxInterval(inputFor(plan, sources[2]!, video))));
    expect(out.map(atsOf).every((a, i, all) => i === 0 || a >= all[i - 1]!)).toBe(true);
    const videoAts = out.filter((p) => pidOf(p) === VIDEO).map(atsOf);
    expect(Math.min(...videoAts)).toBe(timeline[0]!.ats);
    expect(Math.max(...videoAts)).toBe(timeline.at(-1)!.ats);
    const back = demux(out).pes.filter((p) => p.pid === VIDEO);
    expect(back.map((p) => [p.pts, p.dts, p.payload])).toEqual(video.map((v) => [v.dts90 + 3003, v.dts90, parseRaw(VIDEO, v.pes)!.payload]));
  });

  it('orders kept packets by assigned SPN and raises an ATS that would go back', () => {
    const at = (pid: number, ats: number): Uint8Array => {
      const p = new Uint8Array(PACKET).fill(0xff);
      p.set([0x40 | ((ats >>> 24) & 0x3f), (ats >>> 16) & 0xff, (ats >>> 8) & 0xff, ats & 0xff, 0x47, pid >> 8, pid & 0xff, 0x10]);
      return p;
    };
    // A core PES assigned to SPN 10 whose tail arrived at ATS 30, then a PG packet at SPN 12 (ATS 12), given out of order.
    const kept = [
      { spn: 12, bytes: at(0x1200, 12) },
      { spn: 10, bytes: at(0x1100, 10) },
      { spn: 10, bytes: at(0x1100, 30) },
    ];
    const plan = { ...intervals[1]!, budgetBytes: 6144 };
    const out = packetsOf(bytesOf(remuxInterval({ plan, kept, video: [], videoPid: VIDEO, videoTimeline: [], pcr: null })));
    expect(out.slice(0, 3).map((p) => [pidOf(p), atsOf(p)])).toEqual([[0x1100, 10], [0x1100, 30], [0x1200, 30]]);
    expect(out[2]![0]! & 0xc0).toBe(0x40); // copy_permission_indicator kept
    expect(out.slice(0, 3).map(strip)).toEqual([kept[1]!.bytes, kept[2]!.bytes, kept[0]!.bytes].map(strip));
  });

  it('pads with null packets that carry a valid TP_extra_header and run up to the next interval', () => {
    const out = packetsOf(outputs0());
    const nulls = out.filter((p) => pidOf(p) === 0x1fff);
    expect(nulls.length).toBeGreaterThan(0);
    for (const p of nulls) {
      expect(p[0]! & 0xc0).toBe(0);
      expect(p[4]).toBe(0x47);
      expect(p[7]).toBe(0x10);
      expect(p.subarray(8).every((b) => b === 0xff)).toBe(true);
    }
    expect(atsOf(nulls.at(-1)!)).toBeLessThanOrEqual(sources[0]!.endAts!);
  });

  function outputs0(): Uint8Array {
    return bytesOf(remuxInterval(inputFor(intervals[0]!, sources[0]!, videoOf(packets, intervals[0]!))));
  }
});

// Re-muxes every interval of the fixture clip: a few seconds locally, over 5 s on CI runners (as the whole-clip tests above).
describe('remuxInterval with PCR on the video PID', { timeout: 30_000 }, () => {
  // The fixture's ATS counts packets; spread it to a 27 MHz arrival clock over the clip's 10 s, and give the video PID a
  // PCR every 40 ms, as a disc whose PCR rides on its video.
  const m2ts = readFileSync(join(fixture('disc-levels'), 'STREAM/00001.m2ts'));
  const source = packetsOf(new Uint8Array(m2ts.buffer, m2ts.byteOffset, m2ts.byteLength));
  const clpi = parseClpi(readFileSync(join(fixture('disc-levels'), 'CLIPINF/00001.clpi')));
  const { intervals } = planClip(clpi, LEVELS['h264-1080'], 192_000, RAW_PLAN);
  const ticks = Math.floor(270_000_000 / source.length);
  const PCR0 = 600 * 27_000_000; // the STC at the clip's first packet
  let nextPcr = 0;
  const packets = source.map((p, spn) => {
    const q = p.slice();
    const ats = spn * ticks;
    q.set([(ats >>> 24) & 0x3f, (ats >>> 16) & 0xff, (ats >>> 8) & 0xff, ats & 0xff]);
    if (pidOf(q) === VIDEO && (q[7]! & 0x30) === 0x30 && q[8]! >= 7 && ats >= nextPcr) {
      q[9] = 0x10;
      const pcr = PCR0 + ats;
      const base = Math.floor(pcr / 300);
      q.set([Math.floor(base / 2 ** 25) & 0xff, Math.floor(base / 2 ** 17) & 0xff, Math.floor(base / 2 ** 9) & 0xff, Math.floor(base / 2) & 0xff, ((base % 2) << 7) | 0x7e | ((pcr % 300) >> 8), (pcr % 300) & 0xff], 10);
      nextPcr = ats + 1_080_000;
    }
    return q;
  });
  const sources = collectAll(packets, intervals, cases[0]!.streams(), VIDEO);

  const readPcr = (p: Uint8Array): number => {
    const base = p[10]! * 2 ** 25 + p[11]! * 2 ** 17 + p[12]! * 2 ** 9 + p[13]! * 2 + (p[14]! >> 7);
    return base * 300 + (((p[14]! & 1) << 8) | p[15]!);
  };

  it('collects a PCR anchor from the video PID for every interval', () => {
    for (const s of sources) {
      expect(s.pcr).not.toBeNull();
      expect(s.pcr!.pcr27).toBe(PCR0 + s.pcr!.ats);
    }
  });

  it('carries PCR on the video PID from the ATS clock, never more than 100 ms apart, through the padding', () => {
    intervals.forEach((plan, k) => {
      const out = packetsOf(bytesOf(remuxInterval(inputFor(plan, sources[k]!, videoOf(packets, plan), { pcr: sources[k]!.pcr }))));
      const pcrs = out.filter((p) => pidOf(p) === VIDEO && (p[7]! & 0x30) === 0x20);
      expect(pcrs.length).toBeGreaterThan(0);
      for (const p of pcrs) expect(readPcr(p)).toBe(PCR0 + atsOf(p));
      const at = pcrs.map(atsOf);
      expect(at[0]).toBe(atsOf(out[0]!));
      for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeLessThanOrEqual(PCR_PERIOD_27);
      const end = sources[k]!.endAts ?? atsOf(out.at(-1)!);
      expect(end - at.at(-1)!).toBeLessThanOrEqual(PCR_PERIOD_27);
      // Adaptation-only packets don't advance the counter: the demuxer still gets every video PES.
      expect(demux(out).pes.filter((p) => p.pid === VIDEO).map((p) => p.payload)).toEqual(pesIn(packets, VIDEO, plan).map((p) => p.payload));
    });
  });

  it('falls back to the latest earlier PCR in the same STC sequence for an interval without one', () => {
    const plan = intervals[4]!;
    const noPcr = packets.map((p, spn) => {
      if (spn < plan.srcSpnStart || spn >= plan.srcSpnEnd || pidOf(p) !== VIDEO || (p[7]! & 0x20) === 0) return p;
      const q = p.slice();
      q[9] = q[9]! & ~0x10;
      return q;
    });
    const fallback = collectAll(noPcr, intervals, cases[0]!.streams(), VIDEO);
    const lastOf3 = noPcr.findLast((p, spn) => spn < plan.srcSpnStart && pidOf(p) === VIDEO && (p[7]! & 0x20) !== 0 && (p[9]! & 0x10) !== 0)!;
    expect(fallback[4]!.pcr).toEqual({ ats: atsOf(lastOf3), pcr27: PCR0 + atsOf(lastOf3) });
    expect(fallback[5]!.pcr).toEqual(sources[5]!.pcr);
    expect(collectAll(noPcr, intervals, cases[0]!.streams(), VIDEO, [plan.srcSpnStart])[4]!.pcr).toBeNull();
  });

  it('keeps ATS and PCR from going back across an interval end that a kept PES straddles', () => {
    const { plans, k, pes } = straddle(packets, intervals);
    const moved = collectAll(packets, plans, cases[0]!.streams(), VIDEO);
    const outs = [k, k + 1].map((i) => packetsOf(bytesOf(remuxInterval(inputFor(plans[i]!, moved[i]!, videoOf(packets, plans[i]!), { pcr: moved[i]!.pcr })))));
    const endAts = moved[k]!.endAts!;
    expect(atsOf(packets[pes.at(-1)!]!)).toBeGreaterThan(endAts); // the PES's tail arrived after the end
    expect(Math.max(...outs[0]!.map(atsOf))).toBe(endAts);
    const both = outs.flat();
    expect(both.map(atsOf).every((a, i, all) => i === 0 || a >= all[i - 1]!)).toBe(true);
    const pcrs = both.filter((p) => pidOf(p) === VIDEO && (p[7]! & 0x30) === 0x20).map(readPcr);
    expect(pcrs.every((v, i) => i === 0 || v >= pcrs[i - 1]!)).toBe(true);
  });

  it('refuses to rewrite a PMT section that runs past its packet', () => {
    const long = new Uint8Array(200);
    long.set([0x02, 0xb0, 197]);
    const pmt = psiPacket(0x100, long.subarray(0, 183), 0);
    const source = { ...sources[3]!, kept: [{ spn: intervals[3]!.srcSpnStart, bytes: pmt }, ...sources[3]!.kept] };
    expect(() => remuxInterval(inputFor(intervals[3]!, source, videoOf(packets, intervals[3]!), { pcr: source.pcr }))).toThrow(/spans packets/);
  });

  it('names the video PID as PCR_PID in the PMT, with a valid CRC', () => {
    const pmt = psiPacket(0x100, pmtFor([{ pid: VIDEO, streamType: 0x1b }, { pid: 0x1200, streamType: 0x90 }], { pcrPid: 0x1001 }), 0);
    const source = { ...sources[3]!, kept: [{ spn: intervals[3]!.srcSpnStart, bytes: pmt }, ...sources[3]!.kept] };
    const out = packetsOf(bytesOf(remuxInterval(inputFor(intervals[3]!, source, videoOf(packets, intervals[3]!), { pcr: source.pcr }))));
    const section = out.find((p) => pidOf(p) === 0x100)!.subarray(9);
    const length = 3 + (((section[1]! & 0x0f) << 8) | section[2]!);
    expect(((section[8]! & 0x1f) << 8) | section[9]!).toBe(VIDEO);
    expect(mpegCrc32(section.subarray(0, length))).toBe(0);
  });
});

describe('IntervalCollector', () => {
  const m2ts = readFileSync(join(fixture('disc-levels'), 'STREAM/00001.m2ts'));
  const packets = packetsOf(new Uint8Array(m2ts.buffer, m2ts.byteOffset, m2ts.byteLength));
  const clpi = parseClpi(readFileSync(join(fixture('disc-levels'), 'CLIPINF/00001.clpi')));
  const { intervals } = planClip(clpi, LEVELS['h264-1080'], 192_000, RAW_PLAN);

  it('hands each interval exactly the kept packets assigned to it, waiting for the PES that start in it', () => {
    const all: KeptPacket[] = [];
    const streams = cases[0]!.streams();
    for (const [i, p] of packets.entries()) all.push(...streams.filter(p, i));
    all.push(...streams.flush());
    const sources = collectAll(packets, intervals, cases[0]!.streams());
    intervals.forEach((plan, k) => {
      expect(sources[k]!.kept).toEqual(all.filter((x) => x.spn >= plan.srcSpnStart && x.spn < plan.srcSpnEnd));
      expect(sources[k]!.endAts).toBe(plan.srcSpnEnd < packets.length ? atsOf(packets[plan.srcSpnEnd]!) : undefined);
    });
    expect(sources.flatMap((s) => s.kept)).toHaveLength(all.length);
  });

  it('copies the packets it keeps out of the caller’s buffer, and only those', () => {
    const collector = new IntervalCollector(cases[0]!.streams(), { videoPid: VIDEO, pcrPid: 0x1001, intervals });
    const plan = intervals[0]!;
    for (let spn = 0; spn < packets.length && !collector.ready(plan); spn++) collector.push(packets[spn]!, spn);
    const kept = collector.take(plan).kept;
    expect(kept.length).toBeGreaterThan(0);
    // The test's packets are views into the whole file: none of the kept ones may still point into it.
    for (const k of kept) expect(k.bytes.buffer).not.toBe(m2ts.buffer);
    expect(packets[0]!.buffer).toBe(m2ts.buffer);
  });

  it('is not ready until a PES that straddles the interval end is complete, and gives that PES whole to the interval', () => {
    const { plans, k, pes } = straddle(packets, intervals);
    const plan = plans[k]!;
    const collector = new IntervalCollector(cases[0]!.streams(), { videoPid: VIDEO, pcrPid: 0x1001, intervals: plans });
    const last = pes.at(-1)!;
    let spn = 0;
    for (; spn < last; spn++) {
      collector.push(packets[spn]!, spn);
      if (spn >= plan.srcSpnEnd) expect(collector.ready(plan)).toBe(false);
    }
    expect(() => collector.take(plan)).toThrow();
    collector.push(packets[last]!, last);
    expect(collector.ready(plan)).toBe(true);
    const mine = collector.take(plan).kept.map((x) => x.bytes);
    for (const at of pes) expect(mine).toContainEqual(packets[at]!);
    for (spn = last + 1; spn < packets.length && !collector.ready(plans[k + 1]!); spn++) collector.push(packets[spn]!, spn);
    const next = collector.take(plans[k + 1]!).kept.map((x) => x.bytes);
    for (const at of pes) expect(next).not.toContainEqual(packets[at]!);
  });
});

/**
 * The intervals with interval 1's end moved onto the second packet of an AC-3 core PES that starts in it, so the PES
 * straddles the end; `pes` lists that PES's packets' SPNs.
 */
function straddle(packets: readonly Uint8Array[], intervals: readonly IntervalPlan[]): { plans: IntervalPlan[]; k: number; pes: number[] } {
  const k = 1;
  for (const r of rawPes(packets, 0x1100)) {
    if (r.spn < intervals[k]!.srcSpnStart + 50 || r.spn >= intervals[k]!.srcSpnEnd) continue;
    if (parseRaw(0x1100, r.bytes)?.streamIdExtension !== 0x76) continue;
    const pes: number[] = [r.spn];
    for (let i = r.spn + 1; i < packets.length && !(pidOf(packets[i]!) === 0x1100 && packets[i]![5]! & 0x40); i++) if (pidOf(packets[i]!) === 0x1100) pes.push(i);
    if (pes.length < 3) continue;
    const end = pes[1]!;
    const plans = intervals.map((iv, i) => (i === k ? { ...iv, srcSpnEnd: end } : i === k + 1 ? { ...iv, srcSpnStart: end } : iv));
    return { plans, k, pes };
  }
  throw new Error('no AC-3 core PES of 3 packets or more in interval 1');
}

/** An unbounded video PES with a PTS and a DTS. */
function videoPes(pts: number, dts: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(19 + payload.length);
  out.set([0, 0, 1, 0xe0, 0, 0, 0x80, 0xc0, 10]);
  const ts = (at: number, prefix: number, v: number): void => {
    const high = Math.floor(v / 2 ** 30) & 0x07;
    const low = v % 2 ** 30;
    out.set([(prefix << 4) | (high << 1) | 1, (low >>> 22) & 0xff, (((low >>> 15) & 0x7f) << 1) | 1, (low >>> 7) & 0xff, ((low & 0x7f) << 1) | 1], at);
  };
  ts(9, 3, pts);
  ts(14, 1, dts);
  out.set(payload, 19);
  return out;
}

/** A PSI section on one source packet (pointer_field 0, stuffed with 0xFF), at `ats`. */
function psiPacket(pid: number, section: Uint8Array, ats: number): Uint8Array {
  const p = new Uint8Array(PACKET).fill(0xff);
  p.set([(ats >>> 24) & 0x3f, (ats >>> 16) & 0xff, (ats >>> 8) & 0xff, ats & 0xff, 0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, 0], 0);
  p.set(section, 9);
  return p;
}

function patSection(pmtPid: number): Uint8Array {
  const body = [0x00, 0xb0, 0, 0x00, 0x00, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (pmtPid >> 8), pmtPid & 0xff];
  body[2] = body.length - 3 + 4;
  const s = new Uint8Array(body.length + 4);
  s.set(body);
  const crc = mpegCrc32(s.subarray(0, body.length));
  s.set([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff], body.length);
  return s;
}

/**
 * The production failure (an LPCM music disc at phone-720: interval 198, one frame of 0.04 s, overflowed even at the 1 Mbps
 * floor and the read failed with HTTP 500) and the other overflows found on the NAS, against the plan alone: no scan.
 * Byte counts measured on the NAS.
 */
describe('the plan holds what an interval keeps', () => {
  const AUDIO = 0x1100;
  const packet = (pid: number, ats: number, start = false): Uint8Array => {
    const p = new Uint8Array(PACKET);
    p[0] = (ats >>> 24) & 0x3f;
    p[1] = (ats >>> 16) & 0xff;
    p[2] = (ats >>> 8) & 0xff;
    p[3] = ats & 0xff;
    p.set([0x47, (start ? 0x40 : 0) | ((pid >> 8) & 0x1f), pid & 0xff, 0x10], 4);
    return p;
  };
  /** `n` packets per PID, one ATS tick apart, a PES starting every `pes` packets, assigned to the interval's first SPN. */
  const keptOf = (plan: IntervalPlan, counts: ReadonlyArray<[pid: number, n: number]>, pes = 8): KeptPacket[] => {
    const out: KeptPacket[] = [];
    let ats = 0;
    for (const [pid, n] of counts) for (let i = 0; i < n; i++) out.push({ spn: plan.srcSpnStart, bytes: packet(pid, ats++, i % pes === 0) });
    return out;
  };
  const pes = (size: number, dts90: number): EncodedPes => {
    const bytes = new Uint8Array(size);
    bytes.set([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5]);
    return { pes: bytes, dts90 };
  };
  /** An IDR of `idr` bytes, then 23.976 frames sharing what's left of `seconds` at `bps`. */
  const videoAt = (plan: IntervalPlan, bps: number, idr: number): EncodedPes[] => {
    const seconds = (plan.endPts45 - plan.startPts45) / 45_000;
    const n = Math.max(0, Math.floor(seconds * 23.976) - 1);
    const rest = Math.max(0, (seconds * bps) / 8 - idr);
    return [pes(idr, plan.startPts45 * 2), ...Array.from({ length: n }, (_, i) => pes(Math.max(64, Math.floor(rest / Math.max(1, n))), plan.startPts45 * 2 + (i + 1) * 3_754))];
  };
  const clpi = (durations45: readonly number[], pg = 0) => ({
    version: '0200',
    numSourcePackets: durations45.length * 1000,
    recordingRate: 48_000_000,
    atcSequences: [{ spnAtcStart: 0, offsetStcId: 0, stc: [{ pcrPid: VIDEO, spnStcStart: 0, presentationStart: 0, presentationEnd: durations45.reduce((a, b) => a + b, 0) }] }],
    programs: [
      {
        spnProgramSequenceStart: 0,
        programMapPid: 0x100,
        streams: [
          { pid: VIDEO, codingType: 0x1b, format: 6, rate: 1, lang: '', aspect: 3 },
          ...Array.from({ length: pg }, (_, i) => ({ pid: 0x1200 + i, codingType: 0x90, format: 0, rate: 0, lang: 'eng', aspect: 0 })),
        ],
      },
    ],
    epMaps: [{ pid: VIDEO, epStreamType: 1, entries: durations45.map((_, i) => ({ pts: durations45.slice(0, i).reduce((a, b) => a + b, 0), spn: i * 1000 })) }],
  });
  const remuxed = (plan: IntervalPlan, kept: KeptPacket[], video: EncodedPes[], budgetBytes = plan.budgetBytes): RemuxInput => ({
    plan: { ...plan, budgetBytes },
    kept,
    video,
    videoPid: VIDEO,
    videoTimeline: [{ dts90: plan.startPts45 * 2, ats: 0 }],
    pcr: null,
  });
  /** The kept audio of `seconds` at `bps` in source packets. */
  const audioPackets = (seconds: number, bps: number): number => Math.ceil((seconds * bps) / 8 / PACKET);
  const fits = (input: RemuxInput): boolean => 'bytes' in remuxInterval(input);

  it('merges the one-frame interval away: its IDR and its 25 KB of LPCM fit, with the video at the target rate', () => {
    // 0.836 s, then the 0.04 s interval (one frame), then more of 0.836 s.
    const durations = [37_620, 1_800, ...Array(6).fill(37_620)];
    const level = LEVELS['phone-720'];
    const plan = planClip(clpi(durations), level, 2_457_600).intervals[0]!;
    expect(plan.srcSpnEnd).toBeGreaterThan(2000); // interval 1's entry is gone: it lies inside interval 0
    const seconds = (plan.endPts45 - plan.startPts45) / 45_000;
    // The LPCM at 2.4576 Mb/s over the interval, plus the 131 packets the source muxed among the one-frame interval's IDR.
    const kept = keptOf(plan, [[0, 3], [0x100, 6], [AUDIO, audioPackets(seconds, 2_457_600) + 131]]);
    // The rate formula gave interval 1 alone 43 008 bytes, which its kept packets and a floor IDR overflowed by 1 152.
    const alone = keptOf(plan, [[0, 1], [0x100, 2], [AUDIO, 131]]);
    expect(remuxInterval(remuxed(plan, alone, [pes(15_036, plan.startPts45 * 2)], 43_008))).toEqual({ overflow: 1_152 });
    expect(fits(remuxed(plan, kept, videoAt(plan, level.targetBps, 43_151)))).toBe(true);
  });

  it('holds a burst of subtitles on a disc with 11 PG streams (377 KB in 0.63 s) with the video at the floor', () => {
    const level = LEVELS['phone-720'];
    const plan = planClip(clpi([28_350, ...Array(6).fill(45_045)], 11), level, 1_728_000).intervals[0]!;
    const seconds = (plan.endPts45 - plan.startPts45) / 45_000;
    const kept = keptOf(plan, [[0, 22], [0x100, 44], [0x1200, 1962], [AUDIO, audioPackets(seconds, 1_728_000)]]);
    expect(fits(remuxed(plan, kept, videoAt(plan, 1_000_000, 18_000)))).toBe(true);
  });

  it('holds a 768 KB burst in 1 s on a disc with 5 PG streams with the video at the floor', () => {
    const level = LEVELS['phone-720'];
    const plan = planClip(clpi(Array(8).fill(45_045), 5), level, 1_728_000).intervals[0]!;
    const seconds = (plan.endPts45 - plan.startPts45) / 45_000;
    const kept = keptOf(plan, [[0, 22], [0x100, 44], [0x1200, 4000], [AUDIO, audioPackets(seconds, 1_728_000)]]);
    expect(fits(remuxed(plan, kept, videoAt(plan, 1_000_000, 18_000)))).toBe(true);
  });

  it('merges a short last interval with the one before: the audio muxed after the last picture fits', () => {
    // 0.92 s at the end, holding 451 KB of DTS core (2.1 s of it) after the last picture.
    const level = LEVELS['phone-720'];
    const plans = planClip(clpi([...Array(4).fill(45_045), 41_400]), level, 1_728_000).intervals;
    const plan = plans.at(-1)!;
    expect(plan.srcSpnEnd).toBe(5000);
    expect(plan.srcSpnStart).toBeLessThan(4000);
    const seconds = (plan.endPts45 - plan.startPts45) / 45_000;
    const kept = keptOf(plan, [[0, 22], [0x100, 44], [AUDIO, audioPackets(seconds - 0.92, 1_728_000) + 2352]]);
    expect(fits(remuxed(plan, kept, videoAt(plan, 1_000_000, 18_000)))).toBe(true);
  });

  it('drops whole PES of the highest-numbered graphics streams as a last resort, never the video or the audio', () => {
    const level = LEVELS['phone-720'];
    const plan = planClip(clpi(Array(3).fill(45_045), 3), level, 1_728_000, { minInterval45: 0 }).intervals[0]!;
    // Far more subtitles than any budget holds: 2.5 MB on the third stream, 50 KB on the others.
    const lead = { spn: plan.srcSpnStart, bytes: packet(0x1202, 0) }; // the tail of a PES begun in the interval before
    const kept = [lead, ...keptOf(plan, [[0x1200, 260], [0x1201, 260], [0x1202, 13_000], [AUDIO, 300]])];
    const video = videoAt(plan, 1_000_000, 18_000);
    expect(fits(remuxed(plan, kept, video))).toBe(false);
    const shed = shedGraphics(remuxed(plan, kept, video), { pg: [0x1200, 0x1201, 0x1202], ig: [] })!;
    expect(shed.dropped).toEqual([{ pid: 0x1202, kind: 'pg' }]);
    const pids = (bytes: Uint8Array): number[] => packetsOf(bytes).map(pidOf);
    const out = pids(shed.bytes);
    expect(out.filter((p) => p === 0x1202)).toHaveLength(1); // only the tail of the PES that began before
    expect(out.filter((p) => p === AUDIO)).toHaveLength(300);
    expect(out.filter((p) => p === 0x1200)).toHaveLength(260);
    expect(out.filter((p) => p === VIDEO).length).toBeGreaterThan(0);
    // Nothing left to drop that would make room: null.
    expect(shedGraphics(remuxed(plan, keptOf(plan, [[AUDIO, 20_000]]), video), { pg: [0x1200], ig: [] })).toBeNull();
  });

  it('drops every PG stream, highest number first, before any IG stream, and names only streams that lost packets', () => {
    const level = LEVELS['phone-720'];
    const plan = planClip(clpi(Array(3).fill(45_045), 3), level, 1_728_000, { minInterval45: 0 }).intervals[0]!;
    const video = videoAt(plan, 1_000_000, 18_000);
    const order = { pg: [0x1200, 0x1201, 0x1202], ig: [0x1400, 0x1401] };
    // PG 0x1201 has nothing in this interval; the PG streams together and IG 0x1401 overflow it, IG 0x1400 alone fits.
    const base: Array<[number, number]> = [[AUDIO, 300], [0x1400, 400], [0x1401, 5_000], [0x1200, 600], [0x1202, 600]];
    const shed = shedGraphics(remuxed(plan, keptOf(plan, base), video), order)!;
    expect(shed.dropped).toEqual([
      { pid: 0x1202, kind: 'pg' },
      { pid: 0x1200, kind: 'pg' },
      { pid: 0x1401, kind: 'ig' },
    ]);
    const out = packetsOf(shed.bytes).map(pidOf);
    expect(out.filter((p) => p === 0x1400)).toHaveLength(400); // the lowest-numbered menu stays
    // When dropping the PG streams is enough, no IG is touched.
    const pgOnly = shedGraphics(remuxed(plan, keptOf(plan, [[AUDIO, 300], [0x1400, 400], [0x1202, 5_000]]), video), order)!;
    expect(pgOnly.dropped).toEqual([{ pid: 0x1202, kind: 'pg' }]);
  });
});
