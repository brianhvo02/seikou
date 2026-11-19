// SPDX-License-Identifier: LGPL-3.0-or-later

/** How long a paired, idle landing screen waits before measuring: the app's own start is over by then. */
export const EARLY_PROBE_DELAY_MS = 5000;

/** What scheduleEarlySpeedProbe reads and runs. */
export interface EarlyProbeEnv {
  /** Starts a one-shot timer; returns a handle for `clearTimer`. */
  setTimer(fn: () => void, ms: number): unknown;
  /** Cancels a timer `setTimer` started. */
  clearTimer(handle: unknown): void;
  /** Runs `fn` when the browser is idle (requestIdleCallback), or at once where there is no such thing; returns a cancel. */
  whenIdle(fn: () => void): () => void;
  /** The page is hidden: a hidden page's timers and threads are throttled, so nothing is measured. */
  hidden(): boolean;
  /** Measures (wasmVideoPlayability, which answers from the stored speed when there is one and measures nothing then). */
  run(): void;
}

/**
 * The MPEG-2 and VC-1 decode speed measured ahead of the first NAS pre-flight, which otherwise waits for it: call while
 * a NAS is paired and no disc is open. After EARLY_PROBE_DELAY_MS, when the browser is idle and the page visible, it
 * runs once. Returns a cancel, for when a disc opens or the pairing goes first (the engine also discards a measurement
 * a disc open overlaps).
 */
export function scheduleEarlySpeedProbe(env: EarlyProbeEnv): () => void {
  let cancelIdle: (() => void) | null = null;
  const timer = env.setTimer(() => {
    cancelIdle = env.whenIdle(() => {
      cancelIdle = null;
      let hidden = false;
      try {
        hidden = env.hidden();
      } catch {
        // unreadable: measure
      }
      if (!hidden) env.run();
    });
  }, EARLY_PROBE_DELAY_MS);
  return () => {
    env.clearTimer(timer);
    cancelIdle?.();
  };
}

/** The browser's EarlyProbeEnv around `run`. */
export function browserEarlyProbeEnv(run: () => void): EarlyProbeEnv {
  return {
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    whenIdle: (fn) => {
      if (typeof window.requestIdleCallback === 'function') {
        const id = window.requestIdleCallback(fn, { timeout: 10_000 });
        return () => window.cancelIdleCallback(id);
      }
      const id = window.setTimeout(fn, 0);
      return () => window.clearTimeout(id);
    },
    hidden: () => document.visibilityState === 'hidden',
    run,
  };
}
