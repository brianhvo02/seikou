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

export interface IvfHeader {
  fourcc: string;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  frameCount: number;
}

export interface Av1Packet {
  index: number;
  data: Uint8Array;
  keyframe: boolean;
}

export interface SequenceHeaderResult {
  obu: Obu;
  info: SequenceHeaderInfo;
  av1C: Uint8Array;
}

export interface IvfStream {
  header: IvfHeader;
  packets: AsyncIterable<Av1Packet>;
  sequenceHeader: Promise<SequenceHeaderResult>;
}

/** Matroska's AV1 mapping says temporal delimiter OBUs SHOULD be removed from block data. */
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
