// SPDX-License-Identifier: LGPL-3.0-or-later
// The deinterlacer: decoded interlaced frames go into a ring of plane slots on the GPU, each is measured against its
// neighbours, the cadence detector turns the measurements into pictures, and a picture is drawn when the presenter
// shows it. Slots are reference-counted, so a slot is reused only once nothing still needs its frame.

import { CadenceDetector, LOOKAHEAD, type CadenceMode, type FrameMetrics, type PictureOp, type PlannedPicture } from './cadence';
import type { FieldFlags, FieldInput, YuvPlanes } from './field-input';

/** The GPU side of the deinterlacer (WebGL2 in `gl-backend.ts`, a fake in tests). Slots are numbered from 0. */
export interface DeinterlaceBackend {
  /** Copies the planes into the slot before returning (the caller reuses `planes.data` at once). */
  upload(slot: number, planes: YuvPlanes): void;
  /**
   * Measures the frame in slot `cur` against its neighbours as `FrameMetrics` defines it, the match pairings by
   * parity against `fieldOrder`. A missing neighbour (null) measures as `FrameMetrics` says. Resolves once the GPU's
   * answer is back, never stalling it; the commands are issued before it returns, so the slots may be refilled after.
   */
  measure(prev: number | null, cur: number, next: number | null, fieldOrder: 'tff' | 'bff'): Promise<FrameMetrics>;
  /**
   * Draws the picture `op` makes of the frame in slot `slots.cur`, with its neighbours (null where the stream has
   * none), as RGB with `matrix`, into the backend's canvas (the same canvas every call, valid until the next).
   * `fieldOrder` is the parity the match pairings are taken by, and for an interpolated field the frame's own order.
   * With `cheap`, an interpolated field is drawn by plain field interpolation (line averaging of the one field shown)
   * in bwdif's place; matches and weaves are drawn as they are.
   */
  render(
    op: PictureOp,
    slots: { readonly prev: number | null; readonly cur: number; readonly next: number | null },
    fieldOrder: 'tff' | 'bff',
    matrix: YuvPlanes['matrix'],
    cheap: boolean,
  ): OffscreenCanvas;
  /** GPU time in ms of the latest picture whose timer query has finished, or null without timer queries. */
  readonly gpuMs: number | null;
  /** Frees the GPU resources; the backend is unusable after. */
  dispose(): void;
}

/** One output picture, as the presenter queues it (a `PresentableFrame`). */
export interface Picture {
  /** Presentation time in microseconds, on the playlist clock. */
  readonly timestamp: number;
  /** How long it shows before the next picture, in microseconds (nominal: half a frame for a field, one film frame in film). */
  readonly duration: number;
  /** Releases the picture's hold on its frames' slots; later calls do nothing. */
  close(): void;
}

/** What the deinterlacer is doing, for telemetry. */
export interface DeinterlaceStats {
  readonly mode: CadenceMode;
  readonly fieldOrder: 'tff' | 'bff';
  readonly fieldOrderSource: 'stream' | 'detected' | 'assumed';
  /** Times film was taken up. */
  readonly locks: number;
  /** Times a film lock was lost. */
  readonly breaks: number;
  readonly ringSize: number;
  /** GPU time in ms per picture, or null where the browser has no timer query. */
  readonly gpuMs: number | null;
  /** Pictures are drawn by the cheapest correct path because the device can't keep up. */
  readonly fallback: boolean;
}

/** What a `Deinterlacer` is built with. */
export interface DeinterlacerDeps {
  readonly backend: DeinterlaceBackend;
  /** Slots in the ring (12 at desktop, 10 under the constrained memory profile). */
  readonly ringSize: number;
  /** The stream's frame duration in microseconds. */
  readonly frameDurationUs: number;
  /** Receives the pictures as the detector decides them, in timestamp order. */
  onPictures(pictures: readonly Picture[]): void;
}

const FILM_FRAME_US = 1_001_000 / 24;

/** Pictures the frame-pacing check looks at: the latest this many that were presented or dropped. */
export const PACING_WINDOW = 120;
/** The share of late pictures in a full window at which the deinterlacer falls back to plain field interpolation. */
export const PACING_LATE_SHARE = 0.1;

/** A flush waiting to end its stream, with the promise `flush` returned for it. */
interface FlushMarker {
  readonly kind: 'flush';
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

/** What waits while a flush drains: a frame already uploaded for the next stream, or the flush that ends it. */
type Deferred = { readonly kind: 'frame'; readonly slot: number; readonly input: FieldInput } | FlushMarker;

function flushMarker(): FlushMarker {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { kind: 'flush', promise, resolve, reject };
}

/** One frame in the ring: its slot holds the frame's planes while the frame holds its own reference. */
interface RingFrame {
  readonly seq: number;
  readonly slot: number;
  readonly timestampUs: number;
  readonly flags: FieldFlags;
  readonly matrix: YuvPlanes['matrix'];
  /** The order the match pairings were measured by. */
  order: 'tff' | 'bff';
  /** Set once the frame has been measured (when its next frame arrived, or at flush). */
  measure: Promise<FrameMetrics> | null;
  metrics: FrameMetrics | null;
  /** The frame still holds its slot (it may still be planned, or be a neighbour of a frame still to plan). */
  held: boolean;
}

class RingPicture implements Picture {
  private open = true;

  constructor(
    readonly timestamp: number,
    readonly duration: number,
    readonly op: PictureOp,
    readonly slots: { readonly prev: number | null; readonly cur: number; readonly next: number | null },
    readonly fieldOrder: 'tff' | 'bff',
    readonly matrix: YuvPlanes['matrix'],
    readonly generation: number,
    private readonly release: (p: RingPicture) => void,
  ) {}

  get live(): boolean {
    return this.open;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.release(this);
  }

  /** Drops the picture's references without the release callback (the ring was reset under it). */
  orphan(): void {
    this.open = false;
  }
}

/**
 * Turns decoded interlaced frames into pictures: each frame is uploaded to a free slot of the ring, measured once its
 * next frame is in, planned by the cadence detector, and handed out as pictures (`onPictures`) that hold the slots
 * they are drawn from until they are closed. Decode-ahead is gated on `freeSlots()`: `push` with no free slot throws.
 */
export class Deinterlacer {
  private readonly backend: DeinterlaceBackend;
  private readonly ringSize: number;
  private readonly frameDurationUs: number;
  private readonly onPictures: (pictures: readonly Picture[]) => void;
  private readonly detector: CadenceDetector;
  private readonly refs: Uint16Array;
  /** Frames since the stream (re)started, by sequence number, that still hold their slot or wait to be planned. */
  private readonly frames = new Map<number, RingFrame>();
  /** Frames waiting for their measurements to be fed to the detector, in order. */
  private queue: RingFrame[] = [];
  private readonly pictures = new Set<RingPicture>();
  private nextSeq = 0;
  /** The sequence number the detector counts from (its index 0) in this generation. */
  private startSeq = 0;
  /** Frames the detector has been given this generation. */
  private fed = 0;
  /** Bumped by `reset`: pictures of an earlier generation no longer hold slots. */
  private generation = 0;
  /** Bumped by `reset` and by a new stream after a flush: measurements of an earlier one are ignored. */
  private stream = 0;
  /**
   * A flush is draining the old stream: frames pushed meanwhile wait in `deferred` for the new one, and a flush asked
   * after them waits there too, as the end of that stream (and so on for later streams).
   */
  private flushing = false;
  private deferred: Deferred[] = [];
  private flushDone: (() => void) | null = null;
  private flushReject: ((err: Error) => void) | null = null;
  private flushPromise: Promise<void> | null = null;
  private lastImage: OffscreenCanvas | null = null;
  private failure: Error | null = null;
  /** The latest pictures' lateness (1 late), a ring of `PACING_WINDOW` entries once full. */
  private readonly pacing = new Uint8Array(PACING_WINDOW);
  private pacingCount = 0;
  private pacingLate = 0;
  /** Set for good once pacing fell short: interpolated fields are drawn cheaply. */
  private fallback = false;

  constructor(deps: DeinterlacerDeps) {
    if (!Number.isInteger(deps.ringSize) || deps.ringSize < 1) throw new Error('deinterlacer: the ring needs at least one slot');
    this.backend = deps.backend;
    this.ringSize = deps.ringSize;
    this.frameDurationUs = deps.frameDurationUs;
    this.onPictures = deps.onPictures;
    this.detector = new CadenceDetector({ frameDurationUs: deps.frameDurationUs, lookahead: LOOKAHEAD });
    this.refs = new Uint16Array(deps.ringSize);
  }

  /** What the deinterlacer is doing, for telemetry. */
  get stats(): DeinterlaceStats {
    const d = this.detector;
    return {
      mode: d.mode,
      fieldOrder: d.fieldOrder,
      fieldOrderSource: d.fieldOrderSource,
      locks: d.locks,
      breaks: d.breaks,
      ringSize: this.ringSize,
      gpuMs: this.backend.gpuMs,
      fallback: this.fallback,
    };
  }

  /**
   * Reports one picture's pacing, from where pictures are presented: `late` is true for a picture presented more than
   * half its duration past its time, or dropped without being shown. Once a full window of `PACING_WINDOW` pictures
   * holds at least `PACING_LATE_SHARE` late ones, `stats.fallback` turns true and interpolated fields are drawn by
   * plain field interpolation for the rest of the session (field matching and film decimation go on). A seek or new
   * play item (`reset`) empties the window, but the fall-back stays.
   */
  notePacing(late: boolean): void {
    if (this.fallback) return;
    const i = this.pacingCount % PACING_WINDOW;
    if (this.pacingCount >= PACING_WINDOW) this.pacingLate -= this.pacing[i]!;
    this.pacing[i] = late ? 1 : 0;
    this.pacingLate += this.pacing[i]!;
    this.pacingCount++;
    if (this.pacingCount >= PACING_WINDOW && this.pacingLate >= PACING_LATE_SHARE * PACING_WINDOW) this.fallback = true;
  }

  /** Why the deinterlacer stopped (a measurement failed, as on a lost WebGL context), or null while it works. */
  get error(): Error | null {
    return this.failure;
  }

  /** Slots no frame, neighbour or open picture refers to. */
  freeSlots(): number {
    let free = 0;
    for (const r of this.refs) if (r === 0) free++;
    return free;
  }

  /**
   * Adds one decoded frame: uploads its planes (before returning, so the caller may reuse the buffer), measures the
   * frame before it now that its next frame is in, and hands out the pictures the detector decides, through
   * `onPictures`, as measurements come back. Throws when no slot is free. A push after `flush` starts a new stream;
   * while the flush is still draining, the frame is uploaded at once and joins the new stream once the old one has
   * drained, so no frame is lost. An upload that fails (a lost WebGL context) sets `error` instead of throwing, and
   * once `error` is set pushes do nothing.
   */
  push(input: FieldInput): void {
    if (this.failure) return;
    const slot = this.refs.indexOf(0);
    if (slot < 0) throw new Error('deinterlacer: no free ring slot (decode-ahead must wait for freeSlots())');
    try {
      this.backend.upload(slot, input.planes);
    } catch (err) {
      this.fail(err);
      return;
    }
    this.refs[slot] = 1;
    if (this.flushing) {
      this.deferred.push({ kind: 'frame', slot, input });
      return;
    }
    this.admit(slot, input);
  }

  /** Puts an uploaded frame into the current stream and measures the frame before it. */
  private admit(slot: number, input: FieldInput): void {
    const frame: RingFrame = {
      seq: this.nextSeq++,
      slot,
      timestampUs: input.timestampUs,
      flags: input.flags,
      matrix: input.planes.matrix,
      order: 'tff',
      measure: null,
      metrics: null,
      held: true,
    };
    const before = this.frames.get(frame.seq - 1);
    this.frames.set(frame.seq, frame);
    this.queue.push(frame);
    if (before && !before.measure) this.measure(before, frame);
  }

  /**
   * End of stream: measures the last frame with no next frame, and once every measurement is back, plans the frames
   * still waiting for lookahead and releases the ring's own hold on every slot (open pictures keep theirs). Resolves
   * once that is done (every picture of the stream handed out), or when `reset` abandons it; rejects with `error`
   * when a measurement fails. Frames pushed before it resolves start the next stream.
   */
  flush(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.flushing) {
      // While a flush drains, a flush after newly pushed frames ends their stream once it starts; with none pushed
      // since the latest flush, it is that flush.
      const tail = this.deferred.at(-1);
      if (!tail) return this.flushPromise!;
      if (tail.kind === 'flush') return tail.promise;
      const marker = flushMarker();
      this.deferred.push(marker);
      return marker.promise;
    }
    const marker = flushMarker();
    this.startFlush(marker);
    return marker.promise;
  }

  /** Ends the current stream with `marker`'s flush. */
  private startFlush(marker: FlushMarker): void {
    this.flushing = true;
    this.flushDone = marker.resolve;
    this.flushReject = marker.reject;
    this.flushPromise = marker.promise;
    const last = this.frames.get(this.nextSeq - 1);
    if (last && !last.measure) this.measure(last, null);
    this.drain();
  }

  /**
   * A seek or a new play item: forgets every frame and the cadence, ignores measurements still in flight, and frees
   * every slot. Pictures handed out before stay valid objects, but their `close` does nothing and `render` returns
   * the canvas as it was. The lock and break counts stay.
   */
  reset(): void {
    this.generation++;
    this.pacingCount = 0;
    this.pacingLate = 0;
    for (const p of this.pictures) p.orphan();
    this.pictures.clear();
    const abandoned = this.deferred;
    this.deferred = [];
    this.restart();
    this.refs.fill(0);
    this.endFlush();
    for (const d of abandoned) if (d.kind === 'flush') d.resolve();
  }

  /**
   * Draws the picture into the backend's canvas (the same canvas every call, valid until the next render). With `still`
   * (paused, or a held still) a picture that interpolates one field is drawn as its whole frame woven instead, so a
   * picture that stays on screen is a full one, never a single field.
   */
  render(picture: Picture, still = false): OffscreenCanvas {
    if (!(picture instanceof RingPicture)) throw new Error('deinterlacer: not a picture of this deinterlacer');
    if (!picture.live || picture.generation !== this.generation) {
      // A closed picture, or one from before a reset: its slots may hold other frames now, so the canvas stays as is.
      if (this.lastImage) return this.lastImage;
      throw new Error('deinterlacer: the picture is closed or from before a reset');
    }
    try {
      const op: PictureOp = still && picture.op.kind === 'interpolate' ? { kind: 'weave' } : picture.op;
      this.lastImage = this.backend.render(op, picture.slots, picture.fieldOrder, picture.matrix, this.fallback);
    } catch (err) {
      this.fail(err);
      throw err;
    }
    return this.lastImage;
  }

  /** Frees the GPU resources. */
  dispose(): void {
    this.reset();
    this.backend.dispose();
  }

  /** Records why the deinterlacer stopped (the first failure wins) and settles a flush waiting on it. */
  private fail(err: unknown): void {
    if (!this.failure) this.failure = err instanceof Error ? err : new Error(String(err));
    const reject = this.flushReject;
    this.flushDone = null;
    this.flushReject = null;
    this.flushPromise = null;
    this.flushing = false;
    reject?.(this.failure);
    // Flushes of streams that will now never start fail with it; their frames' slots stay as they are.
    for (const d of this.deferred) if (d.kind === 'flush') d.reject(this.failure);
    this.deferred = this.deferred.filter((d) => d.kind === 'frame');
  }

  /** Settles the flush: it has drained (or was abandoned by a reset). */
  private endFlush(): void {
    const done = this.flushDone;
    this.flushDone = null;
    this.flushReject = null;
    this.flushPromise = null;
    this.flushing = false;
    done?.();
  }

  /**
   * Starts a new stream: the detector forgets the old one, measurements in flight are ignored, and the ring lets go
   * of its frames (open pictures keep their slots).
   */
  private restart(): void {
    this.stream++;
    this.flushing = false;
    this.detector.reset();
    for (const f of this.frames.values()) if (f.held) this.unref(f.slot);
    this.frames.clear();
    this.queue = [];
    this.startSeq = this.nextSeq;
    this.fed = 0;
  }

  private measure(frame: RingFrame, next: RingFrame | null): void {
    const prev = this.frames.get(frame.seq - 1);
    const prevSlot = prev && prev.seq >= this.startSeq && prev.held ? prev.slot : null;
    frame.order = this.detector.fieldOrder;
    const stream = this.stream;
    frame.measure = this.backend.measure(prevSlot, frame.slot, next?.slot ?? null, frame.order);
    frame.measure.then(
      (metrics) => {
        if (stream !== this.stream) return;
        frame.metrics = metrics;
        this.drain();
      },
      (err: unknown) => {
        if (stream !== this.stream) return;
        this.fail(err);
      },
    );
  }

  /** Feeds the detector every measured frame at the head of the queue, then hands out the pictures. */
  private drain(): void {
    if (this.failure) return;
    const out: PlannedPicture[] = [];
    while (this.queue.length > 0 && this.queue[0]!.metrics) {
      const f = this.queue.shift()!;
      out.push(...this.detector.push(f.seq, f.timestampUs, f.flags, f.metrics!));
      this.fed++;
    }
    const finished = this.flushing && this.queue.length === 0;
    if (finished) out.push(...this.detector.flush());
    const pictures = out.map((p) => this.picture(p));
    // A frame is done with once it and the frame after it are planned (it is that frame's previous neighbour).
    const plannedThrough = finished ? Infinity : this.startSeq + this.fed - 1 - LOOKAHEAD;
    for (const f of this.frames.values()) {
      if (f.seq < plannedThrough || finished) this.releaseFrame(f);
    }
    if (pictures.length > 0) this.onPictures(pictures);
    if (finished) {
      // The old stream is done: the frames pushed while it drained start the next one, up to a flush asked after
      // them, which ends that stream (frames after it stay deferred for the stream after).
      const waiting = this.deferred;
      this.deferred = [];
      this.restart();
      this.endFlush();
      for (let i = 0; i < waiting.length; i++) {
        const w = waiting[i]!;
        if (w.kind === 'frame') {
          this.admit(w.slot, w.input);
          continue;
        }
        this.deferred = waiting.slice(i + 1);
        this.startFlush(w);
        break;
      }
    }
  }

  private releaseFrame(f: RingFrame): void {
    if (f.held) {
      f.held = false;
      this.unref(f.slot);
    }
    this.frames.delete(f.seq);
  }

  private picture(p: PlannedPicture): RingPicture {
    const f = this.frames.get(p.frame)!;
    const neighbour = (seq: number): number | null => {
      const n = this.frames.get(seq);
      return n && n.held && n.seq >= this.startSeq ? n.slot : null;
    };
    const slots = { prev: neighbour(f.seq - 1), cur: f.slot, next: neighbour(f.seq + 1) };
    // Match pairings follow the parity the frame was measured by; an interpolated field keeps the frame's own order.
    const order = p.op.kind === 'interpolate' ? (f.flags.fieldOrder ?? f.order) : f.order;
    const duration =
      this.detector.mode === 'film' ? FILM_FRAME_US : p.op.kind === 'interpolate' ? this.frameDurationUs / 2 : this.frameDurationUs;
    for (const s of [slots.prev, slots.cur, slots.next]) if (s !== null) this.refs[s]!++;
    const picture = new RingPicture(p.timestampUs, duration, p.op, slots, order, f.matrix, this.generation, (closed) => {
      this.pictures.delete(closed);
      for (const s of [closed.slots.prev, closed.slots.cur, closed.slots.next]) if (s !== null) this.unref(s);
    });
    this.pictures.add(picture);
    return picture;
  }

  private unref(slot: number): void {
    if (this.refs[slot]! > 0) this.refs[slot]!--;
  }
}
