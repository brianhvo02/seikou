// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SourceUnavailable } from '@seikou/titles/sources';
import { BadCover } from '../../src/server/covers';
import { jsonOf, startRouteFixture, type RouteFixture } from './route-fixture';

let fixture: RouteFixture;
beforeAll(async () => {
  fixture = await startRouteFixture();
});
afterAll(() => fixture.stop());

describe('title routes', () => {
  it('search finds by text', async () => {
    const reply = await fixture.call('/titles/search?q=lantern%20harbor');
    expect(reply.status).toBe(200);
    const { candidates } = jsonOf<{ candidates: Record<string, unknown>[] }>(reply);
    expect(candidates).toEqual([
      { alId: 900101, title: 'Lantern Harbor', nativeTitle: '灯の港', year: 2024, format: 'TV', episodes: 2, poster: `/api/sessions/${fixture.sessionId}/titles/900101/cover` },
    ]);
  });

  it('serves a searched show\'s cover from its own origin', async () => {
    await fixture.call('/titles/search?q=lantern');
    const reply = await fixture.call('/titles/900101/cover');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('image/png');
    expect(reply.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    expect(reply.body.subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it('answers 404 for a cover no search gave', async () => {
    const reply = await fixture.call('/titles/42/cover');
    expect(reply.status).toBe(404);
    expect(jsonOf<{ error: string }>(reply).error).toBe('not-found');
  });

  it('answers 502 bad-cover and 503 for covers the image host will not give', async () => {
    const own = await startRouteFixture({ covers: { get: async () => Promise.reject(new BadCover('not an image')) } });
    try {
      await own.call('/titles/search?q=lantern');
      const bad = await own.call('/titles/900101/cover');
      expect(bad.status).toBe(502);
      expect(jsonOf<{ error: string }>(bad).error).toBe('bad-cover');
    } finally {
      await own.stop();
    }
    const down = await startRouteFixture({ covers: { get: async () => Promise.reject(new SourceUnavailable('down')) } });
    try {
      await down.call('/titles/search?q=lantern');
      const reply = await down.call('/titles/900101/cover');
      expect(reply.status).toBe(503);
      expect(jsonOf<unknown>(reply)).toEqual({ error: 'source-unavailable', source: 'anilist' });
    } finally {
      await down.stop();
    }
  });

  it('an empty query answers 400', async () => {
    for (const path of ['/titles/search?q=', '/titles/search?q=%20%20', '/titles/search']) {
      const reply = await fixture.call(path);
      expect(reply.status).toBe(400);
      expect(jsonOf<{ error: string }>(reply).error).toBe('empty-query');
    }
  });

  it('episodes route gives titles', async () => {
    const reply = await fixture.call('/titles/900101/episodes');
    expect(jsonOf<{ titles: Record<string, string> }>(reply).titles).toEqual({ '1': 'Arrival', '2': 'The Lighthouse' });
    const none = await fixture.call('/titles/42/episodes');
    expect(jsonOf<{ titles: object }>(none).titles).toEqual({});
  });
});
