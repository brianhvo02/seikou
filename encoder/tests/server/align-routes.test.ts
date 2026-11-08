// SPDX-License-Identifier: LGPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FansubAlignment } from '@seikou/nas/nas-api';
import { EpisodeAudioCache } from '../../src/audio/episode-audio-cache';
import { haveTools, toolPaths } from '../helpers/tools';
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
