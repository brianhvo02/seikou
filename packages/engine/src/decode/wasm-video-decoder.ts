// SPDX-License-Identifier: LGPL-3.0-or-later
// MPEG-1, MPEG-2 and VC-1 video through FFmpeg's decoders in video.wasm, run in a decoder worker of their own
// (video-worker.ts), behind the same Decoder surface as WebCodecsVideoDecoder.
import { codingName } from '@seikou/bdmv/stream-types';
import type { WorkerLike } from '../bdj-types';
import { matrixByHeight, type FieldInput, type PlaneMatrix } from '../deinterlace/field-input';
import { DecoderError, UnsupportedCodecError, type Decoder, type StreamConfig } from './decoder';
import type { VideoUnit } from './video-decoder';
import type { FromVideoWorker, ToVideoWorker } from './video-worker-protocol';
import { wasmVideoCodecFor, type DecodedPicture } from './wasm-video';

/** What a WasmVideoDecoder starts its worker and makes its frames with. */
export interface WasmVideoDecoderDeps {
  /** Starts a video decoder worker (video-worker.ts); one per configure. */
  createWorker(): WorkerLike<ToVideoWorker, FromVideoWorker>;
  /** Where the worker fetches video.wasm from. */
  readonly wasmUrl: string;
  /** The limit on that fetch in milliseconds; none when absent. */
  readonly fetchTimeoutMs?: number;
  /** Makes a progressive picture's VideoFrame (frameFromPicture; tests pass a fake). */
  makeFrame(p: DecodedPicture): VideoFrame;
}

/** How many decode times decodeMs averages. */
const DECODE_TIMES = 30;

interface PendingUnit {
  readonly discard: boolean;
  /** Skipping was on when the unit was sent: a picture of it that never comes out was skipped. */
  readonly skipping: boolean;
}

/**
 * Decodes MPEG-1, MPEG-2 and VC-1 video in a worker running FFmpeg's decoders (video.wasm). Units go to the worker as
 * they come (one PES payload each, which the worker's parser splits into pictures); pictures come back in
 * presentation order, each timed by the unit it started in. An interlaced stream's pictures go to `onFieldInput` as
 * I420 planes; a progressive one's become VideoFrames through `makeFrame`. Pictures of `discard` units and pictures
 * the worker sent before a reset() are dropped. A worker that fails is a fatal error; it is not restarted.
 */
export class WasmVideoDecoder implements Decoder<VideoUnit, VideoFrame> {
  onOutput: (frame: VideoFrame) => void = (frame) => frame.close();
  /** When set and the stream is interlaced (StreamConfig.interlaced), every picture goes here as planes instead of to `onOutput`. */
  onFieldInput: ((input: FieldInput) => void) | null = null;
  /** Never called: the worker's pictures are always I420. Present so the player wires both decoders alike. */
  onFieldsUnreadable: ((format: string) => void) | null = null;
  onError: (err: DecoderError) => void = () => undefined;

  private worker: WorkerLike<ToVideoWorker, FromVideoWorker> | null = null;
  private codingType = 0;
  private interlaced = false;
  private failed = false;
  /** The open in progress: settled by `opened` or a failure. */
  private opening: { resolve(): void; reject(err: Error): void } | null = null;
  private nextId = 0;
  /** The highest id the worker has answered (decoded or flushed). */
  private answeredId = 0;
  /** Pictures are from before the latest reset() until the worker answers this id, the last sent before it. */
  private staleUntilId = 0;
  /** Decode ids sent and not yet answered. */
  private readonly inFlight = new Set<number>();
  /** The units sent since the last reset, by rounded time, until a picture at or after their time comes out. */
  private readonly pending = new Map<number, PendingUnit>();
  private readonly flushes = new Map<number, () => void>();
  private readonly times: number[] = [];
  private skipping = false;
  private skippedCount = 0;

  constructor(private readonly deps: WasmVideoDecoderDeps) {}

  /** Units sent to the worker and not yet decoded. */
  get queueSize(): number {
    return this.inFlight.size;
  }

  /** Always 0: pictures reach `onFieldInput` as they arrive, with no copy pending. */
  get fieldInputsPending(): number {
    return 0;
  }

  /** Pictures not decoded because skipping was on (B pictures). */
  get skipped(): number {
    return this.skippedCount;
  }

  /** The mean time the worker took to decode a unit over the last 30, in milliseconds; null before any. */
  get decodeMs(): number | null {
    if (this.times.length === 0) return null;
    return this.times.reduce((a, b) => a + b, 0) / this.times.length;
  }

  /** Starts the worker and opens its decoder for the stream's codec; rejects with UnsupportedCodecError when it can't. */
  configure(config: StreamConfig): Promise<void> {
    const codec = wasmVideoCodecFor(config.codingType);
    if (codec === null) return Promise.reject(new UnsupportedCodecError(config.codingType, `${codingName(config.codingType)} video is not supported.`));
    this.teardown();
    this.codingType = config.codingType;
    this.interlaced = config.interlaced === true;
    this.failed = false;
    this.skippedCount = 0;
    this.times.length = 0;
    this.pending.clear();
    const worker = this.deps.createWorker();
    this.worker = worker;
    worker.onmessage = (event) => this.handleMessage(worker, event.data);
    worker.onerror = (event) => {
      if (worker === this.worker) this.fail(event.message || 'the video decoder worker failed');
    };
    const opened = new Promise<void>((resolve, reject) => {
      this.opening = { resolve, reject };
    });
    worker.postMessage({ type: 'open', wasmUrl: this.deps.wasmUrl, codec, timeoutMs: this.deps.fetchTimeoutMs ?? null });
    return opened;
  }

  decode(unit: VideoUnit): void {
    const worker = this.worker;
    if (!worker || this.opening) return;
    const id = ++this.nextId;
    this.inFlight.add(id);
    if (Number.isFinite(unit.ptsUs)) this.pending.set(Math.round(unit.ptsUs), { discard: unit.discard, skipping: this.skipping });
    worker.postMessage({ type: 'decode', id, data: unit.data, ptsUs: unit.ptsUs, discard: unit.discard });
  }

  /** Resolves once every picture of the units sent has come out (at once when the worker is gone). */
  flush(): Promise<void> {
    const worker = this.worker;
    if (!worker || this.opening) return Promise.resolve();
    const id = ++this.nextId;
    const done = new Promise<void>((resolve) => this.flushes.set(id, resolve));
    worker.postMessage({ type: 'flush', id });
    return done;
  }

  reset(): void {
    const worker = this.worker;
    if (!worker) return;
    this.staleUntilId = this.nextId;
    this.pending.clear();
    worker.postMessage({ type: 'reset' });
  }

  /** On: the worker stops decoding B pictures (a device too slow for them all); counted in `skipped`. */
  setSkipping(on: boolean): void {
    this.skipping = on;
    this.worker?.postMessage({ type: 'skip', on });
  }

  close(): void {
    this.worker?.postMessage({ type: 'close' });
    this.teardown();
  }

  private handleMessage(worker: WorkerLike<ToVideoWorker, FromVideoWorker>, message: FromVideoWorker): void {
    if (worker !== this.worker) return;
    switch (message.type) {
      case 'opened': {
        const opening = this.opening;
        this.opening = null;
        opening?.resolve();
        return;
      }
      case 'picture':
        if (this.answeredId < this.staleUntilId) return; // sent before the latest reset() reached the worker
        this.deliver(message.picture);
        return;
      case 'decoded':
        this.answered(message.id);
        this.inFlight.delete(message.id);
        this.times.push(message.ms);
        if (this.times.length > DECODE_TIMES) this.times.shift();
        return;
      case 'flushed': {
        this.answered(message.id);
        for (const unit of this.pending.values()) if (unit.skipping && !unit.discard) this.skippedCount++;
        this.pending.clear();
        const resolve = this.flushes.get(message.id);
        this.flushes.delete(message.id);
        resolve?.();
        return;
      }
      case 'error':
        if (message.fatal) this.fail(message.message);
        else this.onError(new DecoderError(`Video decoder error: ${message.message}`, false));
        return;
    }
  }

  private answered(id: number): void {
    if (id > this.answeredId) this.answeredId = id;
  }

  /** Passes a picture on, unless it is a discard unit's; units before it that never came out while skipping were skipped. */
  private deliver(picture: DecodedPicture): void {
    const unit = this.pending.get(picture.ptsUs);
    this.pending.delete(picture.ptsUs);
    // pictures come out in presentation order: a unit timed before this picture won't come out now
    for (const [t, u] of this.pending) {
      if (t >= picture.ptsUs) continue;
      if (u.skipping && !u.discard) this.skippedCount++;
      this.pending.delete(t);
    }
    if (unit?.discard) return;
    const sink = this.onFieldInput;
    if (sink && this.interlaced) sink(fieldInputOf(picture));
    else this.onOutput(this.deps.makeFrame(picture));
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    const opening = this.opening;
    this.opening = null;
    this.teardown();
    if (opening) {
      opening.reject(new UnsupportedCodecError(this.codingType, `The ${codingName(this.codingType)} video decoder could not start: ${message}`));
      return;
    }
    this.onError(new DecoderError(`Video decoding failed: ${message}`, true));
  }

  /** Stops the worker; an open in progress resolves (nobody is waiting on its outcome) and flushes resolve. */
  private teardown(): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
    const opening = this.opening;
    this.opening = null;
    opening?.resolve();
    for (const resolve of this.flushes.values()) resolve();
    this.flushes.clear();
    this.inFlight.clear();
    this.pending.clear();
    this.nextId = 0;
    this.answeredId = 0;
    this.staleUntilId = 0;
  }
}

/** A picture's planes as the deinterlacer takes them: tightly packed I420, the chroma planes half size rounded up. */
function fieldInputOf(picture: DecodedPicture): FieldInput {
  const { width, height } = picture;
  const chromaWidth = Math.ceil(width / 2);
  const chromaSize = chromaWidth * Math.ceil(height / 2);
  return {
    planes: {
      format: 'I420',
      width,
      height,
      data: picture.data,
      layout: [
        { offset: 0, stride: width },
        { offset: width * height, stride: chromaWidth },
        { offset: width * height + chromaSize, stride: chromaWidth },
      ],
      matrix: matrixOf(picture),
    },
    timestampUs: picture.ptsUs,
    durationUs: picture.durationUs,
    flags: picture.flags,
    displayWidth: picture.displayWidth,
    displayHeight: picture.displayHeight,
  };
}

function matrixOf(picture: DecodedPicture): PlaneMatrix {
  return picture.matrix ?? matrixByHeight(picture.height);
}

/**
 * A progressive picture as a VideoFrame over its I420 planes, at its time and display size, with the stream's colour
 * matrix, else the one for its height (standard definition at 576 lines or fewer).
 */
export function frameFromPicture(p: DecodedPicture): VideoFrame {
  const matrix = matrixOf(p);
  return new VideoFrame(p.data, {
    format: 'I420',
    codedWidth: p.width,
    codedHeight: p.height,
    displayWidth: p.displayWidth,
    displayHeight: p.displayHeight,
    timestamp: p.ptsUs,
    ...(p.durationUs > 0 ? { duration: p.durationUs } : {}),
    colorSpace: { matrix, primaries: matrix, transfer: matrix === 'bt709' ? 'bt709' : 'smpte170m', fullRange: false },
  });
}
