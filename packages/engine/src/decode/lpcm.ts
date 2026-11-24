/*
 * Ported from FFmpeg libavcodec/pcm-bluray.c (channel layout table)
 * Copyright (c) 2009, 2013 Christian Schmidt
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { CodingType } from '@seikou/bdmv/stream-types';
import type { ChannelLayout, Speaker } from '../audio/channel-map';
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

/** Decoded audio: float PCM in its own channel layout, starting at a playlist time. */
export interface PcmChunk {
  /** Playlist time of the first frame, in microseconds. */
  readonly ptsUs: number;
  /** Hz of `samples`. */
  readonly sampleRate: number;
  /** Sample frames (one sample per channel each). */
  readonly frames: number;
  /** The speakers of `samples`, in order. */
  readonly channels: ChannelLayout;
  /** Interleaved, in [-1, 1]; `frames * channels.length` samples. */
  readonly samples: Float32Array;
}

/**
 * Coded channel order per channel_assignment (Blu-ray Part 3; FFmpeg pcm-bluray.c), named as speakers: the single
 * surround of 3/1 and 2/1 is back centre, the 7.1 assignment's surrounds and backs are the side and back pairs.
 */
const LAYOUTS: Readonly<Record<number, readonly Speaker[]>> = {
  1: ['FC'],
  3: ['FL', 'FR'],
  4: ['FL', 'FR', 'FC'],
  5: ['FL', 'FR', 'BC'],
  6: ['FL', 'FR', 'FC', 'BC'],
  7: ['FL', 'FR', 'SL', 'SR'],
  8: ['FL', 'FR', 'FC', 'SL', 'SR'],
  9: ['FL', 'FR', 'FC', 'SL', 'SR', 'LFE'],
  10: ['FL', 'FR', 'FC', 'SL', 'BL', 'BR', 'SR'],
  11: ['FL', 'FR', 'FC', 'SL', 'BL', 'BR', 'SR', 'LFE'],
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

/** Decodes a whole LPCM payload (header included) in its own layout and rate; trailing bytes short of a frame are dropped. Throws as parseLpcmHeader does. */
export function decodeLpcm(payload: Uint8Array, ptsUs: number): PcmChunk {
  const header = parseLpcmHeader(payload);
  const layout = LAYOUTS[header.channelAssignment];
  const coded = header.codedChannels;
  const bytesPerSample = header.bitsPerSample / 8;
  const frameBytes = header.storedChannels * bytesPerSample;
  const frames = Math.floor((payload.length - 4) / frameBytes);
  const samples = new Float32Array(frames * coded);
  let o = 4;
  let w = 0;
  for (let f = 0; f < frames; f++) {
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
      if (ch < coded) samples[w++] = s;
    }
  }
  return { ptsUs, sampleRate: header.sampleRate, frames, channels: layout, samples };
}
