import { OUTPUT_SAMPLE_RATE } from '../audio/ring';
import { CodingType, codingName } from '@seikou/bdmv/stream-types';
import { AudioFramer, type FramerKind } from './audio-frames';
import { UnsupportedCodecError } from './decoder';
import { decodeLpcm, type PcmChunk } from './lpcm';
import { TrueHdCoreFilter } from './truehd-core';
import { AudioFrameError, WasmCodec, WasmFrameDecoder, type AudioWasm } from './wasm-audio';

export interface AudioUnit {
  readonly data: Uint8Array;
  /** Playlist time. */
  readonly ptsUs: number;
  readonly streamIdExtension?: number;
}

export interface AudioDecodeResult {
  readonly chunks: readonly PcmChunk[];
  /** Frames (or units) that could not be decoded and were skipped. */
  readonly failedFrames: number;
}

/** Synchronous PES-in, PCM-out decoder. Throws UnsupportedCodecError for stream-level problems. */
export interface AudioDecoder {
  decode(unit: AudioUnit): AudioDecodeResult;
  /** After a seek: drop buffered bytes and decoder state. */
  reset(): void;
  close(): void;
  /**
   * An asynchronous decoder (WebCodecs): the PCM that came out since the last decode() or takeOutput(). Its decode()
   * returns what came out so far, so the player also asks here while no unit arrives (reading paused, the end).
   */
  takeOutput?(): AudioDecodeResult;
  /** An asynchronous decoder: at the end of input, makes it give up what it holds (handed on by takeOutput). */
  flush?(): Promise<void>;
}

export type AudioDecoderFactory = (codingType: number) => Promise<AudioDecoder>;

const lpcmDecoder: AudioDecoder = {
  decode(unit) {
    try {
      return { chunks: [decodeLpcm(unit.data, unit.ptsUs)], failedFrames: 0 };
    } catch (err) {
      if (err instanceof UnsupportedCodecError) throw err;
      return { chunks: [], failedFrames: 1 };
    }
  },
  reset: () => undefined,
  close: () => undefined,
};

export class FramedWasmDecoder implements AudioDecoder {
  /** Set once a frame came out at 48 kHz; survives reset() because the stream is then known to be good. */
  private produced48k = false;

  constructor(
    private readonly codingType: number,
    private readonly framer: AudioFramer,
    private readonly frames: Pick<WasmFrameDecoder, 'decode' | 'reset' | 'close'>,
    private readonly coreFilter: TrueHdCoreFilter | null,
  ) {}

  decode(unit: AudioUnit): AudioDecodeResult {
    if (this.coreFilter && !this.coreFilter.accept(unit)) return { chunks: [], failedFrames: 0 };
    const chunks: PcmChunk[] = [];
    let failedFrames = 0;
    for (const frame of this.framer.push(unit.data, unit.ptsUs)) {
      let out: { sampleRate: number; stereo: Float32Array };
      try {
        out = this.frames.decode(frame.data);
      } catch (err) {
        if (!(err instanceof AudioFrameError)) throw err;
        failedFrames++;
        continue;
      }
      if (out.stereo.length === 0) continue;
      if (out.sampleRate !== OUTPUT_SAMPLE_RATE) {
        if (this.produced48k) {
          failedFrames++;
          continue;
        }
        throw new UnsupportedCodecError(this.codingType, `${codingName(this.codingType)} at ${out.sampleRate} Hz is not supported (only 48 kHz).`);
      }
      this.produced48k = true;
      chunks.push({ ptsUs: frame.ptsUs, sampleRate: out.sampleRate, frames: out.stereo.length / 2, stereo: out.stereo });
    }
    return { chunks, failedFrames };
  }

  reset(): void {
    this.framer.reset();
    this.frames.reset();
    this.coreFilter?.reset();
  }

  close(): void {
    this.frames.close();
  }
}

const WASM_KINDS: ReadonlyMap<number, FramerKind> = new Map([
  [CodingType.AC3, 'ac3'],
  [CodingType.TRUEHD, 'ac3'],
  [CodingType.EAC3, 'eac3'],
  [CodingType.DTS, 'dts'],
  [CodingType.DTSHD, 'dts'],
  [CodingType.DTSHD_MASTER, 'dts'],
]);

/** Builds decoders per coding type. The WASM module is loaded on first use and shared; a failed load is retried next time. */
export function createAudioDecoderFactory(loadWasm: () => Promise<AudioWasm>): AudioDecoderFactory {
  let wasm: Promise<AudioWasm> | null = null;
  const getWasm = (): Promise<AudioWasm> => {
    if (!wasm) {
      const p = loadWasm();
      wasm = p;
      p.catch(() => {
        if (wasm === p) wasm = null;
      });
    }
    return wasm;
  };
  return async (codingType) => {
    if (codingType === CodingType.LPCM) return lpcmDecoder;
    const kind = WASM_KINDS.get(codingType);
    if (!kind) throw new UnsupportedCodecError(codingType, `${codingName(codingType)} audio is not supported.`);
    const module = await getWasm();
    return new FramedWasmDecoder(
      codingType,
      new AudioFramer(kind),
      new WasmFrameDecoder(module, kind === 'dts' ? WasmCodec.DTS : WasmCodec.AC3),
      codingType === CodingType.TRUEHD ? new TrueHdCoreFilter() : null,
    );
  };
}
