// SPDX-License-Identifier: LGPL-3.0-or-later
// Frame pacing as the deinterlacer's fall-back sees it: from what each display tick did, was a picture missed? The
// rule is judged in display ticks, so a healthy device never counts as late whatever its display rate (50, 60 or
// 120 Hz) or the beat between the display and the picture rate, and a device that really can't keep up does.

/** What one display tick did with the pictures. */
export interface PacingObservation {
  /** The page's clock in milliseconds. */
  readonly nowMs: number;
  /** Whether the session is playing (a paused, buffering or held session reports nothing). */
  readonly playing: boolean;
  /** How far past its own time the picture this tick selected was, in microseconds, or null when it selected none. */
  readonly shownLateUs: number | null;
  /** The selected picture's duration in microseconds (any picture's, when none was selected). */
  readonly durationUs: number;
  /** Pictures the presenter closed unshown since the previous tick. */
  readonly dropped: number;
}

/**
 * What a tick comes to: `late` (a picture was missed), `ok`, `skip` (inside the settling period: not counted) or
 * `restart` (playback just started, resumed, seeked or came back after a gap: the caller empties its window; the
 * tick is not counted).
 */
export type PacingVerdict = 'late' | 'ok' | 'skip' | 'restart';

/** After a start, resume, seek or return from a gap pacing is not judged for this long. */
export const PACING_SETTLE_MS = 1000;
/** A gap between ticks longer than this is a stall of the page or the worker, not pacing: it settles like a start. */
export const PACING_GAP_MS = 250;
/** The slowest display interval taken as one (30 Hz, which a phone in Low Power Mode shows at); slower ticks are the device falling behind. */
export const PACING_MAX_TICK_MS = 1000 / 30;
/** Spacings kept to measure the display's tick interval from. */
const SPACINGS = 60;
/** Spacings needed before pacing is judged. */
const MIN_SPACINGS = 12;

/**
 * Judges frame pacing one display tick at a time. The display's tick interval is the lower fifth of the latest
 * spacings between ticks (stalls only lengthen a spacing). The estimate is capped at 30 Hz's interval, so a device whose ticks are all slower is judged against it and falls back. A tick is late when its picture was shown more than one
 * picture and one and a half ticks after its time (a picture that came to the screen far behind), or when a tick
 * came more than one and a quarter intervals after the last one with pictures dropped at it, or when it dropped more
 * pictures than the display's rate alone makes it (a tick interval longer than a picture's duration drops some, as a
 * 50 Hz display does at 59.94 pictures a second). At most one late tick comes of each tick, however many pictures it dropped.
 */
export class PacingMonitor {
  private readonly spacings: number[] = [];
  private lastMs: number | null = null;
  private lastGap: number | null = null;
  private settling = true;
  private settleUntilMs = 0;

  /** Playback starts, resumes or seeks, or the page is shown again: the next tick restarts the settling period. */
  settle(): void {
    this.settling = true;
  }

  /** Takes one display tick's observation. */
  observe(o: PacingObservation): PacingVerdict {
    const last = this.lastMs;
    this.lastMs = o.nowMs;
    const gap = last === null ? null : o.nowMs - last;
    if (gap !== null && gap > 0) {
      // one long gap after fast ticks is a stall of the page or worker (a tab hidden): it settles; ticks that are all
      // slow are the device falling behind, and are judged
      if (gap > PACING_GAP_MS && (this.lastGap === null || this.lastGap <= PACING_GAP_MS)) this.settling = true;
      this.lastGap = gap;
      this.spacings.push(gap);
      if (this.spacings.length > SPACINGS) this.spacings.shift();
    }
    if (!o.playing) this.settling = true;
    if (this.settling) {
      if (!o.playing) return 'skip';
      this.settling = false;
      this.settleUntilMs = o.nowMs + PACING_SETTLE_MS;
      return 'restart';
    }
    if (o.nowMs < this.settleUntilMs || this.spacings.length < MIN_SPACINGS || gap === null) return 'skip';
    const tickMs = this.tickMs();
    const durationMs = o.durationUs / 1000;
    if (o.shownLateUs !== null && o.shownLateUs / 1000 > durationMs + 1.5 * tickMs) return 'late';
    if (o.dropped > 0 && gap > 1.25 * tickMs) return 'late';
    // pictures the display's own rate can leave unshown in one tick: more than one tick interval of them
    const allowed = Math.max(0, Math.ceil((1.25 * tickMs) / durationMs) - 1);
    return o.dropped > allowed ? 'late' : 'ok';
  }

  /** The display's tick interval in milliseconds: the lower fifth of the recent spacings, at most `PACING_MAX_TICK_MS`. */
  private tickMs(): number {
    const sorted = [...this.spacings].sort((a, b) => a - b);
    return Math.min(sorted[Math.floor(sorted.length / 5)]!, PACING_MAX_TICK_MS);
  }
}
