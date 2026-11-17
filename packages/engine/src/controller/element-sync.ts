// SPDX-License-Identifier: LGPL-3.0-or-later

/**
 * What the page does after a presented frame: the playback rate to set, a
 * time to seek to (µs, or null), the measured raw offset (µs, or null
 * when nothing was measured), and whether a catch-up began.
 *
 * @internal
 */
export interface SyncAction {
  rate: number;
  seekToUs: number | null;
  offsetUs: number | null;
  /** True on the frame a catch-up begins (counted for telemetry); absent otherwise. */
  catchUp?: true;
}

/**
 * Settings for {@link ElementSync}. `seekBeyondUs` is the offset (µs) past
 * which the element is seeked; `maxRateDelta` bounds the rate correction and
 * the learned trim (a fraction of rate 1); `gain` is the proportional gain,
 * rate change per second of smoothed offset.
 *
 * @internal
 */
export interface ElementSyncOptions {
  seekBeyondUs?: number;
  maxRateDelta?: number;
  gain?: number;
}

const SETTLE_FRAMES = 2;
const SMOOTHING = 0.1;
const FIRST_FRAME_S = 1 / 24;
const MAX_FRAME_S = 0.125;
/**
 * Frames after a start, resume, seek or reset in which the start catch-up may fire (about a second at 24 fps, the
 * second the spec gives sync to settle after a seek).
 */
const START_WINDOW_FRAMES = 24;
/** The raw offsets a start catch-up averages: two frames, a 24 fps film's 3:2 cadence pair on a 60 Hz display. */
const START_CATCH_UP_FRAMES = 2;
/** The average offset beyond which a start catch-up fires. */
const START_CATCH_UP_BEYOND_US = 10_000;
/**
 * The raw offsets a steady-state catch-up averages, and the average it needs: well above the steady band (the
 * measurement sits within about ±10 ms of the clock, quantized by the display's refresh), so the loop alone corrects
 * at most 0.5% in steady state, and only a slip (a decoder hiccup) is caught up.
 */
const STEADY_CATCH_UP_FRAMES = 8;
const STEADY_CATCH_UP_BEYOND_US = 20_000;
/** How much media time a catch-up takes to remove its offset: its rate is set by the offset, within the bound below. */
const CATCH_UP_MEDIA_S = 0.12;
/** The most a catch-up moves the rate from 1 (an offset of 30 ms or more); the least is about 8%, for an offset just past 10 ms. */
const CATCH_UP_MAX_DELTA = 0.25;

/**
 * Keeps a muted video element on the audio clock. The raw offset is
 * smoothed with an exponential moving average; the playback rate is
 * `1 - clamp(gain * smoothed + trim)`, where the trim integrates the
 * smoothed offset (gain and integral gain give critical damping), so a
 * steady drift of the element is learned and the offset settles to zero
 * rather than hunting. A raw offset beyond the seek threshold seeks to the
 * clock instead and clears the smoothing and the trim.
 *
 * The loop corrects at most half a percent, 5 ms a second, which is right
 * for drift but too slow for the step an element starts with: by the time
 * the page sees the clock move it is already a step in, and `play()` takes
 * a display frame or two to start, so every start, resume and seek leaves
 * it 10–60 ms behind. So a start ({@link restart}) begins with a catch-up
 * planned from the lag the page expects, the start's first measured frame
 * re-plans it (or drops it within 10 ms), and for the rest of the second
 * after a start, resume, seek or reset, two raw offsets averaging beyond
 * 10 ms (once a catch-up has ended, measured afresh) run another, since an
 * element can keep slipping while it starts: it plays fast or slow, by what
 * removes the offset in about 0.12 s of media (8% to 25%), for just the media time that
 * removes it (computed from the rate, not measured, so a late measurement
 * cannot make it overshoot), then the loop takes over again with fresh
 * smoothing and the trim it had. In steady state only a slip (eight raw
 * offsets averaging beyond 20 ms) is caught up; otherwise the loop's half
 * percent is all. Pure logic; all times are µs on one timeline.
 *
 * @internal
 */
export class ElementSync {
  private readonly seekBeyondUs: number;
  private readonly maxRateDelta: number;
  private readonly gain: number;
  private readonly integralGain: number;
  private settling = 0;
  private trim = 0;
  private smoothed: number | null = null;
  private prevMediaUs: number | null = null;
  /** The last raw offsets since the loop (re)started, for the catch-up decision. */
  private recent: number[] = [];
  /** While catching up: the rate played and the offset still to remove (µs, signed as the offset). */
  private catchUp: { readonly rate: number; remainingUs: number } | null = null;
  /** Frames left in which a start catch-up may fire; 0 in steady state. */
  private startFrames = START_WINDOW_FRAMES;
  /** Whether the next measured frame is a start's first, which plans (or re-plans) its catch-up from what it measures. */
  private firstOfStart = true;

  /**
   * Creates a controller. Defaults: seek beyond 100 000 µs, rate delta
   * limit 0.005, proportional gain 0.25 per second of offset (the integral
   * gain is a quarter of its square). @internal
   */
  constructor(opts: ElementSyncOptions = {}) {
    this.seekBeyondUs = opts.seekBeyondUs ?? 100_000;
    this.maxRateDelta = opts.maxRateDelta ?? 0.005;
    this.gain = opts.gain ?? 0.25;
    this.integralGain = (this.gain * this.gain) / 4;
  }

  /**
   * Decides what to do for a presented frame at `mediaTimeUs` when the clock
   * reads `clockUs`. A positive offset means the video is ahead. Not playing
   * or no clock: rate 1, no offset, state kept. @internal
   */
  onFrame(mediaTimeUs: number, clockUs: number | null, playing: boolean): SyncAction {
    if (!playing || clockUs === null) return { rate: 1, seekToUs: null, offsetUs: null };
    const offsetUs = mediaTimeUs - clockUs;
    if (this.settling > 0) {
      this.settling--;
      return { rate: 1, seekToUs: null, offsetUs };
    }
    if (Math.abs(offsetUs) > this.seekBeyondUs) {
      this.settling = SETTLE_FRAMES;
      this.trim = 0;
      this.restartLoop();
      this.startFrames = START_WINDOW_FRAMES; // the seek is a start of its own
      this.firstOfStart = true;
      this.prevMediaUs = null;
      return { rate: 1, seekToUs: clockUs, offsetUs };
    }
    const dtS = this.frameSeconds(mediaTimeUs);
    if (this.firstOfStart && this.startFrames > 0) {
      // A start's first measured frame: what play()'s start-up actually left. A catch-up planned at the start from the
      // expected lag is re-planned from it; none is needed when it is within the start threshold.
      this.firstOfStart = false;
      this.startFrames--;
      const planned = this.catchUp !== null;
      if (Math.abs(offsetUs) > START_CATCH_UP_BEYOND_US) {
        const rate = this.planCatchUp(offsetUs);
        return planned ? { rate, seekToUs: null, offsetUs } : { rate, seekToUs: null, offsetUs, catchUp: true };
      }
      if (planned) {
        this.restartLoop();
        return { rate: 1 - this.trim, seekToUs: null, offsetUs };
      }
    }
    const catchUp = this.catchUp;
    if (catchUp) {
      // the frame advanced dtS of media in dtS / rate of clock time
      catchUp.remainingUs += dtS * 1e6 * (1 - 1 / catchUp.rate);
      if (Math.sign(catchUp.remainingUs) === Math.sign(catchUp.rate - 1) || catchUp.remainingUs === 0) {
        this.restartLoop();
        return { rate: 1 - this.trim, seekToUs: null, offsetUs };
      }
      return { rate: catchUp.rate, seekToUs: null, offsetUs };
    }
    this.recent.push(offsetUs);
    if (this.recent.length > STEADY_CATCH_UP_FRAMES) this.recent.shift();
    const starting = this.startFrames > 0;
    if (starting) this.startFrames--;
    const n = starting ? START_CATCH_UP_FRAMES : STEADY_CATCH_UP_FRAMES;
    if (this.recent.length >= n) {
      let sum = 0;
      for (let i = this.recent.length - n; i < this.recent.length; i++) sum += this.recent[i]!;
      const mean = sum / n;
      if (Math.abs(mean) > (starting ? START_CATCH_UP_BEYOND_US : STEADY_CATCH_UP_BEYOND_US)) {
        return { rate: this.planCatchUp(mean), seekToUs: null, offsetUs, catchUp: true };
      }
    }
    this.smoothed =
      this.smoothed === null ? offsetUs : this.smoothed + SMOOTHING * (offsetUs - this.smoothed);
    const errS = this.smoothed / 1e6;
    const max = this.maxRateDelta;
    const u = this.gain * errS + this.trim;
    const rate = 1 - clamp(u, max);
    const saturated = Math.abs(u) >= max && Math.sign(u) === Math.sign(errS);
    if (!saturated) this.trim = clamp(this.trim + this.integralGain * errS * dtS, max);
    return { rate, seekToUs: null, offsetUs };
  }

  /** Clears the smoothing, the trim, a catch-up and the settle state, as after a playlist change; a start follows. @internal */
  reset(): void {
    this.settling = 0;
    this.trim = 0;
    this.restartLoop();
    this.startFrames = START_WINDOW_FRAMES;
    this.firstOfStart = true;
    this.prevMediaUs = null;
  }

  /**
   * The element starts or resumes playing, `lagUs` behind the clock as far as the page can tell (how far the clock is
   * past the element's position, plus play()'s expected start-up): the rate to start at, a catch-up planned from that
   * lag when it is beyond the start threshold, which the start's first measured frame re-plans. The next second's
   * frames may run a start catch-up. Keeps the trim (the element's own drift). @internal
   */
  restart(lagUs = 0): { rate: number; catchUp: boolean } {
    this.restartLoop();
    this.startFrames = START_WINDOW_FRAMES;
    this.firstOfStart = true;
    this.prevMediaUs = null;
    if (lagUs <= START_CATCH_UP_BEYOND_US) return { rate: 1 - this.trim, catchUp: false };
    return { rate: this.planCatchUp(-lagUs), catchUp: true }; // the first measured frame re-plans it
  }

  /** Starts a catch-up that removes `offsetUs` (positive: the element is ahead); its rate. */
  private planCatchUp(offsetUs: number): number {
    const delta = Math.min(CATCH_UP_MAX_DELTA, Math.abs(offsetUs) / 1e6 / CATCH_UP_MEDIA_S);
    const rate = 1 - Math.sign(offsetUs) * delta;
    this.restartLoop();
    this.catchUp = { rate, remainingUs: offsetUs };
    return rate;
  }

  /** Forgets the smoothing, the offsets averaged for a catch-up and any catch-up under way; keeps the trim. */
  private restartLoop(): void {
    this.smoothed = null;
    this.recent = [];
    this.catchUp = null;
  }

  private frameSeconds(mediaTimeUs: number): number {
    const prev = this.prevMediaUs;
    this.prevMediaUs = mediaTimeUs;
    if (prev === null) return FIRST_FRAME_S;
    const dt = (mediaTimeUs - prev) / 1e6;
    return dt > 0 ? Math.min(dt, MAX_FRAME_S) : 0;
  }
}

function clamp(v: number, max: number): number {
  return Math.max(-max, Math.min(max, v));
}
