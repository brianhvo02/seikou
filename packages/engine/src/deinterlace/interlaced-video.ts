// SPDX-License-Identifier: LGPL-3.0-or-later
// The player's side of the deinterlacer: one interlaced session's frames go in, pictures come out for the presenter,
// and a picture the presenter selects is drawn for the compositor. It owns the GPU backend (kept across sessions of the
// same size and ring), parks a frame the ring has no slot for, and says why frames are drawn woven instead.

import type { DrawnPicture } from '../render/compositor';
import type { DeinterlaceBackend, DeinterlaceStats, Picture } from './deinterlacer';
import { Deinterlacer } from './deinterlacer';
import type { FieldInput } from './field-input';
import { PacingMonitor, type PacingObservation } from './pacing-monitor';

/** The device's deinterlacing setting: `auto` deinterlaces interlaced streams, `off` draws their frames woven. */
export type DeinterlaceSetting = 'auto' | 'off';

/** Makes the GPU backend for frames of `width` x `height` with `ringSize` slots, or null where there is none (no WebGL2). */
export type DeinterlaceBackendFactory = (width: number, height: number, ringSize: number) => DeinterlaceBackend | null;

/** Why an interlaced session's frames are drawn woven: the setting is off. */
export const WOVEN_OFF = 'Deinterlacing is off';
/** Why an interlaced session's frames are drawn woven: the browser has no WebGL2 for the deinterlacer. */
export const WOVEN_NO_WEBGL2 = 'WebGL2 is unavailable';
/** Why an interlaced session's frames are drawn woven: WebGL draws in software (`renderer`), too slow to deinterlace in time. */
export const wovenSoftwareRenderer = (renderer: string): string => `A software WebGL renderer (${renderer}) can't deinterlace in real time`;
/**
 * Why an interlaced session's frames are drawn woven: the browser's decoder gives them in `format`, not as YUV planes
 * (I420 or NV12) the deinterlacer can read (Firefox on macOS gives BGRX).
 */
export const wovenFrameFormat = (format: string): string => `The browser decodes to ${format}, which the deinterlacer can't read`;

/** What `InterlacedVideo` is built with. */
export interface InterlacedVideoDeps {
  readonly createBackend: DeinterlaceBackendFactory;
  /** Slots in the ring (the memory profile's `deinterlaceRing`). */
  readonly ringSize: number;
  /** Receives the pictures as they are decided, in timestamp order. */
  onPictures(pictures: readonly Picture[]): void;
}

/** A frame waiting for a free slot (its planes copied), or the end of a stream asked after it. */
type Parked = { readonly kind: 'frame'; readonly input: FieldInput } | { readonly kind: 'flush'; readonly resolve: () => void; readonly reject: (err: Error) => void };

/** The last picture drawn, so drawing the same one again reuses its image as it is. */
interface Drawn {
  readonly picture: Picture;
  readonly still: boolean;
  readonly result: DrawnPicture;
}

/**
 * One interlaced session's way through the deinterlacer. `start` makes the backend (or says why there is none);
 * `push` takes the decoder's field inputs, `render` draws a picture for the compositor, `reset` follows a seek and
 * `flush` the end of a stream (a play item's or the playlist's). Once the GPU fails (`error`) it takes nothing more,
 * and the player draws the session's frames woven.
 */
export class InterlacedVideo {
  private readonly deps: InterlacedVideoDeps;
  private backend: DeinterlaceBackend | null = null;
  private size: { readonly width: number; readonly height: number } | null = null;
  private deinterlacer: Deinterlacer | null = null;
  private parked: Parked[] = [];
  private display = { width: 0, height: 0 };
  /** Pictures of this deinterlacer handed out and not yet known closed (WeakSet: a dropped picture is forgotten). */
  private readonly ours = new WeakSet<Picture>();
  private drawn: Drawn | null = null;
  /** The image of the last picture handed out, closed when the next replaces it (the compositor may redraw it until then). */
  private bitmap: ImageBitmap | null = null;
  private readonly pacing = new PacingMonitor();
  private failure: Error | null = null;

  constructor(deps: InterlacedVideoDeps) {
    this.deps = deps;
  }

  /** The ring's size. */
  get ringSize(): number {
    return this.deps.ringSize;
  }

  /** Why the GPU stopped (a lost WebGL context, a failed upload or draw), or null while it works. */
  get error(): Error | null {
    return this.failure ?? this.deinterlacer?.error ?? null;
  }

  /** What the deinterlacer is doing, for telemetry; null before the first stream. */
  get stats(): DeinterlaceStats | null {
    return this.deinterlacer?.stats ?? null;
  }

  /**
   * A session starts with frames of `width` x `height` (the visible size) at `frameDurationUs` a frame: the backend is
   * made, or kept from the last session when the size is the same. False when there is none (no WebGL2): the session's
   * frames are drawn woven.
   */
  start(width: number, height: number, frameDurationUs: number): boolean {
    const failed = this.error !== null;
    this.deinterlacer?.reset();
    this.deinterlacer = null;
    this.parked = [];
    this.drawn = null;
    if (failed) {
      // the last session's GPU failed (a lost context isn't restored): this one tries a new backend
      this.backend?.dispose();
      this.backend = null;
      this.size = null;
      this.failure = null;
    }
    if (!this.backend || this.size?.width !== width || this.size?.height !== height) {
      this.backend?.dispose();
      this.backend = null;
      this.size = null;
      let backend: DeinterlaceBackend | null = null;
      try {
        backend = this.deps.createBackend(width, height, this.deps.ringSize);
      } catch {
        backend = null;
      }
      if (!backend) return false;
      this.backend = backend;
      this.size = { width, height };
    }
    const deinterlacer: Deinterlacer = new Deinterlacer({
      backend: this.backend,
      ringSize: this.deps.ringSize,
      frameDurationUs,
      onPictures: (pictures) => {
        // a replaced deinterlacer's late pictures (its measurements came back after the session ended) never reach
        // the next session's presenter
        if (this.deinterlacer !== deinterlacer) {
          for (const p of pictures) p.close();
          return;
        }
        for (const p of pictures) this.ours.add(p);
        this.deps.onPictures(pictures);
      },
    });
    this.deinterlacer = deinterlacer;
    return true;
  }

  /** The frame size the backend was made for, or null without one. */
  get frameSize(): { readonly width: number; readonly height: number } | null {
    return this.size;
  }

  /** Whether the picture came from this deinterlacer (and is not a decoded frame). */
  owns(frame: object): frame is Picture {
    return this.ours.has(frame as Picture);
  }

  /**
   * Slots free for frames still to come: the ring's free slots less the frames parked for one. Decode-ahead waits
   * while this, less the frames the decoder still owes, is 0.
   */
  freeSlots(): number {
    const d = this.deinterlacer;
    if (!d) return 0;
    return Math.max(0, d.freeSlots() - this.parked.filter((p) => p.kind === 'frame').length);
  }

  /**
   * Adds a decoded frame. Its planes are uploaded at once, or, with no slot free (a frame the decoder held back),
   * copied and parked until one is. False once the GPU has failed (`error`).
   */
  push(input: FieldInput): boolean {
    const d = this.deinterlacer;
    if (!d || this.error) return false;
    this.display = { width: input.displayWidth, height: input.displayHeight };
    if (this.parked.length > 0 || d.freeSlots() === 0) {
      const planes = { ...input.planes, data: input.planes.data.slice() };
      this.parked.push({ kind: 'frame', input: { ...input, planes } });
      return this.pump();
    }
    d.push(input);
    return d.error === null;
  }

  /** Pushes parked frames while slots are free (call it when pictures close). False once the GPU has failed. */
  pump(): boolean {
    const d = this.deinterlacer;
    if (!d) return false;
    while (this.parked.length > 0 && !d.error) {
      const head = this.parked[0]!;
      if (head.kind === 'frame') {
        if (d.freeSlots() === 0) break;
        this.parked.shift();
        d.push(head.input);
      } else {
        this.parked.shift();
        d.flush().then(head.resolve, head.reject);
      }
    }
    return d.error === null;
  }

  /**
   * The end of a stream (a play item's, or the playlist's): every frame pushed so far becomes pictures, and the next
   * frame starts a new stream (the detector starts over). Resolves once the pictures are out; rejects when the GPU
   * fails meanwhile.
   */
  flush(): Promise<void> {
    const d = this.deinterlacer;
    if (!d) return Promise.resolve();
    if (this.error) return Promise.reject(this.error);
    if (this.parked.length === 0) return d.flush();
    return new Promise<void>((resolve, reject) => {
      this.parked.push({ kind: 'flush', resolve, reject });
    });
  }

  /**
   * Reports one display tick to the pacing check (`PacingMonitor` judges it, the deinterlacer's window counts it);
   * nothing without a session.
   */
  observePacing(o: PacingObservation): void {
    const d = this.deinterlacer;
    if (!d) return;
    const verdict = this.pacing.observe(o);
    if (verdict === 'restart') d.restartPacing();
    else if (verdict !== 'skip') d.notePacing(verdict === 'late');
  }

  /** Playback starts or resumes, or the page is shown again: pacing isn't judged for the next second. */
  settlePacing(): void {
    this.pacing.settle();
  }

  /** A seek: the frames and the cadence are forgotten; pictures handed out before draw nothing new. */
  reset(): void {
    this.pacing.settle();
    for (const p of this.parked) if (p.kind === 'flush') p.resolve();
    this.parked = [];
    this.drawn = null;
    this.deinterlacer?.reset();
  }

  /**
   * Draws the picture for the compositor. `still` (paused, or a held still) draws a picture of one field as its whole
   * frame woven. The same picture drawn the same way again reuses its image. Null when the GPU fails (`error`).
   */
  render(picture: Picture, still: boolean): DrawnPicture | null {
    const d = this.deinterlacer;
    if (!d || this.error) return null;
    const last = this.drawn;
    if (last && last.picture === picture && last.still === still) return last.result;
    let image: ImageBitmap;
    try {
      // WebKit copies a WebGL canvas drawn into a 2D canvas at about 15 ms a 1080 picture on an iPhone 17 Pro, which
      // can't keep up with film; the canvas's image moved out as an ImageBitmap draws without that copy.
      image = d.render(picture, still).transferToImageBitmap();
    } catch (err) {
      this.failure ??= err instanceof Error ? err : new Error(String(err));
      return null;
    }
    const size = this.size!;
    const result: DrawnPicture = {
      image,
      displayWidth: this.display.width || size.width,
      displayHeight: this.display.height || size.height,
      key: {},
    };
    this.bitmap?.close();
    this.bitmap = image;
    this.drawn = { picture, still, result };
    return result;
  }

  /** Frees the GPU resources; the next `start` makes a new backend. */
  dispose(): void {
    this.reset();
    this.bitmap?.close();
    this.bitmap = null;
    this.deinterlacer = null;
    this.backend?.dispose();
    this.backend = null;
    this.size = null;
  }
}
