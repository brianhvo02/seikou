// SPDX-License-Identifier: LGPL-3.0-or-later
import { ClockLine } from '../element/clock-block';

/**
 * How far (us) the presentation time may run ahead of the clock it is given: more than the audio clock's longest step
 * (43 ms in Chrome), so a running clock is never held back, and little enough that a clock that stops stepping while
 * the engine plays (the sound run dry, a still) shows no more than a few pictures past it before ClockLine sees the hold.
 */
const MAX_LEAD_US = 50_000;

/**
 * The playback time the canvas path picks pictures by. The audio clock moves in steps (one per audio callback: about
 * 21 or 43 ms in Chrome, 26 ms on an iPhone) and holds between them, so pictures picked by it come in bursts: at field
 * rate (16.7 ms a picture) a step passes two pictures at one tick and the first is dropped, a fifth of them in Chrome.
 * This is the same line through the clock's steps that the element path follows (ClockLine), capped at 50 ms ahead of
 * the clock: it advances smoothly with the page's clock between steps, starts a new line at a seek back (and jumps with
 * a seek forward), and is the clock itself while paused, before the clock first moves, and once the clock has held
 * longer than a step while playing. A clock that moves smoothly already (the wall clock) passes through unchanged.
 * @internal
 */
export class PresentationClock {
  private readonly line = new ClockLine();

  /** The time to present at, from the clock `clockUs` read at `nowMs` (any millisecond clock) and whether playback runs. */
  at(clockUs: number, playing: boolean, nowMs: number): number {
    const line = this.line.at(clockUs, playing, nowMs);
    return line.running ? Math.min(Math.max(line.clockUs, clockUs), clockUs + MAX_LEAD_US) : clockUs;
  }
}
