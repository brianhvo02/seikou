// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Readable } from 'node:stream';

// A WAV stream is a RIFF file (Microsoft, "Multimedia Programming Interface and Data Specifications
// 1.0", 1991, chapter 2 "RIFF"): the 12-byte header `RIFF <u32 size> WAVE`, then chunks, each an
// ASCII four-character id, a little-endian u32 size and that many bytes, padded to an even length.
// The `fmt ` chunk is WAVEFORMATEX (Microsoft Learn, "WAVEFORMATEX structure"): wFormatTag u16,
// nChannels u16, nSamplesPerSec u32, nAvgBytesPerSec u32, nBlockAlign u16 (bytes per frame of all
// channels), wBitsPerSample u16, then, for formats with more, cbSize u16 and cbSize bytes. Tag
// 0xFFFE is WAVEFORMATEXTENSIBLE (Microsoft Learn, "WAVEFORMATEXTENSIBLE structure"), whose 22 extra
// bytes are wValidBitsPerSample u16, dwChannelMask u32 and the SubFormat GUID; the GUIDs for PCM and
// IEEE float are the plain format tag in their first two bytes followed by
// 0000-0010-8000-00AA00389B71 (Microsoft Learn, "Converting Format Tags and Subformat GUIDs").
// Samples are interleaved little-endian frames: channel 0 first.
//
// vspipe writes this extensible form, and a decoder that does not know the length in advance writes a
// `data` size of 0 or 0xFFFFFFFF; both mean "read to the end of the stream".

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
/** Bytes 2..15 of the SubFormat GUID shared by every format-tag GUID, as stored in the file. */
const SUBTYPE_GUID_TAIL = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);
/** A fmt chunk larger than this is not a WAVE format we read. */
const MAX_FMT_BYTES = 1024;
/** Frames converted per chunk handed to the consumer, so a large read does not become one huge array. */
const FRAMES_PER_CHUNK = 8192;

/** The sample layout of a WAV stream. */
export interface WavFormat {
  channels: number;
  /** Frames per second, in Hz. */
  sampleRate: number;
  /** Container bits per sample: 16 or 24 for integer PCM, 32 for integer or float. */
  bitsPerSample: 16 | 24 | 32;
  /** True for IEEE float samples, false for signed integers. */
  float: boolean;
}

/** A WAV stream whose header has been read; `frames` reads the samples. */
export interface WavReader {
  format: WavFormat;
  /**
   * The samples as planar chunks, one `Float32Array` per channel, scaled to [-1, 1) for integer
   * formats and passed through for float. Iterate it once. Ends at the `data` chunk's size, or at
   * the end of the stream for a streamed size; a trailing partial frame is dropped.
   */
  frames: AsyncIterable<Float32Array[]>;
}

/** Pulls exact byte counts out of a chunked async source. */
class ByteQueue {
  private buffered: Buffer = Buffer.alloc(0);
  private done = false;

  constructor(private readonly source: AsyncIterator<unknown>) {}

  /** Reads until at least `n` bytes are buffered or the source ends; returns how many are buffered. */
  async fill(n: number): Promise<number> {
    while (this.buffered.length < n && !this.done) {
      const next = await this.source.next();
      if (next.done === true) this.done = true;
      else this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value as Uint8Array)]);
    }
    return this.buffered.length;
  }

  /** Exactly `n` bytes; throws when the source ends first. */
  async take(n: number, what: string): Promise<Buffer> {
    if ((await this.fill(n)) < n) throw new Error(`WAV stream ends inside the ${what}`);
    const out = this.buffered.subarray(0, n);
    this.buffered = this.buffered.subarray(n);
    return out;
  }

  /** Up to `max` bytes, at least one unless the source has ended (then an empty buffer). */
  async some(max: number): Promise<Buffer> {
    if (this.buffered.length === 0) await this.fill(1);
    const n = Math.min(max, this.buffered.length);
    const out = this.buffered.subarray(0, n);
    this.buffered = this.buffered.subarray(n);
    return out;
  }

  async skip(n: number, what: string): Promise<void> {
    let left = n;
    while (left > 0) {
      const got = await this.some(left);
      if (got.length === 0) throw new Error(`WAV stream ends inside the ${what}`);
      left -= got.length;
    }
  }
}

function tagName(tag: number): string {
  return `0x${tag.toString(16).padStart(4, '0')}`;
}

/** Decodes a WAVEFORMATEX or WAVEFORMATEXTENSIBLE body into a `WavFormat`, refusing what this reader cannot convert. */
function parseFmt(fmt: Buffer): { format: WavFormat; blockAlign: number } {
  if (fmt.length < 16) throw new Error(`WAV fmt chunk is ${fmt.length} bytes, shorter than WAVEFORMATEX's 16`);
  let tag = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const blockAlign = fmt.readUInt16LE(12);
  const bits = fmt.readUInt16LE(14);
  if (tag === WAVE_FORMAT_EXTENSIBLE) {
    if (fmt.length < 40 || fmt.readUInt16LE(16) < 22) throw new Error('WAV fmt chunk is too short for WAVEFORMATEXTENSIBLE');
    if (!fmt.subarray(26, 40).equals(SUBTYPE_GUID_TAIL)) throw new Error('WAV SubFormat GUID is not a format-tag GUID');
    tag = fmt.readUInt16LE(24);
  }
  if (tag !== WAVE_FORMAT_PCM && tag !== WAVE_FORMAT_IEEE_FLOAT) {
    throw new Error(`Unsupported WAV format tag ${tagName(tag)}: only PCM (0x0001) and IEEE float (0x0003) are read`);
  }
  const float = tag === WAVE_FORMAT_IEEE_FLOAT;
  if (float ? bits !== 32 : bits !== 16 && bits !== 24 && bits !== 32) {
    throw new Error(`Unsupported WAV sample size: ${bits}-bit ${float ? 'float' : 'integer'}`);
  }
  if (channels === 0 || sampleRate === 0) throw new Error('WAV fmt chunk has no channels or a zero sample rate');
  if (blockAlign !== (channels * bits) / 8) throw new Error(`WAV block align ${blockAlign} does not match ${channels} × ${bits}-bit samples`);
  return { format: { channels, sampleRate, bitsPerSample: bits as WavFormat['bitsPerSample'], float }, blockAlign };
}

/** Converts whole interleaved frames into one plane per channel. */
function toPlanar(bytes: Buffer, format: WavFormat, blockAlign: number): Float32Array[] {
  const frames = bytes.length / blockAlign;
  const width = format.bitsPerSample / 8;
  const planes = Array.from({ length: format.channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    let at = f * blockAlign;
    for (let ch = 0; ch < format.channels; ch++, at += width) {
      let v: number;
      if (format.float) v = bytes.readFloatLE(at);
      else if (width === 2) v = bytes.readInt16LE(at) / 32768;
      else if (width === 3) v = bytes.readIntLE(at, 3) / 8388608;
      else v = bytes.readInt32LE(at) / 2147483648;
      planes[ch][f] = v;
    }
  }
  return planes;
}

async function* framesOf(queue: ByteQueue, dataSize: number | null, format: WavFormat, blockAlign: number): AsyncGenerator<Float32Array[]> {
  let left = dataSize ?? Infinity;
  let carry = Buffer.alloc(0);
  const chunkBytes = FRAMES_PER_CHUNK * blockAlign;
  while (left > 0) {
    const got = await queue.some(Math.min(left, chunkBytes));
    if (got.length === 0) break;
    left -= got.length;
    const bytes = carry.length > 0 ? Buffer.concat([carry, got]) : got;
    const whole = bytes.length - (bytes.length % blockAlign);
    carry = Buffer.from(bytes.subarray(whole));
    if (whole > 0) yield toPlanar(bytes.subarray(0, whole), format, blockAlign);
  }
}

/**
 * Reads a WAV header from `stream` and returns its format and an iterator over its samples (see
 * `WavReader`). Accepts `WAVE_FORMAT_PCM` (16, 24 or 32-bit), `WAVE_FORMAT_IEEE_FLOAT` (32-bit) and
 * `WAVE_FORMAT_EXTENSIBLE` with either as its subformat; skips chunks other than `fmt ` before
 * `data`. Rejects input that is not RIFF/WAVE, an unsupported format (naming its tag) and a header
 * cut short. The reader takes over the stream: nothing else should read it.
 */
export async function readWav(stream: Readable): Promise<WavReader> {
  const queue = new ByteQueue(stream[Symbol.asyncIterator]());
  const riff = await queue.take(12, 'RIFF header').catch(() => Buffer.alloc(0));
  if (riff.length < 12 || riff.toString('latin1', 0, 4) !== 'RIFF' || riff.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV stream: it does not start with a RIFF/WAVE header');
  }
  let parsed: { format: WavFormat; blockAlign: number } | null = null;
  for (;;) {
    const head = await queue.take(8, 'chunk header');
    const id = head.toString('latin1', 0, 4);
    const size = head.readUInt32LE(4);
    if (id === 'data') {
      if (parsed === null) throw new Error('WAV data chunk comes before the fmt chunk');
      const streamed = size === 0 || size === 0xffffffff;
      return { format: parsed.format, frames: framesOf(queue, streamed ? null : size, parsed.format, parsed.blockAlign) };
    }
    if (id === 'fmt ') {
      if (size > MAX_FMT_BYTES) throw new Error(`WAV fmt chunk of ${size} bytes is too large`);
      parsed = parseFmt(await queue.take(size, 'fmt chunk'));
      if (size % 2 === 1) await queue.skip(1, 'fmt chunk');
    } else {
      await queue.skip(size + (size % 2), `${id} chunk`);
    }
  }
}
