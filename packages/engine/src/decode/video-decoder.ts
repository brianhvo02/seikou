import { CodingType, codingName } from '@seikou/bdmv/stream-types';
import { DecoderError, UnsupportedCodecError, type Decoder, type StreamConfig } from './decoder';
import { analyzeAvc, avcCodecString, avcIsInterlaced, avcPpsId, type AccessUnitInfo } from '@seikou/bdmv/codecs/h264';
import { analyzeHevc, hevcCodecStrings } from '@seikou/bdmv/codecs/hevc';
import { CODING_AV1, av1CodecString } from './av1';

export interface VideoUnit {
  readonly data: Uint8Array;
  readonly ptsUs: number;
  /** Decode for reference but never present (e.g. before a seek target or outside the play item). */
  readonly discard: boolean;
  /** The container's key-frame flag (a Matroska block's), for codecs whose units carry no random access marker the decoder reads. */
  readonly key?: boolean;
}

export interface VideoDecoderLike {
  readonly state: CodecState;
  readonly decodeQueueSize: number;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

export interface VideoCodecApi {
  create(init: VideoDecoderInit): VideoDecoderLike;
  isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport>;
  makeChunk(init: EncodedVideoChunkInit): EncodedVideoChunk;
}

export const browserVideoCodecApi: VideoCodecApi = {
  create: (init) => new VideoDecoder(init),
  isConfigSupported: (config) => VideoDecoder.isConfigSupported(config),
  makeChunk: (init) => new EncodedVideoChunk(init),
};

/** The message of the UnsupportedCodecError for AV1 video the browser can't decode (an encoded episode). */
export const AV1_UNSUPPORTED_MESSAGE = "This browser can't play AV1 video.";

interface CodecOps {
  /** `key`: the container's key-frame flag, which codecs configured from CodecPrivate go by. */
  analyze(data: Uint8Array, key?: boolean): AccessUnitInfo;
  /**
   * Candidate codec strings in order of preference; the first one the browser supports is used. They come from the
   * SPS of the first unit, or from the track's CodecPrivate for a codec with `fromCodecPrivate`.
   */
  codecStrings(params: Uint8Array): readonly string[];
  /** The codec strings come from the track's CodecPrivate (StreamConfig.codecPrivate), not from the stream. */
  readonly fromCodecPrivate?: true;
  /** The message when the browser supports none of the codec strings. */
  readonly unsupportedMessage?: string;
  /** Chrome's hardware decoders reject interlaced streams ("Decoding error"); its software decoder handles them. */
  needsSoftware?(sps: Uint8Array): boolean;
  /**
   * The id of a PPS NAL unit. With it, a PPS id redefined with other content switches to software decoding: Chrome's
   * hardware decoders on macOS fail on such streams now and then ("Decoding error"), which its software decoder doesn't.
   */
  ppsId?(pps: Uint8Array): number | null;
}

const CODECS: ReadonlyMap<number, CodecOps> = new Map<number, CodecOps>([
  [CodingType.AVC, { analyze: analyzeAvc, codecStrings: (sps) => [avcCodecString(sps)], needsSoftware: avcIsInterlaced, ppsId: avcPpsId }],
  [CodingType.HEVC, { analyze: analyzeHevc, codecStrings: hevcCodecStrings }],
  // Matroska's AV1 blocks are temporal units of OBUs (no start codes, no temporal delimiter); a key block's starts
  // with the sequence header, so WebCodecs needs no description
  [CODING_AV1, { analyze: av1Unit, codecStrings: (av1c) => [av1CodecString(av1c)], fromCodecPrivate: true, unsupportedMessage: AV1_UNSUPPORTED_MESSAGE }],
]);

/** An AV1 temporal unit, taken as it is: a key unit when the container says so. */
function av1Unit(data: Uint8Array, key?: boolean): AccessUnitInfo {
  return { key: key === true, idr: key === true, sps: null, pps: [], data };
}

const HEVC_UNSUPPORTED_MESSAGE = "This device can't decode HEVC (4K) video.";
const MAX_CONSECUTIVE_ERRORS = 3;
/** Above this many fed-but-unseen timestamps, forget ones far behind the newest output (the decoder dropped them). */
const PENDING_PRUNE_SIZE = 64;
const PENDING_PRUNE_WINDOW_US = 2_000_000;

export function isSupportedVideoCoding(codingType: number): boolean {
  return CODECS.has(codingType);
}

export function hasSps(codingType: number, data: Uint8Array): boolean {
  return (CODECS.get(codingType)?.analyze(data).sps ?? null) !== null;
}

/**
 * Whether the decoder can be configured at this unit: one with an SPS, or for a codec configured from CodecPrivate
 * (AV1), a key unit (`key`, the container's flag).
 */
export function canStartStream(codingType: number, data: Uint8Array, key?: boolean): boolean {
  const ops = CODECS.get(codingType);
  if (!ops) return false;
  return ops.fromCodecPrivate ? key === true : ops.analyze(data).sps !== null;
}

function toDomException(err: unknown): DOMException {
  return err instanceof DOMException ? err : new DOMException(String(err), 'EncodingError');
}

export class WebCodecsVideoDecoder implements Decoder<VideoUnit, VideoFrame> {
  onOutput: (frame: VideoFrame) => void = (frame) => frame.close(); // nobody listening: don't leak GPU memory
  onError: (err: DecoderError) => void = () => undefined;

  private decoder: VideoDecoderLike | null = null;
  private config: VideoDecoderConfig | null = null;
  private closed = false;
  private ops: CodecOps | null = null;
  private codingType: number | null = null;
  private needKey = true;
  private requireIdr = false;
  private lastKeyWasIdr = true;
  /** PTS of a non-IDR (open-GOP) random access point whose leading pictures must still be skipped. */
  private leadingKeyPtsUs: number | null = null;
  private consecutiveErrors = 0;
  /** A frame came out since configure(): a later fatal error is a decode failure, not a missing codec. */
  private hasOutput = false;
  /**
   * Timestamps fed since the last reset, mapped to whether their frame is discarded. A frame whose timestamp
   * is missing was decoded before a reset() and delivered late; WebCodecs does not promise to drop those.
   */
  private readonly pending = new Map<number, boolean>();
  private openGopStarts = 0;
  private leadingSkipped = 0;
  /** The last PPS seen under each id since configure(). */
  private readonly ppsById = new Map<number, Uint8Array>();
  /** The switch to software decoding was tried since configure(). */
  private softwareTried = false;

  constructor(private readonly api: VideoCodecApi = browserVideoCodecApi) {}

  get queueSize(): number {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  /** Decode sequences started on a non-IDR random access point, and the leading pictures skipped after them. */
  get openGop(): { readonly starts: number; readonly leadingSkipped: number } {
    return { starts: this.openGopStarts, leadingSkipped: this.leadingSkipped };
  }

  get codec(): string | null {
    return this.config?.codec ?? null;
  }

  async configure(config: StreamConfig): Promise<void> {
    const ops = CODECS.get(config.codingType);
    if (!ops) throw new UnsupportedCodecError(config.codingType, `${codingName(config.codingType)} video is not supported.`);
    if (!config.firstUnit) throw new Error('video configure() needs the first access unit');
    let params: Uint8Array;
    if (ops.fromCodecPrivate) {
      if (!config.codecPrivate) throw new Error('the AV1 track has no av1C record (CodecPrivate)');
      params = config.codecPrivate;
    } else {
      const info = ops.analyze(config.firstUnit);
      if (!info.sps) throw new Error('first video access unit has no SPS');
      params = info.sps;
    }
    const software = ops.needsSoftware?.(params) === true;
    this.closed = false;
    let vdc: VideoDecoderConfig | null = null;
    for (const codec of ops.codecStrings(params)) {
      const candidate: VideoDecoderConfig = { codec };
      if (software) candidate.hardwareAcceleration = 'prefer-software';
      // a rejection (e.g. a codec string the browser can't parse) counts as unsupported
      const support = await this.api.isConfigSupported(candidate).catch(() => ({ supported: false }));
      if (this.closed) return; // closed while support was being checked: don't open a decoder nobody owns
      if (support.supported) {
        vdc = candidate;
        break;
      }
    }
    if (!vdc) {
      const message =
        ops.unsupportedMessage ??
        (config.codingType === CodingType.HEVC
          ? HEVC_UNSUPPORTED_MESSAGE
          : `This browser cannot decode ${codingName(config.codingType)} (${ops.codecStrings(params).join(', ')}).`);
      throw new UnsupportedCodecError(config.codingType, message);
    }
    this.codingType = config.codingType;
    this.ops = ops;
    this.config = vdc;
    this.consecutiveErrors = 0;
    this.hasOutput = false;
    this.requireIdr = false;
    this.ppsById.clear();
    this.softwareTried = false;
    this.lastKeyWasIdr = true;
    this.open();
  }

  decode(unit: VideoUnit): void {
    const decoder = this.decoder;
    const ops = this.ops;
    if (!decoder || !ops || decoder.state !== 'configured') return;
    const info = ops.analyze(unit.data, unit.key);
    this.watchPps(info.pps);
    const startsSequence = this.needKey;
    if (startsSequence) {
      if (!info.key || (this.requireIdr && !info.idr)) return;
      this.needKey = false;
      this.lastKeyWasIdr = info.idr;
      this.leadingKeyPtsUs = info.idr ? null : unit.ptsUs;
      if (!info.idr) this.openGopStarts++;
    } else if (this.leadingKeyPtsUs !== null) {
      // Open GOP: pictures that follow the I-frame in decode order but precede it in display order
      // reference frames before the random access point, which we never fed to the decoder.
      if (unit.ptsUs < this.leadingKeyPtsUs) {
        this.leadingSkipped++;
        return;
      }
      this.leadingKeyPtsUs = null;
    }
    this.pending.set(unit.ptsUs, unit.discard);
    try {
      decoder.decode(this.api.makeChunk({ type: startsSequence || info.idr ? 'key' : 'delta', timestamp: unit.ptsUs, data: info.data }));
    } catch (err) {
      this.handleError(decoder, toDomException(err));
    }
  }

  async flush(): Promise<void> {
    const decoder = this.decoder;
    if (!decoder || decoder.state !== 'configured') return;
    this.needKey = true; // WebCodecs requires a key chunk right after flush() starts
    this.leadingKeyPtsUs = null;
    try {
      await decoder.flush();
    } catch {
      return; // a reset() during flush aborts it; nothing to do
    }
  }

  reset(): void {
    this.pending.clear();
    this.needKey = true;
    this.leadingKeyPtsUs = null;
    this.requireIdr = false;
    const decoder = this.decoder;
    if (!decoder || !this.config) return;
    if (decoder.state === 'closed') {
      this.open();
      return;
    }
    try {
      decoder.reset();
      decoder.configure(this.config);
    } catch (err) {
      this.handleError(decoder, toDomException(err));
    }
  }

  close(): void {
    this.closed = true;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.pending.clear();
  }

  /** Switches to software decoding once a PPS id comes back with other content (CodecOps.ppsId). */
  private watchPps(pps: readonly Uint8Array[]): void {
    const ppsId = this.ops?.ppsId;
    if (!ppsId || this.softwareTried || this.config?.hardwareAcceleration === 'prefer-software') return;
    for (const nal of pps) {
      const id = ppsId(nal);
      if (id === null) continue;
      const seen = this.ppsById.get(id);
      this.ppsById.set(id, nal.slice());
      if (seen && !sameBytes(seen, nal)) {
        this.switchToSoftware();
        return;
      }
    }
  }

  /** Reopens the decoder with software decoding when the browser has it; decoding resumes at the next key unit. */
  private switchToSoftware(): void {
    const config = this.config;
    if (!config) return;
    this.softwareTried = true;
    const software: VideoDecoderConfig = { ...config, hardwareAcceleration: 'prefer-software' };
    void this.api
      .isConfigSupported(software)
      .catch(() => ({ supported: false }))
      .then((support) => {
        // closed, reconfigured or failed for good meanwhile: nothing to switch
        if (!support.supported || this.closed || this.config !== config || !this.decoder) return;
        this.config = software;
        this.open();
      });
  }

  private open(): void {
    const config = this.config;
    if (!config) return;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    const decoder = this.api.create({
      output: (frame) => this.handleFrame(decoder, frame),
      error: (err) => this.handleError(decoder, err),
    });
    this.decoder = decoder;
    this.needKey = true;
    this.leadingKeyPtsUs = null;
    this.pending.clear();
    try {
      decoder.configure(config);
    } catch (err) {
      this.handleError(decoder, toDomException(err));
    }
  }

  private handleFrame(source: VideoDecoderLike, frame: VideoFrame): void {
    if (source !== this.decoder) {
      frame.close();
      return;
    }
    this.consecutiveErrors = 0;
    this.hasOutput = true;
    const discard = this.pending.get(frame.timestamp);
    this.pending.delete(frame.timestamp);
    if (discard !== false) {
      frame.close(); // discarded, or stale from before a reset
      return;
    }
    this.prunePending(frame.timestamp);
    this.onOutput(frame);
  }

  private prunePending(outputUs: number): void {
    if (this.pending.size <= PENDING_PRUNE_SIZE) return;
    for (const ts of this.pending.keys()) if (ts < outputUs - PENDING_PRUNE_WINDOW_US) this.pending.delete(ts);
  }

  private handleError(source: VideoDecoderLike, err: DOMException): void {
    if (source !== this.decoder) return;
    this.consecutiveErrors++;
    if (!this.lastKeyWasIdr) this.requireIdr = true;
    if (this.consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
      this.decoder = null;
      this.onError(new DecoderError(this.codingType === CodingType.HEVC && !this.hasOutput ? HEVC_UNSUPPORTED_MESSAGE : `Video decoding failed: ${err.message}`, true));
      return;
    }
    this.open();
    this.onError(new DecoderError(`Video decoder error, recovering at the next keyframe: ${err.message}`, false));
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
