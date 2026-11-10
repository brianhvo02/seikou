// SPDX-License-Identifier: LGPL-3.0-or-later
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LibraryListing } from '@seikou/nas/nas-api';
import { loadPlaylist } from '../../src/disc/playlist';
import { probeClip, type ClipProbe } from '../../src/disc/probe';
import { parseEpisodeSpec, planEpisodes } from '../../src/plan/episodes';
import { NasClient } from '../../src/nas/client';
import { ClipFetcher, clipsOfEpisode, readMirrorRange, sweepUnheld } from '../../src/nas/fetch';
import { CHUNK_BYTES, ensureMirror, FetchError, HEAD_BYTES } from '../../src/nas/mirror';
import { pairWithNas } from '../../src/nas/pairing';
import { startNasTestServer, type NasTestServer } from './nas-test-server';

const FIXTURE_DISC1 = new URL('../../../fixtures/synthetic/disc1', import.meta.url).pathname;

/** Whether every byte of `b` is zero (compared whole: a deep `toEqual` of tens of MiB runs out of memory). */
const isZero = (b: Buffer): boolean => b.equals(Buffer.alloc(b.length));

describe('ClipFetcher', () => {
  let nas: NasTestServer;
  let source: string;
  let discId: string;
  let dataDir: string;
  /** Range requests for disc files the NAS was sent, by path. */
  let rangeRequests: string[];
  /** Runs before each disc file request goes out (tests use it to abort or fail it). */
  let beforeFile: (url: string) => void;
  let client: NasClient;
  let mirror: { dir: string; key: string };

  const counting: typeof fetch = (input, init) => {
    const url = String(input);
    if (url.includes('/files/')) {
      rangeRequests.push(decodeURIComponent(url.slice(url.indexOf('/files/') + '/files/'.length)));
      beforeFile(url);
    }
    return fetch(input, init);
  };

  const sources = new Map<string, Buffer>();
  /** The NAS's copy of a clip (read once). Large buffers are compared with `equals`, never a deep `toEqual`. */
  const src = (clip: string): Buffer => {
    let b = sources.get(clip);
    if (!b) sources.set(clip, (b = readFileSync(join(source, 'BDMV/STREAM', clip))));
    return b;
  };
  const local = (clip: string): Buffer => readFileSync(join(mirror.dir, 'BDMV/STREAM', clip));
  const fetcher = (o: Partial<ConstructorParameters<typeof ClipFetcher>[0]> = {}): ClipFetcher =>
    new ClipFetcher({ dataDir, client, key: mirror.key, ...o });

  beforeAll(async () => {
    nas = await startNasTestServer({ encodes: false });
    source = join(nas.discsDir!, 'disc1');
    // Clip 2 made longer than a head and a chunk, with bytes that are not zero, so emptying it shows. (APFS fills the
    // holes of a file of 16 MiB or less, so a shorter clip would never read as sparse there.)
    appendFileSync(join(source, 'BDMV/STREAM/00002.m2ts'), randomBytes(CHUNK_BYTES + 8 * 1024 * 1024 + 192 * 7));
  });
  afterAll(async () => {
    await nas.close();
  });
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'encoder-fetch-'));
    rangeRequests = [];
    beforeFile = () => {};
    await pairWithNas(dataDir, { code: await nas.ownerCode(), base: nas.base }, 'Seikou encoder on test');
    client = (await NasClient.load(dataDir, counting))!;
    discId = (await client.json<LibraryListing>('library')).discs.find((d) => d.name === 'disc1')!.id;
    mirror = await ensureMirror(dataDir, client, discId);
    rangeRequests = [];
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('heads fetches the first 4 MiB of each clip of a playlist, or the whole clip when smaller', async () => {
    await fetcher().heads('00000');
    expect(local('00001.m2ts').equals(src('00001.m2ts'))).toBe(true);
    const two = local('00002.m2ts');
    expect(two.subarray(0, HEAD_BYTES).equals(src('00002.m2ts').subarray(0, HEAD_BYTES))).toBe(true);
    expect(isZero(two.subarray(HEAD_BYTES))).toBe(true);
    const state = JSON.parse(readFileSync(join(mirror.dir, 'fetch.json'), 'utf8')) as { heads: string[] };
    expect(state.heads).toEqual(['BDMV/STREAM/00001.M2TS', 'BDMV/STREAM/00002.M2TS']);
  });

  it('hold fetches a clip whole, and a second hold of it fetches nothing', async () => {
    const progress: { bytesDone: number; bytes: number }[] = [];
    await fetcher({ onProgress: (p) => progress.push(p) }).hold('job-1', ['00001.M2TS']);
    expect(local('00001.m2ts').equals(src('00001.m2ts'))).toBe(true);
    expect(rangeRequests).toEqual(['BDMV/STREAM/00001.M2TS']);
    expect(progress.at(-1)).toEqual({ bytesDone: src('00001.m2ts').length, bytes: src('00001.m2ts').length });
    await fetcher().hold('job-2', ['00001.M2TS']);
    expect(rangeRequests).toHaveLength(1);
  });

  it('after an abort mid-fetch, a new hold fetches only the missing ranges, and a refreshed mirror keeps them', async () => {
    const controller = new AbortController();
    // Clip 1 comes whole and clip 2's first chunk; the fetch is stopped as clip 2's second chunk is asked for.
    beforeFile = () => {
      if (rangeRequests.length === 3) controller.abort();
    };
    await expect(fetcher({ signal: controller.signal }).hold('job-1', ['00001.M2TS', '00002.M2TS'])).rejects.toBeDefined();
    expect(rangeRequests).toEqual(['BDMV/STREAM/00001.M2TS', 'BDMV/STREAM/00002.M2TS', 'BDMV/STREAM/00002.M2TS']);
    const state = JSON.parse(readFileSync(join(mirror.dir, 'fetch.json'), 'utf8')) as { ranges: Record<string, [number, number][]> };
    expect(state.ranges['BDMV/STREAM/00002.M2TS']).toEqual([[0, CHUNK_BYTES]]);

    beforeFile = () => {};
    rangeRequests = [];
    await ensureMirror(dataDir, client, discId, mirror.key);
    await fetcher().hold('job-2', ['00001.M2TS', '00002.M2TS']);
    expect(rangeRequests).toEqual(['BDMV/STREAM/00002.M2TS']);
    expect(local('00001.m2ts').equals(src('00001.m2ts'))).toBe(true);
    expect(local('00002.m2ts').equals(src('00002.m2ts'))).toBe(true);
  });

  it('two holders of one clip at once fetch it once', async () => {
    await Promise.all([fetcher().hold('job-1', ['00002.M2TS']), fetcher().hold('session:a', ['00002.M2TS'])]);
    expect(rangeRequests).toEqual(['BDMV/STREAM/00002.M2TS', 'BDMV/STREAM/00002.M2TS']);
    expect(local('00002.m2ts').equals(src('00002.m2ts'))).toBe(true);
  });

  it('release empties a clip no holder claims back to its head, and keeps one another holder claims', async () => {
    const f = fetcher();
    await f.hold('job-1', ['00001.M2TS', '00002.M2TS']);
    await f.hold('session:a', ['00001.M2TS']);
    await f.release('job-1');
    expect(local('00001.m2ts').equals(src('00001.m2ts'))).toBe(true);
    const two = local('00002.m2ts');
    expect(two.subarray(0, HEAD_BYTES).equals(src('00002.m2ts').subarray(0, HEAD_BYTES))).toBe(true);
    expect(isZero(two.subarray(HEAD_BYTES))).toBe(true);
    const st = statSync(join(mirror.dir, 'BDMV/STREAM/00002.m2ts'));
    expect(st.size).toBe(src('00002.m2ts').length);
    expect(st.blocks * 512).toBeLessThan(HEAD_BYTES + 1024 * 1024);
    const state = JSON.parse(readFileSync(join(mirror.dir, 'fetch.json'), 'utf8')) as { ranges: Record<string, [number, number][]> };
    expect(state.ranges['BDMV/STREAM/00002.M2TS']).toEqual([[0, HEAD_BYTES]]);

    // Held again, only what was emptied is fetched.
    rangeRequests = [];
    await f.hold('job-2', ['00002.M2TS']);
    expect(rangeRequests).toEqual(['BDMV/STREAM/00002.M2TS', 'BDMV/STREAM/00002.M2TS']);
    expect(local('00002.m2ts').equals(src('00002.m2ts'))).toBe(true);
  });

  it('the start sweep empties every clip no holder claims', async () => {
    await fetcher().hold('job-1', ['00001.M2TS', '00002.M2TS']);
    // Another app on a copy of this data directory has no holders, as after a restart.
    const restarted = mkdtempSync(join(tmpdir(), 'encoder-fetch-restart-'));
    try {
      cpSync(join(dataDir, 'fetch'), join(restarted, 'fetch'), { recursive: true });
      await sweepUnheld(dataDir);
      expect(local('00002.m2ts').equals(src('00002.m2ts'))).toBe(true);
      await sweepUnheld(restarted);
      const two = readFileSync(join(restarted, 'fetch', mirror.key, 'BDMV/STREAM/00002.m2ts'));
      expect(two.subarray(0, HEAD_BYTES).equals(src('00002.m2ts').subarray(0, HEAD_BYTES))).toBe(true);
      expect(isZero(two.subarray(HEAD_BYTES))).toBe(true);
    } finally {
      rmSync(restarted, { recursive: true, force: true });
    }
  });

  it('refuses with no-room, naming the bytes needed, and fetches nothing', async () => {
    const err = await fetcher({ freeBytes: () => Promise.resolve(1000) })
      .hold('job-1', ['00001.M2TS'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err).toMatchObject({ code: 'no-room' });
    expect((err as Error).message).toContain(String(src('00001.m2ts').length));
    expect(rangeRequests).toEqual([]);
  });

  it('is unreachable after four retries of a dropped connection', async () => {
    beforeFile = () => {
      throw new TypeError('fetch failed');
    };
    const sleeps: number[] = [];
    const err = await fetcher({ sleep: (ms) => (sleeps.push(ms), Promise.resolve()) })
      .hold('job-1', ['00001.M2TS'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err).toMatchObject({ code: 'unreachable' });
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
    expect(rangeRequests).toHaveLength(5);
  });

  it('readMirrorRange reads fetched bytes here and the rest from the NAS, storing none of it', async () => {
    await fetcher().heads('00000');
    rangeRequests = [];
    const path = 'BDMV/STREAM/00002.M2TS';
    const whole = src('00002.m2ts');
    expect(await readMirrorRange(dataDir, client, mirror.key, path, 1000, 5000)).toEqual(new Uint8Array(whole.subarray(1000, 5001)));
    expect(rangeRequests).toEqual([]);
    const across = await readMirrorRange(dataDir, client, mirror.key, path, HEAD_BYTES - 100, HEAD_BYTES + 99);
    expect(across).toEqual(new Uint8Array(whole.subarray(HEAD_BYTES - 100, HEAD_BYTES + 100)));
    expect(rangeRequests).toEqual([path]);
    expect(isZero(local('00002.m2ts').subarray(HEAD_BYTES))).toBe(true);
    expect(await readMirrorRange(dataDir, client, mirror.key, 'BDMV/INDEX.BDMV', 0, 3)).toEqual(new Uint8Array(readFileSync(join(source, 'BDMV/index.bdmv')).subarray(0, 4)));
  });
});

describe('clipsOfEpisode', () => {
  it("gives the clips each episode's plan reads", async () => {
    const playlist = await loadPlaylist(FIXTURE_DISC1, '00000');
    const probes = new Map<string, ClipProbe>();
    for (const item of playlist.items) if (!probes.has(item.clipId)) probes.set(item.clipId, await probeClip(item));
    for (const spec of ['1-2,3-4', '2-3', '1-']) {
      // disc1's clips have no PAT, so the plan cuts no audio (the clips it reads do not depend on it).
      const plans = planEpisodes(playlist, probes, parseEpisodeSpec(spec, playlist.chapters.length), [], new Map());
      for (const plan of plans) {
        const expected = [...new Set(plan.segments.map((s) => `${s.item.clipId}.M2TS`))];
        expect(await clipsOfEpisode(FIXTURE_DISC1, '00000', spec, plan.index)).toEqual(expected);
      }
    }
    expect(await clipsOfEpisode(FIXTURE_DISC1, '00000', '1-2,3-4', 1)).toEqual(['00001.M2TS']);
    expect(await clipsOfEpisode(FIXTURE_DISC1, '00000', '2-3', 1)).toEqual(['00001.M2TS', '00002.M2TS']);
    await expect(clipsOfEpisode(FIXTURE_DISC1, '00000', '1-2', 2)).rejects.toThrow(RangeError);
  });
});
