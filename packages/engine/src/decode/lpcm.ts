/*
 * Ported from FFmpeg libavcodec/pcm-bluray.c (channel layout table)
 * Copyright (c) 2009, 2013 Christian Schmidt
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { CodingType } from '@seikou/bdmv/stream-types';
import { UnsupportedCodecError } from './decoder';

/** The 4-byte header of a Blu-ray LPCM payload (audio data payload size, channel assignment, sampling frequency, bits per sample). */
export interface LpcmHeader {
  /** The 4-bit channel_assignment (a key of the layout table, FFmpeg pcm-bluray.c). */
  readonly channelAssignment: number;
  /** Hz: 48000, 96000 or 192000. */
  readonly sampleRate: number;
  /** 16 or 24; 20-bit streams are refused. */
  readonly bitsPerSample: 16 | 24;
  /** Channels the assignment codes. */
  readonly codedChannels: number;
  /** Channels actually stored per frame (padded to even). */
  readonly storedChannels: number;
}

/** Decoded audio: stereo float PCM (already downmixed) starting at a playlist time. */
export interface PcmChunk {
  /** Playlist time of the first frame, in microseconds. */
  readonly ptsUs: number;
  /** Hz of `stereo`. */
  readonly sampleRate: number;
  /** Sample frames (a left and a right sample each). */
  readonly frames: number;
  /** Interleaved L, R, in [-1, 1]; `frames * 2` samples. */
  readonly stereo: Float32Array;
}

type Role = 'L' | 'R' | 'C' | 'S' | 'Ls' | 'Rs' | 'Lb' | 'Rb' | 'LFE';

/** Coded channel order per channel_assignment (Blu-ray Part 3; FFmpeg pcm-bluray.c). */
const LAYOUTS: Readonly<Record<number, readonly Role[]>> = {
  1: ['C'],
  3: ['L', 'R'],
  4: ['L', 'R', 'C'],
  5: ['L', 'R', 'S'],
  6: ['L', 'R', 'C', 'S'],
  7: ['L', 'R', 'Ls', 'Rs'],
  8: ['L', 'R', 'C', 'Ls', 'Rs'],
  9: ['L', 'R', 'C', 'Ls', 'Rs', 'LFE'],
  10: ['L', 'R', 'C', 'Ls', 'Lb', 'Rb', 'Rs'],
  11: ['L', 'R', 'C', 'Ls', 'Lb', 'Rb', 'Rs', 'LFE'],
};

const M3DB = Math.SQRT1_2;
const DOWNMIX: Readonly<Record<Role, readonly [number, number]>> = {
  L: [1, 0],
  R: [0, 1],
  C: [M3DB, M3DB],
  S: [0.5, 0.5],
  Ls: [M3DB, 0],
  Rs: [0, M3DB],
  Lb: [M3DB, 0],
  Rb: [0, M3DB],
  LFE: [0, 0],
};

const SAMPLE_RATES: Readonly<Record<number, number>> = { 1: 48_000, 4: 96_000, 5: 192_000 };

/** Reads an LPCM payload's header. Throws UnsupportedCodecError for 20-bit audio and a plain Error for a short payload or a reserved code. */
export function parseLpcmHeader(payload: Uint8Array): LpcmHeader {
  if (payload.length < 4) throw new Error('LPCM payload is shorter than its header');
  const channelAssignment = payload[2] >> 4;
  const layout = LAYOUTS[channelAssignment];
  if (!layout) throw new Error(`reserved LPCM channel assignment ${channelAssignment}`);
  const sampleRate = SAMPLE_RATES[payload[2] & 0x0f];
  if (!sampleRate) throw new Error(`reserved LPCM sample rate code ${payload[2] & 0x0f}`);
  const bitsCode = payload[3] >> 6;
  if (bitsCode === 2) throw new UnsupportedCodecError(CodingType.LPCM, '20-bit LPCM audio is not supported.');
  if (bitsCode !== 1 && bitsCode !== 3) throw new Error(`reserved LPCM sample size code ${bitsCode}`);
  const codedChannels = layout.length;
  return {
    channelAssignment,
    sampleRate,
    bitsPerSample: bitsCode === 1 ? 16 : 24,
    codedChannels,
    storedChannels: codedChannels + (codedChannels % 2),
  };
}

/** Downmixes a whole LPCM payload (header included) to stereo at the stream's own rate; trailing bytes short of a frame are dropped. Throws as parseLpcmHeader does. */
export function decodeLpcm(payload: Uint8Array, ptsUs: number): PcmChunk {
  const header = parseLpcmHeader(payload);
  const layout = LAYOUTS[header.channelAssignment];
  const bytesPerSample = header.bitsPerSample / 8;
  const frameBytes = header.storedChannels * bytesPerSample;
  const frames = Math.floor((payload.length - 4) / frameBytes);
  const gainL = layout.map((role) => DOWNMIX[role][0]);
  const gainR = layout.map((role) => DOWNMIX[role][1]);
  const mono = header.codedChannels === 1;
  const norm = mono ? 1 : 1 / Math.max(1, gainL.reduce((a, b) => a + b, 0));
  const stereo = new Float32Array(frames * 2);
  let o = 4;
  for (let f = 0; f < frames; f++) {
    let l = 0;
    let r = 0;
    for (let ch = 0; ch < header.storedChannels; ch++) {
      let s: number;
      if (bytesPerSample === 2) {
        const v = (payload[o] << 8) | payload[o + 1];
        s = (v & 0x8000 ? v - 0x10000 : v) / 32768;
      } else {
        const v = (payload[o] << 16) | (payload[o + 1] << 8) | payload[o + 2];
        s = (v & 0x800000 ? v - 0x1000000 : v) / 8388608;
      }
      o += bytesPerSample;
      if (ch >= header.codedChannels) continue;
      if (mono) {
        l = s;
        r = s;
      } else {
        l += s * gainL[ch];
        r += s * gainR[ch];
      }
    }
    stereo[f * 2] = l * norm;
    stereo[f * 2 + 1] = r * norm;
  }
  return { ptsUs, sampleRate: header.sampleRate, frames, stereo };
}
