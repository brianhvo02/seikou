// SPDX-License-Identifier: LGPL-3.0-or-later

/** Frame index of a clip time (45 kHz ticks) relative to the clip's first video PTS. */
export function frameAt(t45: number, video: { firstPts90: number; fpsNum: number; fpsDen: number }): number {
  return Math.round(((t45 * 2 - video.firstPts90) * video.fpsNum) / (video.fpsDen * 90000));
}

/** Sample index of a clip time (45 kHz ticks) relative to the clip's first audio PTS. */
export function sampleAt(t45: number, audio: { firstPts90: number; sampleRate: number }): number {
  return Math.round(((t45 * 2 - audio.firstPts90) * audio.sampleRate) / 90000);
}

/** Duration of `frames` frames in nanoseconds, rounded to nearest. */
export function framesToNs(frames: number, video: { fpsNum: number; fpsDen: number }): bigint {
  const num = BigInt(video.fpsNum);
  return (BigInt(frames) * BigInt(video.fpsDen) * 1_000_000_000n + num / 2n) / num;
}

export function frameDurationNs(video: { fpsNum: number; fpsDen: number }): bigint {
  return framesToNs(1, video);
}
