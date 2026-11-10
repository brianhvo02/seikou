// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { seasonTitle } from '../../src/nas/nas-titles';

const UUID = '3f2a9c1e-7b4d-4e58-9a61-0c5d8e2f7b13';

describe('seasonTitle', () => {
  it('names the title of every season id the catalogue makes', () => {
    expect(seasonTitle('anilist:990001#season')).toEqual({ source: 'anilist', anilistId: 990001 });
    expect(seasonTitle('anilist:990001#discs')).toEqual({ source: 'anilist', anilistId: 990001 });
    expect(seasonTitle('tmdb-tv:990101#s2')).toEqual({ source: 'tmdb-tv', tmdbId: 990101, season: 2 });
    expect(seasonTitle('tmdb-movie:990103#discs')).toEqual({ source: 'tmdb-movie', tmdbId: 990103 });
    expect(seasonTitle(`own:${UUID}#s3`)).toEqual({ source: 'own', ownId: UUID, season: 3 });
    expect(seasonTitle(`own:${UUID}#discs`)).toEqual({ source: 'own', ownId: UUID, season: null });
  });

  it('answers null for a season the NAS has no title for yet, and for anything else', () => {
    expect(seasonTitle('anilist:990001#s2')).toBeNull();
    expect(seasonTitle('tmdb-tv:990101#discs')).toBeNull();
    expect(seasonTitle('tmdb-tv:990101#s0')).toBeNull();
    expect(seasonTitle('tmdb-movie:990103#s1')).toBeNull();
    expect(seasonTitle(`own:${UUID.toUpperCase()}#s1`)).toBeNull();
    expect(seasonTitle('music:x#discs')).toBeNull();
    expect(seasonTitle('')).toBeNull();
  });
});
