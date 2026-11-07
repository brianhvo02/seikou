import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClpi } from '@seikou/bdmv/clpi-parser';
import { buildClpi } from '../../../tests/helpers/bdmv-builders';
import { rewriteClpi } from './clpi-writer';
import type { IntervalPlan } from './levels';
import { LEVELS, maxBudgetRate, planClip } from './levels';

const FIXTURES = join(import.meta.dirname, '../../../fixtures/synthetic');
const read = (path: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, path)));

describe('rewriteClpi', () => {
  it('rewrites an MPEG-2 1080i clip as H.264 1080p with the planned EP map and size (Review Focus 3)', () => {
    const bytes = read('disc-mpeg2/BDMV/CLIPINF/00001.clpi');
    const before = parseClpi(bytes);
    const level = LEVELS['h264-1080'];
    const plan = planClip(before, level, 448_000);
    const out = rewriteClpi(bytes, { intervals: plan.intervals, level, keepPids: [], audio: { streamNumber: 1, pid: 0x1100, coding: 0x81 }, videoPid: 0x1011, newCoding: 0x1b, newFormat: 6, newRate: 4 });
    const after = parseClpi(out);

    const video = after.programs[0]!.streams.find((s) => s.pid === 0x1011)!;
    expect(video).toMatchObject({ codingType: 0x1b, format: 6, rate: 4, aspect: before.programs[0]!.streams[0]!.aspect });
    expect(after.programs[0]!.streams.map((s) => s.pid)).toEqual([0x1011, 0x1100]);
    expect(after.epMaps).toHaveLength(1);
    expect(after.epMaps[0]!.pid).toBe(0x1011);
    // One entry per interval: the entries the plan kept (it merges short intervals), at their own PTS.
    expect(after.epMaps[0]!.entries.map((e) => e.pts)).toEqual(plan.intervals.map((iv) => iv.startPts45));
    const original = new Set(before.epMaps[0]!.entries.map((e) => e.pts));
    expect(after.epMaps[0]!.entries.every((e) => original.has(e.pts))).toBe(true);
    expect(after.epMaps[0]!.entries.map((e) => e.spn)).toEqual(plan.intervals.map((iv) => iv.spnStart));
    expect(after.numSourcePackets).toBe(plan.sizeBytes / 192);
    expect(after.atcSequences).toEqual(before.atcSequences);
    expect(after.programs[0]!.streams[1]).toEqual(before.programs[0]!.streams[1]); // AC-3 stays as it is
  });

  it('drops the commentary and picture-in-picture streams and keeps the PG streams (Review Focus 4)', () => {
    const bytes = read('disc-levels/BDMV/CLIPINF/00001.clpi');
    const before = parseClpi(bytes);
    const level = LEVELS['phone-720'];
    const plan = planClip(before, level, 640_000);
    const out = rewriteClpi(bytes, { intervals: plan.intervals, level, keepPids: [0x1200, 0x1201], audio: { streamNumber: 1, pid: 0x1100, coding: 0x83 }, videoPid: 0x1011, newCoding: 0x1b, newFormat: 5, newRate: 1 });
    const streams = parseClpi(out).programs[0]!.streams;
    expect(streams.map((s) => s.pid)).toEqual([0x1011, 0x1100, 0x1200, 0x1201]);
    expect(streams.find((s) => s.pid === 0x1011)).toMatchObject({ codingType: 0x1b, format: 5, rate: 1 });
    const pg = before.programs[0]!.streams.filter((s) => s.codingType === 0x90);
    expect(streams.filter((s) => s.codingType === 0x90)).toEqual(pg);
    // the TrueHD track travels as its AC-3 core: same channel layout and language, 48 kHz
    const truehd = before.programs[0]!.streams.find((s) => s.pid === 0x1100)!;
    expect(truehd.codingType).toBe(0x83);
    expect(streams.find((s) => s.pid === 0x1100)).toEqual({ ...truehd, codingType: 0x81, rate: 1 });
  });

  it('sets the recording rate to the highest budget rate of the intervals of 0.5 s or more, counted in 188-byte packets', () => {
    const bytes = read('disc-levels/BDMV/CLIPINF/00001.clpi');
    const before = parseClpi(bytes);
    const level = LEVELS['h264-1080'];
    const plan = planClip(before, level, 640_000);
    const out = parseClpi(rewriteClpi(bytes, { intervals: plan.intervals, level, keepPids: [], audio: { streamNumber: 1, pid: 0x1100, coding: 0x83 }, videoPid: 0x1011, newCoding: 0x1b, newFormat: 6, newRate: 1 }));
    const expected = Math.max(
      ...plan.intervals
        .filter((iv) => iv.endPts45 - iv.startPts45 >= 22_500)
        .map((iv) => Math.ceil(((iv.budgetBytes / 192) * 188 * 45_000) / (iv.endPts45 - iv.startPts45))),
    );
    expect(out.recordingRate).toBe(expected);
    expect(maxBudgetRate(plan.intervals)).toBe(expected);
    // at least the level's budget rate (peak + audio + graphics allowance) in TS bytes, never the source's 48 MB/s
    expect(out.recordingRate).toBeGreaterThanOrEqual((((level.peakBps + 640_000 + 1_500_000) / 8) * 188) / 192);
    expect(out.recordingRate).toBeLessThan(before.recordingRate);
  });

  it('leaves a short last interval out of the recording rate', () => {
    const iv = (index: number, start: number, end: number, budgetBytes: number) => ({ index, startPts45: start, endPts45: end, srcSpnStart: index, srcSpnEnd: index + 1, budgetBytes, spnStart: index * 1000 });
    const intervals = [iv(0, 0, 45_000, 192 * 1000), iv(1, 45_000, 45_000 + 4_500, 6144)]; // 0.1 s, one unit: a high rate
    expect(maxBudgetRate(intervals)).toBe(188 * 1000);
    expect(maxBudgetRate([intervals[1]!])).toBe(Math.ceil((32 * 188 * 45_000) / 4_500)); // nothing longer: it counts
  });

  it('keeps no audio when the clip has none to keep', () => {
    const bytes = read('disc-mpeg2/BDMV/CLIPINF/00001.clpi');
    const level = LEVELS['h264-1080'];
    const plan = planClip(parseClpi(bytes), level, 0);
    const out = parseClpi(rewriteClpi(bytes, { intervals: plan.intervals, level, keepPids: [], audio: null, videoPid: 0x1011, newCoding: 0x1b, newFormat: 6, newRate: 4 }));
    expect(out.programs[0]!.streams.map((s) => s.pid)).toEqual([0x1011]);
  });

  it("keeps the angle change points but not the source's I_end_position_offset on the video's fine entries", () => {
    const bytes = read('disc-mpeg2/BDMV/CLIPINF/00001.clpi').slice();
    const fine = fineEntries(bytes);
    fine.forEach((at, i) => (bytes[at] = (bytes[at]! & 0x0f) | (i % 4 === 2 ? 0xf0 : 0x70)));
    const level = LEVELS['h264-1080'];
    const plan = planClip(parseClpi(bytes), level, 0);
    const out = rewriteClpi(bytes, { intervals: plan.intervals, level, keepPids: [], audio: null, videoPid: 0x1011, newCoding: 0x1b, newFormat: 6, newRate: 4 });
    // The plan merges short intervals: each kept entry keeps its own source entry's angle change point.
    const sourcePts = parseClpi(bytes).epMaps[0]!.entries.map((e) => e.pts);
    const kept = plan.intervals.map((iv) => sourcePts.indexOf(iv.startPts45));
    expect(fineEntries(out).map((at) => out[at]! >> 4)).toEqual(kept.map((i) => (i % 4 === 2 ? 0x8 : 0)));
    expect(kept.some((i) => i % 4 === 2)).toBe(true);
    expect(kept.length).toBeLessThan(sourcePts.length);
  });

  it('refuses a plan whose interval starts at no EP entry of the clip', () => {
    const bytes = read('disc-mpeg2/BDMV/CLIPINF/00001.clpi');
    const level = LEVELS['h264-1080'];
    const plan = planClip(parseClpi(bytes), level, 0);
    const moved = plan.intervals.map((iv, i) => (i === 1 ? { ...iv, startPts45: iv.startPts45 + 1 } : iv));
    expect(() =>
      rewriteClpi(bytes, { intervals: moved, level, keepPids: [], audio: null, videoPid: 0x1011, newCoding: 0x1b, newFormat: 6, newRate: 4 }),
    ).toThrow(/no EP entry/);
  });

  it('is byte-identical at the original level', () => {
    const bytes = read('disc-levels/BDMV/CLIPINF/00001.clpi');
    expect(rewriteClpi(bytes, { level: 'original' })).toEqual(bytes);
  });

  it('writes back the same CPI and program info when nothing changes (identity plan)', () => {
    for (const path of ['disc-mpeg2/BDMV/CLIPINF/00001.clpi', 'disc-levels/BDMV/CLIPINF/00001.clpi']) {
      const bytes = read(path);
      const c = parseClpi(bytes);
      const entries = c.epMaps[0]!.entries;
      const intervals: IntervalPlan[] = entries.map((e, i) => {
        const next = entries[i + 1];
        const end = next ? next.spn : c.numSourcePackets;
        return { index: i, startPts45: e.pts, endPts45: next ? next.pts : e.pts, srcSpnStart: e.spn, srcSpnEnd: end, budgetBytes: (end - e.spn) * 192, spnStart: e.spn };
      });
      // the last interval ends at numSourcePackets, so the size is unchanged
      const video = c.programs[0]!.streams[0]!;
      const keepPids = c.programs[0]!.streams.map((s) => s.pid);
      const out = rewriteClpi(bytes, { intervals, level: LEVELS['h264-1080'], keepPids, audio: null /* every stream kept as it is */, videoPid: video.pid, newCoding: video.codingType, newFormat: video.format, newRate: video.rate });
      // the identity plan's first interval starts at its EP entry, not at packet 0, so only the
      // sequence and program starts (packet 0) move; everything else is the same bytes
      expect(out.length).toBe(bytes.length);
      expect(section(out, 16)).toEqual(section(bytes, 16));
      expect(section(out, 12).subarray(10)).toEqual(section(bytes, 12).subarray(10));
      // the header and ClipInfo match except TS_recording_rate (bytes 52–55), which the plan sets
      expect(out.subarray(0, 52)).toEqual(bytes.subarray(0, 52));
      expect(out.subarray(56, u32(bytes, 8))).toEqual(bytes.subarray(56, u32(bytes, 8)));
      expect(parseClpi(out).programs[0]!.spnProgramSequenceStart).toBe(entries[0]!.spn);
    }
  });

  it('opens a new coarse entry when the PTS high bits or the SPN above 17 bits change', () => {
    const entries = [
      { pts: 0x7_fe00, spn: 0x1_ff00 },
      { pts: 0x8_0a00, spn: 0x1_ff80 }, // PTS crosses bit 19
      { pts: 0x8_1400, spn: 0x2_0010 }, // SPN crosses bit 17
      { pts: 0x8_1e00, spn: 0x2_0100 },
      { pts: 0x1234_5600, spn: 0x9_0000 }, // both
    ];
    const bytes = buildClpi({
      numSourcePackets: 0xa_0000,
      streams: [{ pid: 0x1011, codingType: 0x1b }],
      presentationStart: entries[0]!.pts,
      presentationEnd: 0x1234_5600 + 45_000,
      epMaps: [{ pid: 0x1011, entries }],
    });
    const before = parseClpi(bytes);
    expect(before.epMaps[0]!.entries).toEqual(entries);
    // move every entry across a different boundary in the new layout
    const newSpns = [0, 0x1_fff0, 0x2_0000, 0x3_ffff, 0x4_0001];
    const intervals: IntervalPlan[] = entries.map((e, i) => ({
      index: i,
      startPts45: e.pts,
      endPts45: entries[i + 1]?.pts ?? e.pts + 45_000,
      srcSpnStart: e.spn,
      srcSpnEnd: entries[i + 1]?.spn ?? 0xa_0000,
      budgetBytes: ((newSpns[i + 1] ?? 0x4_0001 + 32) - newSpns[i]!) * 192,
      spnStart: newSpns[i]!,
    }));
    const out = rewriteClpi(bytes, { intervals, level: LEVELS['h264-1080'], keepPids: [], audio: null, videoPid: 0x1011, newCoding: 0x1b, newFormat: 6, newRate: 1 });
    const after = parseClpi(out);
    expect(after.epMaps[0]!.entries).toEqual(entries.map((e, i) => ({ pts: e.pts, spn: newSpns[i] })));
    expect(after.numSourcePackets).toBe(0x4_0001 + 32);
  });

  it('keeps the clip mark and moves the extension data, dropping only its 3D entries', () => {
    const base = read('disc-levels/BDMV/CLIPINF/00001.clpi');
    const withExt = appendExtension(base, [
      { id1: 1, id2: 2, data: Uint8Array.of(0, 0, 0, 2, 0xaa, 0xbb) },
      { id1: 2, id2: 5, data: Uint8Array.of(0, 0, 0, 2, 0xcc, 0xdd) },
    ]);
    const c = parseClpi(withExt);
    const level = LEVELS['h264-1080'];
    const plan = planClip(c, level, 640_000);
    const out = rewriteClpi(withExt, { intervals: plan.intervals, level, keepPids: [], audio: null, videoPid: 0x1011, newCoding: 0x1b, newFormat: 6, newRate: 1 });
    const extAt = u32(out, 24);
    expect(extAt).toBeGreaterThan(0);
    expect(out[extAt + 11]).toBe(1); // one entry left
    expect([...out.subarray(extAt + 12, extAt + 16)]).toEqual([0, 1, 0, 2]);
    const start = u32(out, extAt + 16);
    expect([...out.subarray(extAt + start, extAt + start + 6)]).toEqual([0, 0, 0, 2, 0xaa, 0xbb]);
    // clip mark is copied at its new address
    const markAt = u32(out, 20);
    expect([...out.subarray(markAt, markAt + 4)]).toEqual([...base.subarray(u32(base, 20), u32(base, 20) + 4)]);
  });
});

/** Offsets of the first PID's fine EP entries. */
function fineEntries(b: Uint8Array): number[] {
  const cpi = u32(b, 16);
  const epMap = cpi + 6;
  const fineCount = u32(b, epMap + 2 + 4) & 0x3ffff;
  const stream = epMap + u32(b, epMap + 2 + 8);
  const first = stream + u32(b, stream);
  return Array.from({ length: fineCount }, (_, i) => first + 4 * i);
}

/** The section whose start address is at header offset `at`. */
function section(b: Uint8Array, at: number): Uint8Array {
  const start = u32(b, at);
  return b.subarray(start, start + 4 + u32(b, start));
}

function u32(b: Uint8Array, at: number): number {
  return new DataView(b.buffer, b.byteOffset).getUint32(at);
}

/** The CLPI with an extension data block of these entries appended and its address set. */
function appendExtension(clpi: Uint8Array, entries: Array<{ id1: number; id2: number; data: Uint8Array }>): Uint8Array {
  const table = 12 + 12 * entries.length;
  const dataLen = entries.reduce((n, e) => n + e.data.length, 0);
  const block = new Uint8Array(table + dataLen);
  const v = new DataView(block.buffer);
  v.setUint32(0, block.length - 4);
  v.setUint32(4, table);
  block[11] = entries.length;
  let at = table;
  entries.forEach((e, i) => {
    v.setUint16(12 + 12 * i, e.id1);
    v.setUint16(14 + 12 * i, e.id2);
    v.setUint32(16 + 12 * i, at);
    v.setUint32(20 + 12 * i, e.data.length);
    block.set(e.data, at);
    at += e.data.length;
  });
  const out = new Uint8Array(clpi.length + block.length);
  out.set(clpi);
  out.set(block, clpi.length);
  new DataView(out.buffer).setUint32(24, clpi.length);
  return out;
}
