// SPDX-License-Identifier: LGPL-3.0-or-later
import { expect, it } from 'vitest';
import { ENCODER_TAG, episodeTags } from '../../src/mux/episode-tags';

const base = { discKey: 'f.0123456789abcdef', playlistId: '00002', startMs: 1234 };
const always = { SEIKOU_DISC_KEY: 'f.0123456789abcdef', SEIKOU_PLAYLIST: '00002', SEIKOU_EPISODE_START_MS: '1234', ENCODER: ENCODER_TAG };

it('always names the disc, the playlist, the start and the encoder', () => {
  expect(episodeTags({ ...base, anilist: null })).toEqual(always);
});

it('adds the AniList id, the episode and its title when chosen', () => {
  expect(episodeTags({ ...base, anilist: { anilistId: 990001, episode: 3, title: 'The Lighthouse' } })).toEqual({
    ...always,
    ANILIST_ID: '990001',
    EPISODE: '3',
    EPISODE_TITLE: 'The Lighthouse',
  });
});

it('leaves the episode title out when there is none', () => {
  expect(episodeTags({ ...base, anilist: { anilistId: 990001, episode: 3, title: null } })).toEqual({ ...always, ANILIST_ID: '990001', EPISODE: '3' });
  expect(episodeTags({ ...base, anilist: { anilistId: 990001, episode: 3, title: '' } })).toEqual({ ...always, ANILIST_ID: '990001', EPISODE: '3' });
});

it('names the encoder with its version', () => {
  expect(ENCODER_TAG).toMatch(/^seikou-encode \d+\.\d+\.\d+/);
});
