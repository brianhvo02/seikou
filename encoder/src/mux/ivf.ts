// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Readable } from 'node:stream';
import { ChunkReader } from './chunk-reader';
import {
  buildAv1C,
  isKeyframe,
  ObuType,
  parseSequenceHeader,
  splitObus,
  type Obu,
  type SequenceHeaderInfo,
} from './av1';

// IVF is the simple container SVT-AV1 writes to stdout. It has no formal specification; the layout
// below is the one libaom's ivfenc/ivfdec tools use, all fields little-endian:
//   file header, 32 bytes: "DKIF" (4), version (2, 0), header length (2, 32), fourcc (4, "AV01"),
//     width (2), height (2), timebase denominator (4: the frame rate's numerator),
//     timebase numerator (4: the frame rate's denominator), frame count (4), unused (4)
//   per frame, 12 bytes of header: frame size in bytes (4), presentation timestamp (8), then the
//     frame's data, which for AV1 is one temporal unit in the low-overhead format.

/** The 32-byte IVF file header. */
export interface IvfHeader {
  fourcc: string;
  width: number;
  height: number;
  /** Frame rate as a fraction. */
  fpsNum: number;
  fpsDen: number;
  /** Frame count the writer declared. An encoder writing to a pipe cannot go back to fix it, so it may be 0 or wrong; the packets are what count. */
  frameCount: number;
}

/** One temporal unit, ready to become a Matroska block. */
export interface Av1Packet {
  /** 0-based position in the stream; the frame's presentation time is derived from it and the frame rate. */
  index: number;
  /** The temporal unit with its temporal delimiter OBU removed. */
  data: Uint8Array;
  /** True when the unit starts with a key frame (see `isKeyframe`). */
  keyframe: boolean;
}

/** The first sequence header OBU found in the stream and what is derived from it. */
export interface SequenceHeaderResult {
  obu: Obu;
  info: SequenceHeaderInfo;
  /** The `av1C` record to store as CodecPrivate. */
  av1C: Uint8Array;
}

/** A parsed IVF stream. */
export interface IvfStream {
  header: IvfHeader;
  /** Single-use; reading it drives the underlying stream. */
  packets: AsyncIterable<Av1Packet>;
  /** Resolves as soon as the first sequence header is read, without consuming `packets`; rejects if the stream has none. */
  sequenceHeader: Promise<SequenceHeaderResult>;
}

/**
 * Removes temporal delimiter OBUs from a temporal unit. The Matroska AV1 mapping says they
 * SHOULD be removed from block data (a player puts one back when reconstructing the stream).
 */
export function stripTemporalDelimiters(temporalUnit: Uint8Array): Uint8Array {
  const obus = splitObus(temporalUnit);
  if (!obus.some((o) => o.type === ObuType.TEMPORAL_DELIMITER)) return temporalUnit;
  const kept = obus.filter((o) => o.type !== ObuType.TEMPORAL_DELIMITER);
  const out = new Uint8Array(kept.reduce((n, o) => n + o.header.length + o.payload.length, 0));
  let pos = 0;
  for (const o of kept) {
    out.set(o.header, pos);
    out.set(o.payload, pos + o.header.length);
    pos += o.header.length + o.payload.length;
  }
  return out;
}

const IVF_HEADER_SIZE = 32;
const IVF_FRAME_HEADER_SIZE = 12;

/**
 * Reads an IVF stream from `stream`: the file header, then a lazy packet iterator. Frames are read
 * ahead only as far as the first sequence header, so `sequenceHeader` resolves early. Rejects on a
 * bad signature, a truncated header or a stream that ends without a sequence header OBU; a
 * truncated frame later makes `packets` throw. Zero-length frames are yielded as empty packets.
 */
export async function readIvf(stream: Readable): Promise<IvfStream> {
  const reader = new ChunkReader(stream, 'IVF');
  const raw = await reader.read(IVF_HEADER_SIZE);
  if (raw === null) throw new Error('IVF: empty stream');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const signature = String.fromCharCode(raw[0]!, raw[1]!, raw[2]!, raw[3]!);
  if (signature !== 'DKIF') throw new Error(`IVF: bad signature ${JSON.stringify(signature)}`);
  const headerSize = view.getUint16(6, true);
  if (headerSize > IVF_HEADER_SIZE) {
    if ((await reader.read(headerSize - IVF_HEADER_SIZE)) === null) {
      throw new Error('IVF: truncated header');
    }
  }
  const header: IvfHeader = {
    fourcc: String.fromCharCode(raw[8]!, raw[9]!, raw[10]!, raw[11]!),
    width: view.getUint16(12, true),
    height: view.getUint16(14, true),
    // The IVF timebase is stored as rate then scale, which is the frame rate numerator and denominator.
    fpsNum: view.getUint32(16, true),
    fpsDen: view.getUint32(20, true),
    frameCount: view.getUint32(24, true),
  };

  async function nextFrame(): Promise<Uint8Array | null> {
    const fh = await reader.read(IVF_FRAME_HEADER_SIZE);
    if (fh === null) return null;
    const size = new DataView(fh.buffer, fh.byteOffset, fh.byteLength).getUint32(0, true);
    if (size === 0) return new Uint8Array(0);
    const data = await reader.read(size);
    if (data === null) throw new Error('IVF: truncated stream (missing frame data)');
    return data;
  }

  function findSequenceHeader(frame: Uint8Array): SequenceHeaderResult | null {
    const obu = splitObus(frame).find((o) => o.type === ObuType.SEQUENCE_HEADER);
    if (obu === undefined) return null;
    const info = parseSequenceHeader(obu.payload);
    return { obu, info, av1C: buildAv1C(obu, info) };
  }

  // Read ahead until the sequence header shows up, so it can resolve without the packets being consumed.
  // Frames read on the way are held and handed to `packets` first.
  const held: Uint8Array[] = [];
  const scan = (async (): Promise<SequenceHeaderResult> => {
    for (;;) {
      const frame = await nextFrame();
      if (frame === null) {
        throw new Error('IVF: stream ended without a sequence header OBU');
      }
      held.push(frame);
      const found = findSequenceHeader(frame);
      if (found !== null) {
        return found;
      }
    }
  })();
  // The rejection is delivered through `sequenceHeader` and `packets`; this keeps it from being unhandled.
  scan.catch(() => undefined);

  async function* packets(): AsyncGenerator<Av1Packet> {
    let index = 0;
    const seq = await scan;
    const packet = (frame: Uint8Array): Av1Packet => {
      const data = stripTemporalDelimiters(frame);
      return { index: index++, data, keyframe: isKeyframe(data, seq.info) };
    };
    for (const frame of held.splice(0)) yield packet(frame);
    for (;;) {
      const frame = await nextFrame();
      if (frame === null) return;
      yield packet(frame);
    }
  }

  return { header, packets: packets(), sequenceHeader: scan };
}
