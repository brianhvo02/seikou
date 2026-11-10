// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SourceUnavailable, type Entry } from '@seikou/titles/sources';
import { pickSequel } from '../../src/server/anilist-routes';
import { jsonOf, startRouteFixture, type RouteFixture } from './route-fixture';

let fixture: RouteFixture;
beforeAll(async () => {
  fixture = await startRouteFixture();
});
afterAll(() => fixture.stop());

const STARFALL = {
  alId: 990010,
  title: 'Starfall Wanderer',
  nativeTitle: '流星の旅人',
  year: 2023,
  format: 'TV',
  episodes: 12,
  poster: '/api/anilist/990010/cover',
};

describe('app AniList routes', () => {
  it('search finds a show, its poster under the app route', async () => {
    const reply = await fixture.send('/api/anilist/search?q=starfall%20wanderer');
    expect(reply.status).toBe(200);
    const { candidates } = jsonOf<{ candidates: { alId: number }[] }>(reply);
    expect(candidates[0]).toEqual(STARFALL);
    expect(candidates.map((c) => c.alId)).toEqual([990010, 990011, 990012]);
  });

  it('a blank query answers 400', async () => {
    for (const path of ['/api/anilist/search?q=', '/api/anilist/search?q=%20', '/api/anilist/search']) {
      const reply = await fixture.send(path);
      expect(reply.status).toBe(400);
      expect(jsonOf<{ error: string }>(reply).error).toBe('empty-query');
    }
  });

  it('an entry names its next season, passing over a film', async () => {
    const reply = await fixture.send('/api/anilist/990010');
    expect(reply.status).toBe(200);
    expect(jsonOf<unknown>(reply)).toEqual({
      entry: {
        ...STARFALL,
        sequel: { alId: 990011, title: 'Starfall Wanderer 2', nativeTitle: '流星の旅人 2', year: 2025, format: 'TV', episodes: 12, poster: null },
      },
    });
  });

  it('an entry with no series sequel has sequel null', async () => {
    const reply = await fixture.send('/api/anilist/990011');
    expect(jsonOf<{ entry: { alId: number; sequel: unknown } }>(reply).entry).toMatchObject({ alId: 990011, sequel: null });
  });

  it('an unknown id answers 404', async () => {
    const reply = await fixture.send('/api/anilist/990099');
    expect(reply.status).toBe(404);
    expect(jsonOf<{ error: string }>(reply).error).toBe('not-found');
    expect((await fixture.send('/api/anilist/abc')).status).toBe(404);
  });

  it('episodes answers the recorded titles', async () => {
    const reply = await fixture.send('/api/anilist/990010/episodes');
    expect(reply.status).toBe(200);
    expect(jsonOf<{ titles: Record<string, string> }>(reply).titles).toEqual({ '1': 'The Falling Star', '2': 'Road to the Pass' });
  });

  it('serves the cover an entry lookup gave', async () => {
    const own = await startRouteFixture();
    try {
      expect((await own.send('/api/anilist/990010/cover')).status).toBe(404);
      await own.send('/api/anilist/990010');
      const reply = await own.send('/api/anilist/990010/cover');
      expect(reply.status).toBe(200);
      expect(reply.headers['content-type']).toBe('image/png');
    } finally {
      await own.stop();
    }
  });

  it('a failing AniList answers 503, and a failing sequel lookup only drops the sequel', async () => {
    const down = await startRouteFixture({
      anilist: {
        search: async () => Promise.reject(new SourceUnavailable('down')),
        entry: async () => Promise.reject(new SourceUnavailable('down')),
      },
    });
    try {
      for (const path of ['/api/anilist/search?q=starfall', '/api/anilist/990010']) {
        const reply = await down.send(path);
        expect(reply.status).toBe(503);
        expect(jsonOf<unknown>(reply)).toEqual({ error: 'source-unavailable', source: 'anilist' });
      }
    } finally {
      await down.stop();
    }
    const first = fixture.app.sources.anilist;
    const flaky = await startRouteFixture({
      anilist: {
        search: first.search.bind(first),
        entry: async (id) => (id === 'anilist:990010' ? first.entry(id) : Promise.reject(new SourceUnavailable('down'))),
      },
    });
    try {
      const reply = await flaky.send('/api/anilist/990010');
      expect(reply.status).toBe(200);
      expect(jsonOf<{ entry: { sequel: unknown } }>(reply).entry.sequel).toBeNull();
    } finally {
      await flaky.stop();
    }
  });
});

describe('pickSequel', () => {
  const rel = (id: number, format: string | null, startDate: number | null, type = 'SEQUEL'): Entry['relations'][number] => ({ type, id: `anilist:${id}`, format, startDate });

  it('takes the earliest series sequel by year, month, then day, unknown parts last', () => {
    expect(pickSequel([rel(1, 'TV', 20250300), rel(2, 'ONA', 20250315), rel(3, 'TV_SHORT', 20250000)])).toBe(2);
    expect(pickSequel([rel(1, 'TV', null), rel(2, 'TV', 20300000)])).toBe(2);
    expect(pickSequel([rel(1, 'TV', 20250101), rel(2, 'TV', 20250101)])).toBe(1);
  });

  it('passes over films, other formats and other relations', () => {
    expect(pickSequel([rel(1, 'MOVIE', 20200101), rel(2, 'OVA', 20200101), rel(3, 'TV', 20190101, 'PREQUEL'), rel(4, null, 20200101)])).toBeNull();
    expect(pickSequel([])).toBeNull();
  });
});
