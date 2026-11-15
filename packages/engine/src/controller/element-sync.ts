// SPDX-License-Identifier: LGPL-3.0-or-later

/**
 * What the page does after a presented frame: the playback rate to set, a
 * time to seek to (µs, or null), and the measured raw offset (µs, or null
 * when nothing was measured).
 *
 * @internal
 */
export interface SyncAction {
  rate: number;
  seekToUs: number | null;
  offsetUs: number | null;
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
 * Keeps a muted video element on the audio clock. The raw offset is
 * smoothed with an exponential moving average; the playback rate is
 * `1 - clamp(gain * smoothed + trim)`, where the trim integrates the
 * smoothed offset (gain and integral gain give critical damping), so a
 * steady drift of the element is learned and the offset settles to zero
 * rather than hunting. A raw offset beyond the seek threshold seeks to the
 * clock instead and clears the smoothing and the trim. Pure logic; all times
 * are µs on one timeline.
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
      this.smoothed = null;
      this.prevMediaUs = null;
      return { rate: 1, seekToUs: clockUs, offsetUs };
    }
    const dtS = this.frameSeconds(mediaTimeUs);
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

  /** Clears the smoothing, the trim and the settle state, as after a playlist change. @internal */
  reset(): void {
    this.settling = 0;
    this.trim = 0;
    this.smoothed = null;
    this.prevMediaUs = null;
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
