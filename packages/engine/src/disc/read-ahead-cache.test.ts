import { describe, expect, it } from 'vitest';
import { MemoryDirectory, MemoryFile } from '../../../../tests/helpers/memory-fs';
import { CACHE_DIR, CACHE_MAX_AGE_MS, MAX_DISC_FOLDERS, ReadAheadCache, safeName, segmentName, unsafeName, type LocksLike } from './read-ahead-cache';

/** The origin's Web Locks, shared by the tabs of a test: a request with ifAvailable is granted only when the name is free. */
class FakeLocks implements LocksLike {
  readonly held = new Set<string>();
  async request<T>(name: string, _options: { ifAvailable: true }, callback: (lock: unknown) => T | Promise<T>): Promise<T> {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

const PATH = 'BDMV/STREAM/00001.M2TS';
const OTHER = 'BDMV/STREAM/00002.M2TS';
const SEG = 1000;
const bytes = (n: number, seed = 1): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

function setup(startMs = 1_000_000) {
  const root = new MemoryDirectory();
  const clock = { ms: startMs };
  const sizes = new Map([
    [PATH, 10_000],
    [OTHER, 5_000],
  ]);
  const deps = { root: async () => root.asHandle(), now: () => clock.ms, fileSize: (p: string) => sizes.get(p), segmentBytes: SEG };
  const discDir = async (id = 'disc-a') => (await root.getDirectoryHandle(CACHE_DIR)).getDirectoryHandle(safeName(id));
  return { root, clock, deps, sizes, discDir };
}

describe('ReadAheadCache', () => {
  it('reads back the bytes written, across segments, and a range written in pieces', async () => {
    const { deps, discDir } = setup();
    const cache = await ReadAheadCache.open('disc-a', deps);
    const data = bytes(3000);
    await cache.write(PATH, 500, data.subarray(0, 1000));
    await cache.write(PATH, 1500, data.subarray(1000, 3000));
    expect(await cache.read(PATH, 500, 3000)).toEqual(data);
    expect(await cache.read(PATH, 1500, 100)).toEqual(data.subarray(1000, 1100));
    expect(cache.has(PATH, 500, 3000)).toBe(true);
    expect(cache.coveredEnd(PATH, 700)).toBe(3500);
    expect(cache.heldBytes(PATH, 0, 2000)).toBe(1500);
    // segments 0..3, each its own file, named with the file's size
    expect([...(await discDir()).entries.keys()].filter((n) => n.endsWith('.bin')).sort()).toEqual([0, 1, 2, 3].map((k) => `${segmentName(PATH, 10_000, k)}.bin`));
    await cache.close();
  });

  it('answers null unless the whole range is held', async () => {
    const { deps } = setup();
    const cache = await ReadAheadCache.open('disc-a', deps);
    await cache.write(PATH, 0, bytes(100));
    await cache.write(PATH, 200, bytes(100));
    expect(await cache.read(PATH, 50, 100)).toBeNull(); // runs into the gap at 100..200
    expect(await cache.read(PATH, 250, 100)).toBeNull(); // past the end of what is held
    expect(await cache.read(OTHER, 0, 10)).toBeNull(); // never written
    expect(cache.has(PATH, 50, 100)).toBe(false);
    expect(cache.coveredEnd(PATH, 150)).toBeNull();
    await cache.close();
  });

  it('closes the handles of a segment that opens after the disc closed, so the next open can write', async () => {
    const { deps, discDir } = setup();
    const cache = await ReadAheadCache.open('disc-a', deps);
    await cache.write(OTHER, 0, bytes(10)); // meta.json is written; the next write goes straight to its segments
    const dir = await discDir();
    const real = dir.getFileHandle.bind(dir);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    dir.getFileHandle = async (name, opts) => {
      if (name === `${segmentName(PATH, 10_000, 0)}.bin`) await held;
      return real(name, opts);
    };
    const writing = cache.write(PATH, 500, bytes(1000)); // segments 0 and 1
    await Promise.resolve();
    const closed = cache.close();
    release();
    await expect(writing).rejects.toThrow(/closed/);
    await closed;
    await new Promise((r) => setTimeout(r, 0));
    const files = [...dir.entries.values()].filter((e): e is MemoryFile => e instanceof MemoryFile);
    expect(files.filter((f) => f.locked).map((f) => f.name)).toEqual([]);
    dir.getFileHandle = real;

    const again = await ReadAheadCache.open('disc-a', deps);
    await again.write(PATH, 500, bytes(1000));
    expect(await again.read(PATH, 500, 1000)).toEqual(bytes(1000));
    await again.close();
  });

  it('stops a read that spans segments when the disc closes', async () => {
    const { deps, discDir } = setup();
    const cache = await ReadAheadCache.open('disc-a', deps);
    await cache.write(PATH, 0, bytes(2000));
    await cache.close();
    const again = await ReadAheadCache.open('disc-a', deps);
    const dir = await discDir();
    const real = dir.getFileHandle.bind(dir);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    dir.getFileHandle = async (name, opts) => {
      if (name === `${segmentName(PATH, 10_000, 0)}.bin`) await held;
      return real(name, opts);
    };
    const reading = again.read(PATH, 500, 1000);
    await Promise.resolve();
    const closed = again.close();
    release();
    expect(await reading).toBeNull();
    await closed;
    await new Promise((r) => setTimeout(r, 0));
    expect([...dir.entries.values()].filter((e) => e instanceof MemoryFile && e.locked)).toEqual([]);
  });

  it('keeps what it held for the same disc across opens', async () => {
    const { deps } = setup();
    const first = await ReadAheadCache.open('disc-a', deps);
    await first.write(PATH, 900, bytes(500));
    await first.close();
    const again = await ReadAheadCache.open('disc-a', deps);
    await again.clearOthers();
    expect(again.has(PATH, 900, 500)).toBe(true);
    expect(await again.read(PATH, 900, 500)).toEqual(bytes(500));
    await again.close();
  });

  it("never serves bytes kept for a file whose size has changed, and removes them", async () => {
    const { deps, sizes, discDir } = setup();
    const first = await ReadAheadCache.open('disc-a', deps);
    await first.write(PATH, 0, bytes(500));
    await first.close();
    sizes.set(PATH, 12_000);
    const again = await ReadAheadCache.open('disc-a', deps);
    expect(again.has(PATH, 0, 500)).toBe(false);
    expect(await again.read(PATH, 0, 500)).toBeNull();
    expect([...(await discDir()).entries.keys()].filter((n) => n !== 'meta.json')).toEqual([]);
    await again.close();
  });

  it('frees the segments that overlap nothing still ahead', async () => {
    const { deps, discDir } = setup();
    const cache = await ReadAheadCache.open('disc-a', deps);
    await cache.write(PATH, 0, bytes(3000));
    await cache.write(OTHER, 0, bytes(1000));
    await cache.evictOutside([
      { path: PATH, start: 1500, end: 10_000 },
      { path: OTHER, start: 0, end: 5_000 },
    ]);
    expect(cache.has(PATH, 0, 1)).toBe(false); // segment 0 is behind
    expect(cache.has(PATH, 1000, 2000)).toBe(true); // segment 1 still holds 1500..
    expect(cache.has(OTHER, 0, 1000)).toBe(true);
    expect(await cache.read(PATH, 1000, 2000)).toEqual(bytes(3000).subarray(1000));
    const names = [...(await discDir()).entries.keys()];
    expect(names).not.toContain(`${segmentName(PATH, 10_000, 0)}.bin`);
    expect(names).not.toContain(`${segmentName(PATH, 10_000, 0)}.json`);
    await cache.close();
  });

  it('clears other discs', async () => {
    const { root, deps } = setup();
    const a = await ReadAheadCache.open('disc-a', deps);
    await a.write(PATH, 0, bytes(500));
    await a.close();
    const b = await ReadAheadCache.open('disc-b', deps);
    await b.clearOthers();
    const top = await root.getDirectoryHandle(CACHE_DIR);
    expect([...top.entries.keys()]).toEqual([safeName('disc-b')]);
    await b.close();
    const aAgain = await ReadAheadCache.open('disc-a', deps);
    expect(await aAgain.read(PATH, 0, 500)).toBeNull();
    await aAgain.close();
  });

  it("clears this disc's bytes once they are over 24 hours old", async () => {
    const { clock, deps } = setup();
    const first = await ReadAheadCache.open('disc-a', deps);
    await first.write(PATH, 0, bytes(500));
    await first.close();
    clock.ms += CACHE_MAX_AGE_MS - 1;
    const young = await ReadAheadCache.open('disc-a', deps);
    await young.clearOthers();
    expect(await young.read(PATH, 0, 500)).toEqual(bytes(500));
    await young.close();
    clock.ms += 2;
    const old = await ReadAheadCache.open('disc-a', deps);
    await old.clearOthers();
    expect(await old.read(PATH, 0, 500)).toBeNull();
    // what it holds from now on is young again
    await old.write(PATH, 0, bytes(10));
    await old.close();
    const next = await ReadAheadCache.open('disc-a', deps);
    await next.clearOthers();
    expect(await next.read(PATH, 0, 10)).toEqual(bytes(10));
    await next.close();
  });

  it('clears expired discs when the engine starts', async () => {
    const { root, clock, deps } = setup();
    for (const id of ['old', 'new']) {
      const c = await ReadAheadCache.open(id, deps);
      await c.write(PATH, 0, bytes(10));
      await c.close();
      clock.ms += CACHE_MAX_AGE_MS / 2 + 1;
    }
    await ReadAheadCache.clearExpired(deps.root, clock.ms);
    expect([...(await root.getDirectoryHandle(CACHE_DIR)).entries.keys()]).toEqual([safeName('new')]);
    await ReadAheadCache.clearExpired(async () => new MemoryDirectory().asHandle(), clock.ms); // no cache yet
  });

  it('clears every disc when a disc not on the NAS opens', async () => {
    const { root, deps } = setup();
    await ReadAheadCache.clearAll(deps.root); // nothing yet
    const a = await ReadAheadCache.open('disc-a', deps);
    await a.write(PATH, 0, bytes(500));
    await a.close();
    await ReadAheadCache.clearAll(deps.root);
    expect([...(await root.getDirectoryHandle(CACHE_DIR)).entries.keys()]).toEqual([]);
  });

  it('gives a second tab on the same disc a folder of its own, and the first its folder back once free', async () => {
    const { root, deps } = setup();
    const locks = new FakeLocks();
    const tab1 = await ReadAheadCache.open('disc-a', { ...deps, locks });
    const tab2 = await ReadAheadCache.open('disc-a', { ...deps, locks });
    await tab1.write(PATH, 0, bytes(500, 1));
    await tab2.write(PATH, 0, bytes(500, 2)); // no NoModificationAllowedError: its own files
    await tab2.clearOthers(); // tab 1's folder is in use: it stays
    expect([...(await root.getDirectoryHandle(CACHE_DIR)).entries.keys()].sort()).toEqual([safeName('disc-a'), `${safeName('disc-a')}.1`]);
    expect(await tab1.read(PATH, 0, 500)).toEqual(bytes(500, 1));
    expect(await tab2.read(PATH, 0, 500)).toEqual(bytes(500, 2));
    await tab1.close();
    const again = await ReadAheadCache.open('disc-a', { ...deps, locks });
    expect(await again.read(PATH, 0, 500)).toEqual(bytes(500, 1));
    await again.close();
    await tab2.close();
  });

  it("leaves the folder of a disc another tab plays when clearing others, all or the expired", async () => {
    const { root, clock, deps } = setup();
    const locks = new FakeLocks();
    const playing = await ReadAheadCache.open('disc-a', { ...deps, locks });
    await playing.write(PATH, 0, bytes(500));
    const idle = await ReadAheadCache.open('disc-c', { ...deps, locks });
    await idle.write(PATH, 0, bytes(10));
    await idle.close();
    const other = await ReadAheadCache.open('disc-b', { ...deps, locks });
    await other.clearOthers();
    const names = async () => [...(await root.getDirectoryHandle(CACHE_DIR)).entries.keys()].sort();
    expect(await names()).toEqual([safeName('disc-a'), safeName('disc-b')]);
    await other.close();
    clock.ms += CACHE_MAX_AGE_MS + 1;
    await ReadAheadCache.clearExpired(deps.root, clock.ms, locks);
    expect(await names()).toEqual([safeName('disc-a'), safeName('disc-b')]); // disc-b holds no byte: nothing to date it
    await ReadAheadCache.clearAll(deps.root, locks);
    expect(await names()).toEqual([safeName('disc-a')]);
    expect(await playing.read(PATH, 0, 500)).toEqual(bytes(500));
    await playing.close();
    await ReadAheadCache.clearAll(deps.root, locks);
    expect(await names()).toEqual([]);
  });

  it('fails to open once every folder of the disc is held', async () => {
    const { deps } = setup();
    const locks = new FakeLocks();
    const tabs = [];
    for (let i = 0; i < MAX_DISC_FOLDERS; i++) tabs.push(await ReadAheadCache.open('disc-a', { ...deps, locks }));
    await expect(ReadAheadCache.open('disc-a', { ...deps, locks })).rejects.toThrow(/in use by another tab/);
    await tabs[0]!.close();
    const next = await ReadAheadCache.open('disc-a', { ...deps, locks });
    for (const t of [...tabs, next]) await t.close();
  });

  it('names files safely and distinctly whatever the disc id, and reversibly', () => {
    expect(safeName('a/b')).not.toContain('/');
    expect(safeName('..')).not.toBe('..');
    expect(safeName('a/b')).not.toBe(safeName('a_b'));
    expect(safeName('abc-123')).toBe('abc-123');
    for (const id of ['a/b', 'a_b', 'BDMV/STREAM/00001.M2TS', 'Starfall Wanderer', '..']) expect(unsafeName(safeName(id))).toBe(id);
    expect(unsafeName('bad_zz')).toBeNull();
  });
});
