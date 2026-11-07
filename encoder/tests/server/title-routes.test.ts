// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jsonOf, startRouteFixture, type RouteFixture } from './route-fixture';

let fixture: RouteFixture;
beforeAll(async () => {
  fixture = await startRouteFixture();
});
afterAll(() => fixture.stop());

describe('title routes', () => {
  it('search finds by text', async () => {
    const reply = await fixture.send('/api/titles/search?q=lantern');
    expect(reply.status).toBe(200);
    const { candidates } = jsonOf<{ candidates: Record<string, unknown>[] }>(reply);
    expect(candidates).toEqual([
      { alId: 900101, title: 'Lantern Harbor', nativeTitle: '灯の港', year: 2024, format: 'TV', episodes: 2, poster: null },
    ]);
  });

  it('an empty query answers 400', async () => {
    for (const path of ['/api/titles/search?q=', '/api/titles/search?q=%20%20', '/api/titles/search']) {
      const reply = await fixture.send(path);
      expect(reply.status).toBe(400);
      expect(jsonOf<{ error: string }>(reply).error).toBe('empty-query');
    }
  });

  it('episodes route gives titles', async () => {
    const reply = await fixture.send('/api/titles/900101/episodes');
    expect(jsonOf<{ titles: Record<string, string> }>(reply).titles).toEqual({ '1': 'Arrival', '2': 'The Lighthouse' });
    const none = await fixture.send('/api/titles/42/episodes');
    expect(jsonOf<{ titles: object }>(none).titles).toEqual({});
  });
});
