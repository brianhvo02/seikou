// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { buildEncodeCatalogue, nextEncodeEpisode } from './encode-catalogue';
import type { Entry } from './sources';
import type { EncodeTitle } from '@seikou/nas/encode-title';
import { encodeId } from '@seikou/nas/encode-id';
import { nextInShow } from './encode-next';

type Rel = Entry['relations'][number];
const rel = (type: string, n: number, format: string, startDate: number | null = null): Rel => ({ type, id: `anilist:${n}`, format, startDate });
function entry(n: number, name: string, format: string, relations: Rel[], year = 2020, poster = true): Entry {
  return {
    source: 'anilist', id: `anilist:${n}`, kind: format === 'MOVIE' ? 'movie' : 'series', format,
    names: { english: name, romaji: null, native: null, synonyms: [] }, animation: true, year, episodes: 12, runtimeMin: 24, seasons: [], relations,
    poster: poster ? { small: `https://img.example/${n}-s.jpg`, large: `https://img.example/${n}-l.jpg` } : null, banner: null,
  };
}
const enc = (anilistId: number, episode: number) => ({
  id: `${anilistId}-${episode}`, title: { source: 'anilist', anilistId } as EncodeTitle, titleName: null, anilistId, episode, episodeTitle: `Ep ${episode}`, durationMs: 1000 * episode,
});
/** An encode of a title beyond AniList. */
const other = (title: EncodeTitle, episode: number, titleName: string | null = null) => ({
  id: encodeId(title, episode), title, titleName, anilistId: null, episode, episodeTitle: null, durationMs: 1000,
});
const map = (...es: Entry[]): Map<number, Entry> => new Map(es.map((e) => [Number(e.id.slice(8)), e]));

const first = entry(990001, 'Lantern Road', 'TV', [rel('SEQUEL', 990002, 'TV')], 2020);
const second = entry(990002, 'Lantern Road Again', 'TV', [rel('PREQUEL', 990001, 'TV')], 2021);

describe('buildEncodeCatalogue', () => {
  it('two TV entries linked as sequels are one show with seasons 1 and 2', () => {
    const cat = buildEncodeCatalogue([enc(990002, 1), enc(990001, 2), enc(990001, 1)], map(first, second));
    expect(cat.shows).toHaveLength(1);
    const show = cat.shows[0]!;
    expect(show).toMatchObject({ id: '990001', name: 'Lantern Road' });
    expect(show.seasons.map((s) => [s.anilistId, s.kind, s.number])).toEqual([[990001, 'season', 1], [990002, 'season', 2]]);
    expect(show.seasons[0]!.episodes.map((e) => e.episode)).toEqual([1, 2]);
    expect(show.seasons[0]!.episodes[0]).toEqual({ episode: 1, id: '990001-1', title: 'Ep 1', durationMs: 1000 });
    expect(show.poster).toMatch(/^[0-9a-f]{32}$/);
    expect(cat.art.get(show.poster!)).toEqual({ small: 'https://img.example/990001-s.jpg', large: 'https://img.example/990001-l.jpg' });
    expect(cat.show('990001')).toBe(show);
    expect(cat.show('1')).toBeNull();
  });

  it('a film linked by SIDE_STORY attaches to the show, after the seasons', () => {
    const film = entry(990003, 'Lantern Road: The Film', 'MOVIE', [rel('SIDE_STORY', 990001, 'TV')], 2019);
    const cat = buildEncodeCatalogue([enc(990003, 1), enc(990002, 1), enc(990001, 1)], map(first, second, film));
    expect(cat.shows).toHaveLength(1);
    expect(cat.shows[0]!.seasons.map((s) => [s.anilistId, s.kind])).toEqual([[990001, 'season'], [990002, 'season'], [990003, 'film']]);
  });

  it('an entry with no encodes is not listed', () => {
    const cat = buildEncodeCatalogue([enc(990002, 1)], map(first, second));
    expect(cat.shows[0]!.seasons.map((s) => s.anilistId)).toEqual([990002]);
    expect(buildEncodeCatalogue([], map(first, second)).shows).toEqual([]);
  });

  it('an entry missing from the metadata is its own show named by its id', () => {
    const cat = buildEncodeCatalogue([enc(777, 1)], new Map());
    expect(cat.shows).toEqual([{ id: '777', name: 'AniList 777', poster: null, seasons: [expect.objectContaining({ anilistId: 777, kind: 'season' })] }]);
  });

  it('an unrelated film is its own show', () => {
    const film = entry(5, 'Lonely Film', 'MOVIE', []);
    const cat = buildEncodeCatalogue([enc(5, 1)], map(film));
    expect(cat.shows[0]).toMatchObject({ id: '5', name: 'Lonely Film' });
    expect(cat.shows[0]!.seasons[0]).toMatchObject({ kind: 'film', number: null });
  });
});

describe('nextEncodeEpisode', () => {
  it('next episode crosses into the next season and is null at the end', () => {
    const film = entry(990003, 'Film', 'MOVIE', [rel('SIDE_STORY', 990001, 'TV')]);
    const cat = buildEncodeCatalogue([enc(990001, 1), enc(990001, 3), enc(990002, 4), enc(990002, 5), enc(990003, 1)], map(first, second, film));
    expect(nextEncodeEpisode(cat, '990001-1')).toBe('990001-3');
    expect(nextEncodeEpisode(cat, '990001-3')).toBe('990002-4');
    expect(nextEncodeEpisode(cat, '990002-4')).toBe('990002-5');
    expect(nextEncodeEpisode(cat, '990002-5')).toBeNull();
    expect(nextEncodeEpisode(cat, '990003-1')).toBeNull();
    expect(nextEncodeEpisode(cat, '1-1')).toBeNull();
  });

  it('goes on within an OVA row, as the player does', () => {
    const ova = entry(990004, 'Lantern Road OVA', 'OVA', [rel('SIDE_STORY', 990001, 'TV')]);
    const cat = buildEncodeCatalogue([enc(990001, 1), enc(990004, 1), enc(990004, 2)], map(first, ova));
    expect(nextEncodeEpisode(cat, '990004-1')).toBe('990004-2');
    expect(nextEncodeEpisode(cat, '990004-2')).toBeNull();
  });
});

describe('titles beyond AniList', () => {
  const TV1: EncodeTitle = { source: 'tmdb-tv', tmdbId: 990101, season: 1 };
  const TV2: EncodeTitle = { source: 'tmdb-tv', tmdbId: 990101, season: 2 };
  const FILM: EncodeTitle = { source: 'tmdb-movie', tmdbId: 990102 };
  const OWN_A: EncodeTitle = { source: 'own', ownId: '00000000-0000-4000-8000-00000000000a', season: null };
  const OWN_B: EncodeTitle = { source: 'own', ownId: '00000000-0000-4000-8000-00000000000b', season: null };
  const encodes = (tvName: string | null = null) => [
    enc(990001, 2), enc(990001, 1), other(TV2, 1, tvName), other(TV1, 2, tvName), other(TV1, 1, tvName), other(FILM, 1, 'Ember Road'),
    other(OWN_A, 1, 'Starfall Wanderer'), other(OWN_B, 1, 'Starfall Wanderer'),
  ];
  const names = (t: EncodeTitle) =>
    t.source === 'tmdb-tv' ? { name: 'Brasswick Lane', poster: 'abc' } : t.source === 'tmdb-movie' ? { name: 'Ember Road', poster: null } : null;

  it('groups a TMDB series by season, a film as one row, and own titles of the same name apart', () => {
    const cat = buildEncodeCatalogue(encodes(), map(first), names);
    expect(cat.shows.map((s) => s.id).sort()).toEqual(['990001', 'mv990102', 'own0000000000004000800000000000000a', 'own0000000000004000800000000000000b', 'tv990101']);
    const tv = cat.show('tv990101')!;
    expect(tv).toMatchObject({ name: 'Brasswick Lane', poster: 'abc' });
    expect(tv.seasons.map((s) => [s.title, s.anilistId, s.kind, s.number, s.name])).toEqual([[TV1, null, 'season', 1, 'Season 1'], [TV2, null, 'season', 2, 'Season 2']]);
    expect(tv.seasons[0]!.episodes.map((e) => e.id)).toEqual(['tv990101s1-1', 'tv990101s1-2']);
    expect(cat.show('mv990102')!.seasons).toEqual([expect.objectContaining({ title: FILM, kind: 'film', number: null, name: 'Ember Road' })]);
    const own = cat.shows.filter((s) => s.id.startsWith('own'));
    expect(own.map((s) => s.name)).toEqual(['Starfall Wanderer', 'Starfall Wanderer']);
    expect(own[0]!.seasons).toEqual([expect.objectContaining({ title: OWN_A, kind: 'other', number: null, name: 'Starfall Wanderer' })]);
    expect(cat.show('990001')!.seasons[0]!.title).toEqual({ source: 'anilist', anilistId: 990001 });
  });

  it("names a title it has no name for by its encodes' TITLE_NAME, else by its source and id", () => {
    expect(buildEncodeCatalogue(encodes('Brasswick'), map(first), () => null).show('tv990101')!.name).toBe('Brasswick');
    const bare = buildEncodeCatalogue(encodes(), map(first), () => null);
    expect(bare.show('tv990101')!.name).toBe('TMDB 990101');
    expect(bare.show('mv990102')!.name).toBe('Ember Road');
    expect(buildEncodeCatalogue([other(OWN_A, 1)], new Map(), () => null).shows[0]!.name).toBe('Own title');
    expect(buildEncodeCatalogue([other(FILM, 1)], new Map()).shows[0]!.name).toBe('TMDB 990102');
  });

  it('an own title with seasons groups them by season; an own film is one film row', () => {
    const s1: EncodeTitle = { ...OWN_A, season: 1 } as EncodeTitle;
    const s2: EncodeTitle = { ...OWN_A, season: 2 } as EncodeTitle;
    const cat = buildEncodeCatalogue([other(s2, 1), other(s1, 1)], new Map(), () => ({ name: 'Quiet Harbour', poster: null }));
    expect(cat.shows).toHaveLength(1);
    expect(cat.shows[0]!.seasons.map((s) => [s.kind, s.number])).toEqual([['season', 1], ['season', 2]]);
    const film = buildEncodeCatalogue([other(OWN_B, 1)], new Map(), () => ({ name: 'Quiet Film', poster: null, film: true }));
    expect(film.shows[0]!.seasons).toEqual([expect.objectContaining({ kind: 'film', name: 'Quiet Film' })]);
  });

  it('next episode goes on within a TMDB season, then into the next season, and never after a film', () => {
    const cat = buildEncodeCatalogue(encodes(), map(first), names);
    const tv = cat.show('tv990101')!;
    expect(nextInShow(tv, 'tv990101s1-1')?.id).toBe('tv990101s1-2');
    expect(nextInShow(tv, 'tv990101s1-2')?.id).toBe('tv990101s2-1');
    expect(nextInShow(tv, 'tv990101s2-1')).toBeNull();
    expect(nextInShow(cat.show('mv990102')!, 'mv990102-1')).toBeNull();
    expect(nextEncodeEpisode(cat, 'own0000000000004000800000000000000a-1')).toBeNull();
  });
});
