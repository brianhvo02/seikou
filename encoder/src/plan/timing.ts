// SPDX-License-Identifier: LGPL-3.0-or-later

// Two clocks meet here. Playlist times (PlayItem IN_time/OUT_time, mark times) count 45 kHz ticks,
// half the 90 kHz clock that PES timestamps use (ISO/IEC 13818-1 §2.4.3.7), so a 45 kHz tick is
// doubled before it is compared with a 90 kHz PTS. Frames and samples are then counted from the
// clip's first video PTS and rounded to the nearest whole frame or sample, so a cut lands on the
// frame or sample closest to the requested time and the same time always gives the same index.

/**
 * Frame index of a clip time (45 kHz ticks) relative to the clip's first video PTS, rounded to the
 * nearest frame. Negative when the time lies before the first frame.
 */
export function frameAt(t45: number, video: { firstPts90: number; fpsNum: number; fpsDen: number }): number {
  return Math.round(((t45 * 2 - video.firstPts90) * video.fpsNum) / (video.fpsDen * 90000));
}

/**
 * Sample index of a clip time (45 kHz ticks) relative to `origin.firstPts90`. The planner passes the
 * clip's first VIDEO PTS: BestSource (adjustdelay=-1) aligns audio sample 0 with the first video frame.
 */
export function sampleAt(t45: number, origin: { firstPts90: number; sampleRate: number }): number {
  return Math.round(((t45 * 2 - origin.firstPts90) * origin.sampleRate) / 90000);
}

export { frameDurationNs, framesToNs, videoMs } from '@seikou/matroska/timing';
