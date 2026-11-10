// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { EncodeShow } from '@seikou/nas/nas-api';
import { nextInShow } from './encode-next';

const ep = (anilistId: number, episode: number) => ({ episode, id: `${anilistId}-${episode}`, title: null, durationMs: 1000 });
const SHOW: EncodeShow = {
  id: '100', name: 'Starfall Wanderer', poster: null,
  seasons: [
    { title: { source: 'anilist', anilistId: 100 }, anilistId: 100, name: 'Season 1', kind: 'season', number: 1, episodes: [ep(100, 1), ep(100, 2)] },
    { title: { source: 'anilist', anilistId: 101 }, anilistId: 101, name: 'Season 2', kind: 'season', number: 2, episodes: [ep(101, 1)] },
    { title: { source: 'anilist', anilistId: 103 }, anilistId: 103, name: 'Starfall Wanderer: Ember Road', kind: 'film', number: null, episodes: [ep(103, 1), ep(103, 2)] },
    { title: { source: 'anilist', anilistId: 104 }, anilistId: 104, name: 'Starfall Wanderer OVA', kind: 'other', number: null, episodes: [ep(104, 2), ep(104, 1)] },
  ],
};

describe('nextInShow', () => {
  it('goes on within a season, then to the next season', () => {
    expect(nextInShow(SHOW, '100-1')?.id).toBe('100-2');
    expect(nextInShow(SHOW, '100-2')?.id).toBe('101-1');
    expect(nextInShow(SHOW, '101-1')).toBeNull();
  });

  it('goes on within a non-season row by episode number, and stops at its last', () => {
    expect(nextInShow(SHOW, '104-1')?.id).toBe('104-2');
    expect(nextInShow(SHOW, '104-2')).toBeNull();
  });

  it('never continues from a film, even one with parts', () => {
    expect(nextInShow(SHOW, '103-1')).toBeNull();
    expect(nextInShow(SHOW, '103-2')).toBeNull();
  });

  it('goes from a TMDB season to the next by number, never into a film or another row', () => {
    const tvEp = (season: number, episode: number) => ({ episode, id: `tv990101s${season}-${episode}`, title: null, durationMs: 1000 });
    const tv: EncodeShow = {
      id: 'tv990101', name: 'Brasswick Lane', poster: null,
      seasons: [
        { title: { source: 'tmdb-tv', tmdbId: 990101, season: 1 }, anilistId: null, name: 'Season 1', kind: 'season', number: 1, episodes: [tvEp(1, 1), tvEp(1, 2)] },
        { title: { source: 'tmdb-tv', tmdbId: 990101, season: 3 }, anilistId: null, name: 'Season 3', kind: 'season', number: 3, episodes: [tvEp(3, 1)] },
      ],
    };
    expect(nextInShow(tv, 'tv990101s1-2')?.id).toBe('tv990101s3-1');
    expect(nextInShow(tv, 'tv990101s3-1')).toBeNull();
  });

  it('is null for an episode the show does not hold', () => {
    expect(nextInShow(SHOW, '999-1')).toBeNull();
  });
});
