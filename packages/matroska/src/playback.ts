// SPDX-License-Identifier: LGPL-3.0-or-later
import { childOf, floatOf, type EbmlNode, type ElementHeader } from './ebml-reader';
import { MkvReadError } from './errors';
import { Id } from './ids';
import type { RangeReader } from './io';
import {
  chapterAtoms,
  clusterBlockList,
  frameDurations,
  locateSegment,
  MAX_CLUSTER_BYTES,
  parseOrThrow,
  readAt,
  stringChild,
  trackOf,
  uintChild,
  withName,
  type BlockContext,
  type HeaderAt,
} from './parse';
import type { MkvBlock, MkvTrack } from './reader';

// Opening a Matroska file for playback over byte-range reads. Nothing here reads a Cluster to
// open: the SeekHead (RFC 9559 §5.1.1) says where Info, Tracks, Attachments, Chapters, Tags and
// Cues are, and each is read through it. A file with no usable SeekHead is scanned instead, one
// top-level element header at a time. Seeking goes through the Cues (§5.1.5): the cluster of the
// last video cue at or before the time, or an earlier cluster when a subtitle cue shows an event
// that started before the time and is still on screen. A file without Cues is scanned cluster by
// cluster, which is slow but correct.

/** One chapter of the default edition, on the Segment's millisecond timeline. */
export interface MkvChapterInfo {
  /** ChapterTimeStart in milliseconds, rounded to the nearest (the grid block timestamps use). */
  startMs: number;
  /** ChapterTimeEnd in milliseconds, rounded to the nearest, or null when the chapter has none. */
  endMs: number | null;
  /** The first ChapterDisplay's ChapterString, or null when there is none. */
  name: string | null;
}

/** A file attached to the Segment. Its bytes are not read until `data()` is called. */
export interface MkvAttachedFile {
  /** FileName (RFC 9559 §5.1.6.1.2). */
  name: string;
  /** FileMediaType (§5.1.6.1.3). */
  mediaType: string;
  /** Reads FileData (§5.1.6.1.4) from the file; each call reads it again. */
  data(): Promise<Uint8Array>;
}

/** A Matroska file opened for playback. */
export interface MatroskaFile {
  /** Info Duration in milliseconds; when the file has none, the time of its last video cue, or 0. */
  readonly durationMs: number;
  /** Every TrackEntry, in file order. */
  readonly tracks: readonly MkvTrack[];
  /** Every AttachedFile, in file order. */
  readonly attachments: readonly MkvAttachedFile[];
  /** The default edition's chapters (else the first edition's), hidden and disabled ones left out, sorted by start. Nested chapters are not read. */
  readonly chapters: readonly MkvChapterInfo[];
  /** Segment-level SimpleTags (those whose Targets name no track, edition, chapter or attachment) as name and value; a later tag of the same name wins. */
  readonly tags: Readonly<Record<string, string>>;
  /**
   * The blocks to start playing at `timeMs`, in file order, from the earliest of: the cluster of the
   * last video cue at or before `timeMs` (the first video cue when there is none before it), and the
   * cluster of any subtitle cue whose block is on screen at `timeMs` (CueTime at or before it, and
   * `timeMs` before CueTime plus CueDuration). Everything from there to the end of the file is
   * yielded, so the caller drops the blocks it does not need (audio before the time, a key frame's
   * leading frames). Laced blocks (Xiph, EBML, fixed-size) come out one frame per block, spaced by
   * the track's DefaultDuration, else by an equal share of the BlockDuration. Without Cues the
   * clusters are scanned from the start to find the same place. Rejects with `MkvReadError` for a
   * truncated or malformed cluster, and with the signal's reason when it aborts between reads.
   */
  blocksFrom(timeMs: number, signal?: AbortSignal): AsyncIterable<MkvBlock>;
}

interface Cue {
  timeMs: number;
  track: number;
  /** Absolute offset of the cluster's header. */
  clusterPos: number;
  durationMs: number | undefined;
}

interface ClusterRef {
  /** Absolute offset of the cluster's id. */
  pos: number;
  /** Offset of the cluster's data. */
  dataPos: number;
  size: number;
}

/** Info, Tracks, Chapters, Tags and Cues are read whole; one larger than this is refused. */
const MAX_ELEMENT_BYTES = 64 * 1024 * 1024;
const SEEK_TARGETS = new Set<number>([Id.Info, Id.Tracks, Id.Attachments, Id.Chapters, Id.Tags, Id.Cues]);
/** Top-level elements looked at for a SeekHead before giving up and scanning. */
const SEEK_HEAD_SEARCH = 8;

interface Scan {
  /** Absolute offset of the first element with each id in `SEEK_TARGETS`. */
  found: Map<number, number>;
  clusters: ClusterRef[];
}

/** Visits every top-level element header, noting where the elements of interest and the clusters are. */
async function scanTopLevel(segStart: number, segEnd: number, headerAt: HeaderAt, signal?: AbortSignal): Promise<Scan> {
  const found = new Map<number, number>();
  const clusters: ClusterRef[] = [];
  for (let pos = segStart; pos < segEnd; ) {
    const h = await headerAt(pos, signal);
    if (h === null) throw new MkvReadError(`the file ends inside an element header at byte ${pos} (truncated?)`);
    if (h.size === null) throw new MkvReadError(`the file has an element of unknown size at byte ${pos}, which is not supported`);
    const dataPos = pos + h.headerLength;
    if (dataPos + h.size > segEnd) throw new MkvReadError(`element ${h.id.toString(16)} at byte ${pos} runs past its Segment (truncated?)`);
    if (h.id === Id.Cluster) clusters.push({ pos, dataPos, size: h.size });
    else if (SEEK_TARGETS.has(h.id) && !found.has(h.id)) found.set(h.id, pos);
    pos = dataPos + h.size;
  }
  return { found, clusters };
}

/** Reads the SeekHead if one of the first few top-level elements is one: element id to absolute offset. */
async function readSeekHead(reader: RangeReader, segStart: number, segEnd: number, headerAt: HeaderAt, signal?: AbortSignal): Promise<Map<number, number> | null> {
  for (let pos = segStart, n = 0; pos < segEnd && n < SEEK_HEAD_SEARCH; n++) {
    const h = await headerAt(pos, signal);
    if (h === null || h.size === null) return null;
    const dataPos = pos + h.headerLength;
    if (dataPos + h.size > segEnd) return null;
    if (h.id === Id.Cluster) return null;
    if (h.id === Id.SeekHead) {
      const nodes = parseOrThrow(await readAt(reader, dataPos, h.size, signal), 'SeekHead');
      const out = new Map<number, number>();
      for (const seek of nodes.filter((x) => x.id === Id.Seek)) {
        const idBytes = childOf(seek, Id.SeekID)?.bytes;
        const position = uintChild(seek, Id.SeekPosition);
        if (idBytes === undefined || position === undefined || idBytes.length === 0 || idBytes.length > 4) continue;
        const id = idBytes.reduce((acc, b) => acc * 256 + b, 0);
        if (!out.has(id)) out.set(id, segStart + Number(position));
      }
      return out;
    }
    pos = dataPos + h.size;
  }
  return null;
}

/** Whether an element with id `id` starts at `pos` with a known size that stays inside the Segment. */
async function startsWith(headerAt: HeaderAt, pos: number, id: number, segEnd: number, signal?: AbortSignal): Promise<boolean> {
  if (pos < 0 || pos >= segEnd) return false;
  const h = await headerAt(pos, signal);
  return h !== null && h.id === id && h.size !== null && pos + h.headerLength + h.size <= segEnd;
}

async function readMaster(reader: RangeReader, headerAt: HeaderAt, pos: number, signal?: AbortSignal): Promise<EbmlNode> {
  const h = (await headerAt(pos, signal))!;
  if (h.size! > MAX_ELEMENT_BYTES) throw new MkvReadError(`the ${Object.entries(Id).find(([, v]) => v === h.id)?.[0] ?? h.id.toString(16)} element at byte ${pos} is ${h.size} bytes, more than the ${MAX_ELEMENT_BYTES} this reader takes`);
  const dataPos = pos + h.headerLength;
  const data = await readAt(reader, dataPos, h.size!, signal);
  if (data.length < h.size!) throw new MkvReadError(`element ${h.id.toString(16)} at byte ${pos} is cut short`);
  return { id: h.id, size: h.size!, offset: pos, headerLength: h.headerLength, children: parseOrThrow(data, `element ${h.id.toString(16)}`) };
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\0+$/, '');
}

/** Reads the Attachments element's small children and notes where each FileData is, without reading it. */
async function readAttachments(reader: RangeReader, headerAt: HeaderAt, pos: number, signal?: AbortSignal): Promise<MkvAttachedFile[]> {
  const top = (await headerAt(pos, signal))!;
  const topEnd = pos + top.headerLength + top.size!;
  const out: MkvAttachedFile[] = [];
  const childHeader = async (p: number, end: number): Promise<ElementHeader> => {
    const h = await headerAt(p, signal);
    if (h === null || h.size === null || p + h.headerLength + h.size > end) throw new MkvReadError(`an Attachments element at byte ${p} is malformed`);
    return h;
  };
  for (let p = pos + top.headerLength; p < topEnd; ) {
    const file = await childHeader(p, topEnd);
    const fileStart = p + file.headerLength;
    const fileEnd = fileStart + file.size!;
    if (file.id === Id.AttachedFile) {
      let name = '';
      let mediaType = 'application/octet-stream';
      let data: { pos: number; size: number } = { pos: 0, size: 0 };
      for (let q = fileStart; q < fileEnd; ) {
        const c = await childHeader(q, fileEnd);
        const cPos = q + c.headerLength;
        if (c.id === Id.FileData) data = { pos: cPos, size: c.size! };
        else if (c.id === Id.FileName) name = decodeText(await readAt(reader, cPos, c.size!, signal));
        else if (c.id === Id.FileMediaType) mediaType = decodeText(await readAt(reader, cPos, c.size!, signal));
        q = cPos + c.size!;
      }
      out.push({
        name,
        mediaType,
        async data() {
          try {
            const bytes = await readAt(reader, data.pos, data.size);
            if (bytes.length < data.size) throw new MkvReadError(`attachment "${name}" is cut short`);
            return bytes.slice();
          } catch (err) {
            throw withName(err, reader);
          }
        },
      });
    }
    p = fileEnd;
  }
  return out;
}

function cuesOf(node: EbmlNode | undefined, segStart: number, scale: number): Cue[] {
  const out: Cue[] = [];
  for (const point of node?.children ?? []) {
    if (point.id !== Id.CuePoint) continue;
    const time = uintChild(point, Id.CueTime);
    if (time === undefined) continue;
    for (const pos of point.children ?? []) {
      if (pos.id !== Id.CueTrackPositions) continue;
      const track = uintChild(pos, Id.CueTrack);
      const cluster = uintChild(pos, Id.CueClusterPosition);
      if (track === undefined || cluster === undefined) continue;
      const duration = uintChild(pos, Id.CueDuration);
      out.push({
        timeMs: (Number(time) * scale) / 1e6,
        track: Number(track),
        clusterPos: segStart + Number(cluster),
        durationMs: duration === undefined ? undefined : (Number(duration) * scale) / 1e6,
      });
    }
  }
  return out;
}

function tagsOf(node: EbmlNode | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of node?.children ?? []) {
    if (tag.id !== Id.Tag) continue;
    const targets = childOf(tag, Id.Targets);
    // Only a Tag whose Targets name no track, edition, chapter or attachment is about the Segment.
    if ((targets?.children ?? []).some((c) => c.id !== Id.TargetTypeValue && c.id !== Id.TargetType)) continue;
    for (const simple of tag.children ?? []) {
      if (simple.id !== Id.SimpleTag) continue;
      const name = stringChild(simple, Id.TagName);
      const value = stringChild(simple, Id.TagString);
      if (name !== undefined && value !== undefined) out[name] = value;
    }
  }
  return out;
}

function chaptersOf(node: EbmlNode | undefined): MkvChapterInfo[] {
  return chapterAtoms(node).map((atom) => {
    const end = uintChild(atom, Id.ChapterTimeEnd);
    const display = childOf(atom, Id.ChapterDisplay);
    return {
      startMs: Math.round(Number(uintChild(atom, Id.ChapterTimeStart)!) / 1e6),
      endMs: end === undefined ? null : Math.round(Number(end) / 1e6),
      name: (display && stringChild(display, Id.ChapString)) ?? null,
    };
  });
}

/**
 * Opens the Matroska or WebM file `reader` gives access to for playback. It reads the EBML header,
 * the SeekHead and, through it, Info, Tracks, Attachments (their bytes stay unread until
 * `data()`), Chapters, Tags and Cues, and no Cluster. A file with no SeekHead, or one that points
 * at the wrong places, is scanned instead. Throws `NotMatroskaError` for a file that is not
 * Matroska or WebM and `MkvReadError` for one that is truncated, malformed, has no Info or Tracks,
 * or has an element of unknown size at the Segment's top level. Error messages end with
 * `reader.name` in parentheses when the reader has one. Rejects with the signal's reason when it
 * aborts between reads.
 */
export async function openMatroska(reader: RangeReader, signal?: AbortSignal): Promise<MatroskaFile> {
  try {
    return await open(reader, signal);
  } catch (err) {
    throw withName(err, reader);
  }
}

async function open(reader: RangeReader, signal?: AbortSignal): Promise<MatroskaFile> {
  const { segStart, segEnd, headerAt } = await locateSegment(reader, signal);

  let positions = await readSeekHead(reader, segStart, segEnd, headerAt, signal);
  let clusters: ClusterRef[] | null = null;
  if (positions !== null) {
    let ok = positions.has(Id.Info) && positions.has(Id.Tracks);
    for (const [id, pos] of positions) if (ok && SEEK_TARGETS.has(id) && !(await startsWith(headerAt, pos, id, segEnd, signal))) ok = false;
    if (!ok) positions = null;
  }
  if (positions === null) {
    const scan = await scanTopLevel(segStart, segEnd, headerAt, signal);
    positions = scan.found;
    clusters = scan.clusters;
  }

  const infoPos = positions.get(Id.Info);
  const tracksPos = positions.get(Id.Tracks);
  if (infoPos === undefined || tracksPos === undefined) throw new MkvReadError(`the file has no ${infoPos === undefined ? 'Info' : 'Tracks'} element`);
  const info = await readMaster(reader, headerAt, infoPos, signal);
  const tracksEl = await readMaster(reader, headerAt, tracksPos, signal);
  const scale = Number(uintChild(info, Id.TimestampScale) ?? 1_000_000n);
  const tracks = (tracksEl.children ?? []).filter((n) => n.id === Id.TrackEntry).map(trackOf);
  const at = (id: number): number | undefined => positions!.get(id);
  const chaptersPos = at(Id.Chapters);
  const tagsPos = at(Id.Tags);
  const cuesPos = at(Id.Cues);
  const attachmentsPos = at(Id.Attachments);
  const attachments = attachmentsPos === undefined ? [] : await readAttachments(reader, headerAt, attachmentsPos, signal);
  const chapters = chaptersPos === undefined ? [] : chaptersOf(await readMaster(reader, headerAt, chaptersPos, signal));
  const tags = tagsPos === undefined ? {} : tagsOf(await readMaster(reader, headerAt, tagsPos, signal));
  const cues = cuesPos === undefined ? [] : cuesOf(await readMaster(reader, headerAt, cuesPos, signal), segStart, scale);

  const video = tracks.find((t) => t.type === 1)?.number;
  const subtitleTracks = new Set(tracks.filter((t) => t.type === 17).map((t) => t.number));
  const videoCues = cues.filter((c) => c.track === video).sort((a, b) => a.timeMs - b.timeMs);
  const duration = childOf(info, Id.Duration);
  const durationMs = duration !== undefined ? (floatOf(duration) * scale) / 1e6 : (videoCues[videoCues.length - 1]?.timeMs ?? 0);
  const ctx: BlockContext = { scale, allowLacing: true, frameMs: frameDurations(tracks) };

  // Every cluster from the one at `pos`, in file order.
  async function* clustersFrom(pos: number, signal?: AbortSignal): AsyncGenerator<MkvBlock> {
    while (pos < segEnd) {
      const h = await headerAt(pos, signal);
      if (h === null) throw new MkvReadError(`the file ends inside an element header at byte ${pos} (truncated?)`);
      if (h.size === null) throw new MkvReadError(`the file has an element of unknown size at byte ${pos}, which is not supported`);
      const dataPos = pos + h.headerLength;
      if (dataPos + h.size > segEnd) throw new MkvReadError(`element ${h.id.toString(16)} at byte ${pos} runs past its Segment (truncated?)`);
      if (h.id === Id.Cluster) {
        if (h.size > MAX_CLUSTER_BYTES) throw new MkvReadError(`a cluster of ${h.size} bytes is too large to read`);
        const buf = await readAt(reader, dataPos, h.size, signal);
        if (buf.length < h.size) throw new MkvReadError('the file ends inside a cluster (truncated?)');
        yield* clusterBlockList(ctx, buf);
      }
      pos = dataPos + h.size;
    }
  }

  async function* fromClusterList(refs: readonly ClusterRef[], first: number, signal?: AbortSignal): AsyncGenerator<MkvBlock> {
    for (let i = first; i < refs.length; i++) {
      const c = refs[i]!;
      if (c.size > MAX_CLUSTER_BYTES) throw new MkvReadError(`a cluster of ${c.size} bytes is too large to read`);
      const buf = await readAt(reader, c.dataPos, c.size, signal);
      if (buf.length < c.size) throw new MkvReadError('the file ends inside a cluster (truncated?)');
      yield* clusterBlockList(ctx, buf);
    }
  }

  // Without a usable video cue: reads the clusters from the start up to the time to find the same place the Cues would give.
  async function* scanned(timeMs: number, signal?: AbortSignal): AsyncGenerator<MkvBlock> {
    clusters ??= (await scanTopLevel(segStart, segEnd, headerAt, signal)).clusters;
    let videoStart: number | undefined;
    let subtitleStart: number | undefined;
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i]!;
      if (c.size > MAX_CLUSTER_BYTES) throw new MkvReadError(`a cluster of ${c.size} bytes is too large to read`);
      const buf = await readAt(reader, c.dataPos, c.size, signal);
      if (buf.length < c.size) throw new MkvReadError('the file ends inside a cluster (truncated?)');
      const list = clusterBlockList(ctx, buf);
      if (list.length > 0 && list[0]!.timeMs > timeMs) break;
      for (const b of list) {
        if (b.track === video && b.keyframe && b.timeMs <= timeMs) videoStart = i;
        if (subtitleTracks.has(b.track) && b.durationMs !== undefined && b.timeMs <= timeMs && timeMs < b.timeMs + b.durationMs) subtitleStart ??= i;
      }
    }
    const first = Math.min(videoStart ?? Infinity, subtitleStart ?? Infinity);
    yield* fromClusterList(clusters, first === Infinity ? 0 : first, signal);
  }

  async function* blocksFrom(timeMs: number, signal?: AbortSignal): AsyncGenerator<MkvBlock> {
    try {
      const before = videoCues.filter((c) => c.timeMs <= timeMs);
      const videoCue = before[before.length - 1] ?? videoCues[0];
      if (videoCue === undefined) {
        yield* scanned(timeMs, signal);
        return;
      }
      let start = videoCue.clusterPos;
      for (const c of cues) {
        if (!subtitleTracks.has(c.track) || c.durationMs === undefined) continue;
        if (c.timeMs <= timeMs && timeMs < c.timeMs + c.durationMs && c.clusterPos < start) start = c.clusterPos;
      }
      yield* clustersFrom(start, signal);
    } catch (err) {
      throw withName(err, reader);
    }
  }

  return { durationMs, tracks, attachments, chapters, tags, blocksFrom };
}
