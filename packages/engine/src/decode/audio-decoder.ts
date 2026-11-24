import { OUTPUT_SAMPLE_RATE } from '../audio/ring';
import { CodingType, codingName } from '@seikou/bdmv/stream-types';
import { layoutName, type ChannelLayout, type OutputChannels } from '../audio/channel-map';
import { AudioFramer, type AudioFrame, type FramerKind } from './audio-frames';
import { UnsupportedCodecError } from './decoder';
import { decodeLpcm, type PcmChunk } from './lpcm';
import { AC3_CORE_EXTENSION, TrueHdCoreFilter } from './truehd-core';
import { AudioFrameError, WasmCodec, WasmFrameDecoder, type AudioWasm, type DecodedFrame, type WasmCodecId } from './wasm-audio';

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
   * A synchronous decoder that holds a packet back until the next one starts (an E-AC-3 access unit, a DTS-HD core
   * with its extension substream): at the end of input, the PCM of that last packet.
   */
  end?(): AudioDecodeResult;
  /**
   * An asynchronous decoder: the time of the oldest unit given to decode() whose PCM has not come out yet, or null.
   * Silence for missing audio is never filled past it, so late PCM is not lost.
   */
  pendingFromUs?(): number | null;
  /** How the stream is being decoded, for the telemetry and the Audio menu; null before anything came out. */
  decoding?(): AudioDecoding | null;
}

/** How a stream with a lossless or extended part (TrueHD, DTS-HD) is decoded, and the layout that came out. */
export interface AudioDecoding {
  /** `full`: TrueHD's MLP or DTS-HD's extensions are decoded; `core`: only the Dolby Digital or DTS core; `plain`: a stream with no such parts. */
  readonly part: 'full' | 'core' | 'plain';
  /** The channels the decoder put out (before any mix to the output). */
  readonly channels: ChannelLayout;
}

/**
 * How the telemetry names a stream's decoding: `name` plus, for TrueHD and DTS-HD, "lossless" (TrueHD, DTS-HD Master
 * Audio decoded whole) or the core it plays, plus the decoded layout ("Dolby TrueHD, lossless, 7.1").
 * @internal
 */
export function describeAudioDecoding(name: string, codingType: number, decoding: AudioDecoding): string {
  const layout = layoutName(decoding.channels);
  if (decoding.part === 'core') return `${name}, ${codingType === CodingType.TRUEHD ? 'Dolby Digital' : 'DTS'} core, ${layout}`;
  if (decoding.part === 'full' && codingType !== CodingType.DTSHD) return `${name}, lossless, ${layout}`;
  return `${name}, ${layout}`;
}

/** What a decoder is made for besides its coding type. */
export interface AudioDecoderOptions {
  /** The output's channel count (2, 6 or 8): a stereo output asks every decoder for its stereo downmix, as before. Default 2. */
  readonly outputChannels?: OutputChannels;
  /** Decode TrueHD and DTS-HD whole (falling back to their cores); false plays the cores. Default false. */
  readonly lossless?: boolean;
  /** A clock in milliseconds for the lossless decoders' cost check; default `performance.now`. */
  readonly nowMs?: () => number;
  /** Where a fallback to the core is logged. */
  readonly log?: (message: string) => void;
}

/**
 * Makes a decoder for a Blu-ray coding type (`CodingType`); rejects with UnsupportedCodecError for one with no decoder,
 * or when the audio WASM cannot be loaded.
 */
export type AudioDecoderFactory = (codingType: number, options?: AudioDecoderOptions) => Promise<AudioDecoder>;

function lpcmDecoder(): AudioDecoder {
  let channels: ChannelLayout | null = null;
  return {
    decode(unit) {
      try {
        const chunk = decodeLpcm(unit.data, unit.ptsUs);
        channels = chunk.channels;
        return { chunks: [chunk], failedFrames: 0 };
      } catch (err) {
        if (err instanceof UnsupportedCodecError) throw err;
        return { chunks: [], failedFrames: 1 };
      }
    },
    reset: () => undefined,
    close: () => undefined,
    decoding: () => (channels ? { part: 'plain', channels } : null),
  };
}

/** Rates a lossless decoder may put out (the player decimates them to 48 kHz); the lossy ones give 48 kHz only. */
const LOSSLESS_RATES: ReadonlySet<number> = new Set([48_000, 96_000, 192_000]);
const LOSSY_RATES: ReadonlySet<number> = new Set([OUTPUT_SAMPLE_RATE]);

/** Which units of a TrueHD PID a decoder takes: the AC-3 core or the MLP part. */
interface UnitFilter {
  accept(unit: AudioUnit): boolean;
  reset(): void;
}

/** Passes only the MLP units of a TrueHD stream (stream_id_extension 0x72, or anything not an AC-3 frame). */
export class TrueHdMlpFilter implements UnitFilter {
  accept(unit: AudioUnit): boolean {
    return unit.streamIdExtension === undefined ? !(unit.data[0] === 0x0b && unit.data[1] === 0x77) : unit.streamIdExtension !== AC3_CORE_EXTENSION;
  }

  reset(): void {}
}

/**
 * Decodes AC-3, E-AC-3, DTS, TrueHD and DTS-HD (whole or their cores): an AudioFramer cuts the payloads into frames,
 * the WASM decoder (FFmpeg's) turns each into PCM in the stream's own layout (or the stereo downmix a stereo output
 * asked for). A frame the decoder rejects is skipped and counted (a TrueHD framer then waits for the next major sync);
 * a rate outside `rates` throws UnsupportedCodecError unless a good frame has already come out of this stream.
 */
export class FramedWasmDecoder implements AudioDecoder {
  /** Set once a frame came out at a good rate; survives reset() because the stream is then known to be good. */
  private producedGood = false;
  private lastChannels: ChannelLayout | null = null;
  private lastPart: AudioDecoding['part'] | null = null;

  constructor(
    private readonly codingType: number,
    private readonly framer: AudioFramer,
    private readonly frames: Pick<WasmFrameDecoder, 'decode' | 'reset' | 'close'>,
    private readonly unitFilter: UnitFilter | null,
    private readonly rates: ReadonlySet<number> = LOSSY_RATES,
    private readonly part: AudioDecoding['part'] = 'plain',
    /** What a frame's FFmpeg profile says was decoded, where the decoder can fall back quietly (DTS-HD's XLL). */
    private readonly partOf: ((profile: number | undefined) => AudioDecoding['part']) | null = null,
  ) {}

  decode(unit: AudioUnit): AudioDecodeResult {
    if (this.unitFilter && !this.unitFilter.accept(unit)) return { chunks: [], failedFrames: 0 };
    return this.decodeFrames(this.framer.push(unit.data, unit.ptsUs));
  }

  end(): AudioDecodeResult {
    return this.decodeFrames(this.framer.flush());
  }

  private decodeFrames(frames: readonly AudioFrame[]): AudioDecodeResult {
    const chunks: PcmChunk[] = [];
    let failedFrames = 0;
    for (const frame of frames) {
      let out: DecodedFrame;
      try {
        out = this.frames.decode(frame.data);
      } catch (err) {
        if (!(err instanceof AudioFrameError)) throw err;
        failedFrames++;
        this.framer.resync();
        continue;
      }
      if (out.samples.length === 0 || out.channels.length === 0) continue;
      if (!this.rates.has(out.sampleRate)) {
        if (this.producedGood) {
          failedFrames++;
          continue;
        }
        const allowed = [...this.rates].map((r) => r / 1000).join(', ');
        throw new UnsupportedCodecError(this.codingType, `${codingName(this.codingType)} at ${out.sampleRate} Hz is not supported (only ${allowed} kHz).`);
      }
      this.producedGood = true;
      this.lastChannels = out.channels;
      if (this.partOf) this.lastPart = this.partOf(out.profile);
      chunks.push({ ptsUs: frame.ptsUs, sampleRate: out.sampleRate, frames: out.samples.length / out.channels.length, channels: out.channels, samples: out.samples });
    }
    return { chunks, failedFrames };
  }

  reset(): void {
    this.framer.reset();
    this.frames.reset();
    this.unitFilter?.reset();
  }

  close(): void {
    this.frames.close();
  }

  decoding(): AudioDecoding | null {
    return this.lastChannels ? { part: this.lastPart ?? this.part, channels: this.lastChannels } : null;
  }
}

/**
 * What FFmpeg's dca decoder decoded, from its profile: DTS-HD Master Audio counts as whole only with XLL decoded
 * (profiles 60–62), High Resolution with its extensions (50) too; anything else is its core (dcadec falls back to the
 * core quietly when XLL fails). @internal
 */
export function dtsHdPart(codingType: number): (profile: number | undefined) => AudioDecoding['part'] {
  return (profile) => {
    if (profile === undefined) return 'full';
    if (profile >= 60 && profile <= 62) return 'full';
    return profile === 50 && codingType === CodingType.DTSHD ? 'full' : 'core';
  };
}

/** Stream time a lossless decoder may run without output while its core is there, before the core takes over. */
const LOSSLESS_SILENT_LIMIT_US = 2_000_000;
/** Frames the lossless decoder may reject in a row before the core takes over (the player gives up at 50). */
const LOSSLESS_ERRORS_IN_ROW = 8;
/** Seconds of decoded audio over which the cost of lossless decoding is measured. */
const COST_WINDOW_S = 5;
/** Share of real time lossless decoding may take on the engine worker before the core takes over. */
const MAX_COST = 0.25;

/**
 * TrueHD or DTS-HD decoded whole, with the core decoder as its fallback for the rest of the stream (from the next unit)
 * when the whole decoder fails at the stream level, gives nothing for 2 s of stream time, rejects 8 frames in a row,
 * or costs more than a quarter of real time over 5 s of audio.
 */
export class LosslessDecoder implements AudioDecoder {
  private core: AudioDecoder | null = null;
  private firstUs: number | null = null;
  private seenOutput = false;
  private errorsInRow = 0;
  private windowAudioS = 0;
  private windowCostMs = 0;
  /** Why the core took over, once it has. */
  fallbackReason: string | null = null;

  constructor(
    private readonly codingType: number,
    private readonly whole: AudioDecoder,
    private readonly makeCore: () => AudioDecoder,
    private readonly nowMs: () => number = () => performance.now(),
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  decode(unit: AudioUnit): AudioDecodeResult {
    if (this.core) return this.core.decode(unit);
    const t0 = this.nowMs();
    let result: AudioDecodeResult;
    try {
      result = this.whole.decode(unit);
    } catch (err) {
      if (!(err instanceof UnsupportedCodecError)) throw err;
      return this.fallBack(err.message).decode(unit);
    }
    const cost = this.nowMs() - t0;
    this.firstUs ??= unit.ptsUs;
    if (result.chunks.length > 0) {
      this.seenOutput = true;
      this.errorsInRow = 0;
    }
    this.errorsInRow += result.failedFrames;
    if (this.errorsInRow >= LOSSLESS_ERRORS_IN_ROW) {
      this.fallBack(`${this.errorsInRow} frames in a row could not be decoded`);
      return { chunks: result.chunks, failedFrames: 0 };
    }
    if (!this.seenOutput && unit.ptsUs - this.firstUs >= LOSSLESS_SILENT_LIMIT_US) {
      return this.fallBack('nothing came out for 2 s').decode(unit);
    }
    this.windowCostMs += cost;
    for (const c of result.chunks) this.windowAudioS += c.frames / c.sampleRate;
    if (this.windowAudioS >= COST_WINDOW_S) {
      const share = this.windowCostMs / 1000 / this.windowAudioS;
      this.windowAudioS = 0;
      this.windowCostMs = 0;
      if (share > MAX_COST) this.fallBack(`decoding took ${Math.round(share * 100)}% of real time`);
    }
    return result;
  }

  end(): AudioDecodeResult {
    return (this.core ?? this.whole).end?.() ?? { chunks: [], failedFrames: 0 };
  }

  private fallBack(reason: string): AudioDecoder {
    this.fallbackReason = reason;
    this.log(`${codingName(this.codingType)}: playing the core from here (${reason})`);
    this.whole.close();
    this.core = this.makeCore();
    return this.core;
  }

  reset(): void {
    this.firstUs = null;
    this.errorsInRow = 0;
    if (this.core) this.core.reset();
    else this.whole.reset();
  }

  close(): void {
    if (this.core) this.core.close();
    else this.whole.close();
  }

  decoding(): AudioDecoding | null {
    return (this.core ?? this.whole).decoding?.() ?? null;
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

/**
 * Builds decoders per coding type. The WASM module is loaded on first use and shared; a failed load is retried next
 * time. With `lossless`, TrueHD and DTS-HD are decoded whole (`LosslessDecoder`, the core as fallback); else their cores.
 */
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
  return async (codingType, options = {}) => {
    if (codingType === CodingType.LPCM) return lpcmDecoder();
    const kind = WASM_KINDS.get(codingType);
    if (!kind) throw new UnsupportedCodecError(codingType, `${codingName(codingType)} audio is not supported.`);
    const module = await getWasm();
    const out = options.outputChannels ?? 2;
    const hasCore = codingType === CodingType.TRUEHD || codingType === CodingType.DTSHD || codingType === CodingType.DTSHD_MASTER;
    const framed = (framer: FramerKind, codec: WasmCodecId, filter: UnitFilter | null, rates: ReadonlySet<number>, part: AudioDecoding['part'], partOf: ((p: number | undefined) => AudioDecoding['part']) | null = null): FramedWasmDecoder =>
      new FramedWasmDecoder(codingType, new AudioFramer(framer), new WasmFrameDecoder(module, codec, out), filter, rates, part, partOf);
    const core = (): FramedWasmDecoder =>
      codingType === CodingType.TRUEHD
        ? framed('ac3', WasmCodec.AC3, new TrueHdCoreFilter(), LOSSY_RATES, 'core')
        : framed('dts', WasmCodec.DTS, null, LOSSY_RATES, hasCore ? 'core' : 'plain');
    if (!hasCore) return framed(kind, kind === 'dts' ? WasmCodec.DTS : WasmCodec.AC3, null, LOSSY_RATES, 'plain');
    if (!options.lossless) return core();
    const whole =
      codingType === CodingType.TRUEHD
        ? framed('truehd', WasmCodec.TRUEHD, new TrueHdMlpFilter(), LOSSLESS_RATES, 'full')
        : framed('dtshd', WasmCodec.DTS_FULL, null, LOSSLESS_RATES, 'full', dtsHdPart(codingType));
    return new LosslessDecoder(codingType, whole, core, options.nowMs, options.log);
  };
}
