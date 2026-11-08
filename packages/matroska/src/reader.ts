// SPDX-License-Identifier: LGPL-3.0-or-later
import { childOf, EbmlError, floatOf, parseElements, readElementHeader, stringOf, uintOf, type EbmlNode } from './ebml-reader';
import { Id } from './ids';
import type { RangeReader } from './io';
import type { MkvAttachment, MkvChapter } from './writer';

// Reading a Matroska file (RFC 9559) without loading it whole. The EBML header (RFC 8794 §11.2)
// names the document type. The Segment's top-level elements are then visited one header at a
// time: Info (§5.1.2), Tracks (§5.1.4), Attachments (§5.1.6) and Chapters (§5.1.7) are read and
// parsed in full; each Cluster (§5.1.3) is only located, and is read later, one at a time, when the
// blocks are iterated. Everything else (SeekHead, Cues, Tags, Void) is skipped. The order of the
// top-level elements does not matter, since every one is visited before any block is read.

/** Thrown when a file cannot be read as Matroska: truncated, malformed, or using a feature this reader does not take (lacing, unknown sizes). */
export class MkvReadError extends Error {}

/** Thrown when a file is not Matroska at all: no EBML header, or an EBML DocType other than `matroska` or `webm`. */
export class NotMatroskaError extends MkvReadError {}

/** One TrackEntry (RFC 9559 §5.1.4.1), with each element's default filled in when it is absent. */
export interface MkvTrack {
  /** TrackNumber (§5.1.4.1.1): the number blocks refer to. */
  number: number;
  /** TrackType (§5.1.4.1.3): 1 video, 2 audio, 17 subtitle. */
  type: number;
  /** CodecID (§5.1.4.1.21), such as `V_AV1`, `A_OPUS`, `S_TEXT/ASS` or `S_HDMV/PGS`. */
  codecId: string;
  /** CodecPrivate (§5.1.4.1.22), when present. */
  codecPrivate?: Uint8Array;
  /** Name (§5.1.4.1.18); empty when absent. */
  name: string;
  /** Language (§5.1.4.1.19), ISO 639-2; `eng` when absent, the element's default. */
  language: string;
  /** FlagDefault (§5.1.4.1.5); true when absent. */
  isDefault: boolean;
  /** FlagForced (§5.1.4.1.6); false when absent. */
  isForced: boolean;
  /** DefaultDuration (§5.1.4.1.13) in nanoseconds, when present. */
  defaultDurationNs?: bigint;
  /** CodecDelay (§5.1.4.1.25) in nanoseconds; 0 when absent. */
  codecDelayNs: bigint;
  /** SeekPreRoll (§5.1.4.1.26) in nanoseconds; 0 when absent. */
  seekPreRollNs: bigint;
  /** PixelWidth and PixelHeight (§5.1.4.1.28.6, .7) of a track with a Video element. */
  video?: { width: number; height: number };
  /** Channels (default 1) and SamplingFrequency in Hz (default 8000) of a track with an Audio element (§5.1.4.1.29). */
  audio?: { channels: number; sampleRate: number };
}

/** One block (a SimpleBlock, or the Block of a BlockGroup), placed on the Segment's timeline. */
export interface MkvBlock {
  /** The track number from the block header (RFC 9559 §10.1). */
  track: number;
  /** Cluster Timestamp plus the block's relative timestamp, in milliseconds (exact when TimestampScale is 1,000,000, as `writeMatroska` writes it). */
  timeMs: number;
  /** A SimpleBlock's key-frame flag (§10.2); for a Block in a BlockGroup, true when the group has no ReferenceBlock (§5.1.3.5.5). */
  keyframe: boolean;
  /** The BlockGroup's BlockDuration (§5.1.3.5.3) in milliseconds, when present. */
  durationMs?: number;
  /** The BlockGroup's DiscardPadding (§5.1.3.5.7) in nanoseconds, when present. */
  discardPaddingNs?: bigint;
  /** The frame data after the block header (a view into the cluster just read). */
  data: Uint8Array;
}

/** A Matroska file's description, as `readMatroska` returns it. */
export interface ParsedMkv {
  /** The EBML DocType (RFC 8794 §11.2.6). */
  docType: 'matroska' | 'webm';
  /** Info Title (RFC 9559 §5.1.2.12), when present. */
  title?: string;
  /** Info Duration (§5.1.2.10) in milliseconds, when present. */
  durationMs?: number;
  /** Every TrackEntry, in file order. */
  tracks: MkvTrack[];
  /** Every AttachedFile, in file order, with its data read. */
  attachments: MkvAttachment[];
  /** The default edition's chapters (else the first edition's), hidden and disabled ones left out, sorted by start. Nested chapters are not read. */
  chapters: MkvChapter[];
  /**
   * The blocks of every cluster in file order. Each call reads the clusters again, one at a time,
   * so memory use is one cluster. Throws `MkvReadError` for a truncated or malformed
   * cluster and for a laced block (§10.3), which this reader does not split.
   */
  blocks(): AsyncGenerator<MkvBlock>;
}

const LEVEL1_READ = new Set<number>([Id.Info, Id.Tracks, Id.Attachments, Id.Chapters]);
const HEADER_PROBE = 16;
/** A cluster is read whole; a larger one than this is refused rather than allocated. */
const MAX_CLUSTER_BYTES = 1 << 30;

async function readAt(reader: RangeReader, position: number, length: number): Promise<Uint8Array> {
  if (length === 0 || position >= reader.size) return new Uint8Array(0);
  const first = await reader.read(position, length);
  if (first.length >= length || first.length === 0) return first;
  const out = new Uint8Array(length);
  out.set(first);
  let done = first.length;
  while (done < length) {
    const more = await reader.read(position + done, length - done);
    if (more.length === 0) break;
    out.set(more, done);
    done += more.length;
  }
  return out.subarray(0, done);
}

function parseOrThrow(buf: Uint8Array, what: string): EbmlNode[] {
  try {
    return parseElements(buf, 0, buf.length);
  } catch (err) {
    if (err instanceof EbmlError) throw new MkvReadError(`${what}: ${err.message}`);
    throw err;
  }
}

function uintChild(n: EbmlNode, id: number): bigint | undefined {
  const c = childOf(n, id);
  return c === undefined ? undefined : uintOf(c);
}

function stringChild(n: EbmlNode, id: number): string | undefined {
  const c = childOf(n, id);
  return c === undefined ? undefined : stringOf(c);
}

/** A Signed Integer element's value (RFC 8794 §7.1): two's complement, big-endian. */
function sintOf(n: EbmlNode): bigint {
  const bytes = n.bytes!;
  return bytes.length === 0 ? 0n : BigInt.asIntN(bytes.length * 8, uintOf(n));
}

function trackOf(entry: EbmlNode): MkvTrack {
  const number = uintChild(entry, Id.TrackNumber);
  const codecId = stringChild(entry, Id.CodecID);
  if (number === undefined || number === 0n || codecId === undefined) throw new MkvReadError('a TrackEntry has no TrackNumber or CodecID');
  const priv = childOf(entry, Id.CodecPrivate);
  const dd = uintChild(entry, Id.DefaultDuration);
  const video = childOf(entry, Id.Video);
  const audio = childOf(entry, Id.Audio);
  const sampling = audio === undefined ? undefined : childOf(audio, Id.SamplingFrequency);
  return {
    number: Number(number),
    type: Number(uintChild(entry, Id.TrackType) ?? 0n),
    codecId,
    ...(priv !== undefined ? { codecPrivate: new Uint8Array(priv.bytes!) } : {}),
    name: stringChild(entry, Id.Name) ?? '',
    language: stringChild(entry, Id.Language) ?? 'eng',
    isDefault: (uintChild(entry, Id.FlagDefault) ?? 1n) !== 0n,
    isForced: (uintChild(entry, Id.FlagForced) ?? 0n) !== 0n,
    ...(dd !== undefined ? { defaultDurationNs: dd } : {}),
    codecDelayNs: uintChild(entry, Id.CodecDelay) ?? 0n,
    seekPreRollNs: uintChild(entry, Id.SeekPreRoll) ?? 0n,
    ...(video !== undefined
      ? { video: { width: Number(uintChild(video, Id.PixelWidth) ?? 0n), height: Number(uintChild(video, Id.PixelHeight) ?? 0n) } }
      : {}),
    ...(audio !== undefined
      ? { audio: { channels: Number(uintChild(audio, Id.Channels) ?? 1n), sampleRate: sampling === undefined ? 8000 : floatOf(sampling) } }
      : {}),
  };
}

function chaptersOf(chapters: EbmlNode | undefined): MkvChapter[] {
  const editions = chapters?.children?.filter((c) => c.id === Id.EditionEntry) ?? [];
  const edition = editions.find((e) => uintChild(e, Id.EditionFlagDefault) === 1n) ?? editions[0];
  const out: MkvChapter[] = [];
  for (const atom of edition?.children?.filter((c) => c.id === Id.ChapterAtom) ?? []) {
    if (uintChild(atom, Id.ChapterFlagHidden) === 1n || uintChild(atom, Id.ChapterFlagEnabled) === 0n) continue;
    const start = uintChild(atom, Id.ChapterTimeStart);
    if (start === undefined) continue;
    const display = childOf(atom, Id.ChapterDisplay);
    out.push({ title: (display && stringChild(display, Id.ChapString)) ?? '', startNs: start });
  }
  return out.sort((a, b) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : 0));
}

/** Track number of a block header: an EBML variable-size integer with its marker removed (RFC 9559 §10.1). */
function blockTrack(b: Uint8Array): { track: number; length: number } {
  const first = b[0];
  if (first === undefined || first === 0) throw new MkvReadError('a block has a bad track number');
  const length = Math.clz32(first) - 23;
  if (b.length < length + 3) throw new MkvReadError('a block is shorter than its header');
  let track = first & ((1 << (8 - length)) - 1);
  for (let i = 1; i < length; i++) track = track * 256 + b[i]!;
  return { track, length };
}

function blockOf(clusterTicks: number, scale: number, block: Uint8Array, simple: boolean, group?: EbmlNode): MkvBlock {
  const { track, length } = blockTrack(block);
  const rel = new DataView(block.buffer, block.byteOffset, block.length).getInt16(length, false);
  const flags = block[length + 2]!;
  if ((flags & 0x06) !== 0) throw new MkvReadError(`a block of track ${track} uses lacing, which is not supported`);
  const duration = group === undefined ? undefined : uintChild(group, Id.BlockDuration);
  const padding = group === undefined ? undefined : childOf(group, Id.DiscardPadding);
  return {
    track,
    timeMs: ((clusterTicks + rel) * scale) / 1e6,
    keyframe: simple ? (flags & 0x80) !== 0 : childOf(group!, Id.ReferenceBlock) === undefined,
    ...(duration !== undefined ? { durationMs: (Number(duration) * scale) / 1e6 } : {}),
    ...(padding !== undefined ? { discardPaddingNs: sintOf(padding) } : {}),
    data: block.subarray(length + 3),
  };
}

interface ClusterRef {
  /** Offset of the cluster's data (after its id and size). */
  dataPos: number;
  size: number;
}

async function* clusterBlocks(reader: RangeReader, clusters: readonly ClusterRef[], scale: number): AsyncGenerator<MkvBlock> {
  for (const c of clusters) {
    if (c.size > MAX_CLUSTER_BYTES) throw new MkvReadError(`a cluster of ${c.size} bytes is too large to read`);
    const buf = await readAt(reader, c.dataPos, c.size);
    if (buf.length < c.size) throw new MkvReadError('the file ends inside a cluster (truncated?)');
    const children = parseOrThrow(buf, 'cluster');
    const ts = children.find((n) => n.id === Id.Timestamp);
    if (ts === undefined) throw new MkvReadError('a cluster has no Timestamp');
    const ticks = Number(uintOf(ts));
    for (const n of children) {
      if (n.id === Id.SimpleBlock) yield blockOf(ticks, scale, n.bytes!, true);
      else if (n.id === Id.BlockGroup) {
        const block = childOf(n, Id.Block);
        if (block !== undefined) yield blockOf(ticks, scale, block.bytes!, false, n);
      }
    }
  }
}

/**
 * Reads the description of the Matroska or WebM file `reader` gives access to: the EBML DocType, Info, Tracks,
 * Attachments and Chapters, and where each Cluster is, without reading any cluster. Blocks are read
 * later through `blocks()`. Throws `NotMatroskaError` when the file does not start with an EBML
 * header naming `matroska` or `webm`, and `MkvReadError` when the file is truncated (a Segment or
 * element that runs past the end), malformed, has no Info or Tracks, or uses an unknown-size
 * element (RFC 8794 §6.2) at the Segment's top level.
 */
export async function readMatroska(reader: RangeReader): Promise<ParsedMkv> {
  const fileSize = reader.size;
  const headerAt = async (pos: number): Promise<ReturnType<typeof readElementHeader>> => {
    try {
      return readElementHeader(await readAt(reader, pos, HEADER_PROBE), 0);
    } catch (err) {
      if (err instanceof EbmlError) throw new MkvReadError(`at byte ${pos}: ${err.message}`);
      throw err;
    }
  };

  let ebml: ReturnType<typeof readElementHeader>;
  try {
    ebml = readElementHeader(await readAt(reader, 0, HEADER_PROBE), 0);
  } catch (err) {
    if (err instanceof EbmlError) throw new NotMatroskaError('the file is not a Matroska file (no EBML header)');
    throw err;
  }
  if (ebml === null || ebml.id !== Id.EBML || ebml.size === null || ebml.size > 4096) {
    throw new NotMatroskaError('the file is not a Matroska file (no EBML header)');
  }
  const headerBytes = await readAt(reader, ebml.headerLength, ebml.size);
  if (headerBytes.length < ebml.size) throw new NotMatroskaError(`the file is not a Matroska file (its EBML header is cut short)`);
  let docType: string | undefined;
  try {
    const dt = parseElements(headerBytes, 0, headerBytes.length).find((n) => n.id === Id.DocType);
    docType = dt === undefined ? undefined : stringOf(dt);
  } catch (err) {
    if (err instanceof EbmlError) throw new NotMatroskaError(`the file is not a Matroska file (bad EBML header)`);
    throw err;
  }
  if (docType !== 'matroska' && docType !== 'webm') {
    throw new NotMatroskaError(`the file is not a Matroska file (its EBML DocType is ${docType === undefined ? 'missing' : `"${docType}"`})`);
  }

  const segPos = ebml.headerLength + ebml.size;
  const seg = await headerAt(segPos);
  if (seg === null || seg.id !== Id.Segment) throw new MkvReadError(`the file has no Segment after its EBML header`);
  const segStart = segPos + seg.headerLength;
  const segEnd = seg.size === null ? fileSize : segStart + seg.size;
  if (segEnd > fileSize) throw new MkvReadError(`the file ends before its Segment does (truncated?)`);

  const level1 = new Map<number, EbmlNode>();
  const clusters: ClusterRef[] = [];
  for (let pos = segStart; pos < segEnd; ) {
    const h = await headerAt(pos);
    if (h === null) throw new MkvReadError(`the file ends inside an element header at byte ${pos} (truncated?)`);
    if (h.size === null) throw new MkvReadError(`the file has an element of unknown size at byte ${pos}, which is not supported`);
    const dataPos = pos + h.headerLength;
    if (dataPos + h.size > segEnd) throw new MkvReadError(`element ${h.id.toString(16)} at byte ${pos} runs past its Segment (truncated?)`);
    if (h.id === Id.Cluster) clusters.push({ dataPos, size: h.size });
    else if (LEVEL1_READ.has(h.id) && !level1.has(h.id)) {
      const data = await readAt(reader, dataPos, h.size);
      level1.set(h.id, { id: h.id, size: h.size, offset: pos, headerLength: h.headerLength, children: parseOrThrow(data, `element ${h.id.toString(16)}`) });
    }
    pos = dataPos + h.size;
  }

  const info = level1.get(Id.Info);
  const tracks = level1.get(Id.Tracks);
  if (info === undefined || tracks === undefined) throw new MkvReadError(`the file has no ${info === undefined ? 'Info' : 'Tracks'} element`);
  const scale = Number(uintChild(info, Id.TimestampScale) ?? 1_000_000n);
  const duration = childOf(info, Id.Duration);
  const title = stringChild(info, Id.Title);
  const attachments = (level1.get(Id.Attachments)?.children ?? [])
    .filter((n) => n.id === Id.AttachedFile)
    .map((f): MkvAttachment => ({
      name: stringChild(f, Id.FileName) ?? '',
      mediaType: stringChild(f, Id.FileMediaType) ?? 'application/octet-stream',
      data: new Uint8Array(childOf(f, Id.FileData)?.bytes ?? new Uint8Array(0)),
    }));

  return {
    docType,
    ...(title !== undefined ? { title } : {}),
    ...(duration !== undefined ? { durationMs: (floatOf(duration) * scale) / 1e6 } : {}),
    tracks: (tracks.children ?? []).filter((n) => n.id === Id.TrackEntry).map(trackOf),
    attachments,
    chapters: chaptersOf(level1.get(Id.Chapters)),
    blocks: () => clusterBlocks(reader, clusters, scale),
  };
}
