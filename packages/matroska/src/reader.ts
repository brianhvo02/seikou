// SPDX-License-Identifier: LGPL-3.0-or-later
import { childOf, floatOf, type EbmlNode } from './ebml-reader';
import { MkvReadError, NotMatroskaError } from './errors';
import { Id } from './ids';
import type { RangeReader } from './io';
import { chapterAtoms, clusterBlockList, frameDurations, locateSegment, MAX_CLUSTER_BYTES, parseOrThrow, readAt, stringChild, trackOf, uintChild, withName, type BlockContext } from './parse';
import type { MkvAttachment, MkvChapter } from './writer';

export { MkvReadError, NotMatroskaError };

// Reading a Matroska file (RFC 9559) without loading it whole. The EBML header (RFC 8794 §11.2)
// names the document type. The Segment's top-level elements are then visited one header at a
// time: Info (§5.1.2), Tracks (§5.1.4), Attachments (§5.1.6) and Chapters (§5.1.7) are read and
// parsed in full; each Cluster (§5.1.3) is only located, and is read later, one at a time, when the
// blocks are iterated. Everything else (SeekHead, Cues, Tags, Void) is skipped. The order of the
// top-level elements does not matter, since every one is visited before any block is read.

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
  /**
   * For a frame of a laced block (`openMatroska` only): its place among the block's frames and their
   * number. A laced frame's `timeMs` is spaced by the track's DefaultDuration, else by an equal
   * share of the BlockDuration, else every frame has the block's time; a caller that needs the
   * real spacing (an Opus packet's length from its TOC byte) works it out from these. Both are
   * absent for a block that is not laced.
   */
  frameIndex?: number;
  frameCount?: number;
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

interface ClusterRef {
  /** Offset of the cluster's data (after its id and size). */
  dataPos: number;
  size: number;
}

async function* clusterBlocks(reader: RangeReader, clusters: readonly ClusterRef[], ctx: BlockContext): AsyncGenerator<MkvBlock> {
  for (const c of clusters) {
    if (c.size > MAX_CLUSTER_BYTES) throw new MkvReadError(`a cluster of ${c.size} bytes is too large to read`);
    const buf = await readAt(reader, c.dataPos, c.size);
    if (buf.length < c.size) throw new MkvReadError('the file ends inside a cluster (truncated?)');
    yield* clusterBlockList(ctx, buf);
  }
}

/**
 * Reads the description of the Matroska or WebM file `reader` gives access to: the EBML DocType, Info, Tracks,
 * Attachments and Chapters, and where each Cluster is, without reading any cluster. Blocks are read
 * later through `blocks()`. Throws `NotMatroskaError` when the file does not start with an EBML
 * header naming `matroska` or `webm`, and `MkvReadError` when the file is truncated (a Segment or
 * element that runs past the end), malformed, has no Info or Tracks, or uses an unknown-size
 * element (RFC 8794 §6.2) at the Segment's top level. Error messages end with `reader.name` in
 * parentheses when the reader has one.
  * @example ../examples/read-matroska.ts
 */
export async function readMatroska(reader: RangeReader): Promise<ParsedMkv> {
  try {
    return await readDescription(reader);
  } catch (err) {
    throw withName(err, reader);
  }
}

async function readDescription(reader: RangeReader): Promise<ParsedMkv> {
  const { docType, segStart, segEnd, headerAt } = await locateSegment(reader);

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
  const tracksEl = level1.get(Id.Tracks);
  if (info === undefined || tracksEl === undefined) throw new MkvReadError(`the file has no ${info === undefined ? 'Info' : 'Tracks'} element`);
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
  const tracks = (tracksEl.children ?? []).filter((n) => n.id === Id.TrackEntry).map(trackOf);

  return {
    docType,
    ...(title !== undefined ? { title } : {}),
    ...(duration !== undefined ? { durationMs: (floatOf(duration) * scale) / 1e6 } : {}),
    tracks,
    attachments,
    chapters: chapterAtoms(level1.get(Id.Chapters)).map((atom) => {
      const display = childOf(atom, Id.ChapterDisplay);
      return { title: (display && stringChild(display, Id.ChapString)) ?? '', startNs: uintChild(atom, Id.ChapterTimeStart)! };
    }),
    blocks: () => clusterBlocks(reader, clusters, { scale, allowLacing: false, frameMs: frameDurations(tracks) }),
  };
}
