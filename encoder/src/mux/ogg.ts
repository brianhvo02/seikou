// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Readable } from 'node:stream';
import { ChunkReader } from './chunk-reader';

export interface OpusHead {
  channels: number;
  preSkip: number;
  inputSampleRate: number;
  outputGain: number;
  mappingFamily: number;
  /** The complete OpusHead packet, written verbatim as CodecPrivate. */
  raw: Uint8Array;
}

export interface OpusPacket {
  data: Uint8Array;
  /** Cumulative from 0 over packets; pre-skip is not subtracted. */
  pts48: number;
  durationSamples: number;
}

export interface OggOpusEnd {
  totalSamples: number;
  lastGranule: number;
  discardPadding48: number;
}

export interface OggOpusStream {
  head: OpusHead;
  packets: AsyncIterable<OpusPacket>;
  /** Settles only after `packets` has been fully consumed. */
  end: Promise<OggOpusEnd>;
}

const MAX_PACKET_SAMPLES = 5760; // 120 ms at 48 kHz
const OGG_PAGE_HEADER_SIZE = 27;
const OPUS_HEAD_MIN_SIZE = 19;
const NO_GRANULE = 0xffffffffffffffffn;

/** Duration in 48 kHz samples of one Opus packet (RFC 6716 section 3.1). */
export function opusPacketDuration(packet: Uint8Array): number {
  if (packet.length < 1) throw new Error('Opus: empty packet');
  const toc = packet[0]!;
  const config = toc >> 3;
  const code = toc & 3;
  let frameSize: number;
  if (config < 12) frameSize = [480, 960, 1920, 2880][config & 3]!;
  else if (config < 16) frameSize = [480, 960][config & 1]!;
  else frameSize = [120, 240, 480, 960][config & 3]!;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 3) {
    if (packet.length < 2) throw new Error('Opus: code 3 packet is missing its frame count byte');
    frames = packet[1]! & 0x3f;
  } else frames = 2;
  if (frames < 1) throw new Error('Opus: packet has no frames');
  const duration = frames * frameSize;
  if (duration > MAX_PACKET_SAMPLES) {
    throw new Error(`Opus: packet duration ${duration} exceeds ${MAX_PACKET_SAMPLES} samples`);
  }
  return duration;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function parseOpusHead(data: Uint8Array): OpusHead {
  if (data.length < OPUS_HEAD_MIN_SIZE || ascii(data, 0, 8) !== 'OpusHead') {
    throw new Error('Ogg: first packet is not an OpusHead');
  }
  if (data[8]! >> 4 !== 0) throw new Error(`Ogg: unsupported OpusHead version ${data[8]}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    channels: data[9]!,
    preSkip: view.getUint16(10, true),
    inputSampleRate: view.getUint32(12, true),
    outputGain: view.getInt16(16, true),
    mappingFamily: data[18]!,
    raw: data,
  };
}

interface RawPacket {
  data: Uint8Array;
  /** Granule position of the page, set only on the last packet completed on that page. */
  granule: bigint | null;
}

/** Yields complete packets of the first logical stream, reassembled across pages. */
async function* readPackets(reader: ChunkReader): AsyncGenerator<RawPacket> {
  let serial: number | null = null;
  let partial: Uint8Array[] = [];
  for (;;) {
    const header = await reader.read(OGG_PAGE_HEADER_SIZE);
    if (header === null) {
      if (partial.length > 0) throw new Error('Ogg: stream ended inside a packet');
      return;
    }
    if (ascii(header, 0, 4) !== 'OggS') throw new Error('Ogg: bad capture pattern');
    if (header[4] !== 0) throw new Error(`Ogg: unsupported page version ${header[4]}`);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const flags = header[5]!;
    const granule = view.getBigUint64(6, true);
    const pageSerial = view.getUint32(14, true);
    const segmentCount = header[26]!;
    const lacing = await reader.read(segmentCount);
    if (lacing === null) throw new Error('Ogg: stream ended inside a page header');
    let bodySize = 0;
    for (const v of lacing) bodySize += v;
    const body = await reader.read(bodySize);
    if (body === null) throw new Error('Ogg: stream ended inside a page body');
    // CRC is not verified.

    if (serial === null) serial = pageSerial;
    else if (pageSerial !== serial) continue;

    const continued = (flags & 1) !== 0;
    if (continued && partial.length === 0) throw new Error('Ogg: continuation page without a packet to continue');
    if (!continued && partial.length > 0) throw new Error('Ogg: missing continuation of a packet');

    const completed: Uint8Array[] = [];
    let offset = 0;
    let segmentStart = offset;
    for (let i = 0; i < lacing.length; i++) {
      const len = lacing[i]!;
      offset += len;
      if (len < 255) {
        partial.push(body.subarray(segmentStart, offset));
        completed.push(concat(partial));
        partial = [];
        segmentStart = offset;
      }
    }
    if (segmentStart < offset || (lacing.length > 0 && lacing[lacing.length - 1] === 255)) {
      partial.push(body.subarray(segmentStart, offset));
    }

    for (let i = 0; i < completed.length; i++) {
      const last = i === completed.length - 1;
      yield { data: completed[i]!, granule: last && granule !== NO_GRANULE ? granule : null };
    }
    if ((flags & 4) !== 0) {
      if (partial.length > 0) throw new Error('Ogg: stream ended inside a packet');
      return;
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!.slice();
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function readOggOpus(stream: Readable): Promise<OggOpusStream> {
  const reader = new ChunkReader(stream, 'Ogg');
  const source = readPackets(reader);

  const first = await source.next();
  if (first.done === true) throw new Error('Ogg: empty stream');
  const head = parseOpusHead(first.value.data);
  const tags = await source.next();
  if (tags.done === true) throw new Error('Ogg: stream ended before OpusTags');
  if (ascii(tags.value.data, 0, 8) !== 'OpusTags') throw new Error('Ogg: second packet is not OpusTags');

  let resolveEnd!: (end: OggOpusEnd) => void;
  let rejectEnd!: (err: unknown) => void;
  const end = new Promise<OggOpusEnd>((resolve, reject) => {
    resolveEnd = resolve;
    rejectEnd = reject;
  });
  // The rejection is delivered through `end` and `packets`; this keeps it from being unhandled.
  end.catch(() => undefined);

  async function* packets(): AsyncGenerator<OpusPacket> {
    let totalSamples = 0;
    let lastGranule = 0n;
    try {
      for (;;) {
        const next = await source.next();
        if (next.done === true) break;
        const { data, granule } = next.value;
        if (granule !== null) lastGranule = granule;
        const durationSamples = opusPacketDuration(data);
        const pts48 = totalSamples;
        totalSamples += durationSamples;
        yield { data, pts48, durationSamples };
      }
      if (lastGranule > BigInt(Number.MAX_SAFE_INTEGER) + 1n) {
        throw new Error(`Ogg: granule position ${lastGranule} exceeds 2^53`);
      }
      const last = Number(lastGranule);
      resolveEnd({
        totalSamples,
        lastGranule: last,
        discardPadding48: last > totalSamples ? 0 : totalSamples - last,
      });
    } catch (err) {
      rejectEnd(err);
      throw err;
    }
  }

  return { head, packets: packets(), end };
}
