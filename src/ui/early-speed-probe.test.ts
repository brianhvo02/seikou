// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { EARLY_PROBE_DELAY_MS, scheduleEarlySpeedProbe, type EarlyProbeEnv } from './early-speed-probe';

function fakeEnv(hidden = false) {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const idles = new Map<number, () => void>();
  let next = 0;
  let runs = 0;
  const env: EarlyProbeEnv = {
    setTimer: (fn, ms) => (timers.set(++next, { fn, ms }), next),
    clearTimer: (h) => void timers.delete(h as number),
    whenIdle: (fn) => {
      const id = ++next;
      idles.set(id, fn);
      return () => void idles.delete(id);
    },
    hidden: () => hidden,
    run: () => void runs++,
  };
  return {
    env,
    fireTimers: () => [...timers.entries()].forEach(([id, t]) => (timers.delete(id), t.fn())),
    fireIdle: () => [...idles.entries()].forEach(([id, fn]) => (idles.delete(id), fn())),
    timers,
    runs: () => runs,
  };
}

describe('scheduleEarlySpeedProbe', () => {
  it('measures once, after the delay and when the browser is idle', () => {
    const f = fakeEnv();
    scheduleEarlySpeedProbe(f.env);
    expect([...f.timers.values()].map((t) => t.ms)).toEqual([EARLY_PROBE_DELAY_MS]);
    f.fireTimers();
    expect(f.runs()).toBe(0);
    f.fireIdle();
    expect(f.runs()).toBe(1);
  });

  it('measures nothing once cancelled, before the delay or while waiting for idle', () => {
    const before = fakeEnv();
    scheduleEarlySpeedProbe(before.env)();
    before.fireTimers();
    before.fireIdle();
    expect(before.runs()).toBe(0);
    const waiting = fakeEnv();
    const cancel = scheduleEarlySpeedProbe(waiting.env);
    waiting.fireTimers();
    cancel();
    waiting.fireIdle();
    expect(waiting.runs()).toBe(0);
  });

  it('measures nothing on a hidden page', () => {
    const f = fakeEnv(true);
    scheduleEarlySpeedProbe(f.env);
    f.fireTimers();
    f.fireIdle();
    expect(f.runs()).toBe(0);
  });
});
