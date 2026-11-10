// SPDX-License-Identifier: LGPL-3.0-or-later
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { episodeName, type EncodeEvent, type EncodeOptions } from '../../src/encode';
import { NasClient } from '../../src/nas/client';
import { HEAD_BYTES } from '../../src/nas/mirror';
import { nasLibraryOf } from '../../src/nas/nas-library';
import { pairWithNas } from '../../src/nas/pairing';
import { EpisodeInfoStore, type EpisodeTitle } from '../../src/plan/episode-info';
import { JobError, JobRunner, startJobRunner, type Job, type JobRunnerDeps } from '../../src/server/jobs';
import { DEFAULT_SETTINGS, type EncodeSettings } from '../../src/server/profiles';
import { sessionsOf } from '../../src/server/sessions';
import { startNasTestServer, type NasTestServer } from '../nas/nas-test-server';
import { retagged } from '../nas/retag';
import { fx as fixturePath } from '../paths';
import { startRouteFixture, type RouteFixture } from './route-fixture';

/** Tool paths the fake encoder never runs. */
const DUMMY_TOOLS = { vspipe: '/nonexistent/vspipe', svt: '/nonexistent/SvtAv1EncApp', opusenc: '/nonexistent/opusenc' };
/** The made-up show the episodes are filed under. */
const SHOW = 990002;

async function until(cond: () => boolean, what = 'condition'): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A promise with its resolve, for holding the fake encoder at a point. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

interface Seen {
  readonly episode: number;
  /** Clips the mirror held whole when the encode of this episode began. */
  readonly whole: string[];
}

/** The speech disc on the NAS with clip 2 lengthened, so its key is the NAS's own and both clips are longer than a head. */
let nas: NasTestServer;
let fx: RouteFixture;
let nasKey: string;
let mirrorDir: string;
let seen: Seen[];
/** Holds the encode of an episode until opened. */
let gates: Map<number, { promise: Promise<void>; open: () => void }>;
/** Requests the NAS was sent, as `<method> <path>`. */
let requests: string[];
/** The `Content-Range` of every PUT the NAS answered. */
let putsAnswered: string[];
/** Runs before each request goes out; may return a promise the request waits for. */
let beforeRequest: (method: string, path: string, signal: AbortSignal | null) => Promise<void> | void;
/** Answers a request in the NAS's place when it returns a response. */
let answerInstead: (method: string, path: string) => Response | null;

/** Every clip `fetch.json` records whole, and the bytes it records per clip. */
function mirrorState(): { whole: string[]; bytes: Record<string, number> } {
  const state = JSON.parse(readFileSync(join(mirrorDir, 'fetch.json'), 'utf8')) as { files: Record<string, number>; ranges: Record<string, [number, number][]> };
  const whole: string[] = [];
  const bytes: Record<string, number> = {};
  for (const [path, size] of Object.entries(state.files)) {
    if (!path.startsWith('BDMV/STREAM/') || !path.endsWith('.M2TS')) continue;
    const name = path.slice('BDMV/STREAM/'.length);
    const ranges = state.ranges[path] ?? [];
    bytes[name] = ranges.reduce((n, [a, b]) => n + (b - a), 0);
    if (bytes[name] === size) whole.push(name);
  }
  return { whole, bytes };
}

const encode = async (options: EncodeOptions, onEvent: (e: EncodeEvent) => void): Promise<string[]> => {
  const episode = options.onlyEpisodes![0]!;
  seen.push({ episode, whole: mirrorState().whole });
  await gates.get(episode)?.promise;
  options.signal?.throwIfAborted();
  const path = join(options.outDir, `${episodeName(options.namePattern, episode)}.mkv`);
  writeFileSync(`${path}.partial`, retagged(SHOW, episode));
  renameSync(`${path}.partial`, path);
  onEvent({ kind: 'progress', episode, message: '', framesDone: 100, frames: 100 });
  onEvent({ kind: 'episode-done', episode, message: '', path });
  return [path];
};

const deps = (over: Partial<JobRunnerDeps> = {}): Partial<JobRunnerDeps> => ({ encode, nasRetryMs: 10, nasSleep: () => Promise.resolve(), ...over });
const settings = (over: Partial<EncodeSettings> = {}): EncodeSettings => ({ ...DEFAULT_SETTINGS, namePattern: 'ep-{n}', destination: 'nas', ...over });
const input = (over: Partial<Parameters<JobRunner['add']>[0]> = {}): Parameters<JobRunner['add']>[0] => ({
  discKey: nasKey,
  playlistId: '00000',
  episodeSpec: '1-3,4-5',
  settings: settings(),
  noSubtitles: true,
  ...over,
});

/** Episode 1 starts at chapter 1 and episode 2 at chapter 4. */
async function chooseAniList(chapters: readonly number[]): Promise<void> {
  const titles: Record<string, EpisodeTitle> = Object.fromEntries(chapters.map((c, i) => [String(c), { title: { source: 'anilist' , anilistId: SHOW }, episode: i + 1, name: null }]));
  await new EpisodeInfoStore(fx.dataDir).save(nasKey, '00000', { chapterNames: {}, titles });
}

beforeAll(async () => {
  nas = await startNasTestServer({
    prepare: (dir) => {
      cpSync(fixturePath('fixtures/disc-speech'), join(dir, 'speech'), { recursive: true });
      appendFileSync(join(dir, 'speech/BDMV/STREAM/00002.m2ts'), randomBytes(192 * 10_000));
    },
  });
});
afterAll(async () => {
  await nas.close();
});
beforeEach(async () => {
  fx = await startRouteFixture({}, DUMMY_TOOLS);
  seen = [];
  gates = new Map();
  requests = [];
  putsAnswered = [];
  beforeRequest = () => {};
  answerInstead = () => null;
  await pairWithNas(fx.dataDir, { code: await nas.ownerCode(), base: nas.base }, 'Seikou encoder on test');
  fx.app.nas.client = await NasClient.load(fx.dataDir, async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(String(url)).pathname.replace(/^\/api\//, '');
    requests.push(`${method} ${path}`);
    await beforeRequest(method, path, init?.signal ?? null);
    const instead = answerInstead(method, path);
    if (instead !== null) return instead;
    const res = await fetch(url, init);
    if (method === 'PUT' && res.ok) putsAnswered.push(new Headers(init?.headers).get('content-range') ?? '');
    return res;
  });
  const library = nasLibraryOf(fx.app);
  await library.scan();
  nasKey = library.discs().find((d) => d.label === 'speech')!.key;
  mirrorDir = (await sessionsOf(fx.app).discDirOf(nasKey))!;
});
afterEach(async () => {
  for (const g of gates.values()) g.open();
  await fx.stop();
  rmSync(join(nas.encodesDir!, String(SHOW)), { recursive: true, force: true });
  rmSync(join(nas.encodesDir!, '.uploads'), { recursive: true, force: true });
});

describe('a NAS job', () => {
  it('fetches each episode, encodes it, uploads it, deletes it and ends done with both encode ids', async () => {
    await chooseAniList([1, 4]);
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    const job = await runner.add(input());
    expect(job.outDir).toBe(join(fx.dataDir, 'nas-out', job.id));
    expect(job.settings.web).toBe(false);
    expect(job.cli).toContain(`nas:${nasKey}`);
    expect(job.cli).toContain('--nas');
    expect(job.cli).not.toContain('--out');
    await until(() => ['done', 'failed'].includes(runner.get(job.id)!.state), 'the job to end');
    const done = runner.get(job.id)!;
    expect([done.state, done.error]).toEqual(['done', undefined]);
    expect(done.episodes.map((e) => [e.state, e.encodeId, e.step])).toEqual([
      ['done', `${SHOW}-1`, null],
      ['done', `${SHOW}-2`, null],
    ]);
    // Each episode's clip was whole when its encode began; episode 2's was fetched while episode 1 encoded.
    expect(seen.map((s) => [s.episode, s.whole.includes(`0000${s.episode}.M2TS`)])).toEqual([
      [1, true],
      [2, true],
    ]);
    // The MKVs went to the NAS and left this Mac.
    expect(existsSync(join(nas.encodesDir!, `${SHOW}/1.mkv`))).toBe(true);
    expect(existsSync(join(nas.encodesDir!, `${SHOW}/2.mkv`))).toBe(true);
    expect(existsSync(join(fx.dataDir, 'nas-out', job.id))).toBe(false);
    // Nothing of the mirror is more than its head.
    for (const bytes of Object.values(mirrorState().bytes)) expect(bytes).toBeLessThanOrEqual(HEAD_BYTES);
  });

  it('waits for the NAS while it does not answer, and finishes once it is back', async () => {
    await chooseAniList([1, 4]);
    gates.set(2, gate());
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    const job = await runner.add(input());
    await until(() => seen.length === 2, 'episode 2 to encode');
    await nas.pause();
    try {
      gates.get(2)!.open();
      await until(() => runner.get(job.id)!.waiting === 'Waiting for the NAS', 'the wait');
      expect(runner.get(job.id)!.episodes[1]!.step).toBe('uploading');
    } finally {
      await nas.resume();
    }
    await until(() => ['done', 'failed'].includes(runner.get(job.id)!.state), 'the job to end');
    const done = runner.get(job.id)!;
    expect([done.state, done.waiting]).toEqual(['done', null]);
    expect(done.episodes.map((e) => e.encodeId)).toEqual([`${SHOW}-1`, `${SHOW}-2`]);
  });

  it('a cancel during the wait stops the job at once, releases its clips and keeps the MKVs', async () => {
    await chooseAniList([1, 4]);
    gates.set(1, gate());
    const runner = startJobRunner(fx.app, deps({ nasRetryMs: 60_000 }));
    await runner.ready;
    const job = await runner.add(input());
    await until(() => seen.length === 1, 'episode 1 to encode');
    await until(() => mirrorState().whole.includes('00002.M2TS'), 'episode 2 fetched ahead');
    await nas.pause();
    try {
      gates.get(1)!.open();
      // episode 2's clips are here, so it encodes while episode 1's upload waits; then only uploads are left
      await until(() => runner.get(job.id)!.waiting !== null, 'the wait');
      expect(seen.map((s) => s.episode)).toEqual([1, 2]);
      const cancelled = await runner.cancel(job.id);
      expect(cancelled.state).toBe('cancelled');
      expect(cancelled.episodes.map((e) => e.state)).toEqual(['upload-failed', 'upload-failed']);
      for (const e of cancelled.episodes) expect(existsSync(e.path!)).toBe(true);
    } finally {
      await nas.resume();
    }
    expect(mirrorState().whole).toEqual([]);
    // a retry uploads both from their MKVs, encoding nothing again
    await runner.retry(job.id);
    await until(() => ['done', 'failed'].includes(runner.get(job.id)!.state), 'the retry to end');
    expect(runner.get(job.id)!.episodes.map((e) => e.encodeId)).toEqual([`${SHOW}-1`, `${SHOW}-2`]);
    expect(seen.map((s) => s.episode)).toEqual([1, 2]);
  });

  it('a waiting upload does not hold the runner: the episodes after it encode, then all upload in order', async () => {
    // a local disc in three episodes, so nothing but the uploads needs the NAS
    await new EpisodeInfoStore(fx.dataDir).save(fx.discKey, '00000', {
      chapterNames: {},
      titles: Object.fromEntries([1, 3, 5].map((c, i) => [String(c), { title: { source: 'anilist', anilistId: SHOW }, episode: i + 1, name: null }])),
    });
    gates.set(1, gate());
    gates.set(2, gate());
    const runner = startJobRunner(fx.app, deps({ nasRetryMs: 20 }));
    await runner.ready;
    const job = await runner.add(input({ discKey: fx.discKey, episodeSpec: '1-2,3-4,5' }));
    await until(() => seen.length === 1, 'episode 1 to encode');
    await nas.pause();
    let resumed = false;
    try {
      gates.get(1)!.open();
      await until(() => seen.length === 2, 'episode 2 to encode');
      const during = runner.get(job.id)!;
      expect([during.waiting, during.episodes[0]!.state, during.episodes[0]!.encoded]).toEqual([null, 'upload-waiting', true]);
      expect(during.episodes[0]!.upload?.sha256).toMatch(/^[0-9a-f]{64}$/);
      gates.get(2)!.open();
      await until(() => runner.get(job.id)!.waiting !== null, 'the wait once only uploads are left');
      const waiting = runner.get(job.id)!;
      expect(seen.map((s) => s.episode)).toEqual([1, 2, 3]);
      expect(waiting.waiting).toBe('Waiting for the NAS');
      expect(waiting.episodes.map((e) => [e.state, e.step])).toEqual([
        ['running', 'uploading'],
        ['upload-waiting', null],
        ['upload-waiting', null],
      ]);
      for (const e of waiting.episodes) expect(existsSync(e.path!)).toBe(true);
      await nas.resume();
      resumed = true;
    } finally {
      if (!resumed) await nas.resume();
    }
    await until(() => ['done', 'failed'].includes(runner.get(job.id)!.state), 'the job to end');
    const done = runner.get(job.id)!;
    expect([done.state, done.waiting, done.error]).toEqual(['done', null, undefined]);
    expect(done.episodes.map((e) => e.encodeId)).toEqual([`${SHOW}-1`, `${SHOW}-2`, `${SHOW}-3`]);
    // nothing encoded twice, and the uploads went in episode order
    expect(seen.map((s) => s.episode)).toEqual([1, 2, 3]);
    const filed = (await runner.logTail(job.id, 200)).filter((l) => l.includes(': on the NAS as ')).map((l) => /Episode (\d+):/.exec(l)![1]);
    expect(filed).toEqual(['1', '2', '3']);
  });

  it('an interrupted upload resumes the upload id it stored', async () => {
    await chooseAniList([1, 4]);
    const blocked = gate();
    let blocking = true;
    beforeRequest = (method, _path, signal) => {
      if (method !== 'PUT' || !blocking) return;
      return new Promise<void>((_resolve, reject) => {
        blocked.open();
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const first = new JobRunner(fx.app, deps());
    await first.start();
    const job = await first.add(input());
    await blocked.promise;
    await first.shutdown();
    const stopped = first.get(job.id)!;
    expect(stopped.state).toBe('interrupted');
    expect(stopped.episodes[0]!.state).toBe('upload-failed');
    const uploadId = stopped.episodes[0]!.upload!.id;
    expect(uploadId).toMatch(/^[0-9a-f]{16}$/);
    expect(existsSync(stopped.episodes[0]!.path!)).toBe(true);

    blocking = false;
    requests = [];
    const second = startJobRunner(fx.app, deps());
    await second.ready;
    expect(second.get(job.id)!.episodes[0]!.state).toBe('upload-failed');
    await second.retry(job.id);
    await until(() => ['done', 'failed'].includes(second.get(job.id)!.state), 'the retry to end');
    const done = second.get(job.id)!;
    expect([done.state, done.error]).toEqual(['done', undefined]);
    expect(requests).toContain(`GET encodes/uploads/${uploadId}`);
    expect(requests.filter((r) => r === 'POST encodes/uploads')).toHaveLength(1); // episode 2's only
    // Episode 1 was not encoded again.
    expect(seen.map((s) => s.episode)).toEqual([1, 2]);
  });

  it('a NAS that stops answering after the first piece of an upload gets only the missing pieces once back', async () => {
    await chooseAniList([1, 4]);
    let paused = false;
    beforeRequest = async (method) => {
      if (method === 'PUT' && putsAnswered.length === 1 && !paused) {
        paused = true;
        await nas.pause();
      }
    };
    // three pieces an episode
    const runner = startJobRunner(fx.app, deps({ uploadChunkBytes: 400_000 }));
    await runner.ready;
    const job = await runner.add(input());
    await until(() => runner.get(job.id)!.waiting !== null, 'the wait');
    expect(runner.get(job.id)!.episodes[0]!.step).toBe('uploading');
    await nas.resume();
    await until(() => ['done', 'failed'].includes(runner.get(job.id)!.state), 'the job to end');
    expect(runner.get(job.id)!.state).toBe('done');
    expect(putsAnswered).toHaveLength(6);
    expect(new Set(putsAnswered).size).toBe(3); // each episode's three pieces, none of episode 1's sent twice
    expect(putsAnswered.slice(0, 3)).toEqual([...new Set(putsAnswered.slice(0, 3))]);
    expect(seen.map((x) => x.episode)).toEqual([1, 2]);
  });

  it('removing a job drops the upload it left open on the NAS', async () => {
    await chooseAniList([1, 4]);
    const blocked = gate();
    beforeRequest = (method, _path, signal) => {
      if (method !== 'PUT') return;
      return new Promise<void>((_resolve, reject) => {
        blocked.open();
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    const job = await runner.add(input());
    await blocked.promise;
    beforeRequest = () => {};
    const cancelled = await runner.cancel(job.id);
    const uploadId = cancelled.episodes[0]!.upload!.id!;
    expect(existsSync(join(nas.encodesDir!, '.uploads', `${uploadId}.json`))).toBe(true);
    await runner.remove(job.id);
    expect(existsSync(join(nas.encodesDir!, '.uploads', `${uploadId}.json`))).toBe(false);
    expect(existsSync(join(fx.dataDir, 'nas-out', job.id))).toBe(false);
  });

  it('a disc that changed on the NAS fails the job saying to open it again from the Library', async () => {
    await chooseAniList([1, 4]);
    // The NAS no longer has clip 1 under any of the disc's ids.
    answerInstead = (method, path) => (method === 'GET' && path.endsWith('/BDMV/STREAM/00001.M2TS') ? new Response('{"error":"not-found"}', { status: 404 }) : null);
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    const job = await runner.add(input());
    await until(() => ['done', 'failed'].includes(runner.get(job.id)!.state), 'the job to end');
    const failed = runner.get(job.id)!;
    const said = 'The disc speech changed on the NAS since it was opened. Open it again from the Library and queue it again.';
    expect([failed.state, failed.error, failed.episodes[0]!.error]).toEqual(['failed', said, said]);
  });

  it('with `only`, checks, fetches, encodes and uploads just those episodes', async () => {
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    // episode 1 has no title, and would share episode 2's number if it had one: neither matters, since it is skipped
    await new EpisodeInfoStore(fx.dataDir).save(nasKey, '00000', {
      chapterNames: {},
      titles: { '4': { title: { source: 'anilist', anilistId: SHOW }, episode: 2, name: null } },
    });
    const all = await runner.add(input()).catch((e: unknown) => e);
    expect([(all as JobError).code, (all as JobError).extra.episodes]).toEqual(['nas-needs-title', [1]]);
    const job = await runner.add(input({ only: [2] }));
    expect(job.episodes.map((e) => [e.state, e.skipped])).toEqual([['done', true], ['queued', undefined]]);
    await until(() => ['done', 'failed'].includes(runner.get(job.id)!.state), 'the job to end');
    const done = runner.get(job.id)!;
    expect([done.state, done.error]).toEqual(['done', undefined]);
    expect(done.episodes.map((e) => [e.state, e.encodeId, e.skipped])).toEqual([['done', undefined, true], ['done', `${SHOW}-2`, undefined]]);
    expect(seen.map((s) => s.episode)).toEqual([2]);
    expect(mirrorState().whole).not.toContain('00001.M2TS');
    expect(existsSync(join(nas.encodesDir!, `${SHOW}/2.mkv`))).toBe(true);
    expect(existsSync(join(nas.encodesDir!, `${SHOW}/1.mkv`))).toBe(false);
  });

  it('queueing refuses episodes without AniList, duplicate pairs, and an unpaired app', async () => {
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    await chooseAniList([1]);
    const missing = await runner.add(input()).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(JobError);
    expect([(missing as JobError).status, (missing as JobError).code, (missing as JobError).extra.episodes]).toEqual([409, 'nas-needs-title', [2]]);

    await new EpisodeInfoStore(fx.dataDir).save(nasKey, '00000', {
      chapterNames: {},
      titles: { '1': { title: { source: 'anilist', anilistId: SHOW }, episode: 1, name: null }, '4': { title: { source: 'anilist', anilistId: SHOW }, episode: 1, name: null } },
    });
    const twice = await runner.add(input()).catch((e: unknown) => e);
    expect([(twice as JobError).code, (twice as JobError).extra.episodes]).toEqual(['nas-duplicate-episodes', [1, 2]]);

    const test = await runner.add(input({ kind: 'test', profiles: [{ id: 'a', name: 'A', settings: settings() }] })).catch((e: unknown) => e);
    expect((test as JobError).code).toBe('nas-test-unsupported');

    const client = fx.app.nas.client;
    fx.app.nas.client = null;
    await chooseAniList([1, 4]);
    const unpaired = await runner.add(input()).catch((e: unknown) => e);
    expect((unpaired as JobError).code).toBe('nas-not-paired');
    fx.app.nas.client = client;
  });

  it('queueing to a NAS without an encodes folder is nas-encodes-off; an unreachable NAS queues anyway', async () => {
    await chooseAniList([1, 4]);
    // A local disc, so only the destination asks the NAS.
    const local = { discKey: fx.discKey };
    const bare = await startNasTestServer({ discs: false, encodes: false });
    const client = fx.app.nas.client;
    try {
      const dataDir = mkdtempSync(join(tmpdir(), 'jobs-nas-bare-'));
      await pairWithNas(dataDir, { code: await bare.ownerCode(), base: bare.base }, 'Seikou encoder on test');
      fx.app.nas.client = await NasClient.load(dataDir);
      rmSync(dataDir, { recursive: true, force: true });
      await new EpisodeInfoStore(fx.dataDir).save(fx.discKey, '00000', {
        chapterNames: {},
        titles: { '1': { title: { source: 'anilist', anilistId: SHOW }, episode: 1, name: null }, '4': { title: { source: 'anilist', anilistId: SHOW }, episode: 2, name: null } },
      });
      const runner = startJobRunner(fx.app, deps());
      await runner.ready;
      const off = await runner.add(input(local)).catch((e: unknown) => e);
      expect((off as JobError).code).toBe('nas-encodes-off');
      await bare.pause();
      const queued = await runner.add(input(local));
      expect(queued.state).toMatch(/queued|running/);
      await runner.cancel(queued.id);
    } finally {
      fx.app.nas.client = client;
      await bare.close();
    }
  });

  it('loads a jobs.json written before the NAS destination', async () => {
    const outDir = realpathSync(mkdtempSync(join(tmpdir(), 'jobs-old-')));
    try {
      const { destination: _drop, ...oldSettings } = settings();
      const old = {
        id: '0123456789abcdef',
        kind: 'encode',
        disc: { key: fx.discKey, label: 'Lantern Harbor', dir: fixturePath('fixtures/disc-speech') },
        playlist: '00000',
        episodeSpec: '1-3,4-5',
        settings: oldSettings,
        outDir,
        noSubtitles: true,
        state: 'done',
        paused: false,
        createdAt: '2026-11-01T00:00:00.000Z',
        episodes: [
          { index: 1, state: 'done', framesDone: 1, frames: 1, encoded: true, path: join(outDir, 'ep-01.mkv') },
          // an upload whose completion went unanswered, as a later runner stores it
          {
            index: 2,
            state: 'upload-failed',
            framesDone: 1,
            frames: 1,
            encoded: true,
            path: join(outDir, 'ep-02.mkv'),
            upload: { id: '0123456789abcdef', sha256: 'a'.repeat(64), size: 10, sent: 10, completing: true },
          },
        ],
        recordSavedAt: null,
        cli: '',
      };
      writeFileSync(join(fx.dataDir, 'jobs.json'), JSON.stringify({ jobs: [old] }));
      const runner = startJobRunner(fx.app, deps());
      await runner.ready;
      const job: Job = runner.get(old.id)!;
      expect(job.settings.destination).toBe('folder');
      expect(job.waiting).toBeNull();
      expect(job.episodes[0]!.step).toBeNull();
      expect(job.episodes[0]!.stepDone).toBe(0);
      expect(job.episodes[1]!.upload).toEqual({ id: '0123456789abcdef', sha256: 'a'.repeat(64), size: 10, sent: 10, completing: true });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
