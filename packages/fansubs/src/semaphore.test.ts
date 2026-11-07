import { describe, expect, it } from 'vitest';
import { Semaphore } from './semaphore';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('Semaphore', () => {
  it('runs at most its limit at once, the rest in order as slots free', async () => {
    const s = new Semaphore(2);
    const order: string[] = [];
    const gates = new Map<string, () => void>();
    const job = (name: string): Promise<void> => s.run(() => new Promise<void>((r) => {
      order.push(name);
      gates.set(name, r);
    }));
    const all = ['a', 'b', 'c', 'd'].map(job);
    await tick();
    expect(order).toEqual(['a', 'b']);
    expect(s.queued).toBe(2);
    gates.get('b')!();
    await tick();
    expect(order).toEqual(['a', 'b', 'c']);
    gates.get('a')!();
    gates.get('c')!();
    await tick();
    gates.get('d')!();
    await Promise.all(all);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    expect(s.active).toBe(0);
  });

  it('frees the slot when a job fails, and drops a waiter whose signal aborts', async () => {
    const s = new Semaphore(1);
    await expect(s.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    let release!: () => void;
    const held = s.run(() => new Promise<void>((r) => { release = r; }));
    const ac = new AbortController();
    let ran = false;
    const waiting = s.run(async () => { ran = true; }, ac.signal);
    ac.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
    expect(s.queued).toBe(0);
    release();
    await held;
    expect(ran).toBe(false);
    expect(s.active).toBe(0);
    await expect(s.run(async () => 1, AbortSignal.abort(new Error('already')))).rejects.toThrow('already');
  });
});
