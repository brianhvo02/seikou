import { instantiateStandaloneWasm } from '../util/standalone-wasm';

export interface AudioWasm {
  readonly memory: WebAssembly.Memory;
  audio_open(codec: number): number;
  audio_decode(handle: number, input: number, length: number, output: number, maxFrames: number): number;
  audio_sample_rate(handle: number): number;
  audio_reset(handle: number): void;
  audio_close(handle: number): void;
  malloc(size: number): number;
  free(ptr: number): void;
}

export const WasmCodec = { AC3: 0, DTS: 1 } as const;
export type WasmCodecId = (typeof WasmCodec)[keyof typeof WasmCodec];

/** One frame the decoder rejected (corrupt or not this codec). */
export class AudioFrameError extends Error {
  constructor(readonly code: number) {
    super(`audio frame could not be decoded (${code})`);
    this.name = 'AudioFrameError';
  }
}

/** Largest output of one access unit: a DTS frame of 128 blocks × 32 samples, with headroom. */
const MAX_FRAMES = 8192;

/** Instantiates audio.wasm (the package's wasm/audio/) without emscripten's JS glue. */
export function loadAudioWasm(source: BufferSource | Promise<Response>): Promise<AudioWasm> {
  return instantiateStandaloneWasm<AudioWasm>(source, 'audio.wasm', 'audio decoder');
}

/** One FFmpeg decoder instance inside the shared module; decodes whole frames to interleaved stereo. */
export class WasmFrameDecoder {
  private readonly handle: number;
  private readonly outPtr: number;
  private inPtr = 0;
  private inCap = 0;

  constructor(
    private readonly wasm: AudioWasm,
    codec: WasmCodecId,
  ) {
    this.handle = wasm.audio_open(codec);
    if (this.handle === 0) throw new Error(`audio decoder ${codec} could not be opened`);
    this.outPtr = wasm.malloc(MAX_FRAMES * 2 * 4);
    if (this.outPtr === 0) {
      wasm.audio_close(this.handle);
      throw new Error('audio decoder is out of memory');
    }
  }

  decode(frame: Uint8Array): { readonly sampleRate: number; readonly stereo: Float32Array } {
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
    const stereo = new Float32Array(this.wasm.memory.buffer, this.outPtr, frames * 2).slice();
    return { sampleRate: this.wasm.audio_sample_rate(this.handle), stereo };
  }

  reset(): void {
    this.wasm.audio_reset(this.handle);
  }

  close(): void {
    this.wasm.audio_close(this.handle);
    this.wasm.free(this.outPtr);
    if (this.inPtr !== 0) this.wasm.free(this.inPtr);
  }
}
