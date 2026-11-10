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
