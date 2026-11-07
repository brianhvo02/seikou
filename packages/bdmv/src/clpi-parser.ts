/*
 * Ported from libbluray src/libbluray/bdnav/clpi_parse.c
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2012-2013  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ByteReader, ParseError } from './byte-reader';
import { CodingType, isAudioCoding, isVideoCoding } from './stream-types';
import { checkVersion } from './version';

/** Ported from libbluray bdnav/clpi_parse.c (clip info, sequence info, program info, CPI/EP map). */
export interface StcSequence {
  readonly pcrPid: number;
  readonly spnStcStart: number;
  readonly presentationStart: number;
  readonly presentationEnd: number;
}

export interface AtcSequence {
  readonly spnAtcStart: number;
  readonly offsetStcId: number;
  readonly stc: readonly StcSequence[];
}

export interface ProgramStream {
  readonly pid: number;
  readonly codingType: number;
  readonly format: number;
  readonly rate: number;
  readonly lang: string;
  /** Video aspect ratio code; 0 for other streams. */
  readonly aspect: number;
}

export interface ProgramInfo {
  readonly spnProgramSequenceStart: number;
  readonly programMapPid: number;
  readonly streams: readonly ProgramStream[];
}

export interface EpEntry {
  /** 45 kHz; the low 8 bits are not stored on disc. */
  readonly pts: number;
  readonly spn: number;
}

export interface EpMap {
  readonly pid: number;
  readonly epStreamType: number;
  readonly entries: readonly EpEntry[];
}

export interface Clpi {
  readonly version: string;
  readonly numSourcePackets: number;
  /** TS_recording_rate, bytes per second. */
  readonly recordingRate: number;
  readonly atcSequences: readonly AtcSequence[];
  readonly programs: readonly ProgramInfo[];
  readonly epMaps: readonly EpMap[];
}

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

/** Source packets [startSpn, endSpn) belonging to one STC sequence (one continuous PTS timeline). */
export interface SpnRange {
  readonly startSpn: number;
  readonly endSpn: number;
}

const WHOLE_CLIP: SpnRange = { startSpn: 0, endSpn: Infinity };

/** The SPN range of a play item's STC sequence (libbluray clpi_find_stc_spn); the whole clip if unknown. */
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

/** Last entry with pts ≤ target; the first entry if the target precedes all entries; undefined if empty. */
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

/** First entry with pts > target, or undefined. */
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
