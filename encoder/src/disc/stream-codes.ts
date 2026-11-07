// SPDX-License-Identifier: LGPL-3.0-or-later
// Blu-ray CLPI / STN stream attribute code tables.

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
  5: { width: 720, height: 576, interlaced: false },
  6: { width: 1920, height: 1080, interlaced: false },
  7: { width: 1280, height: 720, interlaced: false },
  8: { width: 3840, height: 2160, interlaced: false },
};

const AUDIO_RATES: Readonly<Record<number, number>> = { 1: 48000, 4: 96000, 5: 192000, 12: 48000, 14: 48000 };

const AUDIO_CHANNELS: Readonly<Record<number, number>> = { 1: 1, 3: 2, 6: 6, 12: 6 };

function lookup<T>(table: Readonly<Record<number, T>>, code: number, what: string): T {
  const value = table[code];
  if (value === undefined) throw new Error(`Unknown ${what} code ${code}`);
  return value;
}

export function videoRate(code: number): { fpsNum: number; fpsDen: number } {
  return lookup(VIDEO_RATES, code, 'video rate');
}

export function videoFormat(code: number): { width: number; height: number; interlaced: boolean } {
  return lookup(VIDEO_FORMATS, code, 'video format');
}

export function audioRate(code: number): number {
  return lookup(AUDIO_RATES, code, 'audio rate');
}

export function audioChannels(formatCode: number): number {
  return lookup(AUDIO_CHANNELS, formatCode, 'audio format');
}
