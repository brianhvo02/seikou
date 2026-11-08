// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { episodeName, type EncodeEvent, type EncodeOptions } from '../../src/encode';
import { DEFAULT_SETTINGS, type EncodeSettings } from '../../src/server/profiles';
import { JobRunner, jobCli, startJobRunner, type Job, type JobProgress, type JobRunnerDeps } from '../../src/server/jobs';
import { safePathSegment } from '../../src/server/job-routes';
import { sessionsOf } from '../../src/server/sessions';
import { appSettings } from '../../src/subs/app-settings';
import { RecordStore, type SubtitleRecord } from '../../src/subs/record';
import { haveTools, toolPaths } from '../helpers/tools';
import { fx as fixturePath } from '../paths';
import { jsonOf, startRouteFixture, type RouteFixture } from './route-fixture';

/** Tool paths the fake encoder never runs; the runner only needs to know some are there. */
const DUMMY_TOOLS = { vspipe: '/nonexistent/vspipe', svt: '/nonexistent/SvtAv1EncApp', opusenc: '/nonexistent/opusenc' };

/** Waits until `cond` holds, polling; fails after five seconds. */
async function until(cond: () => boolean, what = 'condition'): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** One call of the fake encoder: one episode, since the runner encodes one episode per call. */
interface Call {
  readonly options: EncodeOptions;
  readonly onEvent: (e: EncodeEvent) => void;
  readonly episode: number;
  readonly resolve: (paths: string[]) => void;
  readonly reject: (e: unknown) => void;
}

const nameOf = (o: EncodeOptions, n: number): string => join(o.outDir, `${episodeName(o.namePattern, n)}.mkv`);

/** A stand-in for `encodeEpisodes` that the test drives by hand. */
class FakeEncoder {
  readonly calls: Call[] = [];
  private taken = 0;

  readonly encode = (options: EncodeOptions, onEvent: (e: EncodeEvent) => void): Promise<string[]> =>
    new Promise((resolve, reject) => {
      const episode = options.onlyEpisodes?.[0] ?? 0;
      mkdirSync(options.outDir, { recursive: true });
      writeFileSync(`${nameOf(options, episode)}.partial`, 'partial');
      this.calls.push({ options, onEvent, episode, resolve, reject });
      options.signal?.addEventListener('abort', () => reject(new DOMException('The encode was aborted', 'AbortError')), { once: true });
    });

  /** The next call not yet taken. */
  async next(): Promise<Call> {
    await until(() => this.calls.length > this.taken, 'an encode call');
    return this.calls[this.taken++]!;
  }

  /** Whether a call is waiting that was not taken yet. */
  get pending(): boolean {
    return this.calls.length > this.taken;
  }

  /** Completes `call` as the encoder does: rename, the closing 100% progress, then episode-done. */
  static complete(call: Call, frames = 100): void {
    const path = nameOf(call.options, call.episode);
    call.onEvent({ kind: 'episode-start', episode: call.episode, message: `Encoding episode ${call.episode}`, path });
    renameSync(`${path}.partial`, path);
    call.onEvent({ kind: 'progress', episode: call.episode, message: '', framesDone: frames, frames });
    call.onEvent({ kind: 'episode-done', episode: call.episode, message: '', path });
    call.resolve([path]);
  }
}

const settings = (over: Partial<EncodeSettings> = {}): EncodeSettings => ({ ...DEFAULT_SETTINGS, namePattern: 'ep-{n}', ...over });

let fx: RouteFixture;
let fake: FakeEncoder;
let tests: { job: Job; signal: AbortSignal; onEvent: (e: EncodeEvent) => void; resolve: () => void; reject: (e: unknown) => void }[];
let packaged: [string, string][];
let clock: number;
let outRoot: string;

function deps(over: Partial<JobRunnerDeps> = {}): Partial<JobRunnerDeps> {
  return {
    encode: fake.encode,
    runTest: (job, signal, onEvent) =>
      new Promise<void>((resolve, reject) => {
        tests.push({ job, signal, onEvent, resolve, reject });
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
    packageEpisode: async (mkv, out) => {
      packaged.push([mkv, out]);
    },
    now: () => clock,
    ...over,
  };
}

beforeEach(async () => {
  fx = await startRouteFixture({}, DUMMY_TOOLS);
  fake = new FakeEncoder();
  tests = [];
  packaged = [];
  clock = 0;
  outRoot = realpathSync(mkdtempSync(join(tmpdir(), 'jobs-out-')));
});
afterEach(async () => {
  for (const c of fake.calls) c.reject(new Error('test over'));
  for (const t of tests) t.reject(new Error('test over'));
  await fx.stop();
  rmSync(outRoot, { recursive: true, force: true });
});

const input = (over: Partial<Parameters<JobRunner['add']>[0]> = {}): Parameters<JobRunner['add']>[0] => ({
  kind: 'encode',
  discKey: fx.discKey,
  playlistId: '00000',
  episodeSpec: '1-3,4-5',
  settings: settings(),
  outDir: join(outRoot, 'a'),
  noSubtitles: true,
  ...over,
});

const post = (body: unknown) => fx.send('/api/jobs', { method: 'POST', body: JSON.stringify(body) });

/** A valid record for the speech disc with an entry (and a ticked audio stream) for each of `episodes` episodes. */
function record(episodeSpec: string, episodes: number, savedAt: string): SubtitleRecord {
  return {
    disc: { key: fx.discKey, label: 'Lantern Harbor' },
    playlist: '00000',
    episodeSpec,
    anilist: null,
    releases: [],
    fonts: [],
    episodes: Array.from({ length: episodes }, (_, i) => ({
      index: i + 1,
      title: `Part ${i + 1}`,
      tracks: [],
      metadata: { title: `Part ${i + 1}`, video: { name: '', language: 'jpn' }, audio: [{ pid: 0x1100, name: 'Main', language: 'jpn', included: true }], chapters: [] },
    })),
    savedAt,
  };
}

describe('the job runner', () => {
  it('jobs run one at a time in order', async () => {
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    const a = await runner.add(input());
    const b = await runner.add(input({ outDir: join(outRoot, 'b'), episodeSpec: '1-5' }));
    const first = await fake.next();
    expect([first.options.outDir, first.episode]).toEqual([join(outRoot, 'a'), 1]);
    expect(runner.get(a.id)!.state).toBe('running');
    expect(runner.get(b.id)!.state).toBe('queued');
    FakeEncoder.complete(first);
    const second = await fake.next();
    expect([second.options.outDir, second.episode]).toEqual([join(outRoot, 'a'), 2]);
    expect(fake.pending).toBe(false);
    FakeEncoder.complete(second);
    const third = await fake.next();
    expect([third.options.outDir, third.episode]).toEqual([join(outRoot, 'b'), 1]);
    await until(() => runner.get(a.id)!.state === 'done', 'a done');
    expect(runner.get(a.id)!.episodes.map((e) => [e.index, e.state, e.path])).toEqual([
      [1, 'done', join(outRoot, 'a', 'ep-01.mkv')],
      [2, 'done', join(outRoot, 'a', 'ep-02.mkv')],
    ]);
    FakeEncoder.complete(third);
    await until(() => runner.get(b.id)!.state === 'done', 'b done');
    // The settings map onto the encode's options one to one.
    expect(first.options).toMatchObject({ discDir: realpathSync(fixturePath('fixtures/disc-speech')), playlistId: '00000', episodes: '1-3,4-5', namePattern: 'ep-{n}', crf: 25, preset: 4, filmGrain: 4, noPgs: false, noSubtitles: true, record: null, onlyEpisodes: [1] });
    expect(first.options.webDir).toBeUndefined();
    expect(first.options.opusBitrate).toBeUndefined();
    // The jobs survive in jobs.json.
    const stored = JSON.parse(readFileSync(join(fx.dataDir, 'jobs.json'), 'utf8')) as { jobs: Job[] };
    expect(stored.jobs.map((j) => [j.id, j.state])).toEqual([[a.id, 'done'], [b.id, 'done']]);
  });

  it('cancel stops the running job, removes the partial and starts the next', async () => {
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    const a = await runner.add(input());
    const b = await runner.add(input({ outDir: join(outRoot, 'b') }));
    const first = await fake.next();
    expect(existsSync(join(outRoot, 'a', 'ep-01.mkv.partial'))).toBe(true);
    const cancelled = await runner.cancel(a.id);
    expect(cancelled.state).toBe('cancelled');
    expect(first.options.signal!.aborted).toBe(true);
    expect(existsSync(join(outRoot, 'a', 'ep-01.mkv.partial'))).toBe(false);
    expect(cancelled.episodes.map((e) => e.state)).toEqual(['queued', 'queued']);
    const next = await fake.next();
    expect(next.options.outDir).toBe(join(outRoot, 'b'));
    expect(runner.get(b.id)!.state).toBe('running');
    // A queued job is cancelled without running; a finished one cannot be cancelled again.
    const c = await runner.add(input({ outDir: join(outRoot, 'c') }));
    expect((await runner.cancel(c.id)).state).toBe('cancelled');
    await expect(runner.cancel(c.id)).rejects.toMatchObject({ status: 409, code: 'not-cancellable' });
  });

  it('restart marks running jobs interrupted and removes their partial files', async () => {
    const before = startJobRunner(fx.app, deps());
    await before.ready;
    const a = await before.add(input({ settings: settings({ namePattern: 'show-{n}' }) }));
    const queued = await before.add(input({ outDir: join(outRoot, 'b') }));
    await fake.next();
    // The process dies here: jobs.json says running, the partial file stays.
    writeFileSync(join(outRoot, 'a', 'show-02.mkv.partial'), 'old partial');
    writeFileSync(join(outRoot, 'a', 'unrelated.mkv.partial'), 'not this job');
    writeFileSync(join(outRoot, 'a', 'show-01.mkv'), 'a finished file the job never saw');
    const after = new JobRunner(fx.app, deps());
    await after.start();
    const job = after.get(a.id)!;
    expect(job.state).toBe('interrupted');
    expect(job.episodes.map((e) => e.state)).toEqual(['queued', 'queued']);
    expect(readdirSync(join(outRoot, 'a')).sort()).toEqual(['show-01.mkv', 'unrelated.mkv.partial']);
    // Queued jobs stay queued and run.
    await until(() => after.get(queued.id)!.state === 'running', 'the queued job to start');
    await after.shutdown();
  });

  it('retry encodes only unfinished episodes', async () => {
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    const job = await runner.add(input({ episodeSpec: '1-2,3-4,5' }));
    FakeEncoder.complete(await fake.next());
    (await fake.next()).reject(new Error('SvtAv1EncApp failed'));
    await until(() => runner.get(job.id)!.state === 'failed', 'failure');
    expect(runner.get(job.id)!.episodes.map((e) => e.state)).toEqual(['done', 'failed', 'queued']);
    expect(runner.get(job.id)!.error).toMatch(/SvtAv1EncApp failed/);
    await expect(runner.retry(job.id)).resolves.toMatchObject({ state: expect.stringMatching(/queued|running/) });
    const again = await fake.next();
    expect(again.episode).toBe(2);
    FakeEncoder.complete(again);
    const last = await fake.next();
    expect(last.episode).toBe(3);
    FakeEncoder.complete(last);
    await until(() => runner.get(job.id)!.state === 'done', 'done');
    expect(fake.calls.map((c) => c.episode)).toEqual([1, 2, 2, 3]);
    // Only failed, interrupted or cancelled jobs are retried.
    await expect(runner.retry(job.id)).rejects.toMatchObject({ status: 409, code: 'not-retryable' });
  });

  it('a packaging failure is retried by packaging only', async () => {
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    const job = await runner.add(input({ settings: settings({ web: true }) }));
    const first = await fake.next();
    expect(first.options.webDir).toBe(join(outRoot, 'a', 'web'));
    const path = nameOf(first.options, 1);
    renameSync(`${path}.partial`, path);
    first.onEvent({ kind: 'progress', episode: 1, message: '', framesDone: 100, frames: 100 });
    // Encoded but not packaged yet: the episode is not done.
    expect(runner.get(job.id)!.episodes[0]!.state).toBe('running');
    first.onEvent({ kind: 'package-failed', episode: 1, message: 'no AV1 track', path: join(outRoot, 'a', 'web', 'ep-01') });
    first.reject(new Error('no AV1 track'));
    await until(() => runner.get(job.id)!.state === 'failed', 'failure');
    expect(runner.get(job.id)!.episodes.map((e) => e.state)).toEqual(['packaging-failed', 'queued']);
    await runner.retry(job.id);
    const second = await fake.next();
    expect(packaged).toEqual([[path, join(outRoot, 'a', 'web', 'ep-01')]]);
    expect(second.episode).toBe(2);
    expect(fake.calls.map((c) => c.episode)).toEqual([1, 2]);
    second.onEvent({ kind: 'packaged', episode: 2, message: '', path: join(outRoot, 'a', 'web', 'ep-02') });
    FakeEncoder.complete(second);
    await until(() => runner.get(job.id)!.state === 'done', 'done');
    expect(runner.get(job.id)!.episodes.map((e) => e.state)).toEqual(['done', 'done']);
  });

  it('an abort just after the rename keeps the episode done', async () => {
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    const job = await runner.add(input());
    const first = await fake.next();
    const path = nameOf(first.options, 1);
    renameSync(`${path}.partial`, path);
    first.onEvent({ kind: 'progress', episode: 1, message: '', framesDone: 100, frames: 100 });
    // The abort lands before episode-done: the closing progress event already said the file is complete.
    await runner.cancel(job.id);
    expect(runner.get(job.id)!.episodes.map((e) => e.state)).toEqual(['done', 'queued']);
    expect(existsSync(path)).toBe(true);
  });

  it('retry after the record changed encodes every episode', async () => {
    const store = new RecordStore(fx.dataDir);
    await store.write(record('1-3,4-5', 2, '2026-11-08T10:00:00.000Z'));
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    const job = await runner.add(input({ noSubtitles: false }));
    const first = await fake.next();
    expect(first.options.record?.savedAt).toBe('2026-11-08T10:00:00.000Z');
    expect(runner.get(job.id)!.recordSavedAt).toBe('2026-11-08T10:00:00.000Z');
    FakeEncoder.complete(first);
    (await fake.next()).reject(new Error('opusenc failed'));
    await until(() => runner.get(job.id)!.state === 'failed', 'failure');
    await store.write(record('1-3,4-5', 2, '2026-11-08T11:00:00.000Z'));
    await runner.retry(job.id);
    const again = await fake.next();
    expect(again.episode).toBe(1);
    expect(again.options.record?.savedAt).toBe('2026-11-08T11:00:00.000Z');
    FakeEncoder.complete(again);
    FakeEncoder.complete(await fake.next());
    await until(() => runner.get(job.id)!.state === 'done', 'done');
    expect(fake.calls.map((c) => c.episode)).toEqual([1, 2, 1, 2]);
    expect(runner.get(job.id)!.recordSavedAt).toBe('2026-11-08T11:00:00.000Z');
  });

  it('a test job runs at the next episode boundary and the job resumes', async () => {
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    const job = await runner.add(input());
    const first = await fake.next();
    const test = await runner.add(input({ kind: 'test' }));
    expect(test.outDir).toBe(join(fx.dataDir, 'tests', test.id));
    expect(tests).toHaveLength(0);
    FakeEncoder.complete(first);
    await until(() => tests.length === 1, 'the test to start');
    expect(tests[0]!.job.id).toBe(test.id);
    expect(runner.get(job.id)).toMatchObject({ state: 'queued', paused: true });
    expect(runner.get(job.id)!.episodes.map((e) => e.state)).toEqual(['done', 'queued']);
    expect(fake.pending).toBe(false);
    tests[0]!.resolve();
    const second = await fake.next();
    expect(second.episode).toBe(2);
    expect(runner.get(test.id)!.state).toBe('done');
    expect(runner.get(job.id)).toMatchObject({ state: 'running', paused: false });
    FakeEncoder.complete(second);
    await until(() => runner.get(job.id)!.state === 'done', 'done');
    expect(fake.calls.map((c) => c.episode)).toEqual([1, 2]);
    // With nothing running, a test starts at once.
    await runner.add(input({ kind: 'test' }));
    await until(() => tests.length === 2, 'the second test to start');
  });

  it('progress events are at most once a second', async () => {
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    const job = await runner.add(input());
    const seen: [number, JobProgress][] = [];
    runner.events.on('progress', (p: JobProgress) => seen.push([clock, p]));
    const call = await fake.next();
    call.onEvent({ kind: 'episode-start', episode: 1, message: '' });
    for (let i = 1; i < 40; i++) {
      clock += 300;
      call.onEvent({ kind: 'progress', episode: 1, message: '', framesDone: i * 20, frames: 1000 });
    }
    expect(seen.length).toBeGreaterThan(5);
    for (let i = 1; i < seen.length; i++) expect(seen[i]![0] - seen[i - 1]![0]).toBeGreaterThanOrEqual(1000);
    const [at, last] = seen.at(-1)!;
    // 20 frames every 300 ms since the episode started at 0: about 66.7 frames a second.
    expect(last).toMatchObject({ jobId: job.id, episode: 1, frames: 1000 });
    expect(last.fps).toBeCloseTo(last.framesDone / (at / 1000), 5);
    expect(last.etaSeconds).toBe(Math.round((1000 - last.framesDone) / last.fps!));
    expect(runner.get(job.id)!.episodes[0]).toMatchObject({ framesDone: 780, frames: 1000 });
  });

  it('logs every event and state change, and the route answers the tail', async () => {
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    const job = await runner.add(input());
    const call = await fake.next();
    call.onEvent({ kind: 'log', episode: 1, message: 'Leaving out audio stream 0x1101' });
    FakeEncoder.complete(call);
    FakeEncoder.complete(await fake.next());
    await until(() => runner.get(job.id)!.state === 'done', 'done');
    const log = readFileSync(join(fx.dataDir, 'jobs', `${job.id}.log`), 'utf8');
    expect(log).toMatch(/Leaving out audio stream 0x1101/);
    expect(log).toMatch(/running/);
    expect(log.trim().split('\n').at(-1)).toMatch(/done/);
    const tail = await fx.send(`/api/jobs/${job.id}/log?tail=2`);
    expect(tail.status).toBe(200);
    expect(tail.headers['content-type']).toMatch(/^text\/plain/);
    expect(tail.body.toString('utf8').trim().split('\n')).toEqual(log.trim().split('\n').slice(-2));
    expect((await fx.send('/api/jobs/0123456789abcdef/log')).status).toBe(404);
    expect((await fx.send(`/api/jobs/${job.id}/log?tail=nope`)).status).toBe(400);
  });

  it('shutdown cancels the running job and saves it as interrupted', async () => {
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    const job = await runner.add(input());
    const call = await fake.next();
    await runner.shutdown();
    expect(call.options.signal!.aborted).toBe(true);
    const stored = JSON.parse(readFileSync(join(fx.dataDir, 'jobs.json'), 'utf8')) as { jobs: Job[] };
    expect(stored.jobs.find((j) => j.id === job.id)!.state).toBe('interrupted');
    expect(existsSync(join(outRoot, 'a', 'ep-01.mkv.partial'))).toBe(false);
  });

  it('a damaged jobs.json is never overwritten', async () => {
    writeFileSync(join(fx.dataDir, 'jobs.json'), '{ "jobs": [ broken');
    const logged: string[] = [];
    const runner = new JobRunner(fx.app, { ...deps(), log: (m) => logged.push(m) });
    await runner.start();
    expect(runner.list()).toEqual([]);
    expect(logged.join('\n')).toMatch(/jobs\.json/);
    await expect(runner.add(input())).rejects.toMatchObject({ status: 500, code: 'jobs-unreadable' });
    expect(readFileSync(join(fx.dataDir, 'jobs.json'), 'utf8')).toBe('{ "jobs": [ broken');
  });

  it('a damaged jobs.json is an error, not an empty queue, for the list and the stream', async () => {
    writeFileSync(join(fx.dataDir, 'jobs.json'), '{ "jobs": [ broken');
    await startJobRunner(fx.app, { ...deps(), log: () => {} }).ready;
    for (const path of ['/api/jobs', '/api/jobs/events']) {
      const res = await fx.send(path);
      expect([path, res.status]).toEqual([path, 500]);
      expect(jsonOf<{ error: string; message: string }>(res)).toMatchObject({ error: 'jobs-unreadable', message: expect.stringMatching(/jobs\.json/) });
    }
  });

  it("an episode's first report and its closing 100% are never held back", async () => {
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    await runner.add(input());
    const seen: JobProgress[] = [];
    runner.events.on('progress', (p: JobProgress) => seen.push(p));
    const first = await fake.next();
    clock = 10_000;
    first.onEvent({ kind: 'progress', episode: 1, message: '', framesDone: 10, frames: 100 });
    clock += 200;
    first.onEvent({ kind: 'progress', episode: 1, message: '', framesDone: 20, frames: 100 });
    clock += 200;
    // A throttled report, then the closing one at once: the closing one is sent.
    FakeEncoder.complete(first);
    expect(seen.map((p) => [p.episode, p.framesDone])).toEqual([[1, 10], [1, 100]]);
    const second = await fake.next();
    // The next episode's first report comes within the same second, and is sent.
    clock += 100;
    second.onEvent({ kind: 'progress', episode: 2, message: '', framesDone: 5, frames: 100 });
    expect(seen.map((p) => [p.episode, p.framesDone])).toEqual([[1, 10], [1, 100], [2, 5]]);
  });

  it('a tool that fails while the runner stops leaves the job interrupted', async () => {
    const runner = startJobRunner(fx.app, deps());
    await runner.ready;
    const job = await runner.add(input());
    const call = await fake.next();
    // Ctrl-C reached the encoder first: the encode fails with the tool's error before shutdown aborts it.
    call.reject(new Error('SvtAv1EncApp exited with signal SIGINT'));
    await runner.shutdown();
    const stopped = runner.get(job.id)!;
    expect(stopped.state).toBe('interrupted');
    expect(stopped.error).toBeUndefined();
    expect(stopped.episodes.map((e) => e.state)).toEqual(['queued', 'queued']);
  });

  it('the command line is the equivalent encode command, quoted to paste', () => {
    const cli = jobCli({
      discDir: '/discs/Starfall Wanderer/DISC 1',
      playlistId: '00001',
      episodeSpec: '1-3,4-6',
      outDir: "/out/it's here",
      noSubtitles: true,
      settings: settings({ extraSvtArgs: ['--lp', '4'], opusBitrate: 128, pgs: false, web: true, namePattern: 'Starfall {n}' }),
    });
    expect(cli).toBe(
      "seikou-encode encode '/discs/Starfall Wanderer/DISC 1' --playlist 00001 --episodes 1-3,4-6 --out '/out/it'\\''s here' --name 'Starfall {n}' --crf 25 --preset 4 --film-grain 4 --svt-args '--lp 4' --opus-bitrate 128 --no-subtitles --no-pgs --web '/out/it'\\''s here/web'",
    );
    expect(jobCli({ discDir: '/d', playlistId: '00000', episodeSpec: '1-', outDir: '/o', noSubtitles: false, settings: DEFAULT_SETTINGS })).toBe(
      "seikou-encode encode /d --playlist 00000 --episodes 1- --out /o --name 'episode-{n}' --crf 25 --preset 4 --film-grain 4",
    );
  });
});

describe('the job routes', () => {
  beforeEach(async () => {
    await startJobRunner(fx.app, deps()).ready;
  });

  it('a record mismatch is refused with 409', async () => {
    await new RecordStore(fx.dataDir).write(record('1-2,3-5', 2, '2026-11-08T10:00:00.000Z'));
    const body = { discKey: fx.discKey, playlistId: '00000', episodeSpec: '1-3,4-5', settings: settings(), outDir: join(outRoot, 'a') };
    const refused = await post(body);
    expect(refused.status).toBe(409);
    expect(jsonOf(refused)).toMatchObject({ error: 'record-mismatch', recordEpisodeSpec: '1-2,3-5', episodeSpec: '1-3,4-5' });
    expect(jsonOf<{ jobs: Job[] }>(await fx.send('/api/jobs')).jobs).toEqual([]);
    // The same list written another way is no mismatch.
    const same = await post({ ...body, episodeSpec: '1-2, 3-' });
    expect(same.status).toBe(201);
    const ok = await post({ ...body, noSubtitles: true });
    expect(ok.status).toBe(201);
    expect(jsonOf<Job>(ok)).toMatchObject({ kind: 'encode', state: expect.stringMatching(/queued|running/), noSubtitles: true, recordSavedAt: null });
  });

  it('a relative output folder is refused', async () => {
    const body = { discKey: fx.discKey, playlistId: '00000', episodeSpec: '1-3,4-5', settings: settings(), noSubtitles: true };
    const relative = await post({ ...body, outDir: 'out/here' });
    expect(relative.status).toBe(400);
    expect(jsonOf<{ error: string }>(relative).error).toBe('output-not-absolute');
    // Not inside the data directory's own files, the library or the disc.
    const library = realpathSync(mkdtempSync(join(tmpdir(), 'jobs-library-')));
    await appSettings(fx.dataDir).write({ roots: [library] });
    for (const dir of [join(fx.dataDir, 'jobs'), fx.dataDir, join(library, 'Show', 'out'), join(fixturePath('fixtures/disc-speech'), 'out')]) {
      const res = await post({ ...body, outDir: dir });
      expect([dir, res.status, jsonOf<{ error: string }>(res).error]).toEqual([dir, 400, 'output-not-allowed']);
    }
    expect(existsSync(join(library, 'Show'))).toBe(false);
    rmSync(library, { recursive: true, force: true });
    // A folder under <data>/output, or anywhere else, is created.
    const made = await post({ ...body, outDir: join(fx.dataDir, 'output', 'Lantern Harbor', '00000') });
    expect(made.status).toBe(201);
    expect(existsSync(join(fx.dataDir, 'output', 'Lantern Harbor', '00000'))).toBe(true);
    const bad = await post({ ...body, outDir: join(outRoot, 'x'), settings: { ...settings(), crf: 99 } });
    expect(jsonOf(bad)).toMatchObject({ error: 'bad-setting', field: 'crf' });
    const missing = await post({ ...body, outDir: join(outRoot, 'x'), discKey: 'f.0000000000000000000000000000000000000000000000000000000000000000' });
    expect(missing.status).toBe(404);
    const spec = await post({ ...body, outDir: join(outRoot, 'x'), episodeSpec: '1-9' });
    expect(jsonOf<{ error: string }>(spec).error).toBe('bad-episode-spec');
  });

  it('outputs serve only the job\'s own folder', async () => {
    const job = jsonOf<Job>(await post({ discKey: fx.discKey, playlistId: '00000', episodeSpec: '1-3,4-5', settings: settings(), noSubtitles: true, outDir: join(outRoot, 'a') }));
    mkdirSync(join(outRoot, 'a', 'web', 'ep-01'), { recursive: true });
    writeFileSync(join(outRoot, 'a', 'web', 'ep-01', 'episode.json'), '{"ok":true}');
    writeFileSync(join(outRoot, 'secret.txt'), 'not yours');
    symlinkSync(join(outRoot, 'secret.txt'), join(outRoot, 'a', 'link.txt'));
    const ok = await fx.send(`/api/outputs/${job.id}/web/ep-01/episode.json`);
    expect(ok.status).toBe(200);
    expect(ok.body.toString()).toBe('{"ok":true}');
    for (const path of [
      `/api/outputs/${job.id}/../secret.txt`,
      `/api/outputs/${job.id}/%2e%2e/secret.txt`,
      `/api/outputs/${job.id}/%2F${encodeURIComponent(outRoot.slice(1))}%2Fsecret.txt`,
      `/api/outputs/${job.id}//etc/hosts`,
    ]) {
      expect([path, (await rawGet(path)).status]).toEqual([path, 400]);
    }
    expect((await fx.send(`/api/outputs/${job.id}/link.txt`)).status).toBe(404);
    expect((await fx.send(`/api/outputs/${job.id}/web`)).status).toBe(404);
    expect((await fx.send('/api/outputs/0123456789abcdef/web/ep-01/episode.json')).status).toBe(404);
  });

  it('cancel, retry and delete answer through the routes, and the stream sends the jobs', async () => {
    const job = jsonOf<Job>(await post({ discKey: fx.discKey, playlistId: '00000', episodeSpec: '1-3,4-5', settings: settings(), noSubtitles: true, outDir: join(outRoot, 'a') }));
    await fake.next();
    expect((await fx.send(`/api/jobs/${job.id}`, { method: 'DELETE' })).status).toBe(409);
    const stream = await firstEvent('/api/jobs/events');
    expect(stream.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(stream.text).toMatch(/^event: jobs\ndata: /);
    const sent = JSON.parse(stream.text.split('\n')[1]!.slice('data: '.length)) as { jobs: Job[] };
    expect(sent.jobs.map((j) => j.id)).toEqual([job.id]);
    expect(jsonOf<Job>(await fx.send(`/api/jobs/${job.id}/cancel`, { method: 'POST' })).state).toBe('cancelled');
    expect(jsonOf<Job>(await fx.send(`/api/jobs/${job.id}/retry`, { method: 'POST' })).state).toMatch(/queued|running/);
    await fake.next();
    await fx.send(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    expect((await fx.send(`/api/jobs/${job.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(jsonOf<{ jobs: Job[] }>(await fx.send('/api/jobs')).jobs).toEqual([]);
    expect(existsSync(join(fx.dataDir, 'jobs', `${job.id}.log`))).toBe(false);
    expect((await fx.send('/api/jobs/0123456789abcdef/retry', { method: 'POST' })).status).toBe(404);
  });
});

/** A GET sent exactly as written (no client normalisation), with the token. */
function rawGet(path: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: fx.server.port, path, headers: { authorization: 'Bearer route-test-token' } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Opens the event stream and resolves with its headers and the first event's text, then closes it. */
function firstEvent(path: string): Promise<{ headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: fx.server.port, path, headers: { authorization: 'Bearer route-test-token' } }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => {
        text += c.toString('utf8');
        const end = text.indexOf('\n\n');
        if (end >= 0) {
          resolve({ headers: res.headers, text: text.slice(0, end) });
          req.destroy();
        }
      });
    });
    req.on('error', (e) => (e.message.includes('socket hang up') ? undefined : reject(e)));
    req.end();
  });
}

describe.skipIf(!haveTools)('the job runner with the real tools', () => {
  it('encodes disc1 through a queued job', async () => {
    const tools = toolPaths()!;
    const real = await startRouteFixture({}, tools);
    try {
      const session = await sessionsOf(real.app).create({ discDir: fixturePath('fixtures/disc1'), playlistId: '00000', episodeSpec: '1-2,3-4' });
      const runner = startJobRunner(real.app);
      await runner.ready;
      const out = join(outRoot, 'real');
      const job = await runner.add({ kind: 'encode', discKey: session.discKey, playlistId: '00000', episodeSpec: '1-2,3-4', settings: settings({ crf: 40, preset: 8 }), outDir: out, noSubtitles: true });
      const deadline = Date.now() + 540_000;
      while (!['done', 'failed'].includes(runner.get(job.id)!.state) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      const done = runner.get(job.id)!;
      expect(done.error).toBeUndefined();
      expect(done.state).toBe('done');
      expect(done.episodes.map((e) => [e.state, e.framesDone, e.frames])).toEqual([['done', 96, 96], ['done', 96, 96]]);
      expect(readdirSync(out).sort()).toEqual(['ep-01.mkv', 'ep-02.mkv']);
      await runner.shutdown();
    } finally {
      await real.stop();
    }
  }, 600_000);
});

describe('GET /api/jobs/defaults', () => {
  it('answers <data>/output/<disc label>/<playlist>', async () => {
    const reply = await fx.send(`/api/jobs/defaults?disc=${encodeURIComponent(fx.discKey)}&playlist=00000`);
    expect(reply.status).toBe(200);
    expect(jsonOf<{ outDir: string }>(reply).outDir).toBe(join(fx.dataDir, 'output', 'disc-speech', '00000'));
  });

  it('refuses an unknown disc and a bad playlist', async () => {
    expect((await fx.send(`/api/jobs/defaults?disc=${encodeURIComponent('f.' + '0'.repeat(32))}&playlist=00000`)).status).toBe(404);
    expect((await fx.send(`/api/jobs/defaults?disc=${encodeURIComponent(fx.discKey)}&playlist=..%2Fx`)).status).toBe(400);
    expect((await fx.send('/api/jobs/defaults')).status).toBe(400);
  });

  it('makes a disc label one safe path segment', () => {
    expect(safePathSegment('A/B\\C:D')).toBe('A_B_C_D');
    expect(safePathSegment('..')).toBe('disc');
    expect(safePathSegment('  .hidden. ')).toBe('hidden');
    expect(safePathSegment('')).toBe('disc');
    expect(safePathSegment('x'.repeat(300)).length).toBe(100);
  });
});
