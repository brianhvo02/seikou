// SPDX-License-Identifier: LGPL-3.0-or-later
// Test helpers for the cadence detector: a stream is described field by field, each field labelled with the picture
// it shows, and the per-frame metrics are computed from the labels as the GPU would measure them. Only tests import
// this file.

import type { FieldFlags } from './field-input';
import type { FrameMetrics, PlannedPicture } from './cadence';

/**
 * One coded frame as the labels of its two fields: `first` is the field of the stream's first parity (the top field
 * in a top-field-first stream), `second` the other, whatever order the frame's own flags give.
 */
export interface SimFrame {
  readonly first: string;
  readonly second: string;
}

/** A clean pairing's comb value (noise), on the detector's 0 to 1 scale. */
export const SIM_COMB_CLEAN = 0.004;
/** A pairing of two fields from different moments, on the detector's 0 to 1 scale. */
export const SIM_COMB_HIGH = 0.4;
/** The difference of one field from a field showing another moment. */
export const SIM_DIFF_HIGH = 0.1;

/** The duration of a 29.97 frame in microseconds. */
export const NTSC_FRAME_US = 1_001_000 / 30;
/** The duration of a 23.976 film frame in microseconds. */
export const FILM_FRAME_US = 1_001_000 / 24;

/** Film frame `n`'s field label. */
export function filmLabel(n: number): string {
  return `f${n}`;
}

/** The film frame number a label names, or null for a video or progressive label. */
export function filmNumber(label: string): number | null {
  return label.startsWith('f') ? Number(label.slice(1)) : null;
}

/**
 * Hard 3:2 telecine of film frames `start` to `start + count - 1`: film frames give 2 and 3 fields in turn (the
 * first gives 2), `skip` fields are left out at the start (a different phase), and the fields are paired into
 * frames. A trailing odd field is left out.
 */
export function telecine(start: number, count: number, skip = 0): SimFrame[] {
  const fields: string[] = [];
  for (let k = 0; k < count; k++) {
    const n = k % 2 === 0 ? 2 : 3;
    for (let j = 0; j < n; j++) fields.push(filmLabel(start + k));
  }
  return pairFields(fields.slice(skip));
}

/** Field-rate video: every field its own moment, labelled `v<n>` from `start`. */
export function videoFrames(start: number, count: number): SimFrame[] {
  const out: SimFrame[] = [];
  for (let k = 0; k < count; k++) out.push({ first: `v${start + 2 * k}`, second: `v${start + 2 * k + 1}` });
  return out;
}

/** Progressive frames: both fields of a frame show the same moment, labelled `p<n>` from `start`. */
export function progressiveFrames(start: number, count: number): SimFrame[] {
  const out: SimFrame[] = [];
  for (let k = 0; k < count; k++) out.push({ first: `p${start + k}`, second: `p${start + k}` });
  return out;
}

function pairFields(fields: readonly string[]): SimFrame[] {
  const out: SimFrame[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ first: fields[i]!, second: fields[i + 1]! });
  return out;
}

/** How `simMetrics` measures a sequence. */
export interface SimOptions {
  /** The field order the motion evidence points to (default top first). */
  readonly order?: 'tff' | 'bff';
  /** Combing every pairing shows in part of the frame (video-rate titles over film), added to each comb value. */
  readonly overlay?: number;
}

/** The metrics of each frame of `frames`, computed from the field labels. */
export function simMetrics(frames: readonly SimFrame[], opts: SimOptions = {}): FrameMetrics[] {
  const overlay = opts.overlay ?? 0;
  const comb = (a: string | undefined, b: string | undefined): number =>
    (a !== undefined && a === b ? SIM_COMB_CLEAN : SIM_COMB_HIGH) + overlay;
  const diff = (a: string, b: string): number => (a === b ? 0 : SIM_DIFF_HIGH);
  const tff = (opts.order ?? 'tff') === 'tff';
  return frames.map((f, i) => {
    const prev = frames[i - 1];
    const next = frames[i + 1];
    return {
      combWoven: comb(f.first, f.second),
      combMatchPrev: comb(f.first, prev?.second),
      combMatchNext: comb(f.second, next?.first),
      diffPrev: prev ? (diff(f.first, prev.first) + diff(f.second, prev.second)) / 2 : SIM_DIFF_HIGH,
      motionTff: tff ? 0.1 : 0.3,
      motionBff: tff ? 0.3 : 0.1,
    };
  });
}

/** Even timestamps from `start` at `frameUs` a frame, rounded to whole microseconds. */
export function evenTimestamps(count: number, frameUs = NTSC_FRAME_US, start = 0): number[] {
  return Array.from({ length: count }, (_, k) => Math.round(start + k * frameUs));
}

/**
 * Soft 3:2 pulldown timestamps: film frames shown for 3 and 2 fields in turn (the first for 3), so the frames are
 * 50 050 µs and 33 367 µs apart in turn.
 */
export function softPulldownTimestamps(count: number, start = 0): number[] {
  return Array.from({ length: count }, (_, k) => Math.round(start + k * FILM_FRAME_US + (k % 2 === 1 ? FILM_FRAME_US / 5 : 0)));
}

/** Field flags with the given order and nothing else said. */
export function orderFlags(fieldOrder: 'tff' | 'bff' | null): FieldFlags {
  return { fieldOrder, progressive: fieldOrder === null ? null : false, repeatFirstField: false };
}

/**
 * The labels of the fields a planned picture shows: both fields of a weave or match, the one field of an
 * interpolation. `firstSeq` is the sequence number of `frames[0]`, and `order` the field order the frame was coded in.
 */
export function pictureFields(
  picture: PlannedPicture,
  frames: readonly SimFrame[],
  firstSeq: number,
  order: 'tff' | 'bff' = 'tff',
): string[] {
  const i = picture.frame - firstSeq;
  const f = frames[i]!;
  const op = picture.op;
  switch (op.kind) {
    case 'weave':
      return [f.first, f.second];
    case 'match':
      return op.with === 'prev' ? [f.first, frames[i - 1]!.second] : [f.second, frames[i + 1]!.first];
    case 'interpolate': {
      const firstIsTop = order === 'tff';
      return [(op.field === 'top') === firstIsTop ? f.first : f.second];
    }
  }
}

/**
 * The source fields a planned picture shows, as ids: frame index × 2, plus 1 for the field of the second parity.
 * `streamOrder` is the stream's field order, which says which parity is first.
 */
export function pictureFieldIds(picture: PlannedPicture, firstSeq: number, streamOrder: 'tff' | 'bff' = 'tff'): number[] {
  const i = picture.frame - firstSeq;
  const op = picture.op;
  switch (op.kind) {
    case 'weave':
      return [2 * i, 2 * i + 1];
    case 'match':
      return op.with === 'prev' ? [2 * i, 2 * i - 1] : [2 * i + 1, 2 * i + 2];
    case 'interpolate':
      return [(op.field === 'top') === (streamOrder === 'tff') ? 2 * i : 2 * i + 1];
  }
}

/**
 * The film frames a sequence holds whole: those with a first and a second field that a weave or a match can pair
 * (in the same frame, or a first field with the previous frame's second).
 */
export function completeFilmFrames(frames: readonly SimFrame[]): number[] {
  const out = new Set<number>();
  frames.forEach((f, i) => {
    const prev = frames[i - 1];
    for (const pairedWith of [f.second, prev?.second]) {
      const n = filmNumber(f.first);
      if (n !== null && pairedWith === f.first) out.add(n);
    }
  });
  return [...out].sort((a, b) => a - b);
}
