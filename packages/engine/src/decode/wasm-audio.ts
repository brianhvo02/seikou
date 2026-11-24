import { speakerFromAvChannel, type ChannelLayout } from '../audio/channel-map';
import { instantiateStandaloneWasm } from '../util/standalone-wasm';

/** The exports of audio.wasm (packages/engine/wasm/audio/shim.c) plus its allocator. Pointers are byte offsets into `memory`. */
export interface AudioWasm {
  readonly memory: WebAssembly.Memory;
  /**
   * Opens a decoder for a WasmCodec id; `outChannels` 2 asks it for a stereo downmix, 6 asks TrueHD and DTS for 5.1,
   * anything else for the stream's own layout. Returns a handle, 0 when it cannot be opened.
   */
  audio_open(codec: number, outChannels: number): number;
  /**
   * Decodes one packet at `input` (`length` bytes) into `output` as interleaved float in the decoder's channel order,
   * at most `maxFrames` sample frames; returns the sample frames written, or a negative error.
   */
  audio_decode(handle: number, input: number, length: number, output: number, maxFrames: number): number;
  /** The channel count of the last audio_decode's output (0 when it gave none). */
  audio_channels(handle: number): number;
  /** The FFmpeg AVChannel id of output channel `index` of the last audio_decode. */
  audio_channel(handle: number, index: number): number;
  /** The decoder's FFmpeg profile after the last packet (DTS: 60–62 when XLL was decoded, 50 for High Resolution or a core with extension parts). */
  audio_profile(handle: number): number;
  /** The sample rate of the last decoded frame, in Hz. */
  audio_sample_rate(handle: number): number;
  /** Flushes the decoder's state (after a seek). */
  audio_reset(handle: number): void;
  audio_close(handle: number): void;
  malloc(size: number): number;
  free(ptr: number): void;
}

/** The codec ids audio_open takes: Dolby Digital (AC-3, E-AC-3), the DTS core alone, DTS with its extensions (DTS-HD) and TrueHD. */
export const WasmCodec = { AC3: 0, DTS: 1, DTS_FULL: 2, TRUEHD: 3 } as const;
/** A value of WasmCodec. */
export type WasmCodecId = (typeof WasmCodec)[keyof typeof WasmCodec];

/** One frame the decoder rejected (corrupt or not this codec). */
export class AudioFrameError extends Error {
  /** The negative value audio_decode returned. */
  constructor(readonly code: number) {
    super(`audio frame could not be decoded (${code})`);
    this.name = 'AudioFrameError';
  }
}

/** Largest output of one packet: a DTS frame of 128 blocks × 32 samples at 4× rate (XLL at 192 kHz), with headroom. */
const MAX_FRAMES = 16384;
/** Most channels the shim writes. */
const MAX_CHANNELS = 8;

/** Instantiates audio.wasm (the package's wasm/audio/) without emscripten's JS glue. */
export function loadAudioWasm(source: BufferSource | Promise<Response>): Promise<AudioWasm> {
  return instantiateStandaloneWasm<AudioWasm>(source, 'audio.wasm', 'audio decoder');
}

/** What one packet decoded to. */
export interface DecodedFrame {
  readonly sampleRate: number;
  /** The speakers of `samples` (empty when nothing came out). */
  readonly channels: ChannelLayout;
  /** Interleaved, `channels.length` samples a frame (a copy, safe to keep). */
  readonly samples: Float32Array;
  /** The decoder's FFmpeg profile after this packet (what DTS actually decoded); absent where nobody asks. */
  readonly profile?: number;
}

/** One FFmpeg decoder instance inside the shared module; decodes whole packets to interleaved float in their own layout. */
export class WasmFrameDecoder {
  private readonly handle: number;
  private readonly outPtr: number;
  private inPtr = 0;
  private inCap = 0;
  private layoutKey = '';
  private layout: ChannelLayout = [];

  /** `outChannels` is the output's channel count, which decides the downmix the decoder is asked for (see AudioWasm.audio_open). */
  constructor(
    private readonly wasm: AudioWasm,
    codec: WasmCodecId,
    outChannels = 2,
  ) {
    this.handle = wasm.audio_open(codec, outChannels);
    if (this.handle === 0) throw new Error(`audio decoder ${codec} could not be opened`);
    this.outPtr = wasm.malloc(MAX_FRAMES * MAX_CHANNELS * 4);
    if (this.outPtr === 0) {
      wasm.audio_close(this.handle);
      throw new Error('audio decoder is out of memory');
    }
  }

  /** Decodes one whole packet. Throws AudioFrameError when the decoder rejects it. */
  decode(frame: Uint8Array): DecodedFrame {
    if (frame.length > this.inCap) {
      if (this.inPtr !== 0) this.wasm.free(this.inPtr);
      this.inPtr = 0;
      this.inCap = 0;
      const cap = Math.max(frame.length, 8192);
      const p = this.wasm.malloc(cap);
      if (p === 0) throw new Error('audio decoder is out of memory');
      this.inPtr = p;
      this.inCap = cap;
    }
    // Views are taken after every call that may grow memory (growth detaches the old buffer).
    new Uint8Array(this.wasm.memory.buffer, this.inPtr, frame.length).set(frame);
    const frames = this.wasm.audio_decode(this.handle, this.inPtr, frame.length, this.outPtr, MAX_FRAMES);
    if (frames < 0) throw new AudioFrameError(frames);
    const n = frames === 0 ? 0 : this.wasm.audio_channels(this.handle);
    const samples = new Float32Array(this.wasm.memory.buffer, this.outPtr, frames * n).slice();
    return { sampleRate: this.wasm.audio_sample_rate(this.handle), channels: n === 0 ? [] : this.channelLayout(n), samples, profile: this.wasm.audio_profile(this.handle) };
  }

  /** The layout of the last decode, kept while it doesn't change. */
  private channelLayout(n: number): ChannelLayout {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(this.wasm.audio_channel(this.handle, i));
    const key = ids.join(',');
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.layout = ids.map(speakerFromAvChannel);
    }
    return this.layout;
  }

  /** Flushes the decoder's state. */
  reset(): void {
    this.wasm.audio_reset(this.handle);
  }

  /** Closes the decoder and frees its buffers in the module's memory. */
  close(): void {
    this.wasm.audio_close(this.handle);
    this.wasm.free(this.outPtr);
    if (this.inPtr !== 0) this.wasm.free(this.inPtr);
  }
}
