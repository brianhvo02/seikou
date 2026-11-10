// SPDX-License-Identifier: LGPL-3.0-or-later
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureFansubSources } from '@seikou/fansubs/fixture-sources';
import type { FansubAlignment, LibraryListing } from '@seikou/nas/nas-api';
import { EpisodeAudioCache } from '../../src/audio/episode-audio-cache';
import { NasClient } from '../../src/nas/client';
import { ensureMirror, mirrorEntry } from '../../src/nas/mirror';
import { pairWithNas } from '../../src/nas/pairing';
import { episodeAudioCacheOf, episodeAudioKey } from '../../src/server/align-routes';
import type { AppContext, HelperSession } from '../../src/server/http';
import { startHelperServer, type HelperServer } from '../../src/server/server';
import { fixtureAniList } from '../../src/subs/fixture-anilist';
import { haveTools, toolPaths } from '../helpers/tools';
import { startNasTestServer, type NasTestServer } from '../nas/nas-test-server';
import { fx } from '../paths';
import { jsonOf, startRouteFixture, type RouteFixture } from './route-fixture';

interface Span {
  fromMs: number;
  toMs: number;
}
interface AlignAnswer {
  alignment: FansubAlignment;
  trackId: string;
  speech: Span[];
  dialogue: Span[];
}

const timingParam = (t: FansubAlignment): string => Buffer.from(JSON.stringify(t)).toString('base64url');

/** Fetches GroupA's release (Anime Tosho 7001) into the fixture's cache. */
async function fetchGroupA(fixture: RouteFixture): Promise<void> {
  const reply = await fixture.call('/fansubs/fetch', { method: 'POST', body: JSON.stringify({ toshoId: 7001 }) });
  expect(reply.status).toBe(200);
}

const align = (fixture: RouteFixture, episode: number, fileId: string): ReturnType<RouteFixture['send']> =>
  fixture.call(`/episodes/${episode}/align`, { method: 'POST', body: JSON.stringify({ release: 'tosho-7001', fileId }) });

describe.skipIf(!haveTools)('align route with vspipe and BestSource', () => {
  let fixture: RouteFixture;
  beforeAll(async () => {
    fixture = await startRouteFixture({}, toolPaths());
    await fetchGroupA(fixture);
  });
  afterAll(() => fixture.stop());

  it('episode 1 lines up at +1200 ms', async () => {
    const reply = await align(fixture, 1, '7101');
    expect(reply.status).toBe(200);
    const answer = jsonOf<AlignAnswer>(reply);
    expect(answer.alignment.kind).toBe('offset');
    if (answer.alignment.kind !== 'offset') return;
    expect(Math.abs(answer.alignment.offsetMs - 1200)).toBeLessThanOrEqual(30);
    // the Full track, not Signs
    expect(answer.trackId).toBe('t0');
    expect(answer.speech.length).toBeGreaterThanOrEqual(20);
    expect(answer.dialogue).toHaveLength(26);
    expect(answer.dialogue[0]).toEqual({ fromMs: 0, toMs: 2110 });
  }, 120_000);

  it('episode 2 of the fixture answers none with no-speech', async () => {
    const reply = await align(fixture, 2, '7102');
    expect(reply.status).toBe(200);
    expect(jsonOf<AlignAnswer>(reply).alignment).toEqual({ kind: 'none', reason: 'no-speech' });
  }, 120_000);

  it('the BestSource index goes under the data directory', () => {
    expect(readdirNames(join(fixture.dataDir, 'bestsource')).length).toBeGreaterThan(0);
  });
});

function readdirNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

describe('align and subtitle routes without tools', () => {
  let fixture: RouteFixture;
  beforeAll(async () => {
    fixture = await startRouteFixture();
    await fetchGroupA(fixture);
  });
  afterAll(() => fixture.stop());

  it('without tools align answers 503 tools-missing', async () => {
    const reply = await align(fixture, 1, '7101');
    expect(reply.status).toBe(503);
    expect(jsonOf<unknown>(reply)).toEqual({ error: 'tools-missing', message: 'Alignment needs VapourSynth with BestSource (vspipe)' });
  });

  it('the subtitle route applies the timing', async () => {
    const original = readFileSync(join(fixture.dataDir, 'releases', 'tosho-7001', '7101-t0.ass'));
    const plain = await fixture.call('/episodes/1/subtitle?release=tosho-7001&file=7101&track=t0');
    expect(plain.status).toBe(200);
    expect(plain.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(plain.body.equals(original)).toBe(true);

    const timing = timingParam({ kind: 'offset', offsetMs: 1200, confidence: 1 });
    const moved = await fixture.call(`/episodes/1/subtitle?release=tosho-7001&file=7101&track=t0&timing=${timing}`);
    expect(moved.status).toBe(200);
    const firstDialogue = (text: string): string => text.split('\n').find((l) => l.startsWith('Dialogue:'))!;
    expect(firstDialogue(original.toString('utf8'))).toContain('0:00:00.00,0:00:02.11');
    expect(firstDialogue(moved.body.toString('utf8'))).toContain('0:00:01.20,0:00:03.31');
  });

  it('the subtitle route refuses bad requests', async () => {
    expect((await fixture.call('/episodes/1/subtitle?release=tosho-7001&file=7101&track=t9')).status).toBe(404);
    expect((await fixture.call('/episodes/1/subtitle?release=tosho-9999&file=7101&track=t0')).status).toBe(404);
    expect((await fixture.call('/episodes/1/subtitle?release=tosho-7001&file=7101&track=t0&timing=xx')).status).toBe(400);
    const bad = timingParam({ kind: 'offset' } as unknown as FansubAlignment);
    expect((await fixture.call(`/episodes/1/subtitle?release=tosho-7001&file=7101&track=t0&timing=${bad}`)).status).toBe(400);
    expect((await fixture.call('/episodes/9/subtitle?release=tosho-7001&file=7101&track=t0')).status).toBe(404);
  });
});

describe('EpisodeAudioCache', () => {
  it('EpisodeAudioCache shares a decode and evicts the oldest', async () => {
    const calls: number[] = [];
    const cache = new EpisodeAudioCache(async (episode) => {
      calls.push(episode);
      return new Int16Array([episode]);
    }, 2);
    const [a, b] = await Promise.all([cache.get(1), cache.get(1)]);
    expect(a).toBe(b);
    expect(calls).toEqual([1]);
    await cache.get(2);
    await cache.get(1); // 1 is now the most recent
    await cache.get(3); // drops 2
    expect(calls).toEqual([1, 2, 3]);
    await cache.get(1);
    expect(calls).toEqual([1, 2, 3]);
    await cache.get(2);
    expect(calls).toEqual([1, 2, 3, 2]);
  });

  it('one cache per app keeps the last two decodes of every session together', async () => {
    const app = { dataDir: '/nowhere' } as AppContext;
    expect(episodeAudioCacheOf(app)).toBe(episodeAudioCacheOf(app));
    expect(episodeAudioCacheOf(app)).not.toBe(episodeAudioCacheOf({ dataDir: '/nowhere' } as AppContext));
    const a = { id: 'aaaaaaaaaaaaaaaa' } as HelperSession;
    const b = { id: 'bbbbbbbbbbbbbbbb' } as HelperSession;
    expect(episodeAudioKey(a, 1)).not.toBe(episodeAudioKey(b, 1));
    const calls: string[] = [];
    const cache = new EpisodeAudioCache<string>(async (key) => {
      calls.push(key);
      return new Int16Array(1);
    }, 2);
    await cache.get(episodeAudioKey(a, 1));
    await cache.get(episodeAudioKey(b, 1));
    await cache.get(episodeAudioKey(a, 2)); // drops a's episode 1: the budget is shared
    await cache.get(episodeAudioKey(b, 1));
    await cache.get(episodeAudioKey(a, 1));
    expect(calls).toEqual([episodeAudioKey(a, 1), episodeAudioKey(b, 1), episodeAudioKey(a, 2), episodeAudioKey(a, 1)]);
  });

  it('runs one decode at a time', async () => {
    let running = 0;
    let most = 0;
    const cache = new EpisodeAudioCache(async (episode) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return new Int16Array([episode]);
    });
    await Promise.all([cache.get(1), cache.get(2), cache.get(3)]);
    expect(most).toBe(1);
  });

  it('aborts the decode only when every waiter has gone', async () => {
    let loadSignal: AbortSignal | undefined;
    const cache = new EpisodeAudioCache(
      (_episode, signal) =>
        new Promise<Int16Array>((_resolve, reject) => {
          loadSignal = signal;
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const first = new AbortController();
    const second = new AbortController();
    const p1 = cache.get(1, first.signal);
    const p2 = cache.get(1, second.signal);
    await new Promise((r) => setTimeout(r, 0));
    first.abort(new Error('first gone'));
    await expect(p1).rejects.toThrow('first gone');
    expect(loadSignal?.aborted).toBe(false);
    second.abort(new Error('second gone'));
    await expect(p2).rejects.toThrow('second gone');
    expect(loadSignal?.aborted).toBe(true);
  });
});

describe('the line-up on a NAS disc', () => {
  let nas: NasTestServer;
  let server: HelperServer;
  let app: AppContext;
  let sessionId: string;
  let mirrorDir: string;
  const token = 'align-nas-token';

  const call = (sub: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${server.port}/api/sessions/${sessionId}${sub}`, { ...init, headers: { authorization: `Bearer ${token}` } });
  const lineUp = (episode: number): Promise<Response> =>
    call(`/episodes/${episode}/align`, { method: 'POST', body: JSON.stringify({ release: 'tosho-7001', fileId: '7101' }) });
  const nasClip = (name: string): Buffer => readFileSync(join(nas.discsDir!, 'speech/BDMV/STREAM', name));
  const mirrorClip = (name: string): Buffer => readFileSync(join(mirrorDir, 'BDMV/STREAM', name));

  beforeAll(async () => {
    // The speech disc's clips carry a PAT and PMT, which planning reads (the synthetic discs' do not).
    nas = await startNasTestServer({ encodes: false, prepare: (dir) => cpSync(fx('fixtures/disc-speech'), join(dir, 'speech'), { recursive: true }) });
    const dataDir = mkdtempSync(join(tmpdir(), 'align-nas-'));
    await pairWithNas(dataDir, { code: await nas.ownerCode(), base: nas.base }, 'Seikou encoder on test');
    const client = (await NasClient.load(dataDir))!;
    const fansubs = fixtureFansubSources(fx('tests/fixtures/fansubs'));
    const anilist = fixtureAniList(fx('tests/fixtures/fansubs'));
    // Tools that are not there: the line-up gets as far as decoding, which then fails.
    const missing = { vspipe: '/nonexistent/vspipe', svt: '/nonexistent/SvtAv1EncApp', opusenc: '/nonexistent/opusenc' };
    app = {
      dataDir,
      token,
      webDir: null,
      tools: missing,
      sources: { seadex: fansubs.seadex, tosho: fansubs.tosho, anilist: anilist.source, episodes: anilist.episodes, covers: anilist.covers },
      roots: [],
      nas: { client },
    };
    server = await startHelperServer(app);
    const discId = (await client.json<LibraryListing>('library?path=syn')).discs.find((d) => d.name === 'speech')!.id;
    mirrorDir = (await ensureMirror(dataDir, client, discId)).dir;
    sessionId = (await server.sessions.create({ discDir: mirrorDir, playlistId: '00000', episodeSpec: '1-3,4-5' })).id;
    expect((await call('/fansubs/fetch', { method: 'POST', body: JSON.stringify({ toshoId: 7001 }) })).status).toBe(200);
  });
  afterAll(async () => {
    await server.close();
    await nas.close();
    rmSync(app.dataDir, { recursive: true, force: true });
  });

  it("fetches the episode's clips before decoding, and a second line-up fetches nothing", async () => {
    // Episode 1 (chapters 1-3) plays clip 1 alone, which is longer than a head.
    expect(mirrorClip('00001.m2ts').equals(nasClip('00001.m2ts'))).toBe(false);
    // Decoding fails without vspipe, after the fetch.
    expect((await lineUp(1)).status).toBe(500);
    expect(mirrorClip('00001.m2ts').equals(nasClip('00001.m2ts'))).toBe(true);
    expect(await (await call('/episodes/1/fetch')).json()).toEqual({ fetching: null });

    const record = statSync(join(mirrorDir, 'fetch.json')).mtimeMs;
    expect((await lineUp(1)).status).toBe(500);
    // Nothing was fetched: the mirror's record, written after each fetched chunk, is as it was.
    expect(statSync(join(mirrorDir, 'fetch.json')).mtimeMs).toBe(record);
  });

  it("keeps only the last two lined-up episodes' clips whole", async () => {
    // Episodes 1 and 2 play clip 1 (chapters 1-3), episode 3 clip 2 (chapters 4-5).
    const session = await server.sessions.create({ discDir: mirrorDir, playlistId: '00000', episodeSpec: '1,2-3,4-5' });
    const other = session.id;
    const lineUpIn = (episode: number): Promise<Response> =>
      fetch(`http://127.0.0.1:${server.port}/api/sessions/${other}/episodes/${episode}/align`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ release: 'tosho-7001', fileId: '7101' }),
      });
    expect(
      (await fetch(`http://127.0.0.1:${server.port}/api/sessions/${other}/fansubs/fetch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ toshoId: 7001 }),
      })).status,
    ).toBe(200);
    // Clip 2 is shorter than a head, so whether it is held is read from the holders; clip 1 is also held by the first
    // test's session, so being whole shows nothing about this one.
    const key = session.discKey;
    const heldBy = (clip: string): boolean => mirrorEntry(app.dataDir, key).holders.get(`BDMV/STREAM/${clip}`)?.has(`session:${other}`) === true;
    expect((await lineUpIn(3)).status).toBe(500);
    expect((await lineUpIn(1)).status).toBe(500);
    expect([heldBy('00001.M2TS'), heldBy('00002.M2TS')]).toEqual([true, true]);
    // A third line-up lets go of episode 3's clip, which neither kept episode plays; clip 1, which both play, stays.
    expect((await lineUpIn(2)).status).toBe(500);
    expect([heldBy('00001.M2TS'), heldBy('00002.M2TS')]).toEqual([true, false]);
    expect(mirrorClip('00001.m2ts').equals(nasClip('00001.m2ts'))).toBe(true);
    // Lining episode 3 up again drops episode 1, but episode 2 still plays clip 1.
    expect((await lineUpIn(3)).status).toBe(500);
    expect([heldBy('00001.M2TS'), heldBy('00002.M2TS')]).toEqual([true, true]);
  });
});
