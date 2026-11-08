// SPDX-License-Identifier: LGPL-3.0-or-later
import { Id } from '../../src/mux/mkv-ids';

export interface EbmlNode {
  id: number;
  /** Declared payload size. */
  size: number;
  /** Offset of the element's first byte (its id). */
  offset: number;
  /** Length of the id plus the size field. */
  headerLength: number;
  children?: EbmlNode[];
  bytes?: Buffer;
}

const MASTERS = new Set<number>([
  Id.EBML,
  Id.Segment,
  Id.SeekHead,
  Id.Seek,
  Id.Info,
  Id.Tracks,
  Id.TrackEntry,
  Id.Video,
  Id.Audio,
  Id.Attachments,
  Id.AttachedFile,
  Id.Chapters,
  Id.EditionEntry,
  Id.ChapterAtom,
  Id.ChapterDisplay,
  Id.Cluster,
  Id.BlockGroup,
  Id.Cues,
  Id.CuePoint,
  Id.CueTrackPositions,
]);

function parseRange(buf: Buffer, start: number, end: number): EbmlNode[] {
  const nodes: EbmlNode[] = [];
  let pos = start;
  while (pos < end) {
    const first = buf[pos]!;
    const idLen = Math.clz32(first) - 24 + 1;
    const id = Number(buf.readUIntBE(pos, idLen));
    const sizeFirst = buf[pos + idLen]!;
    const sizeLen = Math.clz32(sizeFirst) - 24 + 1;
    const marker = 1 << (8 - sizeLen);
    let size = sizeFirst & (marker - 1);
    for (let i = 1; i < sizeLen; i++) size = size * 256 + buf[pos + idLen + i]!;
    const headerLength = idLen + sizeLen;
    const dataStart = pos + headerLength;
    if (dataStart + size > end) throw new Error(`element ${id.toString(16)} at ${pos} overruns its parent`);
    const node: EbmlNode = { id, size, offset: pos, headerLength };
    if (MASTERS.has(id)) node.children = parseRange(buf, dataStart, dataStart + size);
    else node.bytes = buf.subarray(dataStart, dataStart + size);
    nodes.push(node);
    pos = dataStart + size;
  }
  return nodes;
}

/** Parses a whole file into a synthetic root whose children are the top-level elements. */
export function parseMkv(buf: Buffer): EbmlNode {
  return { id: -1, size: buf.length, offset: 0, headerLength: 0, children: parseRange(buf, 0, buf.length) };
}

export function findAll(tree: EbmlNode, id: number): EbmlNode[] {
  const out: EbmlNode[] = [];
  const walk = (n: EbmlNode): void => {
    for (const c of n.children ?? []) {
      if (c.id === id) out.push(c);
      walk(c);
    }
  };
  walk(tree);
  return out;
}

export function find(tree: EbmlNode, id: number): EbmlNode {
  const hit = findAll(tree, id)[0];
  if (hit === undefined) throw new Error(`element ${id.toString(16)} not found`);
  return hit;
}

export function uintOf(n: EbmlNode): bigint {
  let v = 0n;
  for (const b of n.bytes!) v = (v << 8n) | BigInt(b);
  return v;
}

export function floatOf(n: EbmlNode): number {
  return n.bytes!.length === 4 ? n.bytes!.readFloatBE(0) : n.bytes!.readDoubleBE(0);
}

export function stringOf(n: EbmlNode): string {
  return n.bytes!.toString('utf8');
}

/** Offset of the first byte after the Segment size field. */
export function segmentDataStart(tree: EbmlNode): number {
  const seg = find(tree, Id.Segment);
  return seg.offset + seg.headerLength;
}

/** The cluster's first SimpleBlock is a video (track 1) keyframe. */
export function firstBlockIsVideoKeyframe(cluster: EbmlNode): boolean {
  const first = cluster.children?.find((c) => c.id === Id.SimpleBlock);
  return first?.bytes !== undefined && first.bytes[0] === 0x81 && first.bytes[3] === 0x80;
}

export function countVideoBlocks(tree: EbmlNode): number {
  return findAll(tree, Id.SimpleBlock).concat(findAll(tree, Id.Block)).filter((b) => b.bytes![0] === 0x81).length;
}

/** One block as it sits in the file: its track, absolute timestamp in ms and how it was stored. */
export interface BlockInfo {
  track: number;
  timeMs: number;
  /** `simple` for a SimpleBlock, `group` for a Block inside a BlockGroup. */
  kind: 'simple' | 'group';
  flags: number;
  /** BlockDuration of a BlockGroup, when present. */
  durationMs?: number;
  data: Buffer;
}

/** Every block in file order, with the cluster timestamp added to its relative one (track numbers under 127). */
export function blocksInOrder(tree: EbmlNode): BlockInfo[] {
  const out: BlockInfo[] = [];
  for (const cluster of findAll(tree, Id.Cluster)) {
    const base = Number(uintOf(find(cluster, Id.Timestamp)));
    for (const c of cluster.children ?? []) {
      let block: EbmlNode | undefined;
      let durationMs: number | undefined;
      if (c.id === Id.SimpleBlock) block = c;
      else if (c.id === Id.BlockGroup) {
        block = c.children!.find((g) => g.id === Id.Block);
        const d = c.children!.find((g) => g.id === Id.BlockDuration);
        if (d !== undefined) durationMs = Number(uintOf(d));
      }
      if (block === undefined) continue;
      const b = block.bytes!;
      out.push({
        track: b[0]! & 0x7f,
        timeMs: base + b.readInt16BE(1),
        kind: c.id === Id.SimpleBlock ? 'simple' : 'group',
        flags: b[3]!,
        ...(durationMs !== undefined ? { durationMs } : {}),
        data: b.subarray(4),
      });
    }
  }
  return out;
}
