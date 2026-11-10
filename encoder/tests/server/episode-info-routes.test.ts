// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EpisodeInfo } from '../../src/plan/episode-info';
import { jsonOf, startRouteFixture, type RouteFixture } from './route-fixture';

describe('episode info routes', () => {
  let fixture: RouteFixture;
  beforeAll(async () => {
    fixture = await startRouteFixture();
  });
  afterAll(() => fixture.stop());

  const path = (key = fixture.discKey, playlist = '00000'): string => `/api/discs/${encodeURIComponent(key)}/playlists/${playlist}/info`;
  const put = (body: unknown, key?: string, playlist?: string) =>
    fixture.send(path(key, playlist), { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('answers null before anything is saved', async () => {
    const reply = await fixture.send(path());
    expect(reply.status).toBe(200);
    expect(jsonOf<{ info: EpisodeInfo | null }>(reply)).toEqual({ info: null });
  });

  it('put then get round-trips', async () => {
    const body = { chapterNames: { '1': 'Avant', '2': 'Opening' }, anilist: { '1': { anilistId: 990001, episode: 1, title: 'Starfall' } } };
    const reply = await put(body);
    expect(reply.status).toBe(200);
    const { info } = jsonOf<{ info: EpisodeInfo }>(reply);
    expect(info).toMatchObject(body);
    expect(typeof info.savedAt).toBe('string');
    expect(jsonOf<{ info: EpisodeInfo | null }>(await fixture.send(path()))).toEqual({ info });
  });

  it('a bad name answers 400 bad-info', async () => {
    const reply = await put({ chapterNames: { '1': '' }, anilist: {} });
    expect(reply.status).toBe(400);
    const body = jsonOf<{ error: string; message: string }>(reply);
    expect(body.error).toBe('bad-info');
    expect(body.message).toMatch(/chapterNames\.1/);
    expect(jsonOf<{ error: string }>(await put('not json')).error).toBe('bad-info');
  });

  it('an unknown disc key answers 404 disc-changed', async () => {
    const key = `f.${'0'.repeat(32)}`;
    const reply = await fixture.send(path(key));
    expect(reply.status).toBe(404);
    expect(jsonOf<{ error: string }>(reply).error).toBe('disc-changed');
    expect((await put({ chapterNames: {}, anilist: {} }, key)).status).toBe(404);
  });

  it('a playlist id that is not five digits answers 400 bad-request', async () => {
    const reply = await fixture.send(path(undefined, '0000'));
    expect(reply.status).toBe(400);
    expect(jsonOf<{ error: string }>(reply).error).toBe('bad-request');
  });

  it('a body over 64 KiB answers 413', async () => {
    const reply = await put({ chapterNames: { '1': 'x'.repeat(70 * 1024) }, anilist: {} });
    expect(reply.status).toBe(413);
    expect(jsonOf<{ error: string }>(reply).error).toBe('too-large');
  });
});
