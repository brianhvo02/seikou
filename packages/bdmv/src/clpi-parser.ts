/*
 * Ported from libbluray src/libbluray/bdnav/clpi_parse.c
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2012-2013  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ByteReader, ParseError } from './byte-reader';
import { CodingType, isAudioCoding, isVideoCoding } from './stream-types';
import { checkVersion } from './version';

/**
 * One STC sequence of a clip: a run of source packets with one continuous system time clock, so PTS values within it
 * do not jump. It mirrors libbluray `CLPI_STC_SEQ` (`clpi_data.h`), read by `_parse_sequence` in `clpi_parse.c`.
 */
export interface StcSequence {
  /** `pcr_pid`: the PID that carries the program clock reference. */
  readonly pcrPid: number;
  /** `spn_stc_start`: the first source packet number of the sequence. */
  readonly spnStcStart: number;
  /** `presentation_start_time`: the first presentation time of the sequence, 45 kHz. */
  readonly presentationStart: number;
  /** `presentation_end_time`: the end of the sequence's presentation, 45 kHz. */
  readonly presentationEnd: number;
}

/**
 * One ATC sequence of a clip: a run of source packets whose arrival time stamps are continuous, holding one or more
 * STC sequences. It mirrors libbluray `CLPI_ATC_SEQ` (`clpi_data.h`), read by `_parse_sequence`.
 */
export interface AtcSequence {
  /** `spn_atc_start`: the first source packet number of the sequence. */
  readonly spnAtcStart: number;
  /** `offset_stc_id`: the stc_id of `stc[0]`; a play item's `stcId` minus it indexes `stc`. */
  readonly offsetStcId: number;
  /** `stc_seq`: the STC sequences in order. */
  readonly stc: readonly StcSequence[];
}

/**
 * One elementary stream of a clip's program, libbluray `CLPI_PROG_STREAM` (`clpi_data.h`), read by
 * `_parse_stream_attr` in `clpi_parse.c`. The HDR fields, `oc_flag`, `char_code` and `isrc` are not kept.
 */
export interface ProgramStream {
  /** `pid`: the transport stream PID of the stream. */
  readonly pid: number;
  /** `coding_type`: the stream's codec, one of `CodingType`. */
  readonly codingType: number;
  /** `format`: for video the video format code, for audio the channel layout code; 0 otherwise. */
  readonly format: number;
  /** `rate`: for video the frame rate code, for audio the sample rate code; 0 otherwise. */
  readonly rate: number;
  /** `lang`: the ISO 639-2 language code of audio and graphics streams; empty for video. */
  readonly lang: string;
  /** `aspect`: the video aspect ratio code; 0 for other streams. */
  readonly aspect: number;
}

/**
 * One program sequence of a clip: from a source packet on, which PMT and streams the transport stream carries. It
 * mirrors libbluray `CLPI_PROG` (`clpi_data.h`), read by `_parse_program`.
 */
export interface ProgramInfo {
  /** `spn_program_sequence_start`: the first source packet number the program applies to. */
  readonly spnProgramSequenceStart: number;
  /** `program_map_pid`: the PID of the program map table. */
  readonly programMapPid: number;
  /** `streams`: the program's elementary streams. */
  readonly streams: readonly ProgramStream[];
}

/**
 * One entry point of an EP map: a place where decoding can start (a video key frame), as its presentation time and
 * the source packet it starts at. libbluray keeps the coarse and fine halves (`CLPI_EP_COARSE`, `CLPI_EP_FINE`) and
 * joins them in `clpi_lookup_spn`; here they are joined at parse time with the same arithmetic.
 */
export interface EpEntry {
  /** The entry's PTS in 45 kHz clip time; the low 8 bits are not stored on disc, so they are always 0. */
  readonly pts: number;
  /** The source packet number, counted from the start of the clip's `.m2ts` file in 192-byte packets. */
  readonly spn: number;
}

/**
 * The EP map of one stream (`CLPI_EP_MAP_ENTRY`, read by `_parse_cpi` and `_parse_ep_map_stream`): the entry points
 * seeks go through, sorted by PTS within each STC sequence.
 */
export interface EpMap {
  /** `pid`: the stream the entry points belong to. */
  readonly pid: number;
  /** `ep_stream_type`: the kind of stream the map indexes, as stored. */
  readonly epStreamType: number;
  /** Every entry point, coarse and fine halves joined, in file order. */
  readonly entries: readonly EpEntry[];
}

/** A parsed `BDMV/CLIPINF/*.clpi` clip information file, libbluray `CLPI_CL` (`clpi_data.h`). */
export interface Clpi {
  /** The four version characters after the `HDMV` signature, such as `0200`. */
  readonly version: string;
  /** `CLPI_CLIP_INFO.num_source_packets`: the clip's length in 192-byte source packets. */
  readonly numSourcePackets: number;
  /** `CLPI_CLIP_INFO.ts_recording_rate`: the clip's transport stream rate in bytes per second. */
  readonly recordingRate: number;
  /** `CLPI_SEQ_INFO.atc_seq`: the clip's ATC sequences. */
  readonly atcSequences: readonly AtcSequence[];
  /** `CLPI_PROG_INFO.progs`: the clip's program sequences. */
  readonly programs: readonly ProgramInfo[];
  /** `CLPI_CPI.entry`: one EP map per indexed stream; empty when the clip has no CPI or its type is not EP map (1). */
  readonly epMaps: readonly EpMap[];
}

/**
 * Parses the bytes of a `.clpi` clip information file (libbluray `_clpi_parse`: `_parse_clipinfo`, `_parse_sequence`,
 * `_parse_program`, `_parse_cpi`). Throws a ParseError for a bad signature, an unsupported version, a read past the end
 * of the file, or a coarse EP entry whose fine entries lie outside the fine table. The clip marks, the extension data
 * and the 3D extensions are not read.
 */
export function parseClpi(bytes: Uint8Array): Clpi {
  const r = new ByteReader(bytes);
  const signature = r.ascii(4);
  const version = r.ascii(4);
  if (signature !== 'HDMV') throw new ParseError(`clpi: bad signature "${signature}"`);
  checkVersion('clpi', version);
  const sequenceStart = r.u32();
  const programStart = r.u32();
  const cpiStart = r.u32();
  r.u32(); // clip mark
  r.u32(); // extension data

  r.seek(40);
  r.u32(); // ClipInfo length
  r.skip(2);
  r.u8(); // clip_stream_type
  r.u8(); // application_type
  r.skip(4); // reserved + is_atc_delta
  const recordingRate = r.u32();
  const numSourcePackets = r.u32();

  return {
    version,
    numSourcePackets,
    recordingRate,
    atcSequences: readSequenceInfo(r, sequenceStart),
    programs: readProgramInfo(r, programStart),
    epMaps: readCpi(r, cpiStart),
  };
}

function readSequenceInfo(r: ByteReader, start: number): AtcSequence[] {
  r.seek(start);
  r.u32();
  r.skip(1);
  const atcCount = r.u8();
  const atcs: AtcSequence[] = [];
  for (let i = 0; i < atcCount; i++) {
    const spnAtcStart = r.u32();
    const stcCount = r.u8();
    const offsetStcId = r.u8();
    const stc: StcSequence[] = [];
    for (let j = 0; j < stcCount; j++) {
      const pcrPid = r.u16();
      const spnStcStart = r.u32();
      const presentationStart = r.u32();
      const presentationEnd = r.u32();
      stc.push({ pcrPid, spnStcStart, presentationStart, presentationEnd });
    }
    atcs.push({ spnAtcStart, offsetStcId, stc });
  }
  return atcs;
}

function readProgramInfo(r: ByteReader, start: number): ProgramInfo[] {
  r.seek(start);
  r.u32();
  r.skip(1);
  const programCount = r.u8();
  const programs: ProgramInfo[] = [];
  for (let i = 0; i < programCount; i++) {
    const spnProgramSequenceStart = r.u32();
    const programMapPid = r.u16();
    const streamCount = r.u8();
    r.u8(); // num_groups
    const streams: ProgramStream[] = [];
    for (let j = 0; j < streamCount; j++) {
      const pid = r.u16();
      const length = r.u8();
      const attrStart = r.position;
      const codingType = r.u8();
      let format = 0;
      let rate = 0;
      let lang = '';
      let aspect = 0;
      if (isVideoCoding(codingType)) {
        format = r.bits(4);
        rate = r.bits(4);
        aspect = r.bits(4);
      } else if (isAudioCoding(codingType)) {
        format = r.bits(4);
        rate = r.bits(4);
        lang = r.ascii(3);
      } else if (codingType === CodingType.PG || codingType === CodingType.IG || codingType === 0xa0) {
        // 0xa0: read like the graphics streams, as libbluray's clpi _parse_stream_attr does
        lang = r.ascii(3);
      } else if (codingType === CodingType.TEXT_SUBTITLE) {
        r.skip(1);
        lang = r.ascii(3);
      }
      r.seek(attrStart + length);
      streams.push({ pid, codingType, format, rate, lang, aspect });
    }
    programs.push({ spnProgramSequenceStart, programMapPid, streams });
  }
  return programs;
}

function readCpi(r: ByteReader, start: number): EpMap[] {
  if (start === 0) return [];
  r.seek(start);
  const length = r.u32();
  if (length === 0) return [];
  r.skipBits(12);
  const cpiType = r.bits(4);
  if (cpiType !== 1) return [];
  const epMapStart = r.position;
  r.skip(1);
  const pidCount = r.u8();
  const headers: Array<{ pid: number; epStreamType: number; coarseCount: number; fineCount: number; start: number }> = [];
  for (let i = 0; i < pidCount; i++) {
    const pid = r.u16();
    r.skipBits(10);
    const epStreamType = r.bits(4);
    const coarseCount = r.bits(16);
    const fineCount = r.bits(18);
    const start = epMapStart + r.u32();
    headers.push({ pid, epStreamType, coarseCount, fineCount, start });
  }
  return headers.map((h) => {
    r.seek(h.start);
    const fineStart = r.u32();
    const coarse: Array<{ ref: number; pts: number; spn: number }> = [];
    for (let i = 0; i < h.coarseCount; i++) {
      const ref = r.bits(18);
      const pts = r.bits(14);
      const spn = r.u32();
      coarse.push({ ref, pts, spn });
    }
    r.seek(h.start + fineStart);
    const fine: Array<{ pts: number; spn: number }> = [];
    for (let i = 0; i < h.fineCount; i++) {
      r.skipBits(4); // is_angle_change_point, i_end_position_offset
      const pts = r.bits(11);
      const spn = r.bits(17);
      fine.push({ pts, spn });
    }
    const entries: EpEntry[] = [];
    coarse.forEach((c, ci) => {
      const end = ci + 1 < coarse.length ? coarse[ci + 1].ref : fine.length;
      if (c.ref > end || end > fine.length) {
        throw new ParseError(
          `clpi: pid 0x${h.pid.toString(16)} coarse entry ${ci} fine range ${c.ref}..${end} outside ${fine.length} fine entries`,
        );
      }
      for (let fi = c.ref; fi < end; fi++) {
        entries.push({
          pts: Math.floor(c.pts / 2) * 2 * 2 ** 18 + fine[fi].pts * 2 ** 8,
          spn: Math.floor(c.spn / 0x20000) * 0x20000 + fine[fi].spn,
        });
      }
    });
    return { pid: h.pid, epStreamType: h.epStreamType, entries };
  });
}

/**
 * Source packets [startSpn, endSpn) belonging to one STC sequence (one continuous PTS timeline).
 * @internal
 */
export interface SpnRange {
  readonly startSpn: number;
  readonly endSpn: number;
}

const WHOLE_CLIP: SpnRange = { startSpn: 0, endSpn: Infinity };

/**
 * The SPN range of a play item's STC sequence (after libbluray `clpi_find_stc_spn`, which returns only the start):
 * from the sequence's first packet up to the next sequence's first packet. The whole clip when `stcId` names no
 * sequence.
 * @internal
 */
export function stcSpnRange(clip: Clpi, stcId: number): SpnRange {
  for (const atc of clip.atcSequences) {
    const k = stcId - atc.offsetStcId;
    if (k >= 0 && k < atc.stc.length) {
      const next = atc.stc[k + 1];
      return { startSpn: atc.stc[k].spnStcStart, endSpn: next ? next.spnStcStart : Infinity };
    }
  }
  return WHOLE_CLIP;
}

function entriesIn(map: EpMap, range: SpnRange): readonly EpEntry[] {
  return range === WHOLE_CLIP ? map.entries : map.entries.filter((e) => e.spn >= range.startSpn && e.spn < range.endSpn);
}

/**
 * The last entry with pts ≤ `pts45` (45 kHz clip time) among the entries inside `range`; the first entry if the target
 * precedes all of them; undefined if there are none. Entries must ascend by PTS within the range.
 * @internal
 */
export function findEpBefore(map: EpMap, pts45: number, range: SpnRange = WHOLE_CLIP): EpEntry | undefined {
  const entries = entriesIn(map, range);
  let lo = 0;
  let hi = entries.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].pts <= pts45) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return entries[Math.max(found, 0)];
}

/**
 * The first entry with pts > `pts45` (45 kHz clip time) among the entries inside `range`, or undefined.
 * @internal
 */
export function findEpAfter(map: EpMap, pts45: number, range: SpnRange = WHOLE_CLIP): EpEntry | undefined {
  const entries = entriesIn(map, range);
  let lo = 0;
  let hi = entries.length; // binary search for the first pts > target (entries ascend within one STC sequence)
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].pts > pts45) hi = mid;
    else lo = mid + 1;
  }
  return entries[lo];
}
