// SPDX-License-Identifier: LGPL-3.0-or-later

/**
 * What the page does after a presented frame: the playback rate to set, a
 * time to seek to (µs, or null), and the measured offset (µs, or null when
 * nothing was measured).
 *
 * @internal
 */
export interface SyncAction {
  rate: number;
  seekToUs: number | null;
  offsetUs: number | null;
}

/** Settings for {@link ElementSync}. @internal */
export interface ElementSyncOptions {
  deadBandUs?: number;
  seekBeyondUs?: number;
  maxRateDelta?: number;
  gain?: number;
  integralGain?: number;
}

const SETTLE_FRAMES = 2;
const INTEGRAL_GAIN = 0.1;
const FALLBACK_FRAME_S = 1 / 24;

/**
 * Keeps a muted video element on the audio clock: rate 1 inside a dead band,
 * a small rate nudge up to a threshold, a seek beyond it. Pure logic; all
 * times are µs on one timeline.
 *
 * @internal
 */
export class ElementSync {
  private readonly deadBandUs: number;
  private readonly seekBeyondUs: number;
  private readonly maxRateDelta: number;
  private readonly gain: number;
  private readonly integralGain: number;
  private settling = 0;
  private trim = 0;
  private prevMediaUs: number | null = null;

  /** Creates a controller; defaults are 10 ms, 100 ms, 0.005 and 0.1. @internal */
  constructor(opts: ElementSyncOptions = {}) {
    this.deadBandUs = opts.deadBandUs ?? 10_000;
    this.seekBeyondUs = opts.seekBeyondUs ?? 100_000;
    this.maxRateDelta = opts.maxRateDelta ?? 0.005;
    this.gain = opts.gain ?? 0.1;
    this.integralGain = opts.integralGain ?? INTEGRAL_GAIN;
  }

  /**
   * Decides what to do for a presented frame at `mediaTimeUs` when the clock
   * reads `clockUs`. A positive offset means the video is ahead. @internal
   */
  onFrame(mediaTimeUs: number, clockUs: number | null, playing: boolean): SyncAction {
    if (!playing || clockUs === null) return { rate: 1, seekToUs: null, offsetUs: null };
    const offsetUs = mediaTimeUs - clockUs;
    const dtRaw = this.prevMediaUs === null ? 0 : (mediaTimeUs - this.prevMediaUs) / 1e6;
    this.prevMediaUs = mediaTimeUs;
    const dt = dtRaw > 0 && dtRaw < 0.5 ? dtRaw : FALLBACK_FRAME_S;
    if (this.settling > 0) {
      this.settling--;
      return { rate: 1, seekToUs: null, offsetUs };
    }
    const abs = Math.abs(offsetUs);
    if (abs > this.seekBeyondUs) {
      this.settling = SETTLE_FRAMES;
      this.trim = 0;
      return { rate: 1, seekToUs: clockUs, offsetUs };
    }
    const max = this.maxRateDelta;
    const p = abs <= this.deadBandUs ? 0 : -(offsetUs / 1e6) * this.gain;
    const rate = 1 + clamp(this.trim + p, max);
    const u = this.trim + p;
    const saturated = Math.abs(u) >= max && Math.sign(u) === Math.sign(-offsetUs);
    if (!saturated) {
      this.trim = clamp(this.trim - (offsetUs / 1e6) * this.integralGain * dt, max);
    }
    return { rate, seekToUs: null, offsetUs };
  }

  /** Forgets the settle state, as after a playlist change. @internal */
  reset(): void {
    this.settling = 0;
    this.trim = 0;
    this.prevMediaUs = null;
  }
}

function clamp(v: number, max: number): number {
  return Math.max(-max, Math.min(max, v));
}
