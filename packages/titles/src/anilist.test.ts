import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAniList } from './anilist';
import { Pacer } from './pacer';
import { SourceUnavailable } from './sources';

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8'));

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}
function fakeFetch(respond: (call: Call) => Response): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const pacer = (): Pacer => new Pacer(100, 1_000);

describe('createAniList', () => {
  it('POSTs a search for anime to graphql.anilist.co', async () => {
    const { fetch, calls } = fakeFetch(() => json(fixture('anilist-search.json')));
    await createAniList(fetch, pacer()).search('Hoshifuri no Tabibito');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://graphql.anilist.co');
    expect(calls[0]!.init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0]!.init?.body)) as { query: string; variables: Record<string, unknown> };
    expect(body.variables).toMatchObject({ search: 'Hoshifuri no Tabibito', type: 'ANIME' });
    expect(body.query).toContain('Page');
    expect(body.query).toContain('relations');
  });

  it('maps names, format, episodes, duration, relations and art', async () => {
    const { fetch } = fakeFetch(() => json(fixture('anilist-search.json')));
    const entries = await createAniList(fetch, pacer()).search('Hoshifuri no Tabibito');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      source: 'anilist',
      id: 'anilist:990001',
      kind: 'series',
      format: 'TV',
      names: { english: 'Starfall Wanderer', romaji: 'Hoshifuri no Tabibito', native: '星降りの旅人', synonyms: ['Hoshitabi', 'The Starfall Wanderer'] },
      animation: true,
      year: 2023,
      startDate: 20230407,
      episodes: 24,
      runtimeMin: 24,
      seasons: [],
      relations: [
        { type: 'SEQUEL', id: 'anilist:990002', format: 'TV', startDate: 20250110 },
        { type: 'PREQUEL', id: 'anilist:990000', format: 'MOVIE', startDate: 20220000 },
        { type: 'ADAPTATION', id: 'anilist:880001', format: 'MANGA', startDate: null },
      ],
      poster: {
        small: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx990001-AbCdEf.jpg',
        large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx990001-AbCdEf.jpg',
      },
      banner: 'https://s4.anilist.co/file/anilistcdn/media/anime/banner/990001-GhIjKl.jpg',
    });
    expect(entries[1]).toMatchObject({ id: 'anilist:990002', names: { english: null }, episodes: null, runtimeMin: null, poster: null, banner: null, relations: [] });
  });

  it('narrows a search by kind and year', async () => {
    const { fetch, calls } = fakeFetch(() => json(fixture('anilist-search.json')));
    const anilist = createAniList(fetch, pacer());
    await anilist.search('Hoshifuri', { kind: 'movie', year: 2022 });
    await anilist.search('Hoshifuri', { kind: 'series' });
    const vars = calls.map((c) => (JSON.parse(String(c.init?.body)) as { variables: Record<string, unknown> }).variables);
    expect(vars[0]).toMatchObject({ format_in: ['MOVIE'], startDate_greater: 20219999, startDate_lesser: 20230000 });
    expect(vars[1]).toMatchObject({ format_in: ['TV', 'TV_SHORT', 'OVA', 'ONA', 'SPECIAL'] });
    expect(vars[1]).not.toHaveProperty('startDate_greater');
  });

  it('reads one entry by id', async () => {
    const { fetch, calls } = fakeFetch(() => json(fixture('anilist-entry.json')));
    const entry = await createAniList(fetch, pacer()).entry('anilist:990000');
    const body = JSON.parse(String(calls[0]!.init?.body)) as { variables: Record<string, unknown> };
    expect(body.variables).toEqual({ id: 990000, type: 'ANIME' });
    expect(entry).toMatchObject({
      id: 'anilist:990000',
      kind: 'movie',
      format: 'MOVIE',
      year: 2022,
      episodes: 1,
      runtimeMin: 105,
      names: { english: 'Starfall Wanderer the Movie: First Star', native: '劇場版 星降りの旅人 はじまりの星' },
      relations: [{ type: 'SEQUEL', id: 'anilist:990001', format: 'TV', startDate: 20230407 }],
      banner: null,
    });
  });

  it('answers null for an unknown id and for an id of another source', async () => {
    const { fetch, calls } = fakeFetch(() => json({ data: { Media: null }, errors: [{ message: 'Not Found.', status: 404 }] }, 404));
    const anilist = createAniList(fetch, pacer());
    expect(await anilist.entry('anilist:1')).toBeNull();
    expect(await anilist.entry('tmdb-tv:1')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('throws SourceUnavailable for a 200 that carries GraphQL errors and no data', async () => {
    const failed = createAniList(fakeFetch(() => json({ data: null, errors: [{ message: 'Internal Server Error', status: 500 }] })).fetch, pacer());
    await expect(failed.search('x')).rejects.toBeInstanceOf(SourceUnavailable);
    await expect(failed.entry('anilist:1')).rejects.toBeInstanceOf(SourceUnavailable);
  });

  it('cancels the body of an error response', async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => void (cancelled = true) });
    const anilist = createAniList(fakeFetch(() => new Response(body, { status: 503 })).fetch, pacer());
    await expect(anilist.search('x')).rejects.toBeInstanceOf(SourceUnavailable);
    expect(cancelled).toBe(true);
  });

  it('throws SourceUnavailable on network errors and 5xx', async () => {
    const down = createAniList((async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch, pacer());
    await expect(down.search('x')).rejects.toBeInstanceOf(SourceUnavailable);
    const broken = createAniList(fakeFetch(() => json({}, 502)).fetch, pacer());
    await expect(broken.search('x')).rejects.toBeInstanceOf(SourceUnavailable);
  });
});
