// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { EpisodeInfo } from '../api-types';
import { episodeRows, firstNumberFor, missingAniList, renumberFrom, toInfo, withTitles, type EpisodeRow } from './episode-info-model';

const EPISODES = [
  { index: 1, first: 1 },
  { index: 2, first: 4 },
  { index: 3, first: 7 },
  { index: 4, first: 10 },
];

const info = (anilist: EpisodeInfo['anilist'], chapterNames: EpisodeInfo['chapterNames'] = {}): EpisodeInfo => ({ chapterNames, anilist, savedAt: '2026-11-09T10:00:00.000Z' });

const row = (index: number, firstChapter: number, anilistId: number | null, episode = index): EpisodeRow => ({
  index,
  firstChapter,
  anilist: anilistId === null ? null : { anilistId, episode, title: null },
  prefilled: false,
});

describe('episodeRows', () => {
  it('prefills from the record show, numbered 1 to n, marked prefilled', () => {
    const rows = episodeRows(EPISODES, null, { id: 990010 });
    expect(rows.map((r) => [r.index, r.firstChapter, r.anilist?.anilistId, r.anilist?.episode, r.prefilled])).toEqual([
      [1, 1, 990010, 1, true],
      [2, 4, 990010, 2, true],
      [3, 7, 990010, 3, true],
      [4, 10, 990010, 4, true],
    ]);
  });

  it('leaves every row empty with no record show and nothing saved', () => {
    const rows = episodeRows(EPISODES, info({}), null);
    expect(rows.every((r) => r.anilist === null && !r.prefilled)).toBe(true);
  });

  it('keeps a saved choice and does not prefill beside it', () => {
    const saved = info({ '4': { anilistId: 990020, episode: 7, title: 'The Lantern' } });
    const rows = episodeRows(EPISODES, saved, { id: 990010 });
    expect(rows[1]).toEqual({ index: 2, firstChapter: 4, anilist: { anilistId: 990020, episode: 7, title: 'The Lantern' }, prefilled: false });
    expect(rows.filter((r) => r.index !== 2).every((r) => r.anilist === null && !r.prefilled)).toBe(true);
  });
});

describe('renumberFrom', () => {
  const four = [row(1, 1, 990010), row(2, 4, 990010), row(3, 7, 990010), row(4, 10, 990010)];

  it('gives the row the entry and number, and the rest of its run the next numbers', () => {
    const rows = renumberFrom(four, 2, 990011, 1);
    expect(rows[0]).toEqual(four[0]);
    expect(rows[1]).toEqual(four[1]);
    expect(rows[2]!.anilist).toEqual({ anilistId: 990011, episode: 1, title: null });
    expect(rows[3]!.anilist).toEqual({ anilistId: 990011, episode: 2, title: null });
  });

  it('stops at a row set by hand to another entry', () => {
    const rows = renumberFrom([...four.slice(0, 3), row(4, 10, 990012, 5), row(5, 13, 990010, 5)], 2, 990011, 1);
    expect(rows[2]!.anilist?.anilistId).toBe(990011);
    expect(rows[3]!.anilist).toEqual({ anilistId: 990012, episode: 5, title: null });
    expect(rows[4]!.anilist).toEqual({ anilistId: 990010, episode: 5, title: null });
  });

  it('renumbering within the same entry runs on, and empty rows join the run', () => {
    const rows = renumberFrom([row(1, 1, 990010), row(2, 4, 990010), row(3, 7, null)], 1, 990010, 5);
    expect(rows.map((r) => r.anilist?.episode)).toEqual([1, 5, 6]);
    expect(rows[2]!.anilist?.anilistId).toBe(990010);
  });

  it('keeps a title only where the entry and number stay the same', () => {
    expect(renumberFrom(four.map((r) => ({ ...r, anilist: { ...r.anilist!, title: 'Kept' } })), 1, 990010, 2).map((r) => r.anilist?.title)).toEqual(['Kept', 'Kept', 'Kept', 'Kept']);
    const titled = four.map((r) => ({ ...r, anilist: { ...r.anilist!, title: `Title ${r.index}` } }));
    const rows = renumberFrom(titled, 1, 990010, 3);
    expect(rows.map((r) => r.anilist?.title)).toEqual(['Title 1', null, null, null]);
  });

  it('drops the prefilled mark of the rows it sets', () => {
    const rows = renumberFrom(episodeRows(EPISODES, null, { id: 990010 }), 2, 990011, 1);
    expect(rows.map((r) => r.prefilled)).toEqual([true, true, false, false]);
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
    expect(rows.map((r) => r.anilist?.title)).toEqual(['Harbor Lights', null, null]);
  });
});

describe('missingAniList', () => {
  it('lists the episodes with no entry', () => {
    expect(missingAniList([row(1, 1, 990010), row(2, 4, null), row(3, 7, 990010), row(4, 10, null)])).toEqual([2, 4]);
  });
});

describe('toInfo', () => {
  it('keys the AniList choices by first chapter and trims the names, leaving out empty ones', () => {
    const out = toInfo([row(1, 1, 990010), row(2, 4, null), row(3, 7, 990010, 2)], { '1': ' Opening ', '2': '', '3': 'Chapter 3', '5': 'Ending' });
    expect(out).toEqual({
      chapterNames: { '1': 'Opening', '5': 'Ending' },
      anilist: { '1': { anilistId: 990010, episode: 1, title: null }, '7': { anilistId: 990010, episode: 2, title: null } },
    });
  });

  it('keeps the choices of chapters that start no episode now', () => {
    const kept = { '4': { anilistId: 990010, episode: 9, title: null }, '7': { anilistId: 990010, episode: 9, title: null } };
    const out = toInfo([row(1, 1, 990010), row(2, 7, null)], {}, kept);
    expect(out.anilist).toEqual({ '1': { anilistId: 990010, episode: 1, title: null }, '4': kept['4'] });
  });
});
