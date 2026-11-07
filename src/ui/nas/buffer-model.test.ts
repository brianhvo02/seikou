import { describe, expect, it } from 'vitest';
import { MemoryDirectory } from '../../../tests/helpers/memory-fs';
import { ReadAheadCache } from '@seikou/engine/disc/read-ahead-cache';
import { BUFFER_FAILED_COPY, CACHE_SLACK_BYTES, bufferPlan, playlistFacts, readAheadCacheBytes, storageRoom, waitCopy, watchBufferFailure } from './buffer-model';

/** A 7200 s film averaging 30 Mbps: 27 GB, which the plan needs at 33 Mbps (the average plus 10%). */
const FILM = { durationS: 7200, playlistBytes: (30e6 / 8) * 7200 };
const LOTS = 1e12;

describe('bufferPlan', () => {
  it('plays at once when the connection keeps up with the rate plus 10%', () => {
    expect(bufferPlan({ ...FILM, connectionMbps: 40, quotaBytes: LOTS })).toEqual({ kind: 'play' });
  });

  it('buffers silently when the wait is under 120 s', () => {
    const plan = bufferPlan({ ...FILM, connectionMbps: 32.5, quotaBytes: LOTS });
    expect(plan.kind).toBe('silent');
    if (plan.kind !== 'silent') return;
    expect(plan.waitS).toBeCloseTo(109.09, 1);
    expect(plan.bytes).toBeCloseTo((plan.waitS * 32.5e6) / 8, 0);
  });

  it('asks when the wait is longer', () => {
    const plan = bufferPlan({ ...FILM, connectionMbps: 25, quotaBytes: LOTS });
    expect(plan.kind).toBe('ask');
    if (plan.kind !== 'ask') return;
    expect(plan.waitS).toBeCloseTo(1745.45, 1);
    expect(plan.bytes).toBeCloseTo((plan.waitS * 25e6) / 8, 0);
  });

  it("says how much the device can hold when it can't hold the bytes to wait for", () => {
    const plan = bufferPlan({ ...FILM, connectionMbps: 25, quotaBytes: 2e9 });
    expect(plan).toEqual({ kind: 'too-big', canHoldBytes: 2e9 - CACHE_SLACK_BYTES, bytes: expect.closeTo((((7200 * 8) / 33) * 25e6) / 8, 0) });
  });

  it('counts the segments the cache frees one at a time on top of the lead', () => {
    const bytes = (((7200 * 8) / 33) * 25e6) / 8;
    expect(bufferPlan({ ...FILM, connectionMbps: 25, quotaBytes: bytes + CACHE_SLACK_BYTES }).kind).toBe('ask');
    expect(bufferPlan({ ...FILM, connectionMbps: 25, quotaBytes: bytes + CACHE_SLACK_BYTES - 1 }).kind).toBe('too-big');
  });

  it('asks before any wait with a silent threshold of 0 (the ?bufferask=1 test flag)', () => {
    const plan = bufferPlan({ ...FILM, connectionMbps: 32.5, quotaBytes: LOTS, silentBelowS: 0 });
    expect(plan.kind).toBe('ask');
  });

  it('plays when nothing is known about the title', () => {
    expect(bufferPlan({ durationS: 0, playlistBytes: 0, connectionMbps: 1, quotaBytes: LOTS })).toEqual({ kind: 'play' });
  });
});

describe('waitCopy', () => {
  it('rounds the wait up to a whole minute', () => {
    expect(waitCopy(1745)).toBe('About 30 minutes before it can play straight through');
    expect(waitCopy(1800)).toBe('About 30 minutes before it can play straight through');
    expect(waitCopy(1801)).toBe('About 31 minutes before it can play straight through');
  });
  it('says one minute in the singular', () => {
    expect(waitCopy(1)).toBe('About 1 minute before it can play straight through');
    expect(waitCopy(60)).toBe('About 1 minute before it can play straight through');
    expect(waitCopy(61)).toBe('About 2 minutes before it can play straight through');
  });
});

describe('storageRoom', () => {
  it('asks for persistence first, then gives the quota left', async () => {
    const calls: string[] = [];
    const room = await storageRoom({
      persist: async () => (calls.push('persist'), false),
      estimate: async () => (calls.push('estimate'), { quota: 5e9, usage: 1e9 }),
    });
    expect(calls).toEqual(['persist', 'estimate']);
    expect(room).toBe(4e9);
  });

  it("counts what the read-ahead cache holds now as room (this open clears or reuses it)", async () => {
    const room = await storageRoom({ persist: async () => true, estimate: async () => ({ quota: 5e9, usage: 3e9 }) }, async () => 2e9);
    expect(room).toBe(4e9);
  });

  it('is 0 without a storage manager, or when it fails', async () => {
    expect(await storageRoom(undefined)).toBe(0);
    expect(await storageRoom({ persist: () => Promise.reject(new Error('no')), estimate: () => Promise.reject(new Error('no')) })).toBe(0);
  });
});

describe('playlistFacts', () => {
  it("sums a playlist's clips once each and its play items' lengths", () => {
    const facts = playlistFacts(
      [
        { clipId: '00001', inTime: 0, outTime: 45_000 * 60 },
        { clipId: '00002', inTime: 45_000 * 10, outTime: 45_000 * 40 },
        { clipId: '00001', inTime: 0, outTime: 45_000 * 30 },
      ],
      new Map([
        ['BDMV/STREAM/00001.M2TS', 1000],
        ['BDMV/STREAM/00002.M2TS', 500],
      ]),
    );
    expect(facts).toEqual({ durationS: 120, playlistBytes: 1500 });
  });
});

describe('readAheadCacheBytes', () => {
  it('sums the bytes of every disc in the cache, and is 0 without one', async () => {
    const root = new MemoryDirectory();
    expect(await readAheadCacheBytes(async () => root.asHandle())).toBe(0);
    const sizes = new Map([['BDMV/STREAM/00001.M2TS', 10_000]]);
    const cache = await ReadAheadCache.open('d', { root: async () => root.asHandle(), now: () => 1, fileSize: (p) => sizes.get(p), segmentBytes: 1000 });
    await cache.write('BDMV/STREAM/00001.M2TS', 0, new Uint8Array(2500));
    cache.close();
    const total = await readAheadCacheBytes(async () => root.asHandle());
    expect(total).toBeGreaterThanOrEqual(2500); // the bytes, and the small index and meta files
    expect(total).toBeLessThan(3000);
  });

  it("counts a file it can't read as 0, not the whole total", async () => {
    const root = new MemoryDirectory();
    const sizes = new Map([['BDMV/STREAM/00001.M2TS', 10_000]]);
    const cache = await ReadAheadCache.open('d', { root: async () => root.asHandle(), now: () => 1, fileSize: (p) => sizes.get(p), segmentBytes: 1000 });
    await cache.write('BDMV/STREAM/00001.M2TS', 0, new Uint8Array(2500));
    cache.close();
    const disc = await (await root.getDirectoryHandle('read-ahead')).getDirectoryHandle('d');
    const broken = [...disc.entries.values()].find((e) => e.name.endsWith('.0.bin'))! as unknown as { getFile(): Promise<never> };
    broken.getFile = () => Promise.reject(new DOMException('gone', 'NotFoundError'));
    const total = await readAheadCacheBytes(async () => root.asHandle());
    expect(total).toBeGreaterThanOrEqual(1500); // segments 1 and 2
    expect(total).toBeLessThan(2000);
  });
});

describe('watchBufferFailure', () => {
  function fakeController() {
    const listeners = new Set<() => void>();
    const c = {
      discOpens: 1,
      snapshot: { buffer: null as { stopped?: string } | null },
      notices: [] as string[],
      subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
      getSnapshot: () => c.snapshot,
      showNotice: (_code: string, message: string) => c.notices.push(message),
      emit: (buffer: { stopped?: string } | null) => {
        c.snapshot = { buffer };
        for (const l of [...listeners]) l();
      },
      listeners,
    };
    return c;
  }

  it('says the disc will play with pauses once its fill fails, once', () => {
    const c = fakeController();
    watchBufferFailure(c);
    c.emit({});
    expect(c.notices).toEqual([]);
    c.emit({ stopped: 'failed' });
    c.emit({ stopped: 'failed' });
    expect(c.notices).toEqual([BUFFER_FAILED_COPY]);
    expect(c.listeners.size).toBe(0);
  });

  it('lets go when another disc opens', () => {
    const c = fakeController();
    watchBufferFailure(c);
    c.discOpens = 2;
    c.emit({ stopped: 'no-cache' });
    expect(c.notices).toEqual([]);
    expect(c.listeners.size).toBe(0);
  });
});
