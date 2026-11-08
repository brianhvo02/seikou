// SPDX-License-Identifier: LGPL-3.0-or-later

// A video track's frames sit on a fixed grid of `fpsNum / fpsDen` frames per second. These three
// functions put a frame index on the Matroska time grid, in nanoseconds or in whole milliseconds
// (the unit of every block timestamp, since TimestampScale is 1,000,000).

/** Duration of `frames` frames in nanoseconds, rounded to nearest. */
export function framesToNs(frames: number, video: { fpsNum: number; fpsDen: number }): bigint {
  const num = BigInt(video.fpsNum);
  return (BigInt(frames) * BigInt(video.fpsDen) * 1_000_000_000n + num / 2n) / num;
}

/** Duration of one frame in nanoseconds, rounded to nearest. */
export function frameDurationNs(video: { fpsNum: number; fpsDen: number }): bigint {
  return framesToNs(1, video);
}

/** Matroska millisecond timestamp of video frame `frame`; block timestamps and chapter starts share this grid. */
export function videoMs(frame: number, video: { fpsNum: number; fpsDen: number }): number {
  return Math.round((frame * video.fpsDen * 1000) / video.fpsNum);
}
