import { CodingType, codingName } from '@seikou/bdmv/stream-types';
import { DecoderError, UnsupportedCodecError, type Decoder, type StreamConfig } from './decoder';
import { analyzeAvc, avcCodecString, avcIsInterlaced, avcPicStruct, avcPpsId, avcTiming, type AccessUnitInfo, type AvcTiming } from '@seikou/bdmv/codecs/h264';
import { analyzeHevc, hevcCodecStrings } from '@seikou/bdmv/codecs/hevc';
import { flagsFromPicStruct, framePlanes, readableFrameFormat, type FieldFlags, type FieldInput } from '../deinterlace/field-input';
import { CODING_AV1, av1CodecString } from './av1';
import { wasmVideoCodecFor } from './wasm-video';

/** One video access unit for the decoder. */
export interface VideoUnit {
  /** Annex B bytes for H.264 and HEVC; an AV1 temporal unit as it lies in the Matroska block. */
  readonly data: Uint8Array;
  /** Playlist time in microseconds; it identifies the unit when its frame comes out. */
  readonly ptsUs: number;
  /** Decode for reference but never present (e.g. before a seek target or outside the play item). */
  readonly discard: boolean;
  /** The container's key-frame flag (a Matroska block's), for codecs whose units carry no random access marker the decoder reads. */
  readonly key?: boolean;
}

/** The part of WebCodecs' VideoDecoder the engine uses, so tests can inject a fake. */
export interface VideoDecoderLike {
  readonly state: CodecState;
  /** Chunks queued and not yet decoded. */
  readonly decodeQueueSize: number;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

/** The WebCodecs entry points the video decoder calls (injected, like the rest of the player's browser APIs). */
export interface VideoCodecApi {
  create(init: VideoDecoderInit): VideoDecoderLike;
  isConfigSupported(config: VideoDecoderConfig): Promise<VideoDecoderSupport>;
  makeChunk(init: EncodedVideoChunkInit): EncodedVideoChunk;
}

/** The real WebCodecs: VideoDecoder, VideoDecoder.isConfigSupported and EncodedVideoChunk. */
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
/** The most units since a key unit kept for a replay into the software decoder (5 s at 24 pictures a second). */
const MAX_REPLAY_UNITS = 120;
const MAX_CONSECUTIVE_ERRORS = 3;
/** Above this many fed-but-unseen timestamps, forget ones far behind the newest output (the decoder dropped them). */
const PENDING_PRUNE_SIZE = 64;
const PENDING_PRUNE_WINDOW_US = 2_000_000;

/**
 * Whether the engine can decode this coding type here: H.264, HEVC and AV1 through WebCodecs, and MPEG-1, MPEG-2 and
 * VC-1 when `wasm` says their decoder (video.wasm in a worker of its own) can run. Anything else plays without a picture.
 */
export function canDecodeVideo(codingType: number, wasm: boolean): boolean {
  return CODECS.has(codingType) || (wasm && wasmVideoCodecFor(codingType) !== null);
}

/**
 * What the player drives a video decoder through on the canvas path: WebCodecsVideoDecoder (H.264, HEVC, AV1) or
 * WasmVideoDecoder (MPEG-1, MPEG-2, VC-1). An interlaced stream's pictures go to `onFieldInput` as planes when it is set.
 */
export interface CanvasVideoDecoder extends Decoder<VideoUnit, VideoFrame> {
  /** Receives an interlaced stream's pictures as YUV planes instead of `onOutput`, when set. */
  onFieldInput: ((input: FieldInput) => void) | null;
  /** Called when a picture meant for `onFieldInput` has no planes to read (`format`); it goes to `onOutput`. */
  onFieldsUnreadable: ((format: string) => void) | null;
  /** Pictures out of the decoder still on their way to `onFieldInput`. */
  readonly fieldInputsPending: number;
  /**
   * Decode sequences started on a non-IDR random access point and the leading pictures skipped after them; absent for a
   * decoder that skips them itself without counting (FFmpeg's, in WasmVideoDecoder).
   */
  readonly openGop?: { readonly starts: number; readonly leadingSkipped: number };
}

/** Whether the unit holds a sequence parameter set of this codec, which a decoder can be configured from; false for a codec the engine does not decode. */
export function hasSps(codingType: number, data: Uint8Array): boolean {
  return (CODECS.get(codingType)?.analyze(data).sps ?? null) !== null;
}

/**
 * Whether the decoder can be configured at this unit: one with an SPS, or for a codec configured from CodecPrivate
 * (AV1), a key unit (`key`, the container's flag); any unit for MPEG-1, MPEG-2 and VC-1 (WasmVideoDecoder).
 */
export function canStartStream(codingType: number, data: Uint8Array, key?: boolean): boolean {
  // video.wasm's parser finds the sequence header itself, and FFmpeg outputs nothing before it and the I picture after
  if (wasmVideoCodecFor(codingType) !== null) return true;
  const ops = CODECS.get(codingType);
  if (!ops) return false;
  return ops.fromCodecPrivate ? key === true : ops.analyze(data).sps !== null;
}

function toDomException(err: unknown): DOMException {
  return err instanceof DOMException ? err : new DOMException(String(err), 'EncodingError');
}

/**
 * Decodes H.264, HEVC and AV1 with WebCodecs. It configures itself from the first unit (the SPS, or AV1's CodecPrivate),
 * starts only at a key unit, skips the leading pictures of an open GOP, and drops frames of units marked `discard`.
 * A decoder error reopens the decoder and resumes at the next key unit; after more than three in a row the error is
 * fatal. Runs in the engine worker.
 */
export class WebCodecsVideoDecoder implements CanvasVideoDecoder {
  onOutput: (frame: VideoFrame) => void = (frame) => frame.close(); // nobody listening: don't leak GPU memory
  /**
   * When set, an H.264 stream's frames go here as YUV planes with the field flags of their unit (pic_struct), in
   * output order, instead of to `onOutput`. Set it for an interlaced stream before configure(); progressive streams
   * and other codecs keep `onOutput`.
   */
  onFieldInput: ((input: FieldInput) => void) | null = null;
  /**
   * Called when a frame meant for `onFieldInput` comes in a format that has no YUV planes to read (`format`, e.g. BGRX
   * from Firefox on macOS). That frame goes to `onOutput`, as every later one does once `onFieldInput` is cleared.
   */
  onFieldsUnreadable: ((format: string) => void) | null = null;
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
  /**
   * The units fed since the last key unit while a switch to software decoding may still come (CodecOps.ppsId, hardware
   * decoding): the software decoder replays them from that key unit, so the switch loses no pictures.
   */
  private gop: VideoUnit[] = [];
  /** A replay into the software decoder is being fed: its units aren't kept again. */
  private replaying = false;
  /** The switch to software decoding was made or given up since configure(): nothing more is kept for it. */
  private switchSettled = false;
  /** The picture timing facts of the stream's latest SPS, for reading pic_struct. */
  private timing: AvcTiming | null = null;
  /** The field flags of the units fed, by timestamp, until their frames come out. */
  private readonly fieldFlags = new Map<number, FieldFlags>();
  /** Delivers field inputs one after another, so their order is the output order. */
  private fieldChain: Promise<void> = Promise.resolve();
  /** Bumped by reset(), close() and open(): a field input queued before one of them is dropped, never delivered. */
  private generation = 0;
  private fieldsPending = 0;

  constructor(private readonly api: VideoCodecApi = browserVideoCodecApi) {}

  /** Chunks waiting in the underlying decoder; 0 before configure(). */
  get queueSize(): number {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  /** Frames out of the decoder whose planes are still being copied for `onFieldInput` (not yet delivered or dropped). */
  get fieldInputsPending(): number {
    return this.fieldsPending;
  }

  /** Decode sequences started on a non-IDR random access point, and the leading pictures skipped after them. */
  get openGop(): { readonly starts: number; readonly leadingSkipped: number } {
    return { starts: this.openGopStarts, leadingSkipped: this.leadingSkipped };
  }

  /** The WebCodecs codec string in use, or null before configure(). */
  get codec(): string | null {
    return this.config?.codec ?? null;
  }

  /**
   * Whether the browser could decode the stream whose first unit this is: the check configure() makes, with no decoder
   * opened. False for a codec the engine doesn't decode or a unit with no parameter set.
   */
  async canConfigure(config: StreamConfig): Promise<boolean> {
    const ops = CODECS.get(config.codingType);
    if (!ops || !config.firstUnit) return false;
    try {
      let params: Uint8Array;
      if (ops.fromCodecPrivate) {
        if (!config.codecPrivate) return false;
        params = config.codecPrivate;
      } else {
        const info = ops.analyze(config.firstUnit);
        if (!info.sps) return false;
        params = info.sps;
      }
      return (await this.supportedConfig(ops, params)) !== null;
    } catch {
      return false;
    }
  }

  /** The first candidate decoder configuration for the stream's parameter set that the browser supports (software decoding for an interlaced stream), or null. */
  private async supportedConfig(ops: CodecOps, params: Uint8Array): Promise<VideoDecoderConfig | null> {
    const software = ops.needsSoftware?.(params) === true;
    for (const codec of ops.codecStrings(params)) {
      const candidate: VideoDecoderConfig = { codec };
      if (software) candidate.hardwareAcceleration = 'prefer-software';
      // a rejection (e.g. a codec string the browser can't parse) counts as unsupported
      const support = await this.api.isConfigSupported(candidate).catch(() => ({ supported: false }));
      if (this.closed) return null;
      if (support.supported) return candidate;
    }
    return null;
  }

  /** Picks the first codec string the browser supports (software decoding for an interlaced stream) and opens the decoder. Rejects with UnsupportedCodecError when none is supported. */
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
    this.closed = false;
    const vdc = await this.supportedConfig(ops, params);
    if (this.closed) return; // closed while support was being checked: don't open a decoder nobody owns
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
    this.switchSettled = false;
    this.lastKeyWasIdr = true;
    this.timing = config.codingType === CodingType.AVC ? avcTiming(params) : null;
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
    this.keepForSwitch(unit, startsSequence || info.key);
    this.pending.set(unit.ptsUs, unit.discard);
    if (this.onFieldInput && this.codingType === CodingType.AVC) {
      if (info.sps) this.timing = avcTiming(info.sps);
      this.fieldFlags.set(unit.ptsUs, flagsFromPicStruct(this.timing ? avcPicStruct(unit.data, this.timing) : null));
    }
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
    await this.fieldChain; // field inputs of the flushed frames are delivered before flush() resolves
  }

  reset(): void {
    this.generation++;
    this.gop = [];
    this.pending.clear();
    this.fieldFlags.clear();
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
    this.generation++;
    this.closed = true;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.pending.clear();
    this.fieldFlags.clear();
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

  /** Keeps `unit` for a replay after a switch to software decoding (see `gop`), while one may still come. */
  private keepForSwitch(unit: VideoUnit, key: boolean): void {
    // kept until the switch settles: the units fed while the browser is asked about software decoding are replayed too
    if (this.replaying || this.switchSettled || !this.ops?.ppsId || this.config?.hardwareAcceleration === 'prefer-software') return;
    if (key) this.gop = [unit];
    else if (this.gop.length > 0 && this.gop.length < MAX_REPLAY_UNITS) this.gop.push(unit);
    else this.gop = []; // no key unit kept, or a GOP too long to replay: the switch resumes at the next key unit
  }

  /**
   * Reopens the decoder with software decoding when the browser has it, and replays the units since the last key unit
   * into it: the pictures the hardware decoder already handed out are decoded for reference only, the rest as they were
   * fed, so the switch loses no pictures. With nothing to replay, decoding resumes at the next key unit.
   */
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
        this.switchSettled = true;
        if (!support.supported || this.closed || this.config !== config || !this.decoder) {
          this.gop = [];
          return;
        }
        // a unit still pending was never handed out: it keeps its own discard flag; one handed out is reference only
        const replay = this.gop.map((u) => ({ ...u, discard: this.pending.get(u.ptsUs) ?? true }));
        this.config = software;
        this.open();
        this.replaying = true;
        try {
          for (const unit of replay) this.decode(unit);
        } finally {
          this.replaying = false;
        }
      });
  }

  private open(): void {
    const config = this.config;
    if (!config) return;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.generation++;
    const decoder = this.api.create({
      output: (frame) => this.handleFrame(decoder, frame),
      error: (err) => this.handleError(decoder, err),
    });
    this.decoder = decoder;
    this.needKey = true;
    this.leadingKeyPtsUs = null;
    this.gop = [];
    this.pending.clear();
    this.fieldFlags.clear();
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
    const flags = this.fieldFlags.get(frame.timestamp);
    this.pending.delete(frame.timestamp);
    this.fieldFlags.delete(frame.timestamp);
    if (discard !== false) {
      frame.close(); // discarded, or stale from before a reset
      return;
    }
    this.prunePending(frame.timestamp);
    const sink = this.onFieldInput;
    if (sink && flags && !readableFrameFormat(frame.format)) {
      this.onFieldsUnreadable?.(String(frame.format));
    } else if (sink && flags) {
      this.deliverFields(source, frame, flags, sink);
      return;
    }
    this.onOutput(frame);
  }

  /** Copies the frame's planes and passes them on in output order; the frame is closed either way. */
  private deliverFields(source: VideoDecoderLike, frame: VideoFrame, flags: FieldFlags, sink: (input: FieldInput) => void): void {
    const matrix = this.timing?.matrixCoefficients ?? null;
    const timestampUs = frame.timestamp;
    const durationUs = frame.duration ?? 0;
    const generation = this.generation;
    this.fieldsPending++;
    this.fieldChain = this.fieldChain.then(async () => {
      try {
        const planes = await framePlanes(frame, matrix);
        const displayWidth = frame.displayWidth || planes.width;
        const displayHeight = frame.displayHeight || planes.height;
        if (source === this.decoder && generation === this.generation) sink({ planes, timestampUs, durationUs, flags, displayWidth, displayHeight });
      } catch (err) {
        if (source === this.decoder && generation === this.generation) this.handleError(source, toDomException(err));
      } finally {
        this.fieldsPending--;
        frame.close();
      }
    });
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
