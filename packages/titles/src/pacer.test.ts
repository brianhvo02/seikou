import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pacer, RateLimited } from './pacer';
import { SourceUnavailable } from './sources';

/** Lets every queued promise settle (the sleeps are fake, so nothing else is pending). */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('Pacer', () => {
  it('runs 30 calls in a minute, then waits for the window to pass', async () => {
    let t = 0;
    const sleeps: { ms: number; wake: () => void }[] = [];
    const sleep = (ms: number): Promise<void> => new Promise((wake) => sleeps.push({ ms, wake }));
    const pacer = new Pacer(30, 60_000, () => t, sleep);
    const started: number[] = [];
    const runs = Array.from({ length: 31 }, (_, i) => pacer.run(async () => (started.push(t), i)));
    await flush();
    expect(started).toHaveLength(30);
    expect(sleeps.map((s) => s.ms)).toEqual([60_000]);
    t = 60_000;
    sleeps[0]!.wake();
    expect(await Promise.all(runs)).toEqual(Array.from({ length: 31 }, (_, i) => i));
    expect(started[30]).toBe(60_000);
  });

  it('spaces calls by the oldest one in the window', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const pacer = new Pacer(2, 1_000, () => t, async (ms) => {
      sleeps.push(ms);
      t += ms;
    });
    await pacer.run(async () => null);
    t = 400;
    await pacer.run(async () => null);
    await pacer.run(async () => null); // waits until the first leaves the window at 1000
    expect(sleeps).toEqual([600]);
    expect(t).toBe(1_000);
  });

  it('waits Retry-After once on a 429, then throws SourceUnavailable', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const pacer = new Pacer(30, 60_000, () => t, async (ms) => {
      sleeps.push(ms);
      t += ms;
    });
    let calls = 0;
    const run = pacer.run(async () => {
      calls++;
      throw new RateLimited(2_000);
    });
    await expect(run).rejects.toBeInstanceOf(SourceUnavailable);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2_000]);
  });

  it('answers after a 429 when the retry succeeds', async () => {
    let t = 0;
    const pacer = new Pacer(30, 60_000, () => t, async (ms) => {
      t += ms;
    });
    let calls = 0;
    const value = await pacer.run(async () => {
      if (calls++ === 0) throw new RateLimited(null);
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(t).toBe(60_000); // no Retry-After: one window
  });

  it('starts an urgent call ahead of calls already waiting (ruling T9h)', async () => {
    let t = 0;
    const sleeps: { ms: number; wake: () => void }[] = [];
    const sleep = (ms: number): Promise<void> => new Promise((wake) => sleeps.push({ ms, wake }));
    const pacer = new Pacer(1, 1_000, () => t, sleep);
    const order: string[] = [];
    const runs = [
      pacer.run(async () => order.push('first')),
      pacer.run(async () => order.push('background')),
    ];
    await flush();
    runs.push(pacer.run(async () => order.push('lookup'), { urgent: true }));
    await flush();
    t = 1_000;
    sleeps[0]!.wake();
    await flush();
    t = 2_000;
    sleeps[1]!.wake();
    await Promise.all(runs);
    expect(order).toEqual(['first', 'lookup', 'background']);
  });

  it('drops a waiting call whose signal aborts, without spending a start on it', async () => {
    let t = 0;
    const sleeps: { ms: number; wake: () => void }[] = [];
    const sleep = (ms: number): Promise<void> => new Promise((wake) => sleeps.push({ ms, wake }));
    const pacer = new Pacer(1, 1_000, () => t, sleep);
    const ran: string[] = [];
    const first = pacer.run(async () => ran.push('first'));
    const abort = new AbortController();
    const dropped = pacer.run(async () => ran.push('dropped'), { signal: abort.signal });
    const last = pacer.run(async () => ran.push('last'));
    await flush();
    abort.abort(new Error('timed out'));
    await expect(dropped).rejects.toThrow('timed out');
    t = 1_000;
    sleeps[0]!.wake();
    await Promise.all([first, last]);
    expect(ran).toEqual(['first', 'last']);
    await expect(pacer.run(async () => null, { signal: abort.signal })).rejects.toThrow('timed out');
  });

  it('gives urgent calls at most 2/3 of the window, so background calls progress under a flood (ruling T9j)', async () => {
    let t = 0;
    const pacer = new Pacer(3, 1_000, () => t, async (ms) => {
      t += ms;
    });
    const order: string[] = [];
    const call = (name: string, urgent = false): Promise<unknown> => pacer.run(async () => order.push(name), { urgent });
    const runs = ['x1', 'x2', 'x3'].map((n) => call(n));
    runs.push(call('b1'), call('b2'));
    for (let i = 1; i <= 6; i++) runs.push(call(`u${i}`, true));
    await Promise.all(runs);
    expect(order).toEqual(['x1', 'x2', 'x3', 'u1', 'u2', 'b1', 'u3', 'u4', 'b2', 'u5', 'u6']);
  });

  it('cancels its pending sleep when the last waiting call aborts', async () => {
    let t = 0;
    const signals: (AbortSignal | undefined)[] = [];
    const pacer = new Pacer(1, 60_000, () => t, (_ms, signal) => {
      signals.push(signal);
      return new Promise((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    });
    await pacer.run(async () => null);
    const abort = new AbortController();
    const waiting = pacer.run(async () => null, { signal: abort.signal });
    await flush();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    abort.abort(new Error('gone'));
    await expect(waiting).rejects.toThrow('gone');
    expect(signals[0]!.aborted).toBe(true);
  });

  describe('with real timers faked', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('leaves no timer behind when the last waiting call aborts', async () => {
      vi.useFakeTimers();
      const pacer = new Pacer(1, 60_000);
      await pacer.run(async () => null);
      const abort = new AbortController();
      const waiting = pacer.run(async () => null, { signal: abort.signal });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      abort.abort(new Error('gone'));
      await expect(waiting).rejects.toThrow('gone');
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('passes other errors through', async () => {
    const pacer = new Pacer(1, 1_000);
    await expect(pacer.run(async () => Promise.reject(new SourceUnavailable('down')))).rejects.toThrow('down');
  });
});
