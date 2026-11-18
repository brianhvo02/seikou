// SPDX-License-Identifier: LGPL-3.0-or-later
import { CodingType } from '@seikou/bdmv/stream-types';
import { matrixFromCoefficients, type FieldFlags, type PlaneMatrix } from '../deinterlace/field-input';
import { instantiateStandaloneWasm } from '../util/standalone-wasm';

/** The exports of video.wasm (packages/engine/wasm/video/shim.c) plus its allocator. Pointers are byte offsets into `memory`. */
export interface VideoWasm {
  readonly memory: WebAssembly.Memory;
  /** Opens a decoder for a WasmVideoCodec id; returns a handle, 0 when it cannot be opened. */
  video_open(codec: number): number;
  /**
   * Feeds `length` bytes at `input` of the elementary stream, any slice of it; `ptsUs` is the time of the first picture
   * starting in them when `hasPts` is 1. Returns the pictures the decoder rejected, or -1 when out of memory.
   */
  video_push(handle: number, input: number, length: number, ptsUs: number, hasPts: number): number;
  /** Ends the stream: every picture still held comes out. Returns as video_push. */
  video_flush(handle: number): number;
  /** Takes the next picture for the accessors: 1, 0 when none is ready, -2 for a picture that isn't 4:2:0, -1 out of memory. */
  video_receive(handle: number): number;
  /** Drops every picture held (a seek); the next one out is a key picture. */
  video_reset(handle: number): void;
  /** Non-zero: B pictures are skipped. */
  video_set_skip(handle: number, on: number): void;
  video_close(handle: number): void;
  /** Where the taken picture's planes are, tightly packed I420. */
  video_picture_data(handle: number): number;
  /** The planes' size in bytes. */
  video_picture_size(handle: number): number;
  video_picture_width(handle: number): number;
  video_picture_height(handle: number): number;
  video_picture_sar_num(handle: number): number;
  video_picture_sar_den(handle: number): number;
  /** The picture's time in microseconds, NaN when it has none. */
  video_picture_pts(handle: number): number;
  /** Bit 0 key, bit 1 interlaced, bit 2 top field first, bit 3 an interlaced sequence; repeat_pict from bit 8. */
  video_picture_flags(handle: number): number;
  /** The picture's matrix_coefficients (H.264 Table E-5 numbering). */
  video_picture_colorspace(handle: number): number;
  video_frame_rate_num(handle: number): number;
  video_frame_rate_den(handle: number): number;
  malloc(size: number): number;
  free(ptr: number): void;
}

/** The codec ids video_open takes. */
export const WasmVideoCodec = { MPEG1: 0, MPEG2: 1, VC1: 2 } as const;
/** A value of WasmVideoCodec. */
export type WasmVideoCodecId = (typeof WasmVideoCodec)[keyof typeof WasmVideoCodec];

/** The video.wasm codec for a stream's coding type: MPEG-1, MPEG-2 or VC-1 video; null for any other. */
export function wasmVideoCodecFor(codingType: number): WasmVideoCodecId | null {
  if (codingType === CodingType.MPEG1_VIDEO) return WasmVideoCodec.MPEG1;
  if (codingType === CodingType.MPEG2_VIDEO) return WasmVideoCodec.MPEG2;
  if (codingType === CodingType.VC1) return WasmVideoCodec.VC1;
  return null;
}

/** One decoded picture, in presentation order. */
export interface DecodedPicture {
  /** The decoded size in pixels (both fields of an interlaced frame). */
  readonly width: number;
  readonly height: number;
  /** The size it shows at, its sample aspect applied: the width grows for a wide sample, the height for a tall one. */
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** I420, tightly packed: Y at width × height, then U and V at (width/2) × (height/2), halves rounded up. */
  readonly data: Uint8Array;
  /** The picture's time in microseconds: its PES time, or the previous picture's time plus its duration. */
  readonly ptsUs: number;
  /** How long it shows, repeated fields counted, from the sequence's frame rate (else the gap before it); 0 when unknown. */
  readonly durationUs: number;
  /** An intra picture a decode can start from. */
  readonly keyFrame: boolean;
  /** The colour matrix the stream names, or null when it names none this engine knows. */
  readonly matrix: PlaneMatrix | null;
  readonly flags: FieldFlags;
}

/** Instantiates video.wasm (the package's wasm/video/) without emscripten's JS glue. */
export function loadVideoWasm(source: BufferSource | Promise<Response>): Promise<VideoWasm> {
  return instantiateStandaloneWasm<VideoWasm>(source, 'video.wasm', 'video decoder');
}

const FLAG_KEY = 1;
const FLAG_INTERLACED = 2;
const FLAG_TFF = 4;
const FLAG_INTERLACED_SEQUENCE = 8;
const REPEAT_SHIFT = 8;

/**
 * The field flags of a decoded picture, as FieldFlags reads H.264's pic_struct. A frame FFmpeg didn't mark interlaced is
 * progressive. An interlaced sequence states which field is first for every frame (MPEG-2's top_field_first, VC-1's
 * TFF), progressive ones included: under soft pulldown that is the field shown first and, with repeat_first_field, again
 * after the second, so the order is given whenever the sequence is interlaced, as pic_struct 3 to 6 give it. A
 * progressive sequence's frames carry none; their repeat_pict above 1 is frame doubling or tripling, a repeat too.
 */
function fieldFlags(flags: number): FieldFlags {
  const interlaced = (flags & FLAG_INTERLACED) !== 0;
  const states = interlaced || (flags & FLAG_INTERLACED_SEQUENCE) !== 0;
  const fieldOrder = states ? ((flags & FLAG_TFF) !== 0 ? 'tff' : 'bff') : null;
  return { fieldOrder, progressive: !interlaced, repeatFirstField: flags >> REPEAT_SHIFT > 0 };
}

/**
 * One FFmpeg MPEG-1, MPEG-2 or VC-1 decoder inside the shared module. Synchronous: bytes go in with `push` in any
 * slices, and decoded pictures come out of `drain` and `flush` in presentation order, each a copy safe to keep.
 */
export class WasmPictureDecoder {
  private readonly handle: number;
  private inPtr = 0;
  private inCap = 0;
  private lastPtsUs: number | null = null;
  /** The previous picture's duration, unrounded. */
  private lastSpanUs = 0;
  private closed = false;

  constructor(
    private readonly wasm: VideoWasm,
    codec: WasmVideoCodecId,
  ) {
    this.handle = wasm.video_open(codec);
    if (this.handle === 0) throw new Error(`video decoder ${codec} could not be opened`);
  }

  /**
   * Feeds bytes of the elementary stream (whole pictures, parts of one, or several). `ptsUs` is the PES time of the first
   * picture that starts in them; NaN when the bytes carry none.
   */
  push(bytes: Uint8Array, ptsUs: number): void {
    if (bytes.length === 0) return;
    if (bytes.length > this.inCap) {
      if (this.inPtr !== 0) this.wasm.free(this.inPtr);
      this.inPtr = 0;
      this.inCap = 0;
      const cap = Math.max(bytes.length, 65536);
      const p = this.wasm.malloc(cap);
      if (p === 0) throw new Error('video decoder is out of memory');
      this.inPtr = p;
      this.inCap = cap;
    }
    // Views are taken after every call that may grow memory (growth detaches the old buffer).
    new Uint8Array(this.wasm.memory.buffer, this.inPtr, bytes.length).set(bytes);
    const hasPts = Number.isFinite(ptsUs);
    const r = this.wasm.video_push(this.handle, this.inPtr, bytes.length, hasPts ? ptsUs : 0, hasPts ? 1 : 0);
    if (r < 0) throw new Error('video decoder is out of memory');
  }

  /** The pictures decoded so far, in presentation order. */
  drain(): DecodedPicture[] {
    const out: DecodedPicture[] = [];
    for (;;) {
      const r = this.wasm.video_receive(this.handle);
      if (r === 0) return out;
      if (r === -2) throw new Error('video decoder produced a picture that is not 4:2:0');
      if (r < 0) throw new Error('video decoder is out of memory');
      const picture = this.take();
      if (picture) out.push(picture);
    }
  }

  /** Ends the stream and returns every picture still held. The decoder then takes a new stream from a key picture. */
  flush(): DecodedPicture[] {
    if (this.wasm.video_flush(this.handle) < 0) throw new Error('video decoder is out of memory');
    return this.drain();
  }

  /** Drops every picture held, decoded or not (a seek); the next picture out is a key picture. */
  reset(): void {
    this.wasm.video_reset(this.handle);
    this.lastPtsUs = null;
    this.lastSpanUs = 0;
  }

  /** On: B pictures, which nothing refers to, are not decoded (for a device too slow to decode them all). */
  setSkipNonReference(on: boolean): void {
    this.wasm.video_set_skip(this.handle, on ? 1 : 0);
  }

  /** Closes the decoder and frees its buffers in the module's memory. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wasm.video_close(this.handle);
    if (this.inPtr !== 0) this.wasm.free(this.inPtr);
  }

  /**
   * Reads the picture video_receive took. A picture with no time of its own follows the one before it; with nothing
   * before it to follow, it is dropped (null).
   */
  private take(): DecodedPicture | null {
    const w = this.wasm;
    const h = this.handle;
    const flags = w.video_picture_flags(h);
    const repeat = flags >> REPEAT_SHIFT;
    const rateNum = w.video_frame_rate_num(h);
    const rateDen = w.video_frame_rate_den(h);
    let ptsUs = w.video_picture_pts(h);
    if (Number.isNaN(ptsUs)) {
      if (this.lastPtsUs === null || this.lastSpanUs <= 0) return null;
      ptsUs = Math.round(this.lastPtsUs + this.lastSpanUs);
    }
    let frameUs = 0;
    if (rateNum > 0 && rateDen > 0) frameUs = (1e6 * rateDen) / rateNum;
    else if (this.lastPtsUs !== null && ptsUs > this.lastPtsUs) frameUs = ptsUs - this.lastPtsUs;
    const spanUs = frameUs * (1 + repeat / 2);
    this.lastPtsUs = ptsUs;
    this.lastSpanUs = spanUs;

    const width = w.video_picture_width(h);
    const height = w.video_picture_height(h);
    const sarNum = w.video_picture_sar_num(h);
    const sarDen = w.video_picture_sar_den(h);
    let displayWidth = width;
    let displayHeight = height;
    if (sarNum > 0 && sarDen > 0 && sarNum !== sarDen) {
      if (sarNum > sarDen) displayWidth = Math.round((width * sarNum) / sarDen);
      else displayHeight = Math.round((height * sarDen) / sarNum);
    }
    const data = new Uint8Array(w.memory.buffer, w.video_picture_data(h), w.video_picture_size(h)).slice();
    return {
      width,
      height,
      displayWidth,
      displayHeight,
      data,
      ptsUs,
      durationUs: Math.round(spanUs),
      keyFrame: (flags & FLAG_KEY) !== 0,
      matrix: matrixFromCoefficients(w.video_picture_colorspace(h)),
      flags: fieldFlags(flags),
    };
  }
}
