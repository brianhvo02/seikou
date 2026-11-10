// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { nasTitleId, parseTitlePart, sameTitle, showIdOfTitle, titleFromTags, titlePart, titleTags } from './encode-title';
import type { EncodeTitle } from './encode-title';

const UUID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const HEX = '0f0e0d0c0b0a49088706050403020100';

const CASES: readonly [EncodeTitle, string][] = [
  [{ source: 'anilist', anilistId: 990001 }, '990001'],
  [{ source: 'tmdb-tv', tmdbId: 990002, season: 2 }, 'tv990002s2'],
  [{ source: 'tmdb-movie', tmdbId: 990003 }, 'mv990003'],
  [{ source: 'own', ownId: UUID, season: 1 }, `own${HEX}s1`],
  [{ source: 'own', ownId: UUID, season: null }, `own${HEX}`],
];

describe('encode titles', () => {
  it('round-trips the title part of every source', () => {
    for (const [title, part] of CASES) {
      expect(titlePart(title)).toBe(part);
      expect(parseTitlePart(part)).toEqual(title);
    }
  });

  it('refuses malformed title parts', () => {
    const bad = [
      '', '0', '01', 'tv990002', 'tvs2', 'tv990002s0', 'tv0s1', 'mv0', 'mv990003s1', 'TV990002s2',
      `own${HEX.slice(1)}`, `own${HEX}0`, `own${HEX.toUpperCase()}`, `own${HEX}s0`, `own${UUID}`, 'own', '990001s1', '-1', '1.5',
    ];
    for (const s of bad) expect(parseTitlePart(s), s).toBeNull();
  });

  it('names the NAS title id of each source, in the forms the admin routes accept', () => {
    const TITLE_ID = /^(?:anilist:\d+|tmdb-(?:tv|movie):\d+|own:[0-9a-f-]{36})$/;
    const ids = CASES.map(([t]) => nasTitleId(t));
    expect(ids).toEqual(['anilist:990001', 'tmdb-tv:990002', 'tmdb-movie:990003', `own:${UUID}`, `own:${UUID}`]);
    for (const id of ids) expect(id).toMatch(TITLE_ID);
  });

  it('compares titles by every field', () => {
    expect(sameTitle({ source: 'anilist', anilistId: 1 }, { source: 'anilist', anilistId: 1 })).toBe(true);
    expect(sameTitle({ source: 'anilist', anilistId: 1 }, { source: 'anilist', anilistId: 2 })).toBe(false);
    expect(sameTitle({ source: 'tmdb-tv', tmdbId: 1, season: 1 }, { source: 'tmdb-tv', tmdbId: 1, season: 2 })).toBe(false);
    expect(sameTitle({ source: 'tmdb-tv', tmdbId: 1, season: 1 }, { source: 'tmdb-movie', tmdbId: 1 })).toBe(false);
    expect(sameTitle({ source: 'tmdb-movie', tmdbId: 1 }, { source: 'tmdb-movie', tmdbId: 1 })).toBe(true);
    expect(sameTitle({ source: 'own', ownId: UUID, season: null }, { source: 'own', ownId: UUID, season: null })).toBe(true);
    expect(sameTitle({ source: 'own', ownId: UUID, season: null }, { source: 'own', ownId: UUID, season: 1 })).toBe(false);
  });

  it('writes and reads the tags that name a title', () => {
    expect(titleTags(CASES[0]![0])).toEqual({ ANILIST_ID: '990001' });
    expect(titleTags(CASES[1]![0])).toEqual({ SEIKOU_TITLE: 'tmdb-tv:990002', SEASON: '2' });
    expect(titleTags(CASES[2]![0])).toEqual({ SEIKOU_TITLE: 'tmdb-movie:990003' });
    expect(titleTags(CASES[3]![0])).toEqual({ SEIKOU_TITLE: `own:${UUID}`, SEASON: '1' });
    expect(titleTags(CASES[4]![0])).toEqual({ SEIKOU_TITLE: `own:${UUID}` });
    for (const [title] of CASES) expect(titleFromTags(titleTags(title))).toEqual(title);
  });

  it('lets ANILIST_ID win, and refuses malformed or incomplete tags', () => {
    expect(titleFromTags({ ANILIST_ID: '7', SEIKOU_TITLE: 'tmdb-tv:1', SEASON: '1' })).toEqual({ source: 'anilist', anilistId: 7 });
    expect(titleFromTags({ ANILIST_ID: ' 990001 ' })).toEqual({ source: 'anilist', anilistId: 990001 });
    expect(titleFromTags({ SEIKOU_TITLE: 'tmdb-tv:1' })).toBeNull();
    expect(titleFromTags({ SEIKOU_TITLE: 'tmdb-movie:5', SEASON: '3' })).toEqual({ source: 'tmdb-movie', tmdbId: 5 });
    const bad: Record<string, string>[] = [
      {},
      { ANILIST_ID: '0' },
      { ANILIST_ID: 'x', SEIKOU_TITLE: 'tmdb-movie:5' },
      { SEIKOU_TITLE: 'tmdb-tv:1', SEASON: '0' },
      { SEIKOU_TITLE: 'tmdb-tv:1', SEASON: 'one' },
      { SEIKOU_TITLE: `own:${UUID}`, SEASON: '-1' },
      { SEIKOU_TITLE: `own:${UUID.toUpperCase()}` },
      { SEIKOU_TITLE: `own:${HEX}` },
      { SEIKOU_TITLE: 'anilist:7' },
      { SEIKOU_TITLE: 'tmdb-movie:0' },
      { SEIKOU_TITLE: 'tmdb-show:5' },
    ];
    for (const tags of bad) expect(titleFromTags(tags), JSON.stringify(tags)).toBeNull();
  });
});

describe('showIdOfTitle', () => {
  it('is null for an AniList entry, whose show is its chain root', () => {
    expect(showIdOfTitle({ source: 'anilist', anilistId: 990001 })).toBeNull();
  });
  it('is tv<n> for every season of a TMDB series', () => {
    expect(showIdOfTitle({ source: 'tmdb-tv', tmdbId: 990101, season: 1 })).toBe('tv990101');
    expect(showIdOfTitle({ source: 'tmdb-tv', tmdbId: 990101, season: 2 })).toBe('tv990101');
  });
  it('is mv<n> for a TMDB film', () => {
    expect(showIdOfTitle({ source: 'tmdb-movie', tmdbId: 990201 })).toBe('mv990201');
  });
  it('is own<32 hex> for an own title, with or without a season', () => {
    const ownId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(showIdOfTitle({ source: 'own', ownId, season: 3 })).toBe('own0f8fad5bd9cb469fa16570867728950e');
    expect(showIdOfTitle({ source: 'own', ownId, season: null })).toBe('own0f8fad5bd9cb469fa16570867728950e');
  });
});
