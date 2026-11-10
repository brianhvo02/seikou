// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, it } from 'vitest';
import { ENCODER_TAG, episodeTags } from '../../src/mux/episode-tags';

const base = { discKey: 'f.0123456789abcdef', playlistId: '00002', startMs: 1234 };
const always = { SEIKOU_DISC_KEY: 'f.0123456789abcdef', SEIKOU_PLAYLIST: '00002', SEIKOU_EPISODE_START_MS: '1234', ENCODER: ENCODER_TAG };

it('always names the disc, the playlist, the start and the encoder', () => {
  expect(episodeTags({ ...base, title: null })).toEqual(always);
});

it('adds the AniList id, the episode and its title when chosen', () => {
  expect(episodeTags({ ...base, title: { title: { source: 'anilist', anilistId: 990001 }, episode: 3, name: 'The Lighthouse' } })).toEqual({
    ...always,
    ANILIST_ID: '990001',
    EPISODE: '3',
    EPISODE_TITLE: 'The Lighthouse',
  });
});

it('leaves the episode title out when there is none', () => {
  expect(episodeTags({ ...base, title: { title: { source: 'anilist', anilistId: 990001 }, episode: 3, name: null } })).toEqual({ ...always, ANILIST_ID: '990001', EPISODE: '3' });
  expect(episodeTags({ ...base, title: { title: { source: 'anilist', anilistId: 990001 }, episode: 3, name: '' } })).toEqual({ ...always, ANILIST_ID: '990001', EPISODE: '3' });
});

it('writes a TMDB series season as SEIKOU_TITLE, SEASON, EPISODE and TITLE_NAME, with no ANILIST_ID', () => {
  const tags = episodeTags({ ...base, title: { title: { source: 'tmdb-tv', tmdbId: 990101, season: 1 }, episode: 2, name: null, showName: 'Starfall Wanderer' } });
  expect(tags).toEqual({ ...always, SEIKOU_TITLE: 'tmdb-tv:990101', SEASON: '1', EPISODE: '2', TITLE_NAME: 'Starfall Wanderer' });
  expect(tags).not.toHaveProperty('ANILIST_ID');
});

it('names the encoder with its version', () => {
  expect(ENCODER_TAG).toMatch(/^seikou-encode \d+\.\d+\.\d+/);
});
