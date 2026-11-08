// SPDX-License-Identifier: LGPL-3.0-or-later
// Blu-ray CLPI stream attribute code tables. A CLPI ProgramInfo stream entry packs a 4-bit
// format and a 4-bit rate (video: video_format and frame_rate; audio: channel layout and
// sampling_freq); the numbers below are libbluray's enumerations (src/libbluray/bluray.h,
// BLURAY_VIDEO_FORMAT_*, BLURAY_VIDEO_RATE_*, BLURAY_AUDIO_FORMAT_*, BLURAY_AUDIO_RATE_*) as
// parsed by `_parse_stream_attr` in src/libbluray/bdnav/clpi_parse.c. The Blu-ray specification
// itself is not public.

const VIDEO_RATES: Readonly<Record<number, { fpsNum: number; fpsDen: number }>> = {
  1: { fpsNum: 24000, fpsDen: 1001 },
  2: { fpsNum: 24, fpsDen: 1 },
  3: { fpsNum: 25, fpsDen: 1 },
  4: { fpsNum: 30000, fpsDen: 1001 },
  6: { fpsNum: 50, fpsDen: 1 },
  7: { fpsNum: 60000, fpsDen: 1001 },
};

const VIDEO_FORMATS: Readonly<Record<number, { width: number; height: number; interlaced: boolean }>> = {
  1: { width: 720, height: 480, interlaced: true },
  2: { width: 720, height: 576, interlaced: true },
  3: { width: 720, height: 480, interlaced: false },
  4: { width: 1920, height: 1080, interlaced: true },
  5: { width: 1280, height: 720, interlaced: false },
  6: { width: 1920, height: 1080, interlaced: false },
  7: { width: 720, height: 576, interlaced: false },
  8: { width: 3840, height: 2160, interlaced: false },
};

// Codes 12 and 14 are "combo" rates: a lossless stream at 192 kHz (12) or 96 kHz (14) that carries
// an AC-3/DTS core at 48 kHz. The table reports the lossless rate, because that is the rate BestSource
// decodes them at (libavcodec decodes the TrueHD and DTS-HD Master Audio lossless layers, not the core),
// and the planner counts each stream's samples at the rate it is decoded at.
const AUDIO_RATES: Readonly<Record<number, number>> = { 1: 48000, 4: 96000, 5: 192000, 12: 192000, 14: 96000 };

// 1 mono, 3 stereo, 6 multichannel, 12 combo (a stereo core with a multichannel extension); the
// multichannel count of 6 is the 5.1 core.
const AUDIO_CHANNELS: Readonly<Record<number, number>> = { 1: 1, 3: 2, 6: 6, 12: 6 };

function lookup<T>(table: Readonly<Record<number, T>>, code: number, what: string): T {
  const value = table[code];
  if (value === undefined) throw new Error(`Unknown ${what} code ${code}`);
  return value;
}

/** Frame rate for a CLPI `video_rate` code as a fraction (24000/1001 for code 1). Throws on a code the table lacks. */
export function videoRate(code: number): { fpsNum: number; fpsDen: number } {
  return lookup(VIDEO_RATES, code, 'video rate');
}

/** Frame size and scan type for a CLPI `video_format` code. Throws on a code the table lacks. */
export function videoFormat(code: number): { width: number; height: number; interlaced: boolean } {
  return lookup(VIDEO_FORMATS, code, 'video format');
}

/** Sample rate in Hz for a CLPI audio rate code. Throws on a code the table lacks. */
export function audioRate(code: number): number {
  return lookup(AUDIO_RATES, code, 'audio rate');
}

/** Channel count for a CLPI audio format code (the core's count for combo streams). Throws on a code the table lacks. */
export function audioChannels(formatCode: number): number {
  return lookup(AUDIO_CHANNELS, formatCode, 'audio format');
}
