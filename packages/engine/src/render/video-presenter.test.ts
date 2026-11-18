import { describe, expect, it } from 'vitest';
import { VideoPresenter, type PresentableFrame } from './video-presenter';

interface TestFrame extends PresentableFrame {
  closed: boolean;
  closes: number;
}

function frame(timestamp: number): TestFrame {
  return { timestamp, closed: false, closes: 0, close() { this.closed = true; this.closes++; } };
}

describe('VideoPresenter', () => {
  it('drops frames older than the one on screen instead of stepping backwards', () => {
    const p = new VideoPresenter<TestFrame>();
    const [a, late, b] = [frame(40_000), frame(20_000), frame(80_000)];
    p.push(a);
    expect(p.select(50_000)).toBe(a);
    p.push(late);
    p.push(b);
    expect(p.select(60_000)).toBeNull();
    expect(late.closed).toBe(true);
    expect(p.select(80_000)).toBe(b);
  });

  it('a frame due for under 5 ms does not drop the unshown one before it: that one shows first', () => {
    const p = new VideoPresenter<TestFrame>();
    const [a, b, c] = [frame(0), frame(16_683), frame(33_367)];
    for (const f of [a, b, c]) p.push(f);
    expect(p.select(0)).toBe(a);
    // b and c are both due, c for 1 ms only: b shows now and c at the next tick, nothing dropped
    expect(p.select(34_367)).toBe(b);
    expect(p.select(51_000)).toBe(c);
    expect(p.dropped).toBe(0);
    // once the newer has been due for 5 ms the older one is late, and dropped as before
    const q = new VideoPresenter<TestFrame>();
    const [d, e, f] = [frame(0), frame(16_683), frame(33_367)];
    for (const x of [d, e, f]) q.push(x);
    q.select(0);
    expect(q.select(38_367)).toBe(f);
    expect(q.dropped).toBe(1);
    // dropLate keeps the frame select would show
    const r = new VideoPresenter<TestFrame>();
    const [g, h2] = [frame(16_683), frame(33_367)];
    r.push(g);
    r.push(h2);
    r.dropLate(34_367);
    expect(r.size).toBe(2);
  });

  it('shows the newest due frame and closes skipped ones', () => {
    const p = new VideoPresenter<TestFrame>();
    const [a, b, c] = [frame(0), frame(40_000), frame(80_000)];
    p.push(a);
    p.push(b);
    p.push(c);
    expect(p.select(50_000)).toBe(b);
    expect(a.closed).toBe(true);
    expect(p.dropped).toBe(1);
    expect(p.current).toBe(b);
    expect(p.size).toBe(1);
    expect(p.select(60_000)).toBeNull();
    expect(p.select(80_000)).toBe(c);
    expect(b.closed).toBe(true);
    expect(p.presented).toBe(2);
  });

  it('previews the first frame after clear even if it is not due yet, then holds', () => {
    const p = new VideoPresenter<TestFrame>();
    const [a, b] = [frame(1_000_000), frame(1_040_000)];
    p.push(a);
    p.push(b);
    expect(p.select(900_000)).toBe(a);
    expect(p.select(950_000)).toBeNull();
    expect(p.current).toBe(a);
  });

  it('keeps frames sorted when pushed out of order', () => {
    const p = new VideoPresenter<TestFrame>();
    p.push(frame(80_000));
    p.push(frame(40_000));
    expect(p.select(40_000)?.timestamp).toBe(40_000);
  });

  it('dropLate closes all but the newest due frame', () => {
    const p = new VideoPresenter<TestFrame>();
    const frames = [frame(0), frame(40_000), frame(80_000), frame(120_000)];
    for (const f of frames) p.push(f);
    p.dropLate(90_000);
    expect(frames.map((f) => f.closed)).toEqual([true, true, false, false]);
    expect(p.size).toBe(2);
    expect(p.dropped).toBe(2);
  });

  it('clear closes queued and current frames', () => {
    const p = new VideoPresenter<TestFrame>();
    const [a, b] = [frame(0), frame(40_000)];
    p.push(a);
    p.push(b);
    p.select(0);
    p.clear();
    expect(a.closed && b.closed).toBe(true);
    expect(p.current).toBeNull();
    expect(p.size).toBe(0);
  });

  it('closes every frame exactly once across select, dropLate, stale drops and clear', () => {
    const p = new VideoPresenter<TestFrame>();
    const frames = [0, 40_000, 80_000, 120_000, 160_000, 200_000].map(frame);
    for (const f of frames.slice(0, 4)) p.push(f);
    p.select(50_000); // shows 40k, drops 0
    p.dropLate(130_000); // drops 80k, keeps 120k queued
    p.push(frame(10_000)); // stale (older than shown)
    p.push(frames[4]);
    p.select(170_000); // drops 120k + stale, shows 160k
    p.push(frames[5]);
    p.clear(); // closes 160k (shown) and 200k (queued)
    expect(frames.map((f) => f.closes)).toEqual([1, 1, 1, 1, 1, 1]);
  });
});
