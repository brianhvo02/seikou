// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Where the alignment strip draws its marks: the disc's speech in the top lane where it is, the track's dialogue lines
 * in the bottom lane where the found timing and the user's nudge put them, both clipped to the strip's window of
 * episode time and scaled to pixels. Pure, so the drawing component stays a thin canvas loop.
 */
import type { FansubAlignment, Span } from '../api-types';

/** A mark's horizontal place in the strip, in CSS pixels from its left edge. Lanes give the vertical place. */
export interface Rect {
  /** Left edge in pixels. */
  readonly x: number;
  /** Width in pixels; never negative. */
  readonly width: number;
}

/** What `stripLanes` needs. Times are milliseconds of episode time (0 is the episode's first frame). */
export interface StripInput {
  /** Where the disc's audio holds speech. */
  readonly speech: readonly Span[];
  /** The track's dialogue lines at the release's own timing. */
  readonly dialogue: readonly Span[];
  /** The timing lining up found; only `offset` and `split` move anything. */
  readonly alignment: FansubAlignment;
  /** The user's adjustment in milliseconds, added after the alignment. */
  readonly nudgeMs: number;
  /** Episode time at the strip's left edge. */
  readonly viewFromMs: number;
  /** Episode time at the strip's right edge; greater than `viewFromMs`. */
  readonly viewToMs: number;
  /** The strip's width in pixels. */
  readonly widthPx: number;
}

/** The marks of both lanes, in the order of their spans. */
export interface StripLanes {
  /** The disc's speech. */
  readonly top: Rect[];
  /** The subtitle lines, moved. */
  readonly bottom: Rect[];
}

/**
 * How far the alignment moves a line that starts at `atMs` of the release's own timing: the offset for `offset`, the
 * offset of the last part starting at or before it for `split` (as the backend's retime does), 0 otherwise.
 */
export function shiftAt(alignment: FansubAlignment, atMs: number): number {
  if (alignment.kind === 'offset') return alignment.offsetMs;
  if (alignment.kind !== 'split') return 0;
  let shift = 0;
  for (const part of [...alignment.parts].sort((a, b) => a.fromMs - b.fromMs)) if (part.fromMs <= atMs) shift = part.offsetMs;
  return shift;
}

/** Spans moved by `shift(span)`, clipped to the view and scaled; spans wholly outside the view are left out. */
function place(spans: readonly Span[], shift: (span: Span) => number, input: StripInput): Rect[] {
  const scale = input.widthPx / (input.viewToMs - input.viewFromMs);
  const rects: Rect[] = [];
  for (const span of spans) {
    const by = shift(span);
    const fromMs = Math.max(span.fromMs + by, input.viewFromMs);
    const toMs = Math.min(span.toMs + by, input.viewToMs);
    if (toMs <= fromMs) continue;
    rects.push({ x: (fromMs - input.viewFromMs) * scale, width: (toMs - fromMs) * scale });
  }
  return rects;
}

/**
 * The strip's marks: speech as found on the disc, and each dialogue line moved by the alignment (its split part's
 * offset for a split) plus the nudge. Marks are clipped to `[viewFromMs, viewToMs]` and scaled linearly to
 * `widthPx`.
 */
export function stripLanes(input: StripInput): StripLanes {
  return {
    top: place(input.speech, () => 0, input),
    bottom: place(input.dialogue, (span) => shiftAt(input.alignment, span.fromMs) + input.nudgeMs, input),
  };
}
