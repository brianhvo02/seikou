// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Deinterlacer, PACING_LATE_SHARE, PACING_WINDOW } from './deinterlacer';
import { PacingMonitor, type PacingObservation, type PacingVerdict } from './pacing-monitor';

/** The judge under test: a monitor's `observe`, or the first rule (late past half a picture, every drop late). */
type Judge = (o: PacingObservation) => PacingVerdict;
const OLD_RULE: Judge = (o) => ((o.shownLateUs ?? 0) > o.durationUs / 2 || o.dropped > 0 ? 'late' : 'ok');
const judgeUnderTest = (): Judge => {
  const m = new PacingMonitor();
  return (o) => m.observe(o);
};

interface Run {
  /** Display tick interval in ms. */
  tickMs: number;
  /** Picture duration in microseconds (59.94 fields a second by default). */
  durationUs?: number;
  seconds: number;
  /** Jitter of each tick in ms (uniform, +-). */
  jitterMs?: number;
  /** Every n-th tick is delayed by this many extra tick intervals (a stall). */
  stallEvery?: number;
  stallTicks?: number;
  /** Extra events: a gap with a burst of drops at this tick index. */
  burstAt?: { tick: number; gapMs: number; dropped: number };
  /** Once the cheap path is on, ticks come at this interval instead (the cheap path's own pace). */
  cheapTickMs?: number;
  /** Once the cheap path is on, the stall pattern stops (the cheap path let the device keep up). */
  cheapHeals?: boolean;
}

/** Plays pictures against display ticks as the presenter does and returns the share of late verdicts and whether the deinterlacer fell back. */
function simulate(judge: Judge, run: Run): { fellBack: boolean; frameRate: boolean; frameRateAtMs: number | null; lateTicks: number; counted: number } {
  const d = run.durationUs ?? 1_001_000 / 60;
  const deint = fakeWindow();
  let seed = 12345;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let nowMs = 0;
  let lastShown = -1; // index of the last picture shown or dropped
  let ticks = 0;
  let lateTicks = 0;
  let counted = 0;
  let frameRateAtMs: number | null = null;
  for (let i = 0; nowMs < run.seconds * 1000; i++) {
    const cheap = deint.fallback();
    const tickMs = cheap && run.cheapTickMs !== undefined ? run.cheapTickMs : run.tickMs;
    let gapMs = tickMs + (run.jitterMs ? (rnd() * 2 - 1) * run.jitterMs : 0);
    if (run.stallEvery && !(cheap && run.cheapHeals) && i % run.stallEvery === run.stallEvery - 1) gapMs += tickMs * (run.stallTicks ?? 2);
    let dropped = 0;
    if (run.burstAt && i === run.burstAt.tick) {
      gapMs = run.burstAt.gapMs;
      dropped = run.burstAt.dropped;
    }
    nowMs += gapMs;
    const newest = Math.floor((nowMs * 1000) / d);
    let shownLate: number | null = null;
    if (newest > lastShown) {
      dropped += newest - lastShown - 1;
      lastShown = newest;
      shownLate = nowMs * 1000 - newest * d;
    }
    ticks++;
    const verdict = judge({ nowMs, playing: true, shownLateUs: shownLate, durationUs: d, dropped });
    if (verdict === 'restart') deint.restart();
    else if (verdict !== 'skip') {
      counted++;
      if (verdict === 'late') lateTicks++;
      deint.note(verdict === 'late');
      if (frameRateAtMs === null && deint.frameRate()) frameRateAtMs = nowMs;
    }
  }
  expect(ticks).toBeGreaterThan(0);
  return { fellBack: deint.fallback(), frameRate: deint.frameRate(), frameRateAtMs, lateTicks, counted };
}

/** The deinterlacer's own window, through its public methods. */
function fakeWindow(): { note(late: boolean): void; restart(): void; fallback(): boolean; frameRate(): boolean } {
  const backend = {
    upload() {},
    measure: () => new Promise<never>(() => {}),
    render: () => ({}) as OffscreenCanvas,
    gpuMs: null,
    dispose() {},
  };
  const d = new Deinterlacer({ backend, ringSize: 4, frameDurationUs: 33_366, onPictures: () => {} });
  return { note: (l) => d.notePacing(l), restart: () => d.restartPacing(), fallback: () => d.stats.fallback, frameRate: () => d.stats.frameRate };
}

describe('PacingMonitor against the deinterlacer\'s window', () => {
  const healthy: Array<[string, Run]> = [
    ['a 60 Hz display with 59.94 pictures a second and jitter', { tickMs: 1000 / 60, seconds: 60, jitterMs: 1.5 }],
    ['a 60 Hz display, no jitter', { tickMs: 1000 / 60, seconds: 60 }],
    ['a 120 Hz display with jitter', { tickMs: 1000 / 120, seconds: 60, jitterMs: 1 }],
    ['a 50 Hz display with 59.94 pictures a second', { tickMs: 20, seconds: 60, jitterMs: 1 }],
    ['one stall in a minute', { tickMs: 1000 / 60, seconds: 60, burstAt: { tick: 900, gapMs: 200, dropped: 12 } }],
  ];
  for (const [name, run] of healthy) {
    it(`never falls back on ${name}`, () => {
      for (const judge of [OLD_RULE, judgeUnderTest()]) {
        const r = simulate(judge, run);
        if (judge !== OLD_RULE) expect(r).toMatchObject({ fellBack: false, frameRate: false });
        else if (name.startsWith('a 60 Hz display with')) expect(r.fellBack).toBe(true); // the first rule's flaw
      }
    });
  }

  it('ignores a burst of 30 drops in one tick after a visibility change', () => {
    const run: Run = { tickMs: 1000 / 60, seconds: 20, burstAt: { tick: 300, gapMs: 5000, dropped: 30 } };
    expect(simulate(OLD_RULE, run).fellBack).toBe(true);
    expect(simulate(judgeUnderTest(), run).fellBack).toBe(false);
  });

  it('falls back within a window when 15% of the pictures are missed in a sustained stall', () => {
    const run: Run = { tickMs: 1000 / 60, seconds: 6, stallEvery: 7, stallTicks: 2 };
    const r = simulate(judgeUnderTest(), run);
    expect(r.lateTicks / r.counted).toBeGreaterThanOrEqual(PACING_LATE_SHARE);
    expect(r.fellBack).toBe(true);
  });

  it('falls back on a device whose every tick is slow, whatever the slowness', () => {
    for (const [tickMs, seconds] of [[50, 20], [100, 30], [300, 60]] as const) {
      const r = simulate(judgeUnderTest(), { tickMs, seconds });
      expect(r.fellBack, `${tickMs} ms ticks`).toBe(true);
    }
  });

  it('never falls back on a 30 Hz display (Low Power Mode) showing 59.94 pictures a second', () => {
    expect(simulate(judgeUnderTest(), { tickMs: 1000 / 30, seconds: 60, jitterMs: 1.5 }).fellBack).toBe(false);
  });

  it('steps down to frame rate on a device whose ticks stay slow with the cheap path on, a few seconds after it', () => {
    for (const [tickMs, cheapTickMs] of [[50, 50], [100, 50]] as const) {
      const r = simulate(judgeUnderTest(), { tickMs, cheapTickMs, seconds: 60 });
      expect(r, `${tickMs} ms ticks, then ${cheapTickMs}`).toMatchObject({ fellBack: true, frameRate: true });
      expect(r.frameRateAtMs!).toBeLessThan(40_000);
    }
  });

  it('steps down on a sustained stall the cheap path doesn\'t cure', () => {
    expect(simulate(judgeUnderTest(), { tickMs: 1000 / 60, seconds: 30, stallEvery: 7, stallTicks: 2 })).toMatchObject({ fellBack: true, frameRate: true });
  });

  it('stays at field rate on a device the cheap path lets keep up', () => {
    expect(simulate(judgeUnderTest(), { tickMs: 1000 / 60, seconds: 120, stallEvery: 7, stallTicks: 2, cheapHeals: true, jitterMs: 1.5 })).toMatchObject({
      fellBack: true,
      frameRate: false,
    });
    expect(simulate(judgeUnderTest(), { tickMs: 50, cheapTickMs: 1000 / 60, seconds: 120, jitterMs: 1 })).toMatchObject({ fellBack: true, frameRate: false });
  });

  it('a stall in a minute after the cheap path is on never steps down (one late burst is not a window)', () => {
    const r = simulate(judgeUnderTest(), { tickMs: 50, cheapTickMs: 1000 / 60, seconds: 60, burstAt: { tick: 2000, gapMs: 200, dropped: 12 } });
    expect(r).toMatchObject({ fellBack: true, frameRate: false });
  });

  it('counts at most one late per tick, and nothing while settling after a resume', () => {
    const m = new PacingMonitor();
    let now = 0;
    const tick = (o: Partial<PacingObservation> = {}): PacingVerdict => {
      now += 16.7;
      return m.observe({ nowMs: now, playing: true, shownLateUs: 0, durationUs: 16_683, dropped: 0, ...o });
    };
    expect(tick()).toBe('restart');
    for (let i = 0; i < 80; i++) expect(tick()).toBe(i < 59 ? 'skip' : 'ok');
    expect(tick({ dropped: 40 })).toBe('late');
    m.settle();
    expect(tick({ dropped: 40 })).toBe('restart');
    expect(tick({ dropped: 40 })).toBe('skip');
    expect(PACING_WINDOW).toBe(120);
  });
});
