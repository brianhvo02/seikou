import { describe, expect, it } from 'vitest';
import { windowsFor } from './disc-audio';

describe('windowsFor', () => {
  it('takes the whole of an episode under three minutes', () => {
    expect(windowsFor(150_000)).toEqual([{ fromMs: 0, toMs: 150_000 }]);
  });

  it('takes the whole of an episode under three and a half minutes', () => {
    expect(windowsFor(209_000)).toEqual([{ fromMs: 0, toMs: 209_000 }]);
  });

  it('spreads six minutes-long windows over a full episode', () => {
    const ws = windowsFor(1_440_000);
    expect(ws).toHaveLength(6);
    for (const w of ws) expect(w.toMs - w.fromMs).toBe(60_000);
    expect(ws[0].fromMs).toBe(90_000);
    expect(ws[5].toMs).toBe(1_350_000);
  });

  it('takes fewer and shorter windows of a short episode', () => {
    const ws = windowsFor(300_000);
    expect(ws.length).toBeLessThan(6);
    for (const w of ws) expect(w.toMs - w.fromMs).toBeGreaterThanOrEqual(30_000);
    expect(ws[0].fromMs).toBe(90_000);
    expect(ws[ws.length - 1].toMs).toBeLessThanOrEqual(210_000);
    for (const w of ws) expect(w.toMs - w.fromMs).toBeLessThanOrEqual(60_000);
  });
});
