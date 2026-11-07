import { CodingType, isAudioCoding, isVideoCoding } from '@seikou/bdmv/stream-types';
import { ByteWriter } from './byte-writer';

export type IndexObjectSpec =
  | { kind: 'hdmv'; movieObjectId: number; playbackType?: number }
  | { kind: 'bdj'; name: string; playbackType?: number };

export interface IndexSpec {
  firstPlay: IndexObjectSpec;
  topMenu: IndexObjectSpec;
  titles: IndexObjectSpec[];
  version?: string;
  appInfo?: { initialOutputModePreference: number; contentExistFlag: boolean };
}

export function buildIndex(spec: IndexSpec): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter();
  w.ascii('INDX').ascii(spec.version ?? '0200');
  const indexesStartAt = w.position;
  w.u32(0); // indexes_start_address (patched)
  w.u32(0); // extension_data_start_address
  w.zeros(24);
  const app = spec.appInfo;
  w.u32(34).bits(1, 0).bits(1, app?.initialOutputModePreference ?? 0).bits(1, app?.contentExistFlag ? 1 : 0).bits(5, 0).zeros(33); // AppInfoBDMV
  w.patchU32(indexesStartAt, w.position);
  const lengthAt = w.position;
  w.u32(0);
  writeIndexObject(w, spec.firstPlay, false);
  writeIndexObject(w, spec.topMenu, false);
  w.u16(spec.titles.length);
  for (const title of spec.titles) writeIndexObject(w, title, true);
  w.patchU32(lengthAt, w.position - lengthAt - 4);
  return w.toBytes();
}

function writeIndexObject(w: ByteWriter, o: IndexObjectSpec, isTitle: boolean): void {
  w.bits(2, o.kind === 'hdmv' ? 1 : 2);
  if (isTitle) w.bits(2, 0).bits(28, 0);
  else w.bits(30, 0);
  w.bits(2, o.playbackType ?? 0).bits(14, 0);
  if (o.kind === 'hdmv') w.u16(o.movieObjectId).u32(0);
  else w.ascii(o.name.padEnd(5, '0').slice(0, 5)).u8(0);
}

export interface StreamSpec {
  pid: number;
  codingType: number;
  format?: number;
  rate?: number;
  lang?: string;
  /** 1 = main clip (default), 2/3/4 = sub-path streams. */
  streamType?: number;
  /** Sub-path reference of a stream_type 2/3/4 entry. */
  subPathId?: number;
  /** Sub-clip reference of a stream_type 2 entry. */
  subClipId?: number;
  /** Extra zero bytes after the attributes, to test length-based skipping. */
  extraAttrBytes?: number;
}

export interface SubPlayItemSpec {
  clipId: string;
  inTime: number;
  outTime: number;
  connectionCondition?: number;
  stcId?: number;
  syncPlayItemId?: number;
  syncPts?: number;
  /** Further clips of a multi-clip sub play item (is_multi_clip is set when this is non-empty). */
  extraClipIds?: string[];
}

export interface SubPathSpec {
  type?: number;
  isRepeat?: boolean;
  items: SubPlayItemSpec[];
}

export interface PlayItemSpec {
  clipId: string;
  inTime: number;
  outTime: number;
  connectionCondition?: number;
  stcId?: number;
  video?: StreamSpec[];
  audio?: StreamSpec[];
  pg?: StreamSpec[];
  ig?: StreamSpec[];
  pipPg?: StreamSpec[];
  /** Secondary audio entries with their primary audio references. */
  secondaryAudio?: Array<{ stream: StreamSpec; primaryAudioRefs: number[] }>;
  /** Secondary video entries with their secondary audio and PiP PG references. */
  secondaryVideo?: Array<{ stream: StreamSpec; secondaryAudioRefs: number[]; pipPgRefs: number[] }>;
  angleClipIds?: string[];
  /** 0 none, 1 time, 2 infinite. */
  stillMode?: number;
  stillTime?: number;
  /** 8-byte UO mask table. */
  uoMask?: ArrayLike<number>;
}

export interface MarkSpec {
  playItemRef: number;
  time: number;
  type?: number;
}

export interface MplsSpec {
  playItems: PlayItemSpec[];
  marks?: MarkSpec[];
  subPaths?: SubPathSpec[];
  /** 8-byte UO mask table of the playlist. */
  uoMask?: ArrayLike<number>;
}

/** Writes a length byte plus a 5-byte (or longer) stream attribute block, shared by MPLS and CLPI. */
export function writeCodingInfo(
  w: ByteWriter,
  codingType: number,
  opts: { format?: number; rate?: number; lang?: string; extraBytes?: number } = {},
): void {
  const extra = opts.extraBytes ?? 0;
  w.u8(5 + extra).u8(codingType);
  if (isVideoCoding(codingType)) {
    w.bits(4, opts.format ?? 6).bits(4, opts.rate ?? 1).zeros(3);
  } else if (isAudioCoding(codingType)) {
    w.bits(4, opts.format ?? 3).bits(4, opts.rate ?? 1).ascii(opts.lang ?? 'eng');
  } else if (codingType === CodingType.TEXT_SUBTITLE) {
    w.u8(1).ascii(opts.lang ?? 'eng');
  } else {
    w.ascii(opts.lang ?? 'eng').u8(0);
  }
  w.zeros(extra);
}

function writeStream(w: ByteWriter, s: StreamSpec): void {
  const streamType = s.streamType ?? 1;
  w.u8(9).u8(streamType);
  if (streamType === 1) w.u16(s.pid).zeros(6);
  else if (streamType === 2) w.u8(s.subPathId ?? 0).u8(s.subClipId ?? 0).u16(s.pid).zeros(4);
  else w.u8(s.subPathId ?? 0).u16(s.pid).zeros(5);
  writeCodingInfo(w, s.codingType, { format: s.format, rate: s.rate, lang: s.lang, extraBytes: s.extraAttrBytes });
}

/** A reference list: count, reserved byte, the ids, and a padding byte when the count is odd. */
function writeRefs(w: ByteWriter, refs: readonly number[]): void {
  w.u8(refs.length).u8(0);
  for (const r of refs) w.u8(r);
  if (refs.length % 2) w.u8(0);
}

function writeUoMask(w: ByteWriter, mask: ArrayLike<number> | undefined): void {
  for (let i = 0; i < 8; i++) w.u8(mask?.[i] ?? 0);
}

function writePlayItem(w: ByteWriter, item: PlayItemSpec): void {
  const start = w.position;
  w.u16(0);
  const angles = item.angleClipIds ?? [];
  w.ascii(item.clipId).ascii('M2TS');
  w.bits(11, 0).bits(1, angles.length > 0 ? 1 : 0).bits(4, item.connectionCondition ?? 1);
  w.u8(item.stcId ?? 0).u32(item.inTime).u32(item.outTime);
  writeUoMask(w, item.uoMask);
  w.u8(0); // random_access_flag + reserved
  w.u8(item.stillMode ?? 0).u16(item.stillTime ?? 0);
  if (angles.length > 0) {
    w.u8(angles.length + 1).u8(0);
    for (const clip of angles) w.ascii(clip).ascii('M2TS').u8(0);
  }
  const stnStart = w.position;
  w.u16(0).u16(0);
  const video = item.video ?? [];
  const audio = item.audio ?? [];
  const pg = item.pg ?? [];
  const ig = item.ig ?? [];
  const pipPg = item.pipPg ?? [];
  const secondaryAudio = item.secondaryAudio ?? [];
  const secondaryVideo = item.secondaryVideo ?? [];
  w.u8(video.length).u8(audio.length).u8(pg.length).u8(ig.length);
  w.u8(secondaryAudio.length).u8(secondaryVideo.length).u8(pipPg.length).zeros(5);
  for (const s of [...video, ...audio, ...pg, ...pipPg, ...ig]) writeStream(w, s);
  for (const a of secondaryAudio) {
    writeStream(w, a.stream);
    writeRefs(w, a.primaryAudioRefs);
  }
  for (const v of secondaryVideo) {
    writeStream(w, v.stream);
    writeRefs(w, v.secondaryAudioRefs);
    writeRefs(w, v.pipPgRefs);
  }
  w.patchU16(stnStart, w.position - stnStart - 2);
  w.patchU16(start, w.position - start - 2);
}

function writeSubPath(w: ByteWriter, path: SubPathSpec): void {
  const start = w.position;
  w.u32(0).u8(0).u8(path.type ?? 0).bits(15, 0).bits(1, path.isRepeat ? 1 : 0).u8(0).u8(path.items.length);
  for (const item of path.items) {
    const itemStart = w.position;
    const extra = item.extraClipIds ?? [];
    w.u16(0).ascii(item.clipId).ascii('M2TS').bits(27, 0).bits(4, item.connectionCondition ?? 1).bits(1, extra.length > 0 ? 1 : 0);
    w.u8(item.stcId ?? 0).u32(item.inTime).u32(item.outTime).u16(item.syncPlayItemId ?? 0).u32(item.syncPts ?? 0);
    if (extra.length > 0) {
      w.u8(extra.length + 1);
      for (const clip of extra) w.ascii(clip).ascii('M2TS').u8(0);
    }
    w.patchU16(itemStart, w.position - itemStart - 2);
  }
  w.patchU32(start, w.position - start - 4);
}

export function buildMpls(spec: MplsSpec): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter();
  w.ascii('MPLS').ascii('0200');
  const listPosAt = w.position;
  w.u32(0).u32(0).u32(0); // list, mark, extension positions
  w.zeros(20);
  w.u32(14).u8(0).u8(1).u16(0);
  writeUoMask(w, spec.uoMask);
  w.u16(0); // AppInfoPlayList
  w.patchU32(listPosAt, w.position);
  const listStart = w.position;
  w.u32(0).u16(0).u16(spec.playItems.length).u16((spec.subPaths ?? []).length);
  for (const item of spec.playItems) writePlayItem(w, item);
  for (const path of spec.subPaths ?? []) writeSubPath(w, path);
  w.patchU32(listStart, w.position - listStart - 4);
  const marks = spec.marks ?? [];
  w.patchU32(listPosAt + 4, w.position);
  w.u32(2 + 14 * marks.length).u16(marks.length);
  for (const m of marks) w.u8(0).u8(m.type ?? 1).u16(m.playItemRef).u32(m.time).u16(0xffff).u32(0);
  return w.toBytes();
}

export interface ClpiSpec {
  numSourcePackets: number;
  streams: Array<{ pid: number; codingType: number; format?: number; rate?: number }>;
  /** 45 kHz. */
  presentationStart: number;
  /** 45 kHz. */
  presentationEnd: number;
  /** Entry pts are 45 kHz; encoding truncates the low 8 bits, as real discs do. */
  epMaps: Array<{ pid: number; entries: Array<{ pts: number; spn: number }> }>;
  /** STC sequences (PTS discontinuities) in one ATC sequence. Default: one spanning the clip. */
  stcSequences?: Array<{ spnStcStart: number; presentationStart: number; presentationEnd: number }>;
}

interface EpGroups {
  coarse: Array<{ ref: number; pts: number; spn: number }>;
  fine: Array<{ pts: number; spn: number }>;
}

function groupEpEntries(entries: ReadonlyArray<{ pts: number; spn: number }>): EpGroups {
  const groups: EpGroups = { coarse: [], fine: [] };
  let lastKey = '';
  entries.forEach((e, i) => {
    const pts90 = e.pts * 2;
    const key = `${Math.floor(pts90 / 2 ** 20)}:${Math.floor(e.spn / 0x20000)}`;
    if (key !== lastKey) {
      groups.coarse.push({ ref: i, pts: Math.floor(pts90 / 2 ** 19) % 0x4000, spn: e.spn });
      lastKey = key;
    }
    groups.fine.push({ pts: Math.floor(pts90 / 2 ** 9) % 0x800, spn: e.spn % 0x20000 });
  });
  return groups;
}

export function buildClpi(spec: ClpiSpec): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter();
  w.ascii('HDMV').ascii('0200');
  const addrAt = w.position;
  w.zeros(20); // sequence, program, cpi, clip mark, extension addresses
  w.zeros(12);

  const clipInfoAt = w.position;
  w.u32(0).u16(0).u8(1).u8(1).u32(0).u32(48_000_000).u32(spec.numSourcePackets).zeros(128).u16(0);
  w.patchU32(clipInfoAt, w.position - clipInfoAt - 4);

  const seqStart = w.position;
  const stcs = spec.stcSequences ?? [{ spnStcStart: 0, presentationStart: spec.presentationStart, presentationEnd: spec.presentationEnd }];
  w.u32(0).u8(0).u8(1);
  w.u32(0).u8(stcs.length).u8(0); // ATC sequence: spn_atc_start, num_stc_seq, offset_stc_id
  for (const stc of stcs) w.u16(0x1001).u32(stc.spnStcStart).u32(stc.presentationStart).u32(stc.presentationEnd);
  w.patchU32(seqStart, w.position - seqStart - 4);

  const progStart = w.position;
  w.u32(0).u8(0).u8(1);
  w.u32(0).u16(0x0100).u8(spec.streams.length).u8(0);
  for (const s of spec.streams) {
    w.u16(s.pid);
    writeCodingInfo(w, s.codingType, { format: s.format, rate: s.rate });
  }
  w.patchU32(progStart, w.position - progStart - 4);

  const cpiStart = w.position;
  w.u32(0).bits(12, 0).bits(4, 1);
  const epMapStart = w.position;
  w.u8(0).u8(spec.epMaps.length);
  const groups = spec.epMaps.map((m) => groupEpEntries(m.entries));
  const addrSlots: number[] = [];
  spec.epMaps.forEach((m, i) => {
    w.u16(m.pid).bits(10, 0).bits(4, 1).bits(16, groups[i].coarse.length).bits(18, groups[i].fine.length);
    addrSlots.push(w.position);
    w.u32(0);
  });
  groups.forEach((g, i) => {
    const streamStart = w.position;
    w.patchU32(addrSlots[i], streamStart - epMapStart);
    const fineStartAt = w.position;
    w.u32(0);
    for (const c of g.coarse) w.bits(18, c.ref).bits(14, c.pts).u32(c.spn);
    w.patchU32(fineStartAt, w.position - streamStart);
    for (const f of g.fine) w.bits(1, 0).bits(3, 0).bits(11, f.pts).bits(17, f.spn);
  });
  w.patchU32(cpiStart, w.position - cpiStart - 4);

  const clipMarkStart = w.position;
  w.u32(0);

  w.patchU32(addrAt, seqStart).patchU32(addrAt + 4, progStart).patchU32(addrAt + 8, cpiStart).patchU32(addrAt + 12, clipMarkStart);
  return w.toBytes();
}

export function buildSoundBdmv(clips: Array<{ channels: 1 | 2; samples: Int16Array }>): Uint8Array<ArrayBuffer> {
  const dataStart = 40 + 4 + 2 + clips.length * 10;
  const w = new ByteWriter().ascii('BCLK').ascii('0200').u32(dataStart).u32(0).zeros(40 - 16);
  const totalBytes = clips.reduce((sum, c) => sum + c.samples.length * 2, 0);
  w.u32(Math.max(1, totalBytes)).u8(0).u8(clips.length);
  let offset = 0;
  for (const c of clips) {
    w.bits(4, c.channels === 2 ? 3 : 1).bits(4, 1).bits(2, 1).bits(6, 0);
    w.u32(offset).u32(c.samples.length * 2);
    offset += c.samples.length * 2;
  }
  for (const c of clips) for (const s of c.samples) w.u16(s & 0xffff);
  return w.toBytes();
}
