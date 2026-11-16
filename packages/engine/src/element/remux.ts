// SPDX-License-Identifier: LGPL-3.0-or-later
import { analyzeAvc } from '@seikou/bdmv/codecs/h264';
import { analyzeHevc } from '@seikou/bdmv/codecs/hevc';
import { ParseError } from '@seikou/bdmv/byte-reader';
import { findParameterSets } from '@seikou/bdmv/codecs/param-sets';
import type { ParameterSets } from '@seikou/bdmv/codecs/param-sets';
import { displaySize, ELEMENT_TIME_OFFSET_US, initSegment, mediaSegment, TIMESCALE, toLengthPrefixed, videoTrack } from './fmp4';
import type { Fmp4Sample, VideoTrack } from './fmp4';

/**
 * What `ElementRemux` hands out: an init segment (a new one whenever the stream's parameter sets change) or a media
 * segment from one IRAP unit up to the next, with the playlist time it covers. An init's `width` and `height` are the
 * size the picture shows at (the coded size with the sample aspect ratio applied), `codedWidth` and `codedHeight` the
 * coded size.
 * @internal
 */
export type RemuxOutput =
  | { kind: 'init'; bytes: Uint8Array; codec: string; width: number; height: number; codedWidth: number; codedHeight: number }
  | { kind: 'segment'; bytes: Uint8Array; startUs: number; endUs: number };

interface Held {
  data: Uint8Array;
  ptsTicks: number;
  dtsTicks: number;
  ptsUs: number;
}

/** Duration of a segment's only sample (one frame at 24 fps), the one case with no neighbour to measure against. */
const LONE_SAMPLE_TICKS = 3750;

const ticks = (us: number): number => Math.round(us * 0.09);
const OFFSET_TICKS = ticks(ELEMENT_TIME_OFFSET_US);

function paramKey(p: ParameterSets): string {
  return [p.vps, p.sps, p.pps].map((list) => list.map((n) => Array.from(n, (b) => b.toString(16).padStart(2, '0')).join('')).join(',')).join('|');
}

/**
 * The stream the element's init segment would describe for a unit holding the stream's parameter sets (what the page
 * is asked about before an element session starts: its codec string, size, colour and HDR metadata); null when the
 * unit has no SPS, or one this can't read.
 * @internal
 */
export function elementStream(coding: 'avc' | 'hevc', data: Uint8Array): VideoTrack | null {
  try {
    const info = coding === 'avc' ? analyzeAvc(data) : analyzeHevc(data);
    const params = findParameterSets(info.data, coding);
    return params.sps.length > 0 ? videoTrack(coding, params, info.data) : null;
  } catch (err) {
    if (err instanceof ParseError) return null; // the canvas path's decoder judges such a stream
    throw err;
  }
}

/**
 * Turns the pipeline's video units (Annex B access units in playlist time) into fragmented MP4 for a `<video>` element:
 * an init segment from the first parameter sets and a media segment per group of pictures, from one random access point
 * (IDR, or an open GOP's I picture with a recovery point) to the next.
 * @internal
 */
export class ElementRemux {
  private held: Held[] = [];
  private key: string | null = null;
  private sequence = 1;
  private lastEndUs = -Infinity;
  /** While the session's first segment is collected: the PTS of the open GOP's I picture it starts at, which leading pictures come before. */
  private leadingBeforeUs: number | null = null;

  constructor(
    private readonly coding: 'avc' | 'hevc',
    private readonly emit: (out: RemuxOutput) => void,
  ) {}

  /** The end of the last emitted segment in playlist time; `-Infinity` before the first. */
  get endUs(): number {
    return this.lastEndUs;
  }

  /** Takes one video unit; units outside the play range are dropped. */
  push(unit: { data: Uint8Array; ptsUs: number; dtsUs?: number; inRange: boolean }): void {
    if (!unit.inRange) return;
    const info = this.coding === 'avc' ? analyzeAvc(unit.data) : analyzeHevc(unit.data);
    // a random access point: an IDR, or an I picture with a recovery point (an open GOP, where Blu-ray's EP map points too)
    const irap = info.key;
    if (irap) {
      this.flushSegment(ticks(unit.dtsUs ?? unit.ptsUs));
      // the first one after a reset starts the session: pictures that follow it in decode order but show before it
      // (an open GOP's leading pictures) refer to the GOP before, which the element never gets
      this.leadingBeforeUs = this.lastEndUs === -Infinity ? unit.ptsUs : null;
      const params = findParameterSets(info.data, this.coding);
      if (params.sps.length > 0) {
        const key = paramKey(params);
        if (key !== this.key) {
          const track = videoTrack(this.coding, params, info.data);
          const display = displaySize(track);
          this.key = key;
          this.emit({ kind: 'init', bytes: initSegment(track), codec: track.codec, width: display.width, height: display.height, codedWidth: track.width, codedHeight: track.height });
        }
      }
      if (this.key === null) return;
    } else if (this.held.length === 0) {
      return;
    } else if (this.leadingBeforeUs !== null && unit.ptsUs < this.leadingBeforeUs) {
      return;
    }
    this.held.push({
      data: info.data,
      ptsTicks: ticks(unit.ptsUs),
      dtsTicks: ticks(unit.dtsUs ?? unit.ptsUs),
      ptsUs: unit.ptsUs,
    });
  }

  /** Emits the segment being collected, if any (the end of the stream: the last sample lasts as long as the one before). */
  flush(): void {
    this.flushSegment(null);
  }

  private flushSegment(nextDtsTicks: number | null): void {
    const held = this.held;
    if (held.length === 0) return;
    this.held = [];
    const samples: Fmp4Sample[] = held.map((h, i) => {
      const next = held[i + 1];
      const duration = next ? next.dtsTicks - h.dtsTicks : 0;
      return { data: toLengthPrefixed(h.data), durationTicks: duration, ctsOffsetTicks: h.ptsTicks - h.dtsTicks, sync: i === 0 };
    });
    const lastIdx = samples.length - 1;
    if (nextDtsTicks !== null) samples[lastIdx].durationTicks = nextDtsTicks - held[lastIdx].dtsTicks;
    else if (samples.length === 1) samples[0].durationTicks = LONE_SAMPLE_TICKS;
    else samples[lastIdx].durationTicks = samples[lastIdx - 1].durationTicks;
    let first = 0;
    let max = 0;
    held.forEach((h, i) => {
      if (h.ptsTicks < held[first].ptsTicks) first = i;
      if (h.ptsTicks > held[max].ptsTicks) max = i;
    });
    const startUs = held[first].ptsUs;
    const endUs = held[max].ptsUs + (samples[max].durationTicks * 1e6) / TIMESCALE;
    const bytes = mediaSegment(this.sequence++, held[0].dtsTicks + OFFSET_TICKS, samples);
    this.lastEndUs = endUs;
    this.emit({ kind: 'segment', bytes, startUs, endUs });
  }

  /** Drops everything held and forgets the parameter sets; the next IRAP unit gives an init segment again. */
  reset(): void {
    this.held = [];
    this.key = null;
    this.sequence = 1;
    this.lastEndUs = -Infinity;
    this.leadingBeforeUs = null;
  }
}
