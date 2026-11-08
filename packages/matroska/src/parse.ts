// SPDX-License-Identifier: LGPL-3.0-or-later
import { childOf, EbmlError, floatOf, parseElements, readElementHeader, stringOf, uintOf, type EbmlNode, type ElementHeader } from './ebml-reader';
import { MkvReadError, NotMatroskaError } from './errors';
import { Id } from './ids';
import type { RangeReader } from './io';
import type { MkvBlock, MkvTrack } from './reader';

// Pieces shared by `readMatroska` (reader.ts) and `openMatroska` (playback.ts): reading ranges,
// the EBML header and Segment, TrackEntry, chapters, and splitting a cluster into blocks.

/** Bytes read to find an element header: an id (4 at most) and a size (8 at most). */
export const HEADER_PROBE = 16;
/** A cluster is read whole; a larger one than this is refused rather than allocated. */
export const MAX_CLUSTER_BYTES = 1 << 30;

/** Adds the reader's name to an error's message, keeping its class. */
export function withName(err: unknown, reader: RangeReader): unknown {
  if (!(err instanceof MkvReadError) || reader.name === undefined) return err;
  const named = new (err.constructor as new (message: string) => MkvReadError)(`${err.message} (${reader.name})`);
  named.stack = err.stack;
  return named;
}

/** Reads exactly `length` bytes at `position` (fewer only at the end of the data), looping over short reads. */
export async function readAt(reader: RangeReader, position: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (length === 0 || position >= reader.size) return new Uint8Array(0);
  const first = await reader.read(position, length, signal);
  if (first.length >= length || first.length === 0) return first;
  const out = new Uint8Array(length);
  out.set(first);
  let done = first.length;
  while (done < length) {
    signal?.throwIfAborted();
    const more = await reader.read(position + done, length - done, signal);
    if (more.length === 0) break;
    out.set(more, done);
    done += more.length;
  }
  return out.subarray(0, done);
}

/** Parses `buf` as a run of elements, mapping EBML errors to `MkvReadError`. */
export function parseOrThrow(buf: Uint8Array, what: string): EbmlNode[] {
  try {
    return parseElements(buf, 0, buf.length);
  } catch (err) {
    if (err instanceof EbmlError) throw new MkvReadError(`${what}: ${err.message}`);
    throw err;
  }
}

/** The unsigned value of child `id` of `n`, if present. */
export function uintChild(n: EbmlNode, id: number): bigint | undefined {
  const c = childOf(n, id);
  return c === undefined ? undefined : uintOf(c);
}

/** The string value of child `id` of `n`, if present. */
export function stringChild(n: EbmlNode, id: number): string | undefined {
  const c = childOf(n, id);
  return c === undefined ? undefined : stringOf(c);
}

/** A Signed Integer element's value (RFC 8794 §7.1): two's complement, big-endian. */
export function sintOf(n: EbmlNode): bigint {
  const bytes = n.bytes!;
  return bytes.length === 0 ? 0n : BigInt.asIntN(bytes.length * 8, uintOf(n));
}

/** Reads the element header at `pos`; null at the end of the data. */
export type HeaderAt = (pos: number, signal?: AbortSignal) => Promise<ElementHeader | null>;

/** Where the Segment's children are, after the EBML header has been checked. */
export interface SegmentLocation {
  docType: 'matroska' | 'webm';
  /** Offset of the Segment's first child. */
  segStart: number;
  /** Offset just past the Segment's last byte. */
  segEnd: number;
  headerAt: HeaderAt;
}

/**
 * Checks the EBML header and finds the Segment. Throws `NotMatroskaError` when the file does not
 * start with an EBML header naming `matroska` or `webm`, and `MkvReadError` when there is no
 * Segment or it runs past the end of the file.
 */
export async function locateSegment(reader: RangeReader, signal?: AbortSignal): Promise<SegmentLocation> {
  const fileSize = reader.size;
  const headerAt: HeaderAt = async (pos, readSignal) => {
    try {
      return readElementHeader(await readAt(reader, pos, HEADER_PROBE, readSignal), 0);
    } catch (err) {
      if (err instanceof EbmlError) throw new MkvReadError(`at byte ${pos}: ${err.message}`);
      throw err;
    }
  };

  let ebml: ElementHeader | null;
  try {
    ebml = readElementHeader(await readAt(reader, 0, HEADER_PROBE, signal), 0);
  } catch (err) {
    if (err instanceof EbmlError) throw new NotMatroskaError('the file is not a Matroska file (no EBML header)');
    throw err;
  }
  if (ebml === null || ebml.id !== Id.EBML || ebml.size === null || ebml.size > 4096) {
    throw new NotMatroskaError('the file is not a Matroska file (no EBML header)');
  }
  const headerBytes = await readAt(reader, ebml.headerLength, ebml.size, signal);
  if (headerBytes.length < ebml.size) throw new NotMatroskaError('the file is not a Matroska file (its EBML header is cut short)');
  let docType: string | undefined;
  try {
    const dt = parseElements(headerBytes, 0, headerBytes.length).find((n) => n.id === Id.DocType);
    docType = dt === undefined ? undefined : stringOf(dt);
  } catch (err) {
    if (err instanceof EbmlError) throw new NotMatroskaError('the file is not a Matroska file (bad EBML header)');
    throw err;
  }
  if (docType !== 'matroska' && docType !== 'webm') {
    throw new NotMatroskaError(`the file is not a Matroska file (its EBML DocType is ${docType === undefined ? 'missing' : `"${docType}"`})`);
  }

  const segPos = ebml.headerLength + ebml.size;
  const seg = await headerAt(segPos, signal);
  if (seg === null || seg.id !== Id.Segment) throw new MkvReadError('the file has no Segment after its EBML header');
  const segStart = segPos + seg.headerLength;
  const segEnd = seg.size === null ? fileSize : segStart + seg.size;
  if (segEnd > fileSize) throw new MkvReadError('the file ends before its Segment does (truncated?)');
  return { docType, segStart, segEnd, headerAt };
}

/** One TrackEntry, with the defaults of absent elements filled in. */
export function trackOf(entry: EbmlNode): MkvTrack {
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

/** The ChapterAtoms of the default edition (else the first), hidden and disabled ones left out, sorted by start; nested chapters are not read. */
export function chapterAtoms(chapters: EbmlNode | undefined): EbmlNode[] {
  const editions = chapters?.children?.filter((c) => c.id === Id.EditionEntry) ?? [];
  const edition = editions.find((e) => uintChild(e, Id.EditionFlagDefault) === 1n) ?? editions[0];
  const atoms = (edition?.children ?? []).filter(
    (a) =>
      a.id === Id.ChapterAtom &&
      uintChild(a, Id.ChapterFlagHidden) !== 1n &&
      uintChild(a, Id.ChapterFlagEnabled) !== 0n &&
      uintChild(a, Id.ChapterTimeStart) !== undefined,
  );
  const start = (a: EbmlNode): bigint => uintChild(a, Id.ChapterTimeStart)!;
  return atoms.sort((a, b) => (start(a) < start(b) ? -1 : start(a) > start(b) ? 1 : 0));
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

/** A variable-size integer at `pos` in `b` with its marker removed. */
function readVint(b: Uint8Array, pos: number): { value: number; length: number } {
  const first = b[pos];
  if (first === undefined || first === 0) throw new MkvReadError('a laced block has a bad frame size');
  const length = Math.clz32(first) - 23;
  if (pos + length > b.length) throw new MkvReadError('a laced block is shorter than its header');
  let value = first & ((1 << (8 - length)) - 1);
  for (let i = 1; i < length; i++) value = value * 256 + b[pos + i]!;
  return { value, length };
}

/** Splits the data after a block header into frames (RFC 9559 §10.3): Xiph (0x02), fixed-size (0x04) or EBML (0x06) lacing. */
function unlace(data: Uint8Array, lacing: number): Uint8Array[] {
  if (data.length < 1) throw new MkvReadError('a laced block has no frame count');
  const count = data[0]! + 1;
  let pos = 1;
  const sizes: number[] = [];
  if (lacing === 0x04) {
    const total = data.length - pos;
    if (total % count !== 0) throw new MkvReadError('a fixed-size laced block does not divide into its frames');
    for (let i = 0; i < count; i++) sizes.push(total / count);
  } else {
    if (lacing === 0x02) {
      for (let i = 0; i < count - 1; i++) {
        let size = 0;
        for (;;) {
          const b = data[pos++];
          if (b === undefined) throw new MkvReadError('a laced block is shorter than its header');
          size += b;
          if (b !== 255) break;
        }
        sizes.push(size);
      }
    } else if (count > 1) {
      const first = readVint(data, pos);
      pos += first.length;
      sizes.push(first.value);
      for (let i = 1; i < count - 1; i++) {
        const d = readVint(data, pos);
        pos += d.length;
        sizes.push(sizes[i - 1]! + d.value - (2 ** (7 * d.length - 1) - 1));
      }
    }
    const last = data.length - pos - sizes.reduce((a, b) => a + b, 0);
    if (last < 0 || sizes.some((s) => s < 0)) throw new MkvReadError("a laced block's frame sizes run past its data");
    sizes.push(last);
  }
  const frames: Uint8Array[] = [];
  for (const size of sizes) {
    if (pos + size > data.length) throw new MkvReadError("a laced block's frame sizes run past its data");
    frames.push(data.subarray(pos, pos + size));
    pos += size;
  }
  return frames;
}

/** How a cluster's blocks are turned into `MkvBlock`s. */
export interface BlockContext {
  /** TimestampScale in nanoseconds per tick. */
  scale: number;
  /** Whether a laced block is split into frames (true) or refused (false). */
  allowLacing: boolean;
  /** Each track's DefaultDuration in milliseconds, which spaces the frames of a laced block. */
  frameMs: ReadonlyMap<number, number>;
}

function blocksOfBlock(ctx: BlockContext, clusterTicks: number, block: Uint8Array, simple: boolean, group?: EbmlNode): MkvBlock[] {
  const { track, length } = blockTrack(block);
  const rel = new DataView(block.buffer, block.byteOffset, block.length).getInt16(length, false);
  const flags = block[length + 2]!;
  const lacing = flags & 0x06;
  if (lacing !== 0 && !ctx.allowLacing) throw new MkvReadError(`a block of track ${track} uses lacing, which is not supported`);
  const duration = group === undefined ? undefined : uintChild(group, Id.BlockDuration);
  const padding = group === undefined ? undefined : childOf(group, Id.DiscardPadding);
  const timeMs = ((clusterTicks + rel) * ctx.scale) / 1e6;
  const keyframe = simple ? (flags & 0x80) !== 0 : childOf(group!, Id.ReferenceBlock) === undefined;
  const durationMs = duration === undefined ? undefined : (Number(duration) * ctx.scale) / 1e6;
  const body = block.subarray(length + 3);
  if (lacing === 0) {
    return [
      {
        track,
        timeMs,
        keyframe,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(padding !== undefined ? { discardPaddingNs: sintOf(padding) } : {}),
        data: body,
      },
    ];
  }
  const frames = unlace(body, lacing);
  const defaultMs = ctx.frameMs.get(track);
  // Frames are spaced by the track's DefaultDuration, else by an equal share of the BlockDuration.
  const each = defaultMs ?? (durationMs !== undefined ? durationMs / frames.length : undefined);
  return frames.map((data, i): MkvBlock => ({
    track,
    timeMs: timeMs + i * (each ?? 0),
    keyframe,
    ...(each !== undefined ? { durationMs: each } : {}),
    frameIndex: i,
    frameCount: frames.length,
    // DiscardPadding trims the end of the last frame.
    ...(padding !== undefined && i === frames.length - 1 ? { discardPaddingNs: sintOf(padding) } : {}),
    data,
  }));
}

/** The blocks of one cluster's data (what follows its id and size), in file order. */
export function clusterBlockList(ctx: BlockContext, buf: Uint8Array): MkvBlock[] {
  const children = parseOrThrow(buf, 'cluster');
  const ts = children.find((n) => n.id === Id.Timestamp);
  if (ts === undefined) throw new MkvReadError('a cluster has no Timestamp');
  const ticks = Number(uintOf(ts));
  const out: MkvBlock[] = [];
  for (const n of children) {
    if (n.id === Id.SimpleBlock) out.push(...blocksOfBlock(ctx, ticks, n.bytes!, true));
    else if (n.id === Id.BlockGroup) {
      const block = childOf(n, Id.Block);
      if (block !== undefined) out.push(...blocksOfBlock(ctx, ticks, block.bytes!, false, n));
    }
  }
  return out;
}

/** Each track's DefaultDuration in milliseconds, for the tracks that have one. */
export function frameDurations(tracks: readonly MkvTrack[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of tracks) if (t.defaultDurationNs !== undefined && t.defaultDurationNs > 0n) m.set(t.number, Number(t.defaultDurationNs) / 1e6);
  return m;
}
