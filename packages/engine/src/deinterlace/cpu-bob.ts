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
 * Shows interlaced video at field rate with no GPU work: each field of a decoded frame becomes a whole picture, its
 * lines kept and the other field's lines filled by the average of the lines above and below (line interpolation, as
 * the GPU deinterlacer's fall-back does). There is no film detection: telecined film shows at field rate too. A frame
 * flagged progressive is shown whole, and a repeated first field (soft pulldown) is shown again after the second.
 * Used where WebGL draws in software, which can't run the GPU deinterlacer in real time.
 * @internal
 */
export class FieldBob {
  private out = new Uint8Array(0);

  /**
   * `fieldUs`: one field's time (half the stream's frame duration), the spacing of the pictures a frame gives.
   * `makeFrame`: how the pictures become video frames.
   */
  constructor(
    private readonly fieldUs: number,
    private readonly makeFrame: MakeVideoFrame = defaultMakeFrame,
  ) {}

  /** The pictures of one decoded frame, in display order, each a video frame the caller owns (and closes). */
  pictures(input: FieldInput): VideoFrame[] {
    const { flags } = input;
    if (flags.progressive === true) return [this.picture(input, null, input.timestampUs, flags.repeatFirstField ? 3 * this.fieldUs : 2 * this.fieldUs)];
    const first = flags.fieldOrder === 'bff' ? 1 : 0;
    const order = flags.repeatFirstField ? [first, 1 - first, first] : [first, 1 - first];
    return order.map((parity, i) => this.picture(input, parity, input.timestampUs + i * this.fieldUs, this.fieldUs));
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
