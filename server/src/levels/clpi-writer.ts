/*
 * Writes a clip information file (.clpi) for a quality level. The structure follows how libbluray
 * reads it (src/libbluray/bdnav/clpi_parse.c, extdata_parse.c) and how packages/bdmv/src/clpi-parser.ts
 * ports that; sections this rewrite doesn't touch are copied byte for byte.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { parseClpi } from '@seikou/bdmv/clpi-parser';
import type { EpEntry } from '@seikou/bdmv/clpi-parser';
import { CodingType } from '@seikou/bdmv/stream-types';
import type { IntervalPlan, KeptAudio, LevelDef } from './levels';
import { AUDIO_RATE_48K, SOURCE_PACKET_BYTES, coreCoding, mapSpn, mapSpnDown, maxBudgetRate } from './levels';
import { BeWriter, readU16, readU32, rebuildSections, sectionBytes, writeU32 } from './sections';

export type ClpiRewrite =
  | { readonly level: 'original' }
  | {
      readonly intervals: readonly IntervalPlan[];
      readonly level: LevelDef;
      /** The graphics streams kept (PG, IG); the video and `audio` are kept besides. */
      readonly keepPids: readonly number[];
      /** The clip's kept audio (`keptAudioFor`), carried as its core; null keeps none. */
      readonly audio: KeptAudio | null;
      readonly videoPid: number;
      readonly newCoding: number;
      readonly newFormat: number;
      readonly newRate: number;
    };

/** Header offsets of the section start addresses. */
const SEQUENCE_AT = 8;
const PROGRAM_AT = 12;
const CPI_AT = 16;
const CLIP_MARK_AT = 20;
const EXTENSION_AT = 24;
/** ClipInfo's number_of_source_packets (ClipInfo starts at 40). */
const RECORDING_RATE_AT = 52;
const NUM_SOURCE_PACKETS_AT = 56;
/** is_angle_change_point among a fine entry's 4 leading bits. */
const ANGLE_CHANGE_POINT = 0x8;

/**
 * The CLPI of a clip at a level: the video's EP map regenerated from the plan, dropped streams
 * gone from the program info, the video's coding, format and rate set, the kept audio's coding
 * set to its core, the recording rate and source packet count set, sequence and program starts moved to their new packets, and every section address fixed.
 * At `original` it is the file unchanged.
 */
export function rewriteClpi(original: Uint8Array, plan: ClpiRewrite): Uint8Array {
  if (plan.level === 'original') return original.slice();
  const { intervals, videoPid } = plan;
  if (intervals.length === 0) throw new Error('levels: an empty plan');
  const last = intervals.at(-1)!;
  const numSourcePackets = last.spnStart + last.budgetBytes / SOURCE_PACKET_BYTES;
  const keep = new Set([videoPid, ...plan.keepPids]);
  if (plan.audio) keep.add(plan.audio.pid);
  const parsed = parseClpi(original);

  const replace = new Map<number, Uint8Array | null>();
  const seqAt = readU32(original, SEQUENCE_AT);
  if (seqAt) replace.set(SEQUENCE_AT, rewriteSequenceInfo(sectionBytes(original, seqAt), intervals));
  const progAt = readU32(original, PROGRAM_AT);
  if (progAt) replace.set(PROGRAM_AT, rewriteProgramInfo(sectionBytes(original, progAt), intervals, keep, plan));
  const cpiAt = readU32(original, CPI_AT);
  if (cpiAt) {
    const cpi = sectionBytes(original, cpiAt);
    const maps = parsed.epMaps
      .filter((m) => keep.has(m.pid))
      .map((m) => ({
        pid: m.pid,
        epStreamType: m.epStreamType,
        entries:
          m.pid === videoPid
            ? planEntries(intervals)
            : m.entries.map((e) => ({ pts: e.pts, spn: mapSpnDown(intervals, e.spn) })),
        // I_end_position_offset describes the source's pictures, so only angle change points stay on the video
        flags: m.pid === videoPid ? keptFlags(m.entries, intervals, fineFlags(cpi, m.pid)).map((f) => f & ANGLE_CHANGE_POINT) : fineFlags(cpi, m.pid),
      }));
    replace.set(CPI_AT, writeCpi(cpi, maps));
  }
  const extAt = readU32(original, EXTENSION_AT);
  if (extAt) replace.set(EXTENSION_AT, rewriteExtension(sectionBytes(original, extAt)));

  const out = rebuildSections(original, [SEQUENCE_AT, PROGRAM_AT, CPI_AT, CLIP_MARK_AT, EXTENSION_AT], replace);
  const recordingRate = maxBudgetRate(intervals);
  if (recordingRate > 0) writeU32(out, RECORDING_RATE_AT, recordingRate);
  writeU32(out, NUM_SOURCE_PACKETS_AT, numSourcePackets);
  return out;
}

/** The primary video's entries at the level: one per interval (the plan merges short intervals, so it may have fewer). */
function planEntries(intervals: readonly IntervalPlan[]): EpEntry[] {
  return intervals.map((iv) => ({ pts: iv.startPts45, spn: iv.spnStart }));
}

/** SequenceInfo with each ATC and STC sequence's first packet moved to the level's layout. */
function rewriteSequenceInfo(section: Uint8Array, intervals: readonly IntervalPlan[]): Uint8Array {
  const out = section.slice();
  let at = 5;
  const atcCount = out[at++]!;
  for (let i = 0; i < atcCount; i++) {
    writeU32(out, at, mapSpn(intervals, readU32(out, at)));
    const stcCount = out[at + 4]!;
    at += 6;
    for (let j = 0; j < stcCount; j++) {
      writeU32(out, at + 2, mapSpn(intervals, readU32(out, at + 2)));
      at += 14;
    }
  }
  return out;
}

/**
 * The coding attributes (after their length byte) of `pid`'s stream in a CLPI's ProgramInfo, as a view into `clpi`, or
 * null. For HEVC video the fourth byte holds dynamic_range_type (high 4 bits) and color_space (libbluray clpi_parse.c,
 * _parse_stream_attr).
 */
export function clpiStreamAttrs(clpi: Uint8Array, pid: number): Uint8Array | null {
  const progAt = readU32(clpi, PROGRAM_AT);
  if (!progAt) return null;
  const section = sectionBytes(clpi, progAt);
  const programCount = section[5]!;
  let at = 6;
  for (let p = 0; p < programCount; p++) {
    const streamCount = section[at + 6]!;
    at += 8;
    for (let s = 0; s < streamCount; s++) {
      const length = section[at + 2]!;
      if (readU16(section, at) === pid) return section.subarray(at + 3, at + 3 + length);
      at += 3 + length;
    }
  }
  return null;
}

/** Whether a CLPI's HEVC video stream is HDR: a non-zero dynamic_range_type (0 is SDR). False for any other coding. */
export function clpiVideoIsHdr(clpi: Uint8Array, pid: number): boolean {
  const attrs = clpiStreamAttrs(clpi, pid);
  return attrs !== null && attrs[0] === CodingType.HEVC && attrs.length > 3 && attrs[3]! >> 4 !== 0;
}

/** ProgramInfo with only the kept streams, the video's coding attributes set. */
function rewriteProgramInfo(
  section: Uint8Array,
  intervals: readonly IntervalPlan[],
  keep: ReadonlySet<number>,
  plan: { videoPid: number; newCoding: number; newFormat: number; newRate: number; audio: KeptAudio | null },
): Uint8Array {
  const w = new BeWriter();
  w.u32(0).bytes(section.subarray(4, 6)); // length, reserved
  const programCount = section[5]!;
  let at = 6;
  for (let p = 0; p < programCount; p++) {
    const streamCount = section[at + 6]!;
    w.u32(mapSpn(intervals, readU32(section, at))).u16(readU16(section, at + 4));
    const countAt = w.position;
    w.u8(0).u8(section[at + 7]!); // num_streams (patched), num_groups
    at += 8;
    let kept = 0;
    for (let s = 0; s < streamCount; s++) {
      const pid = readU16(section, at);
      const end = at + 3 + section[at + 2]!;
      if (keep.has(pid)) {
        const entry = section.slice(at, end);
        if (pid === plan.videoPid) setVideoAttrs(entry.subarray(3), plan, true);
        else if (pid === plan.audio?.pid) setAudioCoding(entry.subarray(3), coreCoding(plan.audio.coding));
        w.bytes(entry);
        kept++;
      }
      at = end;
    }
    w.patchU8(countAt, kept);
  }
  const out = w.toBytes();
  writeU32(out, 0, out.length - 4);
  return out;
}

/**
 * Sets coding type, format and rate in a stream's coding attributes (after its length byte). A
 * video that stops being HEVC loses the HEVC-only bits (cr_flag, dynamic range, colour space,
 * HDR10+), which are reserved for the other codings. `clpi` marks the CLPI layout, whose third
 * byte holds the aspect ratio and oc_flag ahead of cr_flag.
 */
export function setVideoAttrs(attr: Uint8Array, video: { newCoding: number; newFormat: number; newRate: number }, clpi: boolean): void {
  const wasHevc = attr[0] === CodingType.HEVC;
  attr[0] = video.newCoding;
  attr[1] = ((video.newFormat & 0x0f) << 4) | (video.newRate & 0x0f);
  if (!wasHevc || video.newCoding === CodingType.HEVC) return;
  if (clpi) {
    if (attr.length > 2) attr[2]! &= 0xfe;
    attr.fill(0, 3, Math.min(attr.length, 5));
  } else {
    attr.fill(0, 2, Math.min(attr.length, 4));
  }
}

/**
 * Sets an audio stream's coding type in its coding attributes (after the length byte), keeping
 * the channel layout and language. A stream reduced to its core is 48 kHz, so its rate code
 * changes with it.
 */
export function setAudioCoding(attr: Uint8Array, newCoding: number): void {
  if (attr[0] === newCoding) return;
  attr[0] = newCoding;
  attr[1] = (attr[1]! & 0xf0) | AUDIO_RATE_48K;
}

/** The fine-entry bits of the source entries the plan's intervals start at (it merges short intervals, dropping entries). */
function keptFlags(entries: readonly EpEntry[], intervals: readonly IntervalPlan[], flags: readonly number[]): number[] {
  let j = 0;
  return intervals.map((iv, i) => {
    while (j < entries.length && !(entries[j]!.pts === iv.startPts45 && (i === 0 || entries[j]!.spn === iv.srcSpnStart))) j++;
    if (j === entries.length) throw new Error(`levels: interval ${i} starts at no EP entry of the clip (PTS ${iv.startPts45})`);
    return flags[j] ?? 0;
  });
}

/** The 4 leading bits (is_angle_change_point, I_end_position_offset) of each fine entry of a PID. */
function fineFlags(cpi: Uint8Array, pid: number): number[] {
  if (readU32(cpi, 0) === 0) return [];
  const epMapStart = 6;
  const pidCount = cpi[epMapStart + 1]!;
  for (let i = 0; i < pidCount; i++) {
    const h = epMapStart + 2 + 12 * i;
    if (readU16(cpi, h) !== pid) continue;
    const fineCount = readU32(cpi, h + 4) & 0x3ffff;
    const streamStart = epMapStart + readU32(cpi, h + 8);
    const fineStart = streamStart + readU32(cpi, streamStart);
    return Array.from({ length: fineCount }, (_, f) => cpi[fineStart + 4 * f]! >>> 4);
  }
  return [];
}

interface MapToWrite {
  readonly pid: number;
  readonly epStreamType: number;
  readonly entries: readonly EpEntry[];
  /** Per entry, the fine entry's leading 4 bits to keep; 0 where there is none. */
  readonly flags: readonly number[];
}

/**
 * The CPI section with these EP maps. A coarse entry opens whenever the PTS bits above the fine
 * entry's (45 kHz bit 19 up) or the SPN bits above the low 17 change, which is what libbluray's
 * reading of coarse plus fine entries recovers.
 */
function writeCpi(original: Uint8Array, maps: readonly MapToWrite[]): Uint8Array {
  const w = new BeWriter();
  w.u32(0);
  if (readU32(original, 0) === 0 && maps.length === 0) return w.toBytes();
  w.bytes(original.subarray(4, 6)); // reserved, CPI_type
  const epMapStart = w.position;
  w.u8(0).u8(maps.length);
  const groups = maps.map((m) => groupEntries(m.entries));
  const addrAt: number[] = [];
  maps.forEach((m, i) => {
    w.u16(m.pid).bits(10, 0).bits(4, m.epStreamType).bits(16, groups[i]!.length).bits(18, m.entries.length);
    addrAt.push(w.position);
    w.u32(0);
  });
  maps.forEach((m, i) => {
    const streamStart = w.position;
    w.patchU32(addrAt[i]!, streamStart - epMapStart);
    w.u32(4 + 8 * groups[i]!.length);
    for (const c of groups[i]!) {
      const e = m.entries[c]!;
      w.bits(18, c).bits(14, Math.floor(e.pts / 2 ** 18) & 0x3fff).u32(e.spn);
    }
    m.entries.forEach((e, f) => {
      w.bits(4, m.flags[f] ?? 0).bits(11, Math.floor(e.pts / 2 ** 8) & 0x7ff).bits(17, e.spn & 0x1ffff);
    });
  });
  const out = w.toBytes();
  writeU32(out, 0, out.length - 4);
  return out;
}

/** The indexes of the entries that open a coarse entry. */
function groupEntries(entries: readonly EpEntry[]): number[] {
  const starts: number[] = [];
  let key = '';
  entries.forEach((e, i) => {
    const k = `${Math.floor(e.pts / 2 ** 19)}:${Math.floor(e.spn / 0x20000)}`;
    if (k !== key) starts.push(i);
    key = k;
  });
  return starts;
}

/**
 * Extension data without the 3D entries (2.4 extent start points, 2.5 ProgramInfo SS, 2.6 CPI SS),
 * which describe the MVC dependent view every level drops; null when nothing is left. Unchanged
 * when there is nothing to drop.
 */
function rewriteExtension(section: Uint8Array): Uint8Array | null {
  const count = section[11]!;
  const entries = Array.from({ length: count }, (_, i) => {
    const at = 12 + 12 * i;
    return { id1: readU16(section, at), id2: readU16(section, at + 2), start: readU32(section, at + 4), length: readU32(section, at + 8) };
  });
  const kept = entries.filter((e) => !(e.id1 === 2 && (e.id2 === 4 || e.id2 === 5 || e.id2 === 6)));
  if (kept.length === entries.length) return section;
  if (kept.length === 0) return null;
  const table = 12 + 12 * kept.length;
  const w = new BeWriter();
  w.u32(0).u32(table).bytes(section.subarray(8, 11)).u8(kept.length);
  let dataAt = table;
  for (const e of kept) {
    w.u16(e.id1).u16(e.id2).u32(dataAt).u32(e.length);
    dataAt += e.length;
  }
  for (const e of kept) w.bytes(section.subarray(e.start, e.start + e.length));
  const out = w.toBytes();
  writeU32(out, 0, out.length - 4);
  return out;
}
