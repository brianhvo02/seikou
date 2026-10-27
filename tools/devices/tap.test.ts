// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { armExpr, centreOf, DISARM_EXPR, LANDING_EXPR, layoutExpr, sameLayout, tapVerdict, waitSettled, type LayoutReading, type TapLanding } from './tap';

const reading = (o: Partial<LayoutReading> = {}): LayoutReading => ({
  scrollX: 0, scrollY: 0, innerWidth: 390, innerHeight: 664,
  vv: { offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, width: 390, height: 664, scale: 1 },
  rect: { x: 100, y: 500, width: 60, height: 40 }, inView: true, ...o,
});

/** A clock that only moves when the code under test sleeps. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, slept };
}

describe('sameLayout', () => {
  it('agrees within half a pixel and tells a scroll, a resize, a zoom or a moved box apart', () => {
    expect(sameLayout(reading(), reading({ scrollY: 0.4 }))).toBe(true);
    expect(sameLayout(reading(), reading({ scrollY: 3 }))).toBe(false);
    expect(sameLayout(reading(), reading({ innerHeight: 740 }))).toBe(false); // Safari's toolbar collapsed
    expect(sameLayout(reading(), reading({ vv: { ...reading().vv!, offsetTop: 12 } }))).toBe(false);
    expect(sameLayout(reading(), reading({ vv: { ...reading().vv!, scale: 1.2 } }))).toBe(false);
    expect(sameLayout(reading(), reading({ vv: null }))).toBe(false);
    expect(sameLayout(reading(), reading({ rect: { x: 100, y: 480, width: 60, height: 40 } }))).toBe(false);
    expect(sameLayout(reading(), reading({ rect: null }))).toBe(false);
    expect(sameLayout(reading(), reading({ inView: false }))).toBe(false);
  });
});

describe('waitSettled', () => {
  it('returns once three reads in a row agree', async () => {
    const c = fakeClock();
    const seq = [0, 40, 80, 100, 100, 100, 100];
    let i = 0;
    const s = await waitSettled(async () => seq[Math.min(i++, seq.length - 1)]!, (a, b) => a === b, { ...c, intervalMs: 50 });
    expect(s).toMatchObject({ value: 100, settled: true, reads: 6 });
    expect(c.slept).toEqual([50, 50, 50, 50, 50]);
  });

  it('keeps waiting through a slow drift and starts the count again after a jump', async () => {
    const c = fakeClock();
    const seq = [5, 5, 9, 9, 9];
    let i = 0;
    const s = await waitSettled(async () => seq[Math.min(i++, seq.length - 1)]!, (a, b) => a === b, c);
    expect(s).toMatchObject({ value: 9, settled: true, reads: 5 });
  });

  it('gives up at the timeout with the last read, marked unsettled', async () => {
    const c = fakeClock();
    let n = 0;
    const s = await waitSettled(async () => n++, (a, b) => a === b, { ...c, intervalMs: 100, timeoutMs: 450 });
    expect(s.settled).toBe(false);
    expect(s.value).toBe(5);
    expect(s.waitedMs).toBe(500);
  });

  it('with one stable read wanted, takes the first', async () => {
    const c = fakeClock();
    const s = await waitSettled(async () => 7, () => false, { ...c, stableReads: 1 });
    expect(s).toMatchObject({ value: 7, settled: true, reads: 1, waitedMs: 0 });
  });
});

describe('tapVerdict', () => {
  const on = (o: Partial<TapLanding>): TapLanding => ({ type: 'pointerdown', x: 130, y: 520, target: 'remote-ok', hit: true, ...o });

  it('an element tap lands when the touch reached a match, wherever in it', () => {
    expect(tapVerdict({ x: 130, y: 520, selector: '[data-testid=remote-ok]' }, on({ x: 110 })).landed).toBe(true);
    const miss = tapVerdict({ x: 130, y: 520, selector: '[data-testid=remote-ok]' }, on({ y: 470, target: 'video-canvas', hit: false }));
    expect(miss.landed).toBe(false);
    expect(miss.note).toMatch(/pointerdown at \(130, 470\) on video-canvas, not on \[data-testid=remote-ok\] \(aimed at \(130, 520\)\)/);
  });

  it('a point tap lands within 8 px of its aim', () => {
    expect(tapVerdict({ x: 130, y: 520, selector: null }, on({ x: 135, y: 524, hit: null })).landed).toBe(true);
    expect(tapVerdict({ x: 130, y: 520, selector: null }, on({ y: 540, hit: null })).landed).toBe(false);
    expect(tapVerdict({ x: 130, y: 520, selector: null }, on({ x: Number.NaN, hit: null })).landed).toBe(false);
  });

  it('no event is a miss', () => {
    expect(tapVerdict({ x: 1, y: 2, selector: null }, null)).toEqual({ landed: false, note: 'no touch reached the page (aimed at (1, 2))' });
  });
});

describe('centreOf', () => {
  it('gives the box centre, or null with no box', () => {
    expect(centreOf(reading())).toEqual({ x: 130, y: 520 });
    expect(centreOf(reading({ rect: null }))).toBeNull();
  });
});

// the page expressions, run in jsdom (no layout: boxes are empty, so element targets read as not visible)
const run = <T>(expr: string): T => (0, eval)(expr) as T;

describe('page expressions', () => {
  afterEach(() => {
    run(DISARM_EXPR);
    document.body.innerHTML = '';
  });

  it('records the first pointerdown, on a match or not, and disarms after the read', () => {
    document.body.innerHTML = '<div data-testid="remote-pad"><button data-testid="remote-ok"><span>OK</span></button></div><canvas data-testid="video-canvas"></canvas>';
    run(armExpr('[data-testid=remote-ok]'));
    expect(run(LANDING_EXPR)).toBeNull();
    document.querySelector('span')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 12, clientY: 34 }));
    document.querySelector('canvas')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 1, clientY: 1 }));
    expect(run<TapLanding>(LANDING_EXPR)).toEqual({ type: 'pointerdown', x: 12, y: 34, target: 'span', hit: true });
    expect((window as unknown as { __tapDisarm: unknown }).__tapDisarm).toBeNull();
  });

  it('a touch on something else is recorded as a miss of the selector', () => {
    document.body.innerHTML = '<button data-testid="remote-ok">OK</button><canvas data-testid="video-canvas"></canvas>';
    run(armExpr('[data-testid=remote-ok]'));
    document.querySelector('canvas')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 6 }));
    expect(run<TapLanding>(LANDING_EXPR)).toMatchObject({ target: 'video-canvas', hit: false });
  });

  it('arming again drops the earlier listener and record', () => {
    document.body.innerHTML = '<button data-testid="b">b</button>';
    run(armExpr(null));
    document.querySelector('button')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 1, clientY: 2 }));
    run(armExpr(null));
    expect(run(LANDING_EXPR)).toBeNull();
    document.querySelector('button')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 3, clientY: 4 }));
    expect(run<TapLanding>(LANDING_EXPR)).toMatchObject({ x: 3, y: 4, target: 'b', hit: null });
  });

  it('reads the page layout with no target', () => {
    const r = run<LayoutReading>(layoutExpr(null));
    expect(r).toMatchObject({ scrollX: 0, scrollY: 0, rect: null, inView: true });
    expect(typeof r.innerWidth).toBe('number');
  });
});
