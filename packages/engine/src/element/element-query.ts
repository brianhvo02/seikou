// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Clpi } from '@seikou/bdmv/clpi-parser';
import { dynamicRangeOf } from '@seikou/bdmv/dynamic-range';
import type { ColourDescription } from '@seikou/bdmv/codecs/param-sets';
import type { ElementHdr, ElementQuery } from '../protocol';

/** H.273 transfer characteristics: SMPTE ST 2084 (PQ) and ARIB STD-B67 (HLG). */
const TRANSFER_PQ = 16;
const TRANSFER_HLG = 18;

/** CLPI and STN video `rate` code → frames per second (libbluray `bd_video_rate_e`). */
const RATE_FPS: Readonly<Record<number, number>> = { 1: 24_000 / 1001, 2: 24, 3: 25, 4: 30_000 / 1001, 6: 50, 7: 60_000 / 1001 };

/**
 * The frames per second of a clip info or STN video `rate` code; undefined for a code that names none.
 * @internal
 */
export function frameRateOf(rate: number): number | undefined {
  return RATE_FPS[rate];
}

/**
 * Whether a stream is HDR: the clip info of `clips` marks an HEVC stream HDR10 or Dolby Vision (on a UHD disc that may
 * be the enhancement layer's stream alone, behind an HDR10 base layer), or the stream's SPS says PQ or HLG.
 * @internal
 */
export function streamIsHdr(clips: readonly Clpi[], sps: { readonly colour: ColourDescription | null } | null): boolean {
  if (dynamicRangeOf(clips) !== null) return true;
  const transfer = sps?.colour?.transfer;
  return transfer === TRANSFER_PQ || transfer === TRANSFER_HLG;
}

/**
 * What the element question asks about a stream: its codec string, its HDR facts (null for SDR: HLG when its SPS says
 * so, else PQ, with mastering when its first access unit carries the mastering display SEI), its coded size and, for a
 * `rate` code that names one, its frame rate.
 * @internal
 */
export function elementQuery(
  track: { readonly codec: string; readonly width: number; readonly height: number; readonly colour: ColourDescription | null; readonly mastering: unknown },
  clips: readonly Clpi[],
  rate: number,
): ElementQuery {
  const hdr: ElementHdr | null = streamIsHdr(clips, track)
    ? { transfer: track.colour?.transfer === TRANSFER_HLG ? 'hlg' : 'pq', mastering: track.mastering !== null }
    : null;
  const frameRate = frameRateOf(rate);
  return { codec: track.codec, hdr, width: track.width, height: track.height, ...(frameRate !== undefined ? { frameRate } : {}) };
}

/**
 * The key an element question and its answer are kept under: the codec with the HDR facts, size and frame rate, since
 * the browser may play a codec at one size or transfer function and not another.
 * @internal
 */
export function elementQueryKey(q: ElementQuery): string {
  const hdr = q.hdr ? `${q.hdr.transfer}${q.hdr.mastering ? '+m' : ''}` : 'sdr';
  return `${q.codec}|${hdr}|${q.width ?? ''}x${q.height ?? ''}@${q.frameRate ?? ''}`;
}
