/*
 * Original code for Seikou: interlaced video at field rate on the CPU, for devices whose WebGL draws in software.
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import type { FieldInput } from './field-input';

/** Makes a video frame from planes in one buffer (`new VideoFrame(data, init)`, or a stand-in in tests). @internal */
export type MakeVideoFrame = (data: Uint8Array, init: VideoFrameBufferInit) => VideoFrame;

const defaultMakeFrame: MakeVideoFrame = (data, init) => new VideoFrame(data as Uint8Array<ArrayBuffer>, init);

/**
 * How much of the CPU path's output a frame gets: `field` (each field made whole, field rate), `frame` (the first field
 * made whole, one picture a frame) or `woven` (the frame as decoded, one picture a frame, no interpolation).
 * @internal
 */
export type BobStep = 'field' | 'frame' | 'woven';

/**
 * Pictures whose fate isn't counted after a start, a step or `settle()`: the pictures queued then were made the old
 * way, and the clock and the decoder are still finding their pace. @internal
 */
export const BOB_SETTLE_PICTURES = 30;
/** Pictures (presented or dropped) whose share of drops decides a step: about a second at field rate. @internal */
export const BOB_WINDOW = 60;
/**
 * The share of a window's pictures the presenter may drop unshown before the CPU path steps down. The CPU path runs on
 * the engine worker's thread, which also presents the pictures, reads and demuxes, and its pictures go through the
 * software renderer: where the machine can't keep up the presentation ticks starve and most pictures are dropped late
 * (a 4-core CI runner showed under 17 pictures a second of 59.94, dropping over 70%). A healthy 60 Hz display drops
 * none, and a 50 Hz one a sixth of 59.94, below this.
 * @internal
 */
export const BOB_DROP_SHARE = 0.25;

/**
 * Shows interlaced video at field rate with no GPU work: each field of a decoded frame becomes a whole picture, its
 * lines kept and the other field's lines filled by the average of the lines above and below (line interpolation, as
 * the GPU deinterlacer's fall-back does). There is no film detection: telecined film shows at field rate too. A frame
 * flagged progressive is shown whole, and a repeated first field (soft pulldown) is shown again after the second.
 * Used where WebGL draws in software, which can't run the GPU deinterlacer in real time.
 *
 * It steps down twice where the machine can't show what it makes (`step`), judged by what became of its pictures
 * (`notePresentation`): once more than `BOB_DROP_SHARE` of a window of `BOB_WINDOW` pictures (after
 * `BOB_SETTLE_PICTURES`) were dropped unshown, it makes one picture a frame (the first field, for the frame's time),
 * and if a window at that step drops as many, it shows the frames woven, so a slow device shows steady pictures at
 * frame rate instead of dropping most of them. A step lasts for the playlist (the session makes a new FieldBob).
 * @internal
 */
export class FieldBob {
  private out = new Uint8Array(0);
  private stepNow: BobStep = 'field';
  private settling = BOB_SETTLE_PICTURES;
  private windowPictures = 0;
  private windowDropped = 0;

  /**
   * `fieldUs`: one field's time (half the stream's frame duration), the spacing of the pictures a frame gives.
   * `makeFrame`: how the pictures become video frames.
   */
  constructor(
    private readonly fieldUs: number,
    private readonly makeFrame: MakeVideoFrame = defaultMakeFrame,
  ) {}

  /** What a frame gets now: field rate, one interpolated picture a frame, or the woven frame. */
  get step(): BobStep {
    return this.stepNow;
  }

  /** The pictures of one decoded frame, in display order, each a video frame the caller owns (and closes). */
  pictures(input: FieldInput): VideoFrame[] {
    const { flags } = input;
    const frameUs = flags.repeatFirstField ? 3 * this.fieldUs : 2 * this.fieldUs;
    if (flags.progressive === true || this.stepNow === 'woven') return [this.picture(input, null, input.timestampUs, frameUs)];
    const first = flags.fieldOrder === 'bff' ? 1 : 0;
    if (this.stepNow === 'frame') return [this.picture(input, first, input.timestampUs, frameUs)];
    const order = flags.repeatFirstField ? [first, 1 - first, first] : [first, 1 - first];
    return order.map((parity, i) => this.picture(input, parity, input.timestampUs + i * this.fieldUs, this.fieldUs));
  }

  /**
   * What became of its pictures while playing on a visible page: `presented` shown and `dropped` closed unshown since
   * the last report (one display tick's worth). Steps down when a full window drops more than its share.
   */
  notePresentation(presented: number, dropped: number): void {
    if (this.stepNow === 'woven') return;
    const n = presented + dropped;
    if (n === 0) return;
    if (this.settling > 0) {
      this.settling -= n;
      return;
    }
    this.windowPictures += n;
    this.windowDropped += dropped;
    if (this.windowPictures < BOB_WINDOW) return;
    const over = this.windowDropped > BOB_DROP_SHARE * this.windowPictures;
    this.windowPictures = 0;
    this.windowDropped = 0;
    if (!over) return;
    this.stepNow = this.stepNow === 'field' ? 'frame' : 'woven';
    this.settling = BOB_SETTLE_PICTURES;
  }

  /** Playback paused, held, seeked or was hidden: the window starts again after `BOB_SETTLE_PICTURES`. The step stays. */
  settle(): void {
    this.settling = BOB_SETTLE_PICTURES;
    this.windowPictures = 0;
    this.windowDropped = 0;
  }

  /** One picture: the whole frame (`parity` null) or the field of that parity (0 top, 1 bottom) with its other lines interpolated. */
  private picture(input: FieldInput, parity: number | null, timestamp: number, duration: number): VideoFrame {
    const p = input.planes;
    const { width, height } = p;
    const cw = Math.ceil(width / 2);
    const ch = Math.ceil(height / 2);
    const size = width * height + 2 * cw * ch;
    if (this.out.byteLength < size) this.out = new Uint8Array(size);
    const out = this.out;
    const [y, a, b] = p.layout;
    copyPlane(p.data, y!.offset, y!.stride, out, 0, width, width, height, parity);
    if (p.format === 'I420') {
      copyPlane(p.data, a!.offset, a!.stride, out, width * height, cw, cw, ch, parity);
      copyPlane(p.data, b!.offset, b!.stride, out, width * height + cw * ch, cw, cw, ch, parity);
    } else {
      copyPlane(p.data, a!.offset, a!.stride, out, width * height, 2 * cw, 2 * cw, ch, parity);
    }
    return this.makeFrame(out.subarray(0, size), {
      format: p.format,
      codedWidth: width,
      codedHeight: height,
      timestamp,
      duration,
      displayWidth: input.displayWidth,
      displayHeight: input.displayHeight,
      colorSpace: { matrix: p.matrix, fullRange: false },
    });
  }
}

/**
 * Copies `rows` rows of `rowBytes` from `src` (at `srcOffset`, `srcStride` apart) to `dst` (at `dstOffset`,
 * `dstStride` apart). With a `parity`, only that field's rows are copied (rows of that parity: in a 4:2:0 interlaced
 * picture a chroma row belongs to the field of its own parity too), and each other row is the average of the field's
 * rows above and below it (the nearest one at an edge).
 * @internal
 */
export function copyPlane(src: Uint8Array, srcOffset: number, srcStride: number, dst: Uint8Array, dstOffset: number, dstStride: number, rowBytes: number, rows: number, parity: number | null): void {
  for (let r = 0; r < rows; r++) {
    const to = dstOffset + r * dstStride;
    if (parity === null || (r & 1) === parity) {
      dst.set(src.subarray(srcOffset + r * srcStride, srcOffset + r * srcStride + rowBytes), to);
      continue;
    }
    const above = r - 1 >= 0 ? r - 1 : r + 1 < rows ? r + 1 : -1;
    const below = r + 1 < rows ? r + 1 : above;
    if (above < 0) {
      // a one-row plane: no row of the field to take from
      dst.set(src.subarray(srcOffset + r * srcStride, srcOffset + r * srcStride + rowBytes), to);
      continue;
    }
    const s0 = srcOffset + above * srcStride;
    const s1 = srcOffset + below * srcStride;
    for (let x = 0; x < rowBytes; x++) dst[to + x] = (src[s0 + x]! + src[s1 + x]! + 1) >> 1;
  }
}
