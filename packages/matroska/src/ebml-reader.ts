// SPDX-License-Identifier: LGPL-3.0-or-later
import { Id } from './ids';

// Reading EBML (RFC 8794). Every element is an Element ID (§5), an Element Data Size (§6) and that
// many bytes of data. Both are variable-length integers whose first byte's leading zero bits give
// the length (§4): an ID is 1 to 4 bytes and keeps its marker bit, a size is 1 to 8 bytes and
// drops it. A size whose data bits are all ones means "unknown size" (§6.2). Master elements
// (§7.7) hold other elements as their data; every other type is read from its raw bytes.

/** Thrown for bytes that are not well-formed EBML: a bad length marker, or an element that runs past its parent or the data. */
export class EbmlError extends Error {}

/** The id and size field of one element, as `readElementHeader` reads them. */
export interface ElementHeader {
  /** The Element ID with its marker bits, as in `Id`. */
  id: number;
  /** The Element Data Size, or `null` for the reserved "unknown size" value (RFC 8794 §6.2). */
  size: number | null;
  /** Bytes taken by the id and the size field together. */
  headerLength: number;
}

/**
 * Reads the element header that starts at `pos` in `buf` (RFC 8794 §5, §6). Returns `null` when
 * `buf` ends before the header does, so a caller reading a file in pieces can read more and retry.
 * Throws `EbmlError` for an id longer than 4 bytes, a size longer than 8, or a size over 2^53.
 */
export function readElementHeader(buf: Uint8Array, pos: number): ElementHeader | null {
  if (pos >= buf.length) return null;
  const first = buf[pos]!;
  const idLen = Math.clz32(first) - 23;
  if (first === 0 || idLen > 4) throw new EbmlError(`bad element id at byte ${pos}`);
  if (pos + idLen >= buf.length) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + buf[pos + i]!;
  const sizeFirst = buf[pos + idLen]!;
  const sizeLen = Math.clz32(sizeFirst) - 23;
  if (sizeFirst === 0) throw new EbmlError(`bad element size at byte ${pos + idLen}`);
  if (pos + idLen + sizeLen > buf.length) return null;
  const marker = 1 << (8 - sizeLen);
  let size = sizeFirst & (marker - 1);
  let allOnes = size === marker - 1;
  for (let i = 1; i < sizeLen; i++) {
    const b = buf[pos + idLen + i]!;
    if (b !== 0xff) allOnes = false;
    size = size * 256 + b;
  }
  if (!allOnes && !Number.isSafeInteger(size)) throw new EbmlError(`element size at byte ${pos + idLen} is too large`);
  return { id, size: allOnes ? null : size, headerLength: idLen + sizeLen };
}

/** One element of a parsed tree. */
export interface EbmlNode {
  /** The Element ID with its marker bits, as in `Id`; -1 for the synthetic root `parseMkv` returns. */
  id: number;
  /** Declared payload size. */
  size: number;
  /** Offset of the element's first byte (its id), counted from the start of the parsed buffer. */
  offset: number;
  /** Length of the id plus the size field. */
  headerLength: number;
  /** Children of a master element. */
  children?: EbmlNode[];
  /** Data of any other element (a view into the parsed buffer, not a copy). */
  bytes?: Uint8Array;
}

/** The Matroska master elements (RFC 9559 §5.1) the tree parser descends into; every other element keeps its raw bytes. */
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
  Id.Tags,
  Id.Tag,
  Id.Targets,
  Id.SimpleTag,
]);

/**
 * Parses the elements between `start` and `end` of `buf` into a tree, descending into the Matroska
 * master elements. Throws `EbmlError` when an element runs past `end` or has an unknown size.
 */
export function parseElements(buf: Uint8Array, start: number, end: number): EbmlNode[] {
  const nodes: EbmlNode[] = [];
  let pos = start;
  while (pos < end) {
    const h = readElementHeader(buf.subarray(0, end), pos);
    if (h === null) throw new EbmlError(`element at byte ${pos} runs past its parent`);
    if (h.size === null) throw new EbmlError(`element ${h.id.toString(16)} at byte ${pos} has an unknown size`);
    const dataStart = pos + h.headerLength;
    if (dataStart + h.size > end) throw new EbmlError(`element ${h.id.toString(16)} at byte ${pos} runs past its parent`);
    const node: EbmlNode = { id: h.id, size: h.size, offset: pos, headerLength: h.headerLength };
    if (MASTERS.has(h.id)) node.children = parseElements(buf, dataStart, dataStart + h.size);
    else node.bytes = buf.subarray(dataStart, dataStart + h.size);
    nodes.push(node);
    pos = dataStart + h.size;
  }
  return nodes;
}

/** Parses a whole file held in memory into a synthetic root whose children are the top-level elements. Meant for small files and tests; `readMatroska` streams large ones. */
export function parseMkv(buf: Uint8Array): EbmlNode {
  return { id: -1, size: buf.length, offset: 0, headerLength: 0, children: parseElements(buf, 0, buf.length) };
}

/** Every descendant of `tree` with element id `id`, in document order. */
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

/** The first descendant of `tree` with element id `id`; throws when there is none. */
export function find(tree: EbmlNode, id: number): EbmlNode {
  const hit = findAll(tree, id)[0];
  if (hit === undefined) throw new Error(`element ${id.toString(16)} not found`);
  return hit;
}

/** The direct child of `n` with element id `id`, if any (unlike `find`, it does not search deeper). */
export function childOf(n: EbmlNode, id: number): EbmlNode | undefined {
  return n.children?.find((c) => c.id === id);
}

/** An Unsigned Integer element's value (RFC 8794 §7.2): big-endian, 0 to 8 bytes. */
export function uintOf(n: EbmlNode): bigint {
  let v = 0n;
  for (const b of n.bytes!) v = (v << 8n) | BigInt(b);
  return v;
}

/** A Float element's value (RFC 8794 §7.3): 4 or 8 bytes big-endian, 0 for an empty element. */
export function floatOf(n: EbmlNode): number {
  if (n.bytes!.length === 0) return 0;
  const view = new DataView(n.bytes!.buffer, n.bytes!.byteOffset, n.bytes!.length);
  return n.bytes!.length === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
}

/** A String or UTF-8 element's value (RFC 8794 §7.4, §7.5), with any trailing NUL padding removed. */
export function stringOf(n: EbmlNode): string {
  return new TextDecoder().decode(n.bytes!).replace(/\0+$/, '');
}

/** Offset of the first byte after the Segment size field. */
export function segmentDataStart(tree: EbmlNode): number {
  const seg = find(tree, Id.Segment);
  return seg.offset + seg.headerLength;
}

/** True when the cluster's first SimpleBlock is a video (track 1) key frame. */
export function firstBlockIsVideoKeyframe(cluster: EbmlNode): boolean {
  const first = cluster.children?.find((c) => c.id === Id.SimpleBlock);
  return first?.bytes !== undefined && first.bytes[0] === 0x81 && first.bytes[3] === 0x80;
}

/** Number of blocks (SimpleBlock or Block) of track 1. */
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
  data: Uint8Array;
}

/**
 * Every block of a parsed tree in file order, with the cluster timestamp added to its relative one
 * (RFC 9559 §10.1). Assumes track numbers under 127 (a 1-byte track field) and a TimestampScale of
 * 1,000,000, as `writeMatroska` writes them.
 */
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
        timeMs: base + new DataView(b.buffer, b.byteOffset, b.length).getInt16(1, false),
        kind: c.id === Id.SimpleBlock ? 'simple' : 'group',
        flags: b[3]!,
        ...(durationMs !== undefined ? { durationMs } : {}),
        data: b.subarray(4),
      });
    }
  }
  return out;
}
