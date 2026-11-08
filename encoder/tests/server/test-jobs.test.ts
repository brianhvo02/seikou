// SPDX-License-Identifier: LGPL-3.0-or-later
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPlaylist } from '../../src/disc/playlist';
import type { EncodeEvent, PlanEncodeOptions } from '../../src/encode';
import { readIvf } from '../../src/mux/ivf';
import { Id } from '../../src/mux/mkv-ids';
import { readMkv } from '../../src/mux/mkv-reader';
import { writeMkv } from '../../src/mux/mkv-writer';
import { readOggOpus } from '../../src/mux/ogg';
import { startJobRunner, type Job, type JobRunnerDeps } from '../../src/server/jobs';
import { DEFAULT_SETTINGS, type EncodeSettings } from '../../src/server/profiles';
import { planTest, projectedBytes, runTestEncode, testStretches, type TestOutcome, type TestProfile } from '../../src/server/test-encode';
import { childOf, findAll, parseMkv, stringOf } from '../helpers/ebml-reader';
import { haveTools, toolPaths } from '../helpers/tools';
import { fx as fixturePath } from '../paths';
import { jsonOf, startRouteFixture, type RouteFixture } from './route-fixture';

const DUMMY_TOOLS = { vspipe: '/nonexistent/vspipe', svt: '/nonexistent/SvtAv1EncApp', opusenc: '/nonexistent/opusenc' };

async function until(cond: () => boolean, what = 'condition', ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settings = (over: Partial<EncodeSettings> = {}): EncodeSettings => ({ ...DEFAULT_SETTINGS, ...over });
const profile = (id: string, over: Partial<EncodeSettings> = {}): TestProfile => ({ id, name: `Profile ${id}`, settings: settings(over) });

/**
 * A stand-in for `encodePlan` that writes a small real MKV: the AV1 fixture as the video, and the Opus fixture as each
 * audio stream it is asked for. It records every call.
 */
class FakePlanEncoder {
  readonly calls: PlanEncodeOptions[] = [];
  readonly encodePlan = async (o: PlanEncodeOptions, onEvent: (e: EncodeEvent) => void): Promise<void> => {
    this.calls.push(o);
    if (o.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const ivf = await readIvf(createReadStream(fixturePath('fixtures/small.ivf')));
    const seq = await ivf.sequenceHeader;
    const oggs = await Promise.all(o.audio.map(() => readOggOpus(createReadStream(fixturePath('fixtures/tone.opus')))));
    await writeMkv(o.outPath, {
      video: { width: 64, height: 64, fpsNum: 24000, fpsDen: 1001, codecPrivate: seq.av1C, name: '', language: 'und', isDefault: true },
      videoPackets: ivf.packets,
      audio: oggs.map((ogg) => ({
        name: '',
        language: 'jpn',
        isDefault: true,
        channels: 2,
        sampleRate: 48000,
        codecPrivate: ogg.head.raw,
        codecDelayNs: (BigInt(ogg.head.preSkip) * 1_000_000_000n) / 48000n,
        seekPreRollNs: 80_000_000n,
        packets: ogg.packets,
        end: ogg.end,
      })),
      subtitles: [],
      attachments: [],
      chapters: [],
    });
    onEvent({ kind: 'progress', episode: o.plan.index, message: '', framesDone: o.plan.frameCount, frames: o.plan.frameCount });
  };
}

/** The DocType and the codec ids of the tracks of a Matroska or WebM file. */
function describeFile(path: string): { docType: string; codecs: string[] } {
  const tree = parseMkv(readFileSync(path));
  const ebml = tree.children!.find((n) => n.id === Id.EBML)!;
  const docType = stringOf(childOf(ebml, Id.DocType)!);
  const codecs = findAll(tree, Id.TrackEntry).map((t) => stringOf(childOf(t, Id.CodecID)!));
  return { docType, codecs };
}

/** A test outcome with the same made-up measurements for each profile id. */
const outcome = (ids: string[]): TestOutcome => ({ audioStreams: 2, results: ids.map((id) => ({ id, videoBytesPerSecond: 1000, audioBytesPerSecond: 100 })) });

let fx: RouteFixture;
beforeEach(async () => {
  fx = await startRouteFixture({}, DUMMY_TOOLS);
});
afterEach(async () => {
  await fx.stop();
});

describe('test stretches', () => {
  it('a test plans five 10 s stretches in the first episode', async () => {
    const runner = startJobRunner(fx.app, { runTest: () => new Promise(() => undefined) });
    await runner.ready;
    const job = await runner.add({ kind: 'test', discKey: fx.discKey, playlistId: '00000', episodeSpec: '1-3,4-5', profiles: [profile('default'), profile('abc', { crf: 30 })] });
    // The first episode is chapters 1 to 3 of the speech disc: 0 to 90 s.
    const stretches = job.test!.stretches;
    expect(stretches).toHaveLength(5);
    for (const s of stretches) expect(s.endMs - s.startMs).toBe(10_000);
    expect(stretches[0]!.startMs).toBe(4500);
    expect(stretches.at(-1)!.endMs).toBe(85_500);
    for (let i = 1; i < stretches.length; i++) expect(stretches[i]!.startMs).toBeGreaterThanOrEqual(stretches[i - 1]!.endMs);
    expect(job.test!.episodeSeconds).toEqual([90, 60]);
    // One progress unit per sample encode: five stretches by two profiles.
    expect(job.episodes).toHaveLength(10);
    expect(job.settings).toEqual(settings());
    expect(job.outDir).toBe(join(fx.dataDir, 'tests', job.id));
  });

  it('a short episode gets shorter stretches that never overlap or run past it', async () => {
    // disc1 is 8 s with a chapter every 2 s: its first episode here is 4 s.
    const playlist = await loadPlaylist(fixturePath('fixtures/disc1'), '00000');
    const { stretches, episodeSeconds } = planTest(playlist, '1-2,3-4');
    expect(episodeSeconds).toEqual([4, 4]);
    expect(stretches.length).toBeGreaterThanOrEqual(1);
    for (const s of stretches) {
      expect(s.endMs - s.startMs).toBeLessThanOrEqual(Math.ceil(4000 / 6));
      expect(s.startMs).toBeGreaterThanOrEqual(0);
      expect(s.endMs).toBeLessThanOrEqual(4000);
    }
    for (let i = 1; i < stretches.length; i++) expect(stretches[i]!.startMs).toBeGreaterThanOrEqual(stretches[i - 1]!.endMs);
    // Fifty-nine seconds: still five stretches, each a sixth of the episode.
    const almost = testStretches({ startMs: 1000, endMs: 60_000 });
    expect(almost).toHaveLength(5);
    for (const s of almost) expect(s.endMs - s.startMs).toBeLessThanOrEqual(Math.ceil(59_000 / 6));
    expect(almost.at(-1)!.endMs).toBeLessThanOrEqual(60_000);
    expect(testStretches({ startMs: 0, endMs: 3 }).length).toBeGreaterThanOrEqual(1);
  });

  it('projected size adds the audio once per audio stream', () => {
    const result = { id: 'a', videoBytesPerSecond: 100_000, audioBytesPerSecond: 20_000 };
    expect(projectedBytes(1440, result, 1)).toBe(120_000 * 1440);
    expect(projectedBytes(1440, result, 3)).toBe(160_000 * 1440);
    expect(projectedBytes(1440, result, 0)).toBe(100_000 * 1440);
  });

  it('a test refuses no profiles, more than three, or the same profile twice', async () => {
    const post = (body: unknown) => fx.send('/api/jobs', { method: 'POST', body: JSON.stringify(body) });
    const base = { kind: 'test', discKey: fx.discKey, playlistId: '00000', episodeSpec: '1-3,4-5' };
    expect((await post({ ...base, profiles: [] })).status).toBe(400);
    expect((await post({ ...base, profiles: ['a', 'b', 'c', 'd'].map((id) => profile(id)) })).status).toBe(400);
    expect((await post({ ...base, profiles: [profile('a'), profile('a')] })).status).toBe(400);
    const bad = await post({ ...base, profiles: [profile('a', { crf: 99 })] });
    expect(jsonOf(bad)).toMatchObject({ error: 'bad-setting', field: 'crf' });
  });
});

describe('a test run', () => {
  it('audio is encoded once and shared', async () => {
    const fake = new FakePlanEncoder();
    const job = {
      id: '00000000000000aa',
      disc: { dir: fixturePath('fixtures/disc-speech') },
      playlist: '00000',
      episodeSpec: '1-3,4-5',
      noSubtitles: true,
      test: { profiles: [profile('p1', { opusBitrate: 96 }), profile('p2', { crf: 40, opusBitrate: 256 })], stretches: planTest(await loadPlaylist(fixturePath('fixtures/disc-speech'), '00000'), '1-3,4-5').stretches },
    };
    const events: EncodeEvent[] = [];
    const outcome: TestOutcome = await runTestEncode(job, { dataDir: fx.dataDir, tools: DUMMY_TOOLS }, new AbortController().signal, (e) => events.push(e), fake);
    expect(fake.calls).toHaveLength(10);
    const withAudio = fake.calls.filter((c) => c.audio.length > 0);
    expect(withAudio).toHaveLength(5);
    // The audio rides with the first profile's encode, at the first profile's bitrate.
    for (const c of withAudio) expect(c.crf).toBe(DEFAULT_SETTINGS.crf);
    for (const c of fake.calls) expect(c.opusBitrate).toBe(96);
    expect(fake.calls.filter((c) => c.crf === 40)).toHaveLength(5);
    const dir = join(fx.dataDir, 'tests', job.id);
    for (const p of ['p1', 'p2']) {
      expect(readdirSync(join(dir, p)).sort()).toEqual(['1.webm', '2.webm', '3.webm', '4.webm', '5.webm']);
      for (let n = 1; n <= 5; n++) {
        const file = describeFile(join(dir, p, `${n}.webm`));
        expect(file.docType).toBe('webm');
        expect(file.codecs).toEqual(['V_AV1', 'A_OPUS']);
      }
    }
    expect(existsSync(join(dir, 'work'))).toBe(false);
    // The second profile's sample carries the first profile's audio blocks.
    const a = await readMkv(join(dir, 'p1', '1.webm'));
    const b = await readMkv(join(dir, 'p2', '1.webm'));
    const audioOf = async (m: typeof a): Promise<number[]> => {
      const out: number[] = [];
      for await (const blk of m.blocks()) if (blk.track === 2) out.push(blk.data.length);
      return out;
    };
    expect(await audioOf(b)).toEqual(await audioOf(a));
    expect(outcome.results.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(outcome.results[0]!.audioBytesPerSecond).toBeGreaterThan(0);
    expect(outcome.results[1]!.audioBytesPerSecond).toBe(outcome.results[0]!.audioBytesPerSecond);
    expect(outcome.results[0]!.videoBytesPerSecond).toBeGreaterThan(0);
    // The speech disc has one audio stream.
    expect(outcome.audioStreams).toBe(1);
    // One unit per sample encode, in stretch then profile order.
    expect(events.filter((e) => e.kind === 'episode-done').map((e) => e.episode)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(events.filter((e) => e.kind === 'progress').map((e) => e.episode)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('an aborted test leaves no partial sample and rejects with an AbortError', async () => {
    const controller = new AbortController();
    const fake = new FakePlanEncoder();
    let calls = 0;
    const encodePlan: typeof fake.encodePlan = async (o, onEvent) => {
      calls += 1;
      if (calls === 3) controller.abort();
      return fake.encodePlan(o, onEvent);
    };
    const job = {
      id: '00000000000000bb',
      disc: { dir: fixturePath('fixtures/disc-speech') },
      playlist: '00000',
      episodeSpec: '1-3,4-5',
      noSubtitles: true,
      test: { profiles: [profile('p1')], stretches: [{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 3000 }, { startMs: 4000, endMs: 5000 }] },
    };
    await expect(runTestEncode(job, { dataDir: fx.dataDir, tools: DUMMY_TOOLS }, controller.signal, () => undefined, { encodePlan })).rejects.toMatchObject({ name: 'AbortError' });
    const dir = join(fx.dataDir, 'tests', job.id);
    expect(readdirSync(join(dir, 'p1')).sort()).toEqual(['1.webm', '2.webm']);
    expect(existsSync(join(dir, 'work'))).toBe(false);
  });
});

describe('test jobs in the runner', () => {
  it('stores the results in the job, so a reload shows them', async () => {
    const deps: Partial<JobRunnerDeps> = {
      runTest: async (job, _signal, onEvent) => {
        onEvent({ kind: 'episode-start', episode: 1, message: '' });
        onEvent({ kind: 'progress', episode: 1, message: '', framesDone: 5, frames: 10 });
        onEvent({ kind: 'progress', episode: 1, message: '', framesDone: 10, frames: 10 });
        onEvent({ kind: 'episode-done', episode: 1, message: '', path: join(job.outDir, 'a', '1.webm') });
        return outcome(['a']);
      },
    };
    const runner = startJobRunner(fx.app, deps);
    await runner.ready;
    const job = await runner.add({ kind: 'test', discKey: fx.discKey, playlistId: '00000', episodeSpec: '1-3,4-5', profiles: [profile('a')] });
    await until(() => runner.get(job.id)!.state === 'done', 'the test to finish');
    const done = runner.get(job.id)!;
    expect(done.test!.results).toEqual(outcome(['a']).results);
    expect(done.test!.audioStreams).toBe(2);
    expect(done.episodes[0]).toMatchObject({ state: 'done', framesDone: 10, frames: 10 });
    const stored = JSON.parse(readFileSync(join(fx.dataDir, 'jobs.json'), 'utf8')) as { jobs: Job[] };
    expect(stored.jobs[0]!.test!.results).toEqual(outcome(['a']).results);
    // A fresh runner reads them back.
    const again = startJobRunner(fx.app, deps);
    await again.ready;
    expect(again.get(job.id)!.test).toEqual(done.test);
  });

  it("a test job's sample folder is removed with the job", async () => {
    const runner = startJobRunner(fx.app, {
      runTest: async (job) => {
        mkdirSync(join(job.outDir, 'a'), { recursive: true });
        writeFileSync(join(job.outDir, 'a', '1.webm'), 'sample');
        return outcome(['a']);
      },
    });
    await runner.ready;
    const job = await runner.add({ kind: 'test', discKey: fx.discKey, playlistId: '00000', episodeSpec: '1-3,4-5', profiles: [profile('a')] });
    await until(() => runner.get(job.id)!.state === 'done', 'the test to finish');
    expect(existsSync(join(fx.dataDir, 'tests', job.id, 'a', '1.webm'))).toBe(true);
    await runner.remove(job.id);
    expect(existsSync(join(fx.dataDir, 'tests', job.id))).toBe(false);
  });

  it('an interrupted test loses its folder at start, and a retry runs it again from scratch', async () => {
    const runs: string[] = [];
    let hold = true;
    const deps: Partial<JobRunnerDeps> = {
      runTest: (job, signal) =>
        new Promise((resolve, reject) => {
          runs.push(job.id);
          mkdirSync(join(job.outDir, 'a'), { recursive: true });
          writeFileSync(join(job.outDir, 'a', `${runs.length}.webm`), 'sample');
          if (!hold) return resolve(outcome(['a']));
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }),
    };
    const first = startJobRunner(fx.app, deps);
    await first.ready;
    const job = await first.add({ kind: 'test', discKey: fx.discKey, playlistId: '00000', episodeSpec: '1-3,4-5', profiles: [profile('a')] });
    await until(() => runs.length === 1, 'the test to start');
    // A crash: the stored job still says running.
    const stored = JSON.parse(readFileSync(join(fx.dataDir, 'jobs.json'), 'utf8')) as { jobs: Job[] };
    expect(stored.jobs[0]!.state).toBe('running');
    await first.shutdown();
    writeFileSync(join(fx.dataDir, 'jobs.json'), JSON.stringify(stored));
    const second = startJobRunner(fx.app, deps);
    await second.ready;
    expect(second.get(job.id)!.state).toBe('interrupted');
    expect(existsSync(join(fx.dataDir, 'tests', job.id))).toBe(false);
    hold = false;
    await second.retry(job.id);
    await until(() => second.get(job.id)!.state === 'done', 'the retried test to finish');
    expect(readdirSync(join(fx.dataDir, 'tests', job.id, 'a'))).toEqual(['2.webm']);
    expect(second.get(job.id)!.episodes.every((e) => e.state === 'queued' || e.state === 'done')).toBe(true);
  });

  it('a failed test keeps its error', async () => {
    const runner = startJobRunner(fx.app, { runTest: () => Promise.reject(new Error('SvtAv1EncApp stopped')) });
    await runner.ready;
    const job = await runner.add({ kind: 'test', discKey: fx.discKey, playlistId: '00000', episodeSpec: '1-3,4-5', profiles: [profile('a')] });
    await until(() => runner.get(job.id)!.state === 'failed', 'the test to fail');
    expect(runner.get(job.id)!.error).toBe('SvtAv1EncApp stopped');
    expect(runner.get(job.id)!.test!.results).toBeNull();
  });
});

describe('the samples route', () => {
  /** A GET sent exactly as written, with the token and any more headers. */
  function rawGet(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: fx.server.port, path, headers: { authorization: 'Bearer route-test-token', ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('serves a sample with ranges and refuses .., other jobs and links', async () => {
    const runner = startJobRunner(fx.app, {
      runTest: async (job) => {
        mkdirSync(join(job.outDir, 'a'), { recursive: true });
        writeFileSync(join(job.outDir, 'a', '1.webm'), '0123456789');
        return outcome(['a']);
      },
    });
    await runner.ready;
    const one = await runner.add({ kind: 'test', discKey: fx.discKey, playlistId: '00000', episodeSpec: '1-3,4-5', profiles: [profile('a')] });
    await until(() => runner.get(one.id)!.state === 'done', 'the first test');
    const two = await runner.add({ kind: 'test', discKey: fx.discKey, playlistId: '00000', episodeSpec: '1-3,4-5', profiles: [profile('a')] });
    await until(() => runner.get(two.id)!.state === 'done', 'the second test');

    const whole = await rawGet(`/api/tests/${one.id}/a/1.webm`);
    expect(whole.status).toBe(200);
    expect(whole.headers['content-type']).toBe('video/webm');
    expect(whole.body.toString()).toBe('0123456789');
    const part = await rawGet(`/api/tests/${one.id}/a/1.webm`, { range: 'bytes=2-4' });
    expect(part.status).toBe(206);
    expect(part.body.toString()).toBe('234');
    expect(part.headers['content-range']).toBe('bytes 2-4/10');

    const dirOne = realpathSync(join(fx.dataDir, 'tests', one.id));
    const dirTwo = realpathSync(join(fx.dataDir, 'tests', two.id));
    // A link to another job's sample, and a profile folder that links to another job's folder.
    symlinkSync(join(dirTwo, 'a', '1.webm'), join(dirOne, 'a', '2.webm'));
    symlinkSync(join(dirTwo, 'a'), join(dirOne, 'b'));
    // A link to a sample inside the job's own folder is refused as well.
    symlinkSync(join(dirOne, 'a', '1.webm'), join(dirOne, 'a', '3.webm'));
    for (const path of [
      `/api/tests/${one.id}/../${two.id}/a/1.webm`,
      `/api/tests/${one.id}/%2e%2e/1.webm`,
      `/api/tests/${one.id}/a/..%2F..%2F${two.id}%2Fa%2F1.webm`,
      `/api/tests/${one.id}/a/2.webm`,
      `/api/tests/${one.id}/b/1.webm`,
      `/api/tests/${one.id}/a/3.webm`,
      `/api/tests/${one.id}/a/9.webm`,
      `/api/tests/${one.id}/a/1.mkv`,
      `/api/tests/0123456789abcdef/a/1.webm`,
    ]) {
      expect([path, (await rawGet(path)).status >= 400]).toEqual([path, true]);
      expect([path, (await rawGet(path)).body.toString()]).not.toEqual([path, '0123456789']);
    }
    // Only a test job's folder is served.
    const encode = await runner.add({ discKey: fx.discKey, playlistId: '00000', episodeSpec: '1-3,4-5', settings: settings(), outDir: join(fx.dataDir, 'output', 'x'), noSubtitles: true });
    expect((await rawGet(`/api/tests/${encode.id}/a/1.webm`)).status).toBe(404);
    await runner.cancel(encode.id);
  });
});

describe.skipIf(!haveTools)('a test encode with the real tools', () => {
  it('a one-profile test on disc-speech writes five playable WebM samples', async () => {
    const real = await startRouteFixture({}, toolPaths()!);
    try {
      const runner = startJobRunner(real.app);
      await runner.ready;
      const job = await runner.add({ kind: 'test', discKey: real.discKey, playlistId: '00000', episodeSpec: '1-3,4-5', profiles: [profile('fast', { preset: 12, crf: 40, filmGrain: 0 })] });
      await until(() => ['done', 'failed'].includes(runner.get(job.id)!.state), 'the test to finish', 280_000);
      const done = runner.get(job.id)!;
      expect(done.error).toBeUndefined();
      expect(done.state).toBe('done');
      const dir = join(real.dataDir, 'tests', job.id, 'fast');
      expect(readdirSync(dir).sort()).toEqual(['1.webm', '2.webm', '3.webm', '4.webm', '5.webm']);
      for (let n = 1; n <= 5; n++) {
        const file = describeFile(join(dir, `${n}.webm`));
        expect(file.docType).toBe('webm');
        expect(file.codecs).toEqual(['V_AV1', 'A_OPUS']);
      }
      const [result] = done.test!.results!;
      expect(result!.videoBytesPerSecond).toBeGreaterThan(0);
      expect(result!.audioBytesPerSecond).toBeGreaterThan(0);
      expect(done.test!.audioStreams).toBe(1);
      expect(done.episodes.every((e) => e.state === 'done')).toBe(true);
      await runner.shutdown();
    } finally {
      await real.stop();
    }
  }, 300_000);
});
