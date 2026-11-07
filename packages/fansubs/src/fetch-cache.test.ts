import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchCache } from './fetch-cache';

const holdReads: { gate: Promise<void> | null } = { gate: null };
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: async (...args: Parameters<typeof real.readFile>) => {
      const bytes = await real.readFile(...args);
      await holdReads.gate;
      return bytes;
    },
  };
});

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fetch-cache-'));
});
afterEach(() => {
  holdReads.gate = null;
  rmSync(dir, { recursive: true, force: true });
});

const bytes = (n: number, fill = 1): Buffer => Buffer.alloc(n, fill);

describe('FetchCache', () => {
  it('answers a second get from disk', async () => {
    const cache = new FetchCache(dir, 1000);
    const fetchFn = vi.fn(async () => bytes(10, 7));
    expect(await cache.get('https://x/a', fetchFn)).toEqual(bytes(10, 7));
    expect(await cache.get('https://x/a', fetchFn)).toEqual(bytes(10, 7));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('fetches once for concurrent gets of one URL', async () => {
    const cache = new FetchCache(dir, 1000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchFn = vi.fn(async () => {
      await gate;
      return bytes(5);
    });
    const both = Promise.all([cache.get('https://x/a', fetchFn), cache.get('https://x/a', fetchFn)]);
    release();
    const [a, b] = await both;
    expect(a).toEqual(b);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failed fetch', async () => {
    const cache = new FetchCache(dir, 1000);
    await expect(cache.get('https://x/a', async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(await cache.get('https://x/a', async () => bytes(3))).toEqual(bytes(3));
  });

  it('evicts the least recently used past maxBytes', async () => {
    const cache = new FetchCache(dir, 25);
    const fetches = { a: vi.fn(async () => bytes(10, 1)), b: vi.fn(async () => bytes(10, 2)), c: vi.fn(async () => bytes(10, 3)) };
    await cache.get('a', fetches.a);
    await cache.get('b', fetches.b);
    await cache.get('a', fetches.a); // a is now newer than b
    await cache.get('c', fetches.c); // 30 > 25: b goes
    await cache.get('a', fetches.a);
    await cache.get('c', fetches.c);
    expect(fetches.a).toHaveBeenCalledTimes(1);
    expect(fetches.c).toHaveBeenCalledTimes(1);
    await cache.get('b', fetches.b);
    expect(fetches.b).toHaveBeenCalledTimes(2);
  });

  it('survives a new instance', async () => {
    await new FetchCache(dir, 1000).get('https://x/a', async () => bytes(4, 9));
    const fetchFn = vi.fn(async () => bytes(4, 0));
    expect(await new FetchCache(dir, 1000).get('https://x/a', fetchFn)).toEqual(bytes(4, 9));
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refetches an entry whose file is gone, and ignores stray temp files', async () => {
    const cache = new FetchCache(dir, 1000);
    await cache.get('https://x/a', async () => bytes(4));
    const entryDir = join(dir);
    for (const f of readdirSync(entryDir)) if (f !== 'index.json' && !f.endsWith('.lock')) rmSync(join(entryDir, f));
    writeFileSync(join(entryDir, 'stray.123.tmp'), 'half');
    const fetchFn = vi.fn(async () => bytes(4, 5));
    expect(await new FetchCache(dir, 1000).get('https://x/a', fetchFn)).toEqual(bytes(4, 5));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(existsSync(join(entryDir, 'index.json'))).toBe(true);
  });

  it('does not evict an entry a get is returning', async () => {
    const cache = new FetchCache(dir, 10);
    const slow = vi.fn(async () => bytes(10, 1));
    await cache.get('slow', slow); // the older entry, so the first to go under pressure
    const gate = deferred();
    holdReads.gate = gate.promise;
    const reading = cache.get('slow', slow); // now reading its file, held open
    await cache.get('other', async () => bytes(10, 2)); // 20 > 10: slow would be evicted if it weren't pinned
    gate.release();
    expect(await reading).toEqual(bytes(10, 1));
    expect(slow).toHaveBeenCalledTimes(1);
  });
});
