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

/**
 * One stream of a play item's STN table: where the stream is and what it holds. It mirrors libbluray `MPLS_STREAM`
 * (`mpls_data.h`), read by `_parse_stream` in `mpls_parse.c`; the Dolby Vision and HDR fields libbluray also reads for
 * HEVC are not kept.
 */
export interface StreamEntry {
  /** `pid`: the transport stream PID of the stream in its clip. */
  readonly pid: number;
  /** `coding_type`: the stream's codec, one of `CodingType`. */
  readonly codingType: number;
  /** `format`: for video the video format code (such as 1080p), for audio the channel layout code; 0 otherwise. */
  readonly format: number;
  /** `rate`: for video the frame rate code, for audio the sample rate code; 0 otherwise. */
  readonly rate: number;
  /** `lang`: the ISO 639-2 language code of audio, PG, IG and text subtitle streams; empty for video. */
  readonly lang: string;
  /** `char_code`: the character code of a text subtitle stream (coding type 0x92); 0 otherwise. */
  readonly charCode: number;
  /** True when the entry names a sub-path (stream_type 2, 3 or 4) instead of the play item's own clip (stream_type 1). */
  readonly subPath: boolean;
  /** STN stream_type: 1 main clip, 2 sub-path clip, 3 and 4 other sub-path streams. libbluray's IG lookup treats only 2 as a sub-path IG. */
  readonly streamType: number;
  /** STN subpath_id (stream_type 2, 3, 4); 0 for main-path entries. */
  readonly subPathId: number;
  /** STN subclip_id (stream_type 2); 0 otherwise. */
  readonly subClipId: number;
}

/**
 * A play item's STN table (stream number table): the streams a player may select while the item plays, in stream
 * number order, so `audio[0]` is audio stream number 1. It mirrors libbluray `MPLS_STN` (`mpls_data.h`), read by
 * `_parse_stn`. libbluray keeps PG and PiP PG entries in one `pg` array (the `num_pg` entries, then the `num_pip_pg`
 * ones); here they are split. The secondary streams' reference lists and the Dolby Vision entries are skipped.
 */
export interface StnTable {
  /** Primary video streams (`num_video`). */
  readonly video: readonly StreamEntry[];
  /** Primary audio streams (`num_audio`). */
  readonly audio: readonly StreamEntry[];
  /** Presentation graphics (subtitle) and text subtitle streams (`num_pg`). */
  readonly pg: readonly StreamEntry[];
  /** Interactive graphics (menu) streams (`num_ig`). */
  readonly ig: readonly StreamEntry[];
  /** Picture-in-picture presentation graphics streams (`num_pip_pg`). */
  readonly pipPg: readonly StreamEntry[];
  /** Secondary audio streams (`num_secondary_audio`). */
  readonly secondaryAudio: readonly StreamEntry[];
  /** Secondary (picture-in-picture) video streams (`num_secondary_video`). */
  readonly secondaryVideo: readonly StreamEntry[];
}

/**
 * One play item: a stretch of one clip that the playlist plays. It mirrors libbluray `MPLS_PI` (`mpls_data.h`), read
 * by `_parse_playitem` in `mpls_parse.c`.
 */
export interface PlayItem {
  /** `clip[0].clip_id`: the 5-digit name of the clip, `BDMV/CLIPINF/<clipId>.clpi` and `BDMV/STREAM/<clipId>.m2ts`. */
  readonly clipId: string;
  /** `clip[0].codec_id`: `M2TS` (libbluray also accepts `FMTS`). */
  readonly codecId: string;
  /**
   * `connection_condition`: how this item joins the previous one, 1 for a non-seamless join, 5 and 6 for seamless
   * joins (libbluray `navigation.c` `_fill_clip` then starts reading the clip at packet 0).
   */
  readonly connectionCondition: number;
  /** `clip[0].stc_id`: the STC sequence of the clip that `inTime` and `outTime` refer to (see `stcSpnRange`). */
  readonly stcId: number;
  /** `in_time`: where the item starts, in 45 kHz clip time. */
  readonly inTime: number;
  /** `out_time`: where the item ends, in 45 kHz clip time (exclusive). */
  readonly outTime: number;
  /** `uo_mask`: the 8 bytes of the item's user-operation mask table as stored (libbluray decodes them in `uo_mask_parse`). */
  readonly uoMask: Uint8Array;
  /** `still_mode`: 0 for no still, 1 for a still of `stillTime` seconds, 2 for an infinite still (`bd_still_mode_e`). */
  readonly stillMode: number;
  /** `still_time`: the still's length in seconds when `stillMode` is 1; 0 otherwise. */
  readonly stillTime: number;
  /** `is_multi_angle`: the item has more than one camera angle. */
  readonly isMultiAngle: boolean;
  /** `angle_count`: 1 for single-angle items (and for a stored 0, as libbluray). */
  readonly angleCount: number;
  /** `clip[1..].clip_id`: the clips of angles 2 and up, in order; empty for single-angle items. */
  readonly angleClipIds: readonly string[];
  /** `stn`: the streams selectable while this item plays. */
  readonly stn: StnTable;
}

/**
 * One sub play item: a stretch of a clip that a sub-path plays beside the main path, such as an out-of-mux IG menu or
 * text subtitle. It mirrors libbluray `MPLS_SUB_PI` (`mpls_data.h`), read by `_parse_subplayitem` in `mpls_parse.c`;
 * only the first clip of a multi-clip item is kept.
 */
export interface SubPlayItem {
  /** `clip[0].clip_id`: the 5-digit name of the clip. */
  readonly clipId: string;
  /** `clip[0].codec_id`: `M2TS` (libbluray also accepts `FMTS`). */
  readonly codecId: string;
  /** `connection_condition`: how this item joins the previous one, 1 non-seamless, 5 and 6 seamless. */
  readonly connectionCondition: number;
  /** `is_multi_clip`: the item names more than one clip; the others are not kept. */
  readonly isMultiClip: boolean;
  /** `clip[0].stc_id`: the STC sequence of the clip that `inTime` and `outTime` refer to. */
  readonly stcId: number;
  /** `in_time`: where the item starts, in 45 kHz clip time. */
  readonly inTime: number;
  /** `out_time`: where the item ends, in 45 kHz clip time. */
  readonly outTime: number;
  /** `sync_play_item_id`: the main-path play item this item starts in. */
  readonly syncPlayItemId: number;
  /** `sync_pts`: the 45 kHz time within that play item's clip where this item starts. */
  readonly syncPts: number;
}

/**
 * One sub-path of a playlist: a second timeline of clips played beside the main path. It mirrors libbluray `MPLS_SUB`
 * (`mpls_data.h`), read by `_parse_subpath` in `mpls_parse.c`.
 */
export interface SubPath {
  /**
   * `type` (`mpls_sub_path_type`): 2 the audio of a browsable slideshow, 3 an interactive graphics menu, 4 a text
   * subtitle, 5 out-of-mux synchronous streams, 6 asynchronous and 7 synchronous picture-in-picture, 8 stereoscopic
   * video, 10 a Dolby Vision enhancement layer.
   */
  readonly type: number;
  /** `is_repeat`: the sub-path's items repeat. */
  readonly isRepeat: boolean;
  /** `sub_play_item`: the sub-path's items in order. */
  readonly items: readonly SubPlayItem[];
}

/**
 * One playlist mark, libbluray `MPLS_PLM` (`mpls_data.h`), read by `_parse_playlistmark` in `mpls_parse.c`. Entry marks
 * are the chapters.
 */
export interface PlayListMark {
  /** `mark_type`: one of `MarkType`, 1 for an entry mark (a chapter) and 2 for a link point. */
  readonly type: number;
  /** `play_item_ref`: the index of the play item the mark lies in. */
  readonly playItemRef: number;
  /** `time`: the mark's 45 kHz clip time within the referenced play item. */
  readonly time: number;
  /** `entry_es_pid`: the elementary stream PID the mark is bound to. */
  readonly entryEsPid: number;
  /** `duration`: the mark's duration in 45 kHz ticks, as stored. */
  readonly duration: number;
}

/** A parsed `BDMV/PLAYLIST/*.mpls` playlist, libbluray `MPLS_PL` (`mpls_data.h`). Its extension data is not read. */
export interface Mpls {
  /** The four version characters after the `MPLS` signature, such as `0200`. */
  readonly version: string;
  /** `MPLS_AI.playback_type`; libbluray reads a `playback_count` after it when the value is 2 or 3. */
  readonly playbackType: number;
  /** `MPLS_AI.uo_mask`: the 8 bytes of the playlist's user-operation mask table as stored. */
  readonly uoMask: Uint8Array;
  /** `play_item`: the main path, in play order. */
  readonly playItems: readonly PlayItem[];
  /** `sub_path`: the sub-paths, in file order (a stream's `subPathId` indexes this). */
  readonly subPaths: readonly SubPath[];
  /** `play_mark`: the marks in file order; empty when the file has no mark section. */
  readonly marks: readonly PlayListMark[];
}

/** `PlayListMark.type` values, libbluray `BD_MARK_ENTRY` and `BD_MARK_LINK`. */
export const MarkType = { ENTRY: 1, LINK: 2 } as const;

/**
 * Parses the bytes of a `.mpls` playlist (libbluray `_parse_playlist` and `_parse_playlistmark`). Throws a ParseError
 * for a bad signature, an unsupported version, a play item shorter than 18 bytes, a sub play item shorter than 24
 * bytes, or a read past the end of the file.
 *
 * @example ../examples/parse-mpls.ts#parse
 */
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
