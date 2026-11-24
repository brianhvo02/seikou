// SPDX-License-Identifier: LGPL-3.0-or-later
import { readElementHeader, type ElementHeader } from './ebml-reader';
import { MkvReadError } from './errors';
import { Id } from './ids';
import type { RangeReader } from './io';
import { clusterBlockList, frameDurations, MAX_CLUSTER_BYTES, readAt, withName, type BlockContext } from './parse';
import { readStructure, scanTopLevel, type Cue } from './playback';
import type { MkvBlock } from './reader';

// The blocks of some tracks (the subtitle tracks of a release) out of a Matroska file that may be
// gigabytes long. Every subtitle block can have its own cue (CueRelativePosition, RFC 9559
// §5.1.5.1.2.3), and when the Cues name them all the blocks are read one by one, a few kilobytes
// of a file of gigabytes. Nothing proves the Cues name all of them, so that path is taken only
// when every wanted track is ASS or SSA and the ReadOrder values (the first field of each block's
// payload) of its blocks are exactly 0..n-1: a gap shows a block the Cues missed. Any other file
// is walked cluster by cluster.

/** Largest range read from the file in one go while walking. */
const CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Options of `textTrackBlocks`.
 * @internal
 */
export interface TextBlocksOptions {
  /** Called as the file is read with the position reached and the file's size; the last call of a walk has both equal. */
  onProgress?: (readBytes: number, totalBytes: number) => void;
  /** Aborts the read; the returned promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * What `textTrackBlocks` found.
 * @internal
 */
export interface TextBlocks {
  /** The blocks of the wanted tracks only, sorted by time, then by position in the file. */
  blocks: MkvBlock[];
  /** `cues` when the Cues led to every block, `walk` when the clusters were read. */
  via: 'cues' | 'walk';
}

/**
 * Reads the blocks of the tracks numbered `tracks` from the Matroska file `reader` gives access
 * to. Through the Cues when every wanted track is an ASS or SSA track whose cues carry a relative
 * position and name blocks with ReadOrder exactly 0..n-1; otherwise by reading the clusters in
 * chunks of at most 8 MiB. Rejects with `MkvReadError` for a malformed file and with the signal's
 * reason when it aborts.
 * @internal
 */
export async function textTrackBlocks(reader: RangeReader, tracks: readonly number[], opts: TextBlocksOptions = {}): Promise<TextBlocks> {
  const { signal, onProgress } = opts;
  try {
    const s = await readStructure(reader, signal);
    const wanted = new Set(tracks);
    const ctx: BlockContext = { scale: s.scale, allowLacing: true, frameMs: frameDurations(s.tracks) };
    const byTrack = new Map(s.tracks.map((t) => [t.number, t]));
    const allAss = tracks.length > 0 && tracks.every((n) => {
      const id = byTrack.get(n)?.codecId;
      return id === 'S_TEXT/ASS' || id === 'S_TEXT/SSA';
    });
    if (allAss) {
      try {
        const viaCues = await throughCues(reader, s.headerAt, ctx, s.cues, tracks, signal);
        if (viaCues !== null) return { blocks: viaCues, via: 'cues' };
      } catch (err) {
        signal?.throwIfAborted();
        if (!(err instanceof MkvReadError)) throw err;
      }
    }
    const clusters = s.clusters ?? (await scanTopLevel(s.segStart, s.segEnd, s.headerAt, signal)).clusters;
    return { blocks: await walk(reader, clusters, ctx, wanted, onProgress, signal), via: 'walk' };
  } catch (err) {
    throw withName(err, reader);
  }
}

function sortBlocks(blocks: { block: MkvBlock; order: number }[]): MkvBlock[] {
  return blocks.sort((a, b) => a.block.timeMs - b.block.timeMs || a.order - b.order).map((x) => x.block);
}

/** The first comma-separated field of an ASS block's payload as a number, or NaN. */
function readOrderOf(data: Uint8Array): number {
  let end = 0;
  while (end < data.length && data[end] !== 0x2c) end++;
  const text = new TextDecoder().decode(data.subarray(0, end));
  return /^\d+$/.test(text) ? Number(text) : NaN;
}

async function throughCues(
  reader: RangeReader,
  headerAt: (pos: number, signal?: AbortSignal) => Promise<ElementHeader | null>,
  ctx: BlockContext,
  cues: readonly Cue[],
  tracks: readonly number[],
  signal: AbortSignal | undefined,
): Promise<MkvBlock[] | null> {
  const wanted = new Set(tracks);
  // One entry per block (the same block can be cued twice), keyed by cluster and relative position.
  const places = new Map<number, Cue>();
  const perTrack = new Map<number, number>();
  for (const c of cues) {
    if (!wanted.has(c.track)) continue;
    if (c.relativePos === undefined) return null;
    const abs = c.clusterPos + c.relativePos;
    if (places.has(abs)) continue;
    places.set(abs, c);
    perTrack.set(c.track, (perTrack.get(c.track) ?? 0) + 1);
  }
  for (const n of tracks) if (!perTrack.has(n)) return null;

  // The cluster's Timestamp element, read once per cluster: header and value.
  const stamps = new Map<number, Uint8Array>();
  const clusterStamp = async (clusterPos: number): Promise<{ dataPos: number; stamp: Uint8Array }> => {
    const ch = await headerAt(clusterPos, signal);
    if (ch === null || ch.id !== Id.Cluster || ch.size === null) throw new MkvReadError(`a cue points at byte ${clusterPos}, which is not a cluster`);
    const dataPos = clusterPos + ch.headerLength;
    let stamp = stamps.get(clusterPos);
    if (stamp === undefined) {
      const th = await headerAt(dataPos, signal);
      if (th === null || th.id !== Id.Timestamp || th.size === null || th.size > 8) throw new MkvReadError(`the cluster at byte ${clusterPos} does not start with its Timestamp`);
      stamp = await readAt(reader, dataPos, th.headerLength + th.size, signal);
      stamps.set(clusterPos, stamp);
    }
    return { dataPos, stamp };
  };

  const found: { block: MkvBlock; order: number }[] = [];
  const orders = new Map<number, number[]>();
  const sorted = [...places.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, cue] of sorted) {
    const { dataPos, stamp } = await clusterStamp(cue.clusterPos);
    const pos = dataPos + cue.relativePos!;
    const h = await headerAt(pos, signal);
    if (h === null || h.size === null || (h.id !== Id.SimpleBlock && h.id !== Id.BlockGroup)) throw new MkvReadError(`a cue points at byte ${pos}, which is not a block`);
    const el = await readAt(reader, pos, h.headerLength + h.size, signal);
    if (el.length < h.headerLength + h.size) throw new MkvReadError(`the block at byte ${pos} is cut short`);
    const blocks = clusterBlockList(ctx, concat(stamp, el));
    for (const block of blocks) {
      if (block.track !== cue.track) throw new MkvReadError(`the block at byte ${pos} is not of the track its cue names`);
      found.push({ block, order: pos });
      const list = orders.get(block.track) ?? [];
      list.push(readOrderOf(block.data));
      orders.set(block.track, list);
    }
  }
  for (const n of tracks) {
    const list = (orders.get(n) ?? []).slice().sort((a, b) => a - b);
    if (list.length === 0 || list.some((v, i) => v !== i)) return null;
  }
  return sortBlocks(found);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

async function walk(
  reader: RangeReader,
  clusters: readonly { dataPos: number; size: number }[],
  ctx: BlockContext,
  wanted: ReadonlySet<number>,
  onProgress: ((readBytes: number, totalBytes: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<MkvBlock[]> {
  const found: { block: MkvBlock; order: number }[] = [];
  const total = reader.size;
  let order = 0;
  for (const c of clusters) {
    signal?.throwIfAborted();
    if (c.size > MAX_CLUSTER_BYTES) throw new MkvReadError(`a cluster of ${c.size} bytes is too large to read`);
    const end = c.dataPos + c.size;
    // A window over the cluster's data, refilled as the children are visited.
    let winStart = c.dataPos;
    let win: Uint8Array = new Uint8Array(0);
    const ensure = async (pos: number, need: number): Promise<void> => {
      const last = Math.min(end, pos + need);
      if (pos >= winStart && last <= winStart + win.length) return;
      const len = Math.min(end - pos, Math.max(need, CHUNK_BYTES));
      win = await readAt(reader, pos, len, signal);
      winStart = pos;
      if (win.length < Math.min(need, end - pos)) throw new MkvReadError('the file ends inside a cluster (truncated?)');
    };
    let stamp: Uint8Array | null = null;
    for (let pos = c.dataPos; pos < end; ) {
      await ensure(pos, Math.min(16, end - pos));
      const h = readElementHeader(win, pos - winStart);
      if (h === null || h.size === null) throw new MkvReadError(`a cluster has a malformed element at byte ${pos}`);
      const size_ = h.headerLength + h.size;
      if (pos + size_ > end) throw new MkvReadError(`an element at byte ${pos} runs past its cluster`);
      if (h.id === Id.Timestamp) {
        await ensure(pos, size_);
        stamp = win.slice(pos - winStart, pos - winStart + size_);
      } else if (h.id === Id.SimpleBlock || h.id === Id.BlockGroup) {
        await ensure(pos, size_);
        const at = pos - winStart;
        if (stamp === null) throw new MkvReadError('a cluster has no Timestamp');
        const body = win.subarray(at, at + size_);
        const track = h.id === Id.SimpleBlock ? simpleTrack(body, h.headerLength) : null;
        if (track === null || wanted.has(track)) {
          for (const block of clusterBlockList(ctx, concat(stamp, body))) {
            if (wanted.has(block.track)) found.push({ block: { ...block, data: block.data.slice() }, order: order++ });
          }
        }
      }
      pos += size_;
    }
    onProgress?.(Math.min(end, total), total);
  }
  onProgress?.(total, total);
  return sortBlocks(found);
}

/** The track number at the start of a SimpleBlock's data (a vint), or null when it is malformed. */
function simpleTrack(el: Uint8Array, headerLength: number): number | null {
  const first = el[headerLength];
  if (first === undefined || first === 0) return null;
  const len = Math.clz32(first) - 23;
  if (len > 8 || headerLength + len > el.length) return null;
  let v = first & (0xff >> len);
  for (let i = 1; i < len; i++) v = v * 256 + el[headerLength + i]!;
  return v;
}
