// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { buildEncodeCatalogue, nextEncodeEpisode } from './encode-catalogue';
import type { Entry } from './sources';

type Rel = Entry['relations'][number];
const rel = (type: string, n: number, format: string, startDate: number | null = null): Rel => ({ type, id: `anilist:${n}`, format, startDate });
function entry(n: number, name: string, format: string, relations: Rel[], year = 2020, poster = true): Entry {
  return {
    source: 'anilist', id: `anilist:${n}`, kind: format === 'MOVIE' ? 'movie' : 'series', format,
    names: { english: name, romaji: null, native: null, synonyms: [] }, animation: true, year, episodes: 12, runtimeMin: 24, seasons: [], relations,
    poster: poster ? { small: `https://img.example/${n}-s.jpg`, large: `https://img.example/${n}-l.jpg` } : null, banner: null,
  };
}
const enc = (anilistId: number, episode: number) => ({ id: `${anilistId}-${episode}`, anilistId, episode, episodeTitle: `Ep ${episode}`, durationMs: 1000 * episode });
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
});
