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
}

const SETTLE_FRAMES = 2;

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
  private settling = 0;

  /** Creates a controller; defaults are 10 ms, 100 ms, 0.005 and 0.1. @internal */
  constructor(opts: ElementSyncOptions = {}) {
    this.deadBandUs = opts.deadBandUs ?? 10_000;
    this.seekBeyondUs = opts.seekBeyondUs ?? 100_000;
    this.maxRateDelta = opts.maxRateDelta ?? 0.005;
    this.gain = opts.gain ?? 0.1;
  }

  /**
   * Decides what to do for a presented frame at `mediaTimeUs` when the clock
   * reads `clockUs`. A positive offset means the video is ahead. @internal
   */
  onFrame(mediaTimeUs: number, clockUs: number | null, playing: boolean): SyncAction {
    if (!playing || clockUs === null) return { rate: 1, seekToUs: null, offsetUs: null };
    const offsetUs = mediaTimeUs - clockUs;
    if (this.settling > 0) {
      this.settling--;
      return { rate: 1, seekToUs: null, offsetUs };
    }
    const abs = Math.abs(offsetUs);
    if (abs <= this.deadBandUs) return { rate: 1, seekToUs: null, offsetUs };
    if (abs > this.seekBeyondUs) {
      this.settling = SETTLE_FRAMES;
      return { rate: 1, seekToUs: clockUs, offsetUs };
    }
    const delta = Math.max(-this.maxRateDelta, Math.min(this.maxRateDelta, (offsetUs / 1e6) * this.gain));
    return { rate: 1 - delta, seekToUs: null, offsetUs };
  }

  /** Forgets the settle state, as after a playlist change. @internal */
  reset(): void {
    this.settling = 0;
  }
}
