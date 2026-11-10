// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { EncodeTitle } from '@seikou/nas/encode-title';
import type { EpisodeInfo, EpisodeTitle } from '../api-types';
import {
  aniListIdOf,
  episodeRows,
  episodesPhrase,
  firstNumberFor,
  missingTitles,
  renumberFrom,
  sharedTitles,
  suggestedTitles,
  toInfo,
  withTitles,
  type EpisodeRow,
} from './episode-info-model';

const EPISODES = [
  { index: 1, first: 1 },
  { index: 2, first: 4 },
  { index: 3, first: 7 },
  { index: 4, first: 10 },
];

const info = (anilist: EpisodeInfo['titles'], chapterNames: EpisodeInfo['chapterNames'] = {}): EpisodeInfo => ({ chapterNames, titles: anilist, savedAt: '2026-11-09T10:00:00.000Z' });

const row = (index: number, firstChapter: number, anilistId: number | null, episode = index): EpisodeRow => ({
  index,
  firstChapter,
  title: anilistId === null ? null : { title: { source: 'anilist', anilistId }, episode, name: null },
  prefilled: false,
});

describe('episodeRows', () => {
  it('prefills from the record show, numbered 1 to n, marked prefilled', () => {
    const rows = episodeRows(EPISODES, null, { id: 990010 });
    expect(rows.map((r) => [r.index, r.firstChapter, aniListIdOf(r.title), r.title?.episode, r.prefilled])).toEqual([
      [1, 1, 990010, 1, true],
      [2, 4, 990010, 2, true],
      [3, 7, 990010, 3, true],
      [4, 10, 990010, 4, true],
    ]);
  });

  it('leaves every row empty with no record show and nothing saved', () => {
    const rows = episodeRows(EPISODES, info({}), null);
    expect(rows.every((r) => r.title === null && !r.prefilled)).toBe(true);
  });

  it('keeps a saved choice and does not prefill beside it', () => {
    const saved = info({ '4': { title: { source: 'anilist', anilistId: 990020 }, episode: 7, name: 'The Lantern' } });
    const rows = episodeRows(EPISODES, saved, { id: 990010 });
    expect(rows[1]).toEqual({ index: 2, firstChapter: 4, title: { title: { source: 'anilist', anilistId: 990020 }, episode: 7, name: 'The Lantern' }, prefilled: false });
    expect(rows.filter((r) => r.index !== 2).every((r) => r.title === null && !r.prefilled)).toBe(true);
  });
});

describe('renumberFrom', () => {
  const four = [row(1, 1, 990010), row(2, 4, 990010), row(3, 7, 990010), row(4, 10, 990010)];

  it('gives the row the entry and number, and the rest of its run the next numbers', () => {
    const rows = renumberFrom(four, 2, 990011, 1);
    expect(rows[0]).toEqual(four[0]);
    expect(rows[1]).toEqual(four[1]);
    expect(rows[2]!.title).toEqual({ title: { source: 'anilist', anilistId: 990011 }, episode: 1, name: null });
    expect(rows[3]!.title).toEqual({ title: { source: 'anilist', anilistId: 990011 }, episode: 2, name: null });
  });

  it('stops at a row set by hand to another entry', () => {
    const rows = renumberFrom([...four.slice(0, 3), row(4, 10, 990012, 5), row(5, 13, 990010, 5)], 2, 990011, 1);
    expect(aniListIdOf(rows[2]!.title)).toBe(990011);
    expect(rows[3]!.title).toEqual({ title: { source: 'anilist', anilistId: 990012 }, episode: 5, name: null });
    expect(rows[4]!.title).toEqual({ title: { source: 'anilist', anilistId: 990010 }, episode: 5, name: null });
  });

  it('renumbering within the same entry runs on, and empty rows join the run', () => {
    const rows = renumberFrom([row(1, 1, 990010), row(2, 4, 990010), row(3, 7, null)], 1, 990010, 5);
    expect(rows.map((r) => r.title?.episode)).toEqual([1, 5, 6]);
    expect(aniListIdOf(rows[2]!.title)).toBe(990010);
  });

  it('keeps a title only where the entry and number stay the same', () => {
    expect(renumberFrom(four.map((r) => ({ ...r, title: { ...r.title!, name: 'Kept' } })), 1, 990010, 2).map((r) => r.title?.name)).toEqual(['Kept', 'Kept', 'Kept', 'Kept']);
    const titled = four.map((r) => ({ ...r, title: { ...r.title!, name: `Title ${r.index}` } }));
    const rows = renumberFrom(titled, 1, 990010, 3);
    expect(rows.map((r) => r.title?.name)).toEqual(['Title 1', null, null, null]);
  });

  it('drops the prefilled mark of the rows it sets', () => {
    const rows = renumberFrom(episodeRows(EPISODES, null, { id: 990010 }), 2, 990011, 1);
    expect(rows.map((r) => r.prefilled)).toEqual([true, true, false, false]);
  });
});

describe('renumberFrom with a title of another source', () => {
  const harbour: EncodeTitle = { source: 'tmdb-tv', tmdbId: 990101, season: 2 };
  const tv = (index: number, episode: number, name: string | null = null): EpisodeRow => ({
    index,
    firstChapter: index * 3 - 2,
    title: { title: harbour, episode, name, showName: 'Lantern Harbour' },
    prefilled: false,
  });

  it('keeps the title and show name of a TMDB run it renumbers', () => {
    const rows = renumberFrom([tv(1, 1), tv(2, 2), tv(3, 3, 'Kept?')], 1, harbour, 5, 'Lantern Harbour');
    expect(rows.map((r) => r.title)).toEqual([
      { title: harbour, episode: 1, name: null, showName: 'Lantern Harbour' },
      { title: harbour, episode: 5, name: null, showName: 'Lantern Harbour' },
      { title: harbour, episode: 6, name: null, showName: 'Lantern Harbour' },
    ]);
  });

  it('gives a picked own title and its name to the run, rows with none included, and stops at another title', () => {
    const mine: EncodeTitle = { source: 'own', ownId: '0b7a1f4e-3c52-4d0a-9a55-2f6e8c1d7b90', season: 1 };
    const rows = renumberFrom([row(1, 1, 990010), row(2, 4, null), row(3, 7, 990012, 4)], 0, mine, 1, 'Harbour Notes');
    expect(rows.map((r) => [r.title?.title, r.title?.episode, r.title?.showName])).toEqual([
      [mine, 1, 'Harbour Notes'],
      [mine, 2, 'Harbour Notes'],
      [{ source: 'anilist', anilistId: 990012 }, 4, undefined],
    ]);
  });

  it('numbers after the row before when it has the same title', () => {
    expect(firstNumberFor([tv(1, 3), row(2, 4, null)], 1, harbour)).toBe(4);
    expect(firstNumberFor([tv(1, 3), row(2, 4, null)], 1, { ...harbour, season: 1 })).toBe(1);
  });
});

describe('firstNumberFor', () => {
  it('follows the row before when it has the same entry, else starts at 1', () => {
    const rows = [row(1, 1, 990010, 3), row(2, 4, 990011)];
    expect(firstNumberFor(rows, 1, 990010)).toBe(4);
    expect(firstNumberFor(rows, 1, 990012)).toBe(1);
    expect(firstNumberFor(rows, 0, 990010)).toBe(1);
  });
});

describe('withTitles', () => {
  it('fills the titles of the entry by number, null where AniList has none', () => {
    const rows = withTitles([row(1, 1, 990010, 1), row(2, 4, 990010, 2), row(3, 7, 990011, 1)], 990010, { 1: 'Harbor Lights' });
    expect(rows.map((r) => r.title?.name)).toEqual(['Harbor Lights', null, null]);
  });
});

describe('missingTitles', () => {
  it('lists the episodes with no entry', () => {
    expect(missingTitles([row(1, 1, 990010), row(2, 4, null), row(3, 7, 990010), row(4, 10, null)])).toEqual([2, 4]);
  });
});

describe('suggestedTitles', () => {
  it('lists the episodes whose entry is a suggestion never saved', () => {
    expect(suggestedTitles([row(1, 1, 990010), { ...row(2, 4, 990010), prefilled: true }])).toEqual([2]);
  });
});

describe('sharedTitles', () => {
  it('groups the saved episodes that share one entry and number', () => {
    const rows = [row(1, 1, 990010, 1), row(2, 4, 990010, 1), row(3, 7, 990011, 1), row(4, 10, 990010, 1), row(5, 13, null)];
    expect(sharedTitles(rows)).toEqual([[1, 2, 4]]);
  });

  it('leaves suggestions out', () => {
    expect(sharedTitles([row(1, 1, 990010, 1), { ...row(2, 4, 990010, 1), prefilled: true }])).toEqual([]);
  });
});

describe('episodesPhrase', () => {
  it('names one, two or more episodes', () => {
    expect(episodesPhrase([2])).toBe('Episode 2');
    expect(episodesPhrase([1, 2])).toBe('Episodes 1 and 2');
    expect(episodesPhrase([1, 3, 4])).toBe('Episodes 1, 3 and 4');
  });
});

describe('toInfo', () => {
  it('keys the AniList choices by first chapter and trims the names, leaving out empty ones', () => {
    const out = toInfo([row(1, 1, 990010), row(2, 4, null), row(3, 7, 990010, 2)], { '1': ' Opening ', '2': '', '3': 'Chapter 3', '5': 'Ending' });
    expect(out).toEqual({
      chapterNames: { '1': 'Opening', '5': 'Ending' },
      titles: { '1': { title: { source: 'anilist', anilistId: 990010 }, episode: 1, name: null }, '7': { title: { source: 'anilist', anilistId: 990010 }, episode: 2, name: null } },
    });
  });

  it('keeps the choices of chapters that start no episode now', () => {
    const kept: Record<string, EpisodeTitle> = { '4': { title: { source: 'anilist', anilistId: 990010 }, episode: 9, name: null }, '7': { title: { source: 'anilist', anilistId: 990010 }, episode: 9, name: null } };
    const out = toInfo([row(1, 1, 990010), row(2, 7, null)], {}, kept);
    expect(out.titles).toEqual({ '1': { title: { source: 'anilist', anilistId: 990010 }, episode: 1, name: null }, '4': kept['4'] });
  });
});
