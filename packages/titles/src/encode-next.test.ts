// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { EncodeShow } from '@seikou/nas/nas-api';
import { nextInShow } from './encode-next';

const ep = (anilistId: number, episode: number) => ({ episode, id: `${anilistId}-${episode}`, title: null, durationMs: 1000 });
const SHOW: EncodeShow = {
  id: '100', name: 'Starfall Wanderer', poster: null,
  seasons: [
    { anilistId: 100, name: 'Season 1', kind: 'season', number: 1, episodes: [ep(100, 1), ep(100, 2)] },
    { anilistId: 101, name: 'Season 2', kind: 'season', number: 2, episodes: [ep(101, 1)] },
    { anilistId: 103, name: 'Starfall Wanderer: Ember Road', kind: 'film', number: null, episodes: [ep(103, 1), ep(103, 2)] },
    { anilistId: 104, name: 'Starfall Wanderer OVA', kind: 'other', number: null, episodes: [ep(104, 2), ep(104, 1)] },
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

  it('is null for an episode the show does not hold', () => {
    expect(nextInShow(SHOW, '999-1')).toBeNull();
  });
});
