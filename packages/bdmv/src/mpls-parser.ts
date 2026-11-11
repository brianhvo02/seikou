/*
 * Ported from libbluray src/libbluray/bdnav/mpls_parse.c
 * Copyright (C) 2009-2010  John Stebbins
 * Copyright (C) 2012  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ByteReader, ParseError } from './byte-reader';
import { CodingType, isAudioCoding, isVideoCoding } from './stream-types';
import { checkVersion } from './version';

/** Ported from libbluray bdnav/mpls_parse.c (playlist, play items, STN, marks). */
export interface StreamEntry {
  readonly pid: number;
  readonly codingType: number;
  readonly format: number;
  readonly rate: number;
  readonly lang: string;
  /** Text subtitle character code (coding type 0x92); 0 otherwise. */
  readonly charCode: number;
  /** True for streams carried in a sub-path clip (stream_type 2–4); M1 plays main-path streams only. */
  readonly subPath: boolean;
  /** STN stream_type: 1 main clip, 2 sub-path clip, 3 and 4 other sub-path streams. libbluray's IG lookup treats only 2 as a sub-path IG. */
  readonly streamType: number;
  /** STN subpath_id (stream_type 2, 3, 4); 0 for main-path entries. */
  readonly subPathId: number;
  /** STN subclip_id (stream_type 2); 0 otherwise. */
  readonly subClipId: number;
}

export interface StnTable {
  readonly video: readonly StreamEntry[];
  readonly audio: readonly StreamEntry[];
  readonly pg: readonly StreamEntry[];
  readonly ig: readonly StreamEntry[];
  readonly pipPg: readonly StreamEntry[];
  readonly secondaryAudio: readonly StreamEntry[];
  readonly secondaryVideo: readonly StreamEntry[];
}

export interface PlayItem {
  readonly clipId: string;
  readonly codecId: string;
  readonly connectionCondition: number;
  readonly stcId: number;
  /** 45 kHz clip time. */
  readonly inTime: number;
  /** 45 kHz clip time (exclusive). */
  readonly outTime: number;
  readonly uoMask: Uint8Array;
  readonly stillMode: number;
  readonly stillTime: number;
  readonly isMultiAngle: boolean;
  /** pi->angle_count: 1 for single-angle items. */
  readonly angleCount: number;
  readonly angleClipIds: readonly string[];
  readonly stn: StnTable;
}

/** Ported from libbluray mpls_parse.c _parse_subplayitem (MPLS_SUB_PI); only the first clip of a multi-clip item is kept. */
export interface SubPlayItem {
  readonly clipId: string;
  readonly codecId: string;
  readonly connectionCondition: number;
  readonly isMultiClip: boolean;
  readonly stcId: number;
  /** 45 kHz clip time. */
  readonly inTime: number;
  readonly outTime: number;
  readonly syncPlayItemId: number;
  readonly syncPts: number;
}

/** Ported from libbluray mpls_parse.c _parse_subpath (MPLS_SUB). */
export interface SubPath {
  readonly type: number;
  readonly isRepeat: boolean;
  readonly items: readonly SubPlayItem[];
}

export interface PlayListMark {
  readonly type: number;
  readonly playItemRef: number;
  /** 45 kHz clip time within the referenced play item. */
  readonly time: number;
  readonly entryEsPid: number;
  readonly duration: number;
}

export interface Mpls {
  readonly version: string;
  readonly playbackType: number;
  readonly uoMask: Uint8Array;
  readonly playItems: readonly PlayItem[];
  readonly subPaths: readonly SubPath[];
  readonly marks: readonly PlayListMark[];
}

export const MarkType = { ENTRY: 1, LINK: 2 } as const;

export function parseMpls(bytes: Uint8Array): Mpls {
  const r = new ByteReader(bytes);
  const signature = r.ascii(4);
  const version = r.ascii(4);
  if (signature !== 'MPLS') throw new ParseError(`mpls: bad signature "${signature}"`);
  checkVersion('mpls', version);
  const listPos = r.u32();
  const markPos = r.u32();
  r.u32(); // extension data position

  r.seek(40);
  const appInfoLength = r.u32();
  const appInfoStart = r.position;
  r.skip(1);
  const playbackType = r.u8();
  r.skip(2);
  const uoMask = r.take(8).slice();
  r.seek(appInfoStart + appInfoLength);

  r.seek(listPos);
  r.u32(); // length
  r.skip(2);
  const itemCount = r.u16();
  const subPathCount = r.u16();
  const playItems: PlayItem[] = [];
  for (let i = 0; i < itemCount; i++) playItems.push(readPlayItem(r));
  const subPaths: SubPath[] = [];
  for (let i = 0; i < subPathCount; i++) subPaths.push(readSubPath(r));

  return { version, playbackType, uoMask, playItems, subPaths, marks: readMarks(r, markPos) };
}

function readSubPath(r: ByteReader): SubPath {
  const length = r.u32();
  const end = r.position + length;
  r.skip(1);
  const type = r.u8();
  r.skipBits(15);
  const isRepeat = r.flag();
  r.skip(1);
  const count = r.u8();
  const items: SubPlayItem[] = [];
  for (let i = 0; i < count; i++) items.push(readSubPlayItem(r));
  r.seek(end);
  return { type, isRepeat, items };
}

function readSubPlayItem(r: ByteReader): SubPlayItem {
  const length = r.u16();
  if (length < 24) throw new ParseError(`mpls: sub play item length ${length} is too short`); // as libbluray
  const start = r.position;
  const clipId = r.ascii(5);
  const codecId = r.ascii(4);
  r.skipBits(27);
  const connectionCondition = r.bits(4);
  const isMultiClip = r.flag();
  const stcId = r.u8();
  const inTime = r.u32();
  const outTime = r.u32();
  const syncPlayItemId = r.u16();
  const syncPts = r.u32();
  r.seek(start + length); // the extra clips of a multi-clip item are not used
  return { clipId, codecId, connectionCondition, isMultiClip, stcId, inTime, outTime, syncPlayItemId, syncPts };
}

function readPlayItem(r: ByteReader): PlayItem {
  const length = r.u16();
  if (length < 18) throw new ParseError(`mpls: play item length ${length} is too short`); // as libbluray
  const start = r.position;
  const clipId = r.ascii(5);
  const codecId = r.ascii(4);
  r.skipBits(11);
  const isMultiAngle = r.flag();
  const connectionCondition = r.bits(4);
  const stcId = r.u8();
  const inTime = r.u32();
  const outTime = r.u32();
  const uoMask = r.take(8).slice();
  r.skip(1); // random_access_flag + reserved
  const stillMode = r.u8();
  const stillTimeField = r.u16();
  const angleClipIds: string[] = [];
  let angleCount = 1;
  if (isMultiAngle) {
    angleCount = Math.max(1, r.u8());
    r.skip(1);
    for (let a = 1; a < angleCount; a++) {
      angleClipIds.push(r.ascii(5));
      r.skip(4 + 1); // codec id, stc id
    }
  }
  const stn = readStn(r);
  r.seek(start + length);
  return {
    clipId,
    codecId,
    connectionCondition,
    stcId,
    inTime,
    outTime,
    uoMask,
    stillMode,
    stillTime: stillMode === 1 ? stillTimeField : 0,
    isMultiAngle,
    angleCount,
    angleClipIds,
    stn,
  };
}

function readStn(r: ByteReader): StnTable {
  const length = r.u16();
  const start = r.position;
  r.skip(2);
  const videoCount = r.u8();
  const audioCount = r.u8();
  const pgCount = r.u8();
  const igCount = r.u8();
  const secondaryAudioCount = r.u8();
  const secondaryVideoCount = r.u8();
  const pipPgCount = r.u8();
  r.skip(5); // num_dv, reserved
  const readMany = (n: number, extra?: () => void): StreamEntry[] =>
    Array.from({ length: n }, () => {
      const s = readStream(r);
      extra?.();
      return s;
    });
  const refs = (): void => {
    const n = r.u8();
    r.skip(1 + n + (n % 2));
  };
  const video = readMany(videoCount);
  const audio = readMany(audioCount);
  const pg = readMany(pgCount);
  const pipPg = readMany(pipPgCount);
  const ig = readMany(igCount);
  const secondaryAudio = readMany(secondaryAudioCount, refs);
  const secondaryVideo = readMany(secondaryVideoCount, () => {
    refs();
    refs();
  });
  r.seek(start + length);
  return { video, audio, pg, ig, pipPg, secondaryAudio, secondaryVideo };
}

function readStream(r: ByteReader): StreamEntry {
  const entryLength = r.u8();
  const entryStart = r.position;
  const streamType = r.u8();
  let pid = 0;
  let subPathId = 0;
  let subClipId = 0;
  switch (streamType) {
    case 1:
      pid = r.u16();
      break;
    case 2:
      subPathId = r.u8();
      subClipId = r.u8();
      pid = r.u16();
      break;
    case 3:
    case 4:
      subPathId = r.u8();
      pid = r.u16();
      break;
    default:
      break;
  }
  r.seek(entryStart + entryLength);

  const attrLength = r.u8();
  const attrStart = r.position;
  const codingType = r.u8();
  let format = 0;
  let rate = 0;
  let lang = '';
  let charCode = 0;
  if (isVideoCoding(codingType)) {
    format = r.bits(4);
    rate = r.bits(4);
  } else if (isAudioCoding(codingType)) {
    format = r.bits(4);
    rate = r.bits(4);
    lang = r.ascii(3);
  } else if (codingType === CodingType.PG || codingType === CodingType.IG) {
    lang = r.ascii(3);
  } else if (codingType === CodingType.TEXT_SUBTITLE) {
    charCode = r.u8();
    lang = r.ascii(3);
  }
  r.seek(attrStart + attrLength);
  return { pid, codingType, format, rate, lang, charCode, subPath: streamType !== 1, streamType, subPathId, subClipId };
}

function readMarks(r: ByteReader, markPos: number): PlayListMark[] {
  if (markPos === 0) return [];
  r.seek(markPos);
  r.u32(); // length
  const count = r.u16();
  const marks: PlayListMark[] = [];
  for (let i = 0; i < count; i++) {
    r.skip(1);
    const type = r.u8();
    const playItemRef = r.u16();
    const time = r.u32();
    const entryEsPid = r.u16();
    const duration = r.u32();
    marks.push({ type, playItemRef, time, entryEsPid, duration });
  }
  return marks;
}
