// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../api';
import { createAppApi } from './app-api';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function recorder(body: unknown): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      return ok(body);
    },
  };
}

const hit = (alId: number, poster: string | null) => ({ alId, title: 'Starfall Wanderer', nativeTitle: null, year: 2023, format: 'TV', episodes: 12, poster });

describe('createAppApi episode info', () => {
  it('reads a playlist\'s episode info', async () => {
    const { fetch, urls } = recorder({ info: null });
    expect(await createAppApi('', 'secret', fetch).episodeInfo('d.abc', '00001')).toBeNull();
    expect(urls).toEqual(['/api/discs/d.abc/playlists/00001/info']);
  });
});

describe('createAppApi AniList calls', () => {
  it('searches and gives each cover the token', async () => {
    const { fetch, urls } = recorder({ candidates: [hit(990010, '/api/anilist/990010/cover'), hit(990011, null)] });
    const hits = await createAppApi('http://127.0.0.1:4197/', 'secret', fetch).searchAniList('starfall wanderer');
    expect(urls).toEqual(['http://127.0.0.1:4197/api/anilist/search?q=starfall+wanderer']);
    expect(hits.map((h) => h.poster)).toEqual(['http://127.0.0.1:4197/api/anilist/990010/cover?t=secret', null]);
  });

  it('gives an entry and its sequel the token', async () => {
    const { fetch, urls } = recorder({ entry: { ...hit(990010, '/api/anilist/990010/cover'), sequel: hit(990011, '/api/anilist/990011/cover') } });
    const entry = await createAppApi('', 'secret', fetch).aniListEntry(990010);
    expect(urls).toEqual(['/api/anilist/990010']);
    expect(entry.poster).toBe('/api/anilist/990010/cover?t=secret');
    expect(entry.sequel?.poster).toBe('/api/anilist/990011/cover?t=secret');
  });

  it('unwraps episode titles', async () => {
    const { fetch, urls } = recorder({ titles: { 1: 'The Falling Star' } });
    expect(await createAppApi('', 'secret', fetch).aniListEpisodes(990010)).toEqual({ 1: 'The Falling Star' });
    expect(urls).toEqual(['/api/anilist/990010/episodes']);
  });
});

describe('createAppApi NAS calls', () => {
  it('reads the status, pairs and unpairs', async () => {
    const calls: [string, string, unknown][] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push([init?.method ?? 'GET', url, init?.body]);
      return ok({ paired: false });
    };
    const api = createAppApi('', 'secret', fetch);
    expect(await api.nas()).toEqual({ paired: false });
    await api.pairNas({ code: 'K7QM-4XP2-R9TD', base: 'https://nas.example/bluray/api/' });
    await api.unpairNas();
    expect(calls).toEqual([
      ['GET', '/api/nas', undefined],
      ['POST', '/api/nas/pair', JSON.stringify({ code: 'K7QM-4XP2-R9TD', base: 'https://nas.example/bluray/api/' })],
      ['DELETE', '/api/nas', undefined],
    ]);
  });

  it('looks titles up by source and makes an own title', async () => {
    const calls: [string, string, unknown][] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push([init?.method ?? 'GET', url, init?.body]);
      return ok(url.includes('lookup') ? { titles: [] } : { id: 'own:x', kind: 'movie', name: 'Harbour Film', seasons: null });
    };
    const api = createAppApi('', 'secret', fetch);
    expect(await api.lookupTitles('lantern harbour', 'tmdb')).toEqual([]);
    expect(await api.createOwnTitle({ kind: 'movie', name: 'Harbour Film', seasons: null })).toMatchObject({ name: 'Harbour Film' });
    expect(calls).toEqual([
      ['GET', '/api/nas/lookup?q=lantern+harbour&source=tmdb', undefined],
      ['POST', '/api/nas/own-titles', JSON.stringify({ kind: 'movie', name: 'Harbour Film', seasons: null })],
    ]);
  });

  it('reads the NAS catalogue, its posters made loadable with the token', async () => {
    const calls: string[] = [];
    const show = { titleId: 'anilist:990001', name: 'Lantern Road', poster: '/api/nas/art/00112233445566778899aabbccddeeff', kind: 'series', seasons: 1, films: 0, encoded: 1, toEncode: 0 };
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      if (url.includes('/api/nas/lookup')) return ok({ titles: [{ id: 'anilist:990001', poster: '00112233445566778899aabbccddeeff', names: {} }, { id: 'own:x', poster: null, names: {} }] });
      if (url.endsWith('/api/nas/shows')) return ok({ shows: [show, { ...show, poster: null }], unsorted: [], reachable: true, stale: false, encodedKnown: true });
      return ok({ title: { titleId: 'anilist:990001', name: 'Lantern Road', poster: show.poster, kind: 'series' }, seasons: [], reachable: true, stale: false, encodedKnown: true });
    };
    const api = createAppApi('http://127.0.0.1:4196', 'se cret', fetch);
    const shows = await api.nasShows();
    expect(shows.shows.map((s) => s.poster)).toEqual(['http://127.0.0.1:4196/api/nas/art/00112233445566778899aabbccddeeff?t=se%20cret', null]);
    expect((await api.nasShow('anilist:990001')).title.poster).toBe(shows.shows[0]!.poster);
    expect(calls).toContain('http://127.0.0.1:4196/api/nas/shows/anilist%3A990001');
    expect((await api.lookupTitles('lantern', 'anilist')).map((t) => t.poster)).toEqual([shows.shows[0]!.poster, null]);
  });
});
