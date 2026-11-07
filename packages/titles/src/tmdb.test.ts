import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Pacer } from './pacer';
import { SourceUnavailable } from './sources';
import { createTmdb } from './tmdb';

const KEY = 'k3y-0123456789abcdef';
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8'));
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Answers each TMDB path with its recorded response. */
function fakeTmdb(routes: Record<string, () => Response>): { fetch: typeof globalThis.fetch; urls: URL[] } {
  const urls: URL[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const route = routes[url.pathname];
    return route ? route() : json({ success: false, status_code: 34, status_message: 'The resource you requested could not be found.' }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}
const pacer = (): Pacer => new Pacer(100, 1_000);

describe('createTmdb', () => {
  it('searches TV with the key as api_key and builds poster URLs', async () => {
    const { fetch, urls } = fakeTmdb({ '/3/search/tv': () => json(fixture('tmdb-search-tv.json')) });
    const entries = await createTmdb(fetch, pacer(), KEY).search('Starfall Wanderer', { kind: 'series', year: 2023 });
    expect(urls[0]!.origin).toBe('https://api.themoviedb.org');
    expect(urls[0]!.searchParams.get('api_key')).toBe(KEY);
    expect(urls[0]!.searchParams.get('query')).toBe('Starfall Wanderer');
    expect(urls[0]!.searchParams.get('first_air_date_year')).toBe('2023');
    expect(entries).toEqual([
      {
        source: 'tmdb',
        id: 'tmdb-tv:990101',
        kind: 'series',
        format: null,
        names: { english: 'Starfall Wanderer', romaji: null, native: '星降りの旅人', synonyms: [] },
        animation: true,
        year: 2023,
        startDate: 20230407,
        episodes: null,
        runtimeMin: null,
        seasons: [],
        relations: [],
        poster: { small: 'https://image.tmdb.org/t/p/w342/pStarfallPoster.jpg', large: 'https://image.tmdb.org/t/p/w780/pStarfallPoster.jpg' },
        banner: 'https://image.tmdb.org/t/p/w1280/qXbAckdropStarfall.jpg',
      },
    ]);
  });

  it('searches movies by year', async () => {
    const { fetch, urls } = fakeTmdb({ '/3/search/movie': () => json(fixture('tmdb-search-movie.json')) });
    const entries = await createTmdb(fetch, pacer(), KEY).search('Lanternfall', { kind: 'movie', year: 2019 });
    expect(urls[0]!.searchParams.get('year')).toBe('2019');
    expect(entries).toMatchObject([{ id: 'tmdb-movie:990201', kind: 'movie', year: 2019, names: { english: 'Lanternfall', native: 'Lanternfall' }, animation: false }]);
  });

  it('searches both kinds through search/multi and leaves out people', async () => {
    const { fetch } = fakeTmdb({ '/3/search/multi': () => json(fixture('tmdb-search-multi.json')) });
    const entries = await createTmdb(fetch, pacer(), KEY).search('Lanternfall');
    expect(entries.map((e) => [e.id, e.kind, e.year, e.poster?.small ?? null, e.banner])).toEqual([
      ['tmdb-movie:990201', 'movie', 2019, 'https://image.tmdb.org/t/p/w342/pLanternfall.jpg', null],
      ['tmdb-tv:990202', 'series', null, null, 'https://image.tmdb.org/t/p/w1280/bLanternfallTv.jpg'],
    ]);
  });

  it('reads a TV entry with its seasons from 1, episode counts and episode run time', async () => {
    const { fetch, urls } = fakeTmdb({ '/3/tv/990101': () => json(fixture('tmdb-tv.json')) });
    const entry = await createTmdb(fetch, pacer(), KEY).entry('tmdb-tv:990101');
    expect(urls[0]!.searchParams.get('api_key')).toBe(KEY);
    expect(entry).toMatchObject({
      id: 'tmdb-tv:990101',
      kind: 'series',
      year: 2023,
      episodes: 37,
      runtimeMin: 24,
      seasons: [
        { number: 1, episodes: 24, runtimeMin: 24 },
        { number: 2, episodes: 13, runtimeMin: 24 },
      ],
      poster: { small: 'https://image.tmdb.org/t/p/w342/pStarfallPoster.jpg', large: 'https://image.tmdb.org/t/p/w780/pStarfallPoster.jpg' },
    });
  });

  it('marks animation from genre 16 in genre_ids or genres', async () => {
    const { fetch } = fakeTmdb({ '/3/tv/990101': () => json(fixture('tmdb-tv.json')) });
    expect((await createTmdb(fetch, pacer(), KEY).entry('tmdb-tv:990101'))?.animation).toBe(true);
    const drama = fakeTmdb({ '/3/tv/1': () => json({ id: 1, name: 'Glass Orchard', genres: [{ id: 18, name: 'Drama' }] }) });
    expect((await createTmdb(drama.fetch, pacer(), KEY).entry('tmdb-tv:1'))?.animation).toBe(false);
  });

  it("falls back to the last aired episode's runtime, then to null", async () => {
    const tv = fixture('tmdb-tv.json') as Record<string, unknown>;
    const { fetch } = fakeTmdb({
      '/3/tv/1': () => json({ ...tv, id: 1, episode_run_time: [], last_episode_to_air: { id: 5, runtime: 23, season_number: 2, episode_number: 13 } }),
      '/3/tv/2': () => json({ ...tv, id: 2, episode_run_time: [], last_episode_to_air: null }),
    });
    const tmdb = createTmdb(fetch, pacer(), KEY);
    expect((await tmdb.entry('tmdb-tv:1'))?.runtimeMin).toBe(23);
    const none = await tmdb.entry('tmdb-tv:2');
    expect(none?.runtimeMin).toBeNull();
    expect(none?.seasons[0]?.runtimeMin).toBeNull();
  });

  it('cancels the body of an error response', async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => void (cancelled = true) });
    const fetch = (async () => new Response(body, { status: 500 })) as typeof globalThis.fetch;
    await expect(createTmdb(fetch, pacer(), KEY).search('x')).rejects.toBeInstanceOf(SourceUnavailable);
    expect(cancelled).toBe(true);
  });

  it('reads a movie entry with its runtime', async () => {
    const { fetch } = fakeTmdb({ '/3/movie/990201': () => json(fixture('tmdb-movie.json')) });
    const entry = await createTmdb(fetch, pacer(), KEY).entry('tmdb-movie:990201');
    // the fixture has no genres: unknown, not live action
    expect(entry).toMatchObject({ id: 'tmdb-movie:990201', kind: 'movie', year: 2019, runtimeMin: 118, episodes: null, seasons: [], animation: null });
  });

  it('answers null for an unknown id and for an id of another source', async () => {
    const { fetch, urls } = fakeTmdb({});
    const tmdb = createTmdb(fetch, pacer(), KEY);
    expect(await tmdb.entry('tmdb-tv:1')).toBeNull();
    expect(await tmdb.entry('anilist:1')).toBeNull();
    expect(urls).toHaveLength(1);
  });

  it('never puts the key in a thrown error', async () => {
    const leaky = (async (input: string | URL | Request) => {
      throw new TypeError(`fetch failed: ${String(input)}`);
    }) as typeof globalThis.fetch;
    const failures = [
      createTmdb(leaky, pacer(), KEY).search('x'),
      createTmdb(fakeTmdb({ '/3/search/multi': () => json({ status_message: `Invalid API key: ${KEY}` }, 401) }).fetch, pacer(), KEY).search('x'),
      createTmdb(fakeTmdb({ '/3/tv/5': () => json({}, 503) }).fetch, pacer(), KEY).entry('tmdb-tv:5'),
      createTmdb(fakeTmdb({ '/3/search/multi': () => new Response('not json') }).fetch, pacer(), KEY).search('x'),
    ];
    for (const failure of failures) {
      const error = await failure.then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SourceUnavailable);
      const err = error as Error;
      expect(`${err.message} ${err.stack ?? ''} ${String(err.cause ?? '')}`).not.toContain(KEY);
    }
  });
});
