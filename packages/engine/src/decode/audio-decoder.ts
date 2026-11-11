import { OUTPUT_SAMPLE_RATE } from '../audio/ring';
import { CodingType, codingName } from '@seikou/bdmv/stream-types';
import { AudioFramer, type FramerKind } from './audio-frames';
import { UnsupportedCodecError } from './decoder';
import { decodeLpcm, type PcmChunk } from './lpcm';
import { TrueHdCoreFilter } from './truehd-core';
import { AudioFrameError, WasmCodec, WasmFrameDecoder, type AudioWasm } from './wasm-audio';

/** One PES payload of an audio stream, as the pipeline hands it to a decoder. */
export interface AudioUnit {
  /** The PES payload (for a disc stream, without the PES header). */
  readonly data: Uint8Array;
  /** Playlist time. */
  readonly ptsUs: number;
  /** The PES header's stream_id_extension, when it has one (ISO/IEC 13818-1 §2.4.3.7); TrueHdCoreFilter uses it to tell the AC-3 core from the MLP part. */
  readonly streamIdExtension?: number;
  /** A Matroska block's DiscardPadding in microseconds: samples at the end of its output to drop. */
  readonly discardPaddingUs?: number;
}

/** What one decode() call produced. */
export interface AudioDecodeResult {
  /** The PCM that came out, in presentation order (empty while a frame is still incomplete). */
  readonly chunks: readonly PcmChunk[];
  /** Frames (or units) that could not be decoded and were skipped. */
  readonly failedFrames: number;
}

/**
 * PES-in, PCM-out decoder (synchronous, except that an asynchronous one such as Opus returns late PCM through
 * takeOutput). Throws UnsupportedCodecError for stream-level problems; a frame that fails to decode is counted in
 * `failedFrames` instead.
 */
export interface AudioDecoder {
  /** Feeds one unit and returns the PCM that completed. */
  decode(unit: AudioUnit): AudioDecodeResult;
  /** After a seek: drop buffered bytes and decoder state. */
  reset(): void;
  /** Releases the decoder; it is not used afterwards. */
  close(): void;
  /**
   * An asynchronous decoder (WebCodecs): the PCM that came out since the last decode() or takeOutput(). Its decode()
   * returns what came out so far, so the player also asks here while no unit arrives (reading paused, the end).
   */
  takeOutput?(): AudioDecodeResult;
  /** An asynchronous decoder: at the end of input, makes it give up what it holds (handed on by takeOutput). */
  flush?(): Promise<void>;
  /**
   * An asynchronous decoder: the time of the oldest unit given to decode() whose PCM has not come out yet, or null.
   * Silence for missing audio is never filled past it, so late PCM is not lost.
   */
  pendingFromUs?(): number | null;
}

/** Makes a decoder for a Blu-ray coding type (`CodingType`); rejects with UnsupportedCodecError for one with no decoder, or when the audio WASM cannot be loaded. */
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

/**
 * Decodes AC-3, E-AC-3, DTS and the cores of TrueHD and DTS-HD: an AudioFramer cuts the payloads into frames, the
 * WASM decoder (FFmpeg's) turns each into stereo PCM at 48 kHz. A frame the decoder rejects is skipped and counted;
 * another sample rate throws UnsupportedCodecError unless a 48 kHz frame has already come out of this stream.
 */
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
