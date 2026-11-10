// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The Episodes page's chapter names and episode titles: one row per episode of the grouping, keyed in the saved
 * episode info by the playlist chapter it starts at, so regrouping keeps what was chosen. Pure.
 */
import { encodeId } from '@seikou/nas/encode-id';
import type { EpisodeInfo, EpisodeTitle } from '../api-types';

/** The names the chapter picker offers besides "No name" and a custom one; the backend's `CHAPTER_NAMES`, repeated because the page never imports the backend. */
export const CHAPTER_NAMES = ['Avant', 'Opening', 'Part A', 'Part B', 'Ending', 'Part C', 'Preview'] as const;

/** One episode of the grouping with its title and number. */
export interface EpisodeRow {
  /** 1-based position in the episode list. */
  readonly index: number;
  /** The playlist chapter the episode starts at: its key in `EpisodeInfo.titles`. */
  readonly firstChapter: number;
  /** The title and number, or null when none is chosen. */
  readonly title: EpisodeTitle | null;
  /** True for a suggestion the user has not confirmed (from the saved subtitle record's show); false once saved. */
  readonly prefilled: boolean;
}

/** One row per episode of the grouping: the saved choice for its first chapter, else a prefill. */
export function episodeRows(
  episodes: readonly { readonly index: number; readonly first: number }[],
  info: EpisodeInfo | null,
  recordShow: { readonly id: number } | null,
): EpisodeRow[] {
  const saved = info?.titles ?? {};
  const anySaved = episodes.some((e) => saved[String(e.first)] !== undefined);
  return episodes.map((e, i): EpisodeRow => {
    const choice = saved[String(e.first)];
    if (choice !== undefined) return { index: e.index, firstChapter: e.first, title: choice, prefilled: false };
    if (!anySaved && recordShow !== null) {
      return { index: e.index, firstChapter: e.first, title: { title: { source: 'anilist', anilistId: recordShow.id }, episode: i + 1, name: null }, prefilled: true };
    }
    return { index: e.index, firstChapter: e.first, title: null, prefilled: false };
  });
}

/** The AniList entry of a title, or null for a title of another source. */
export function aniListIdOf(t: EpisodeTitle | null): number | null {
  return t !== null && t.title.source === 'anilist' ? t.title.anilistId : null;
}

/** Renumbers from `row` on: that row gets `entryId` and `first`, each later row of the same entry run the next number, until a row whose entry was set by hand to another one. */
export function renumberFrom(rows: readonly EpisodeRow[], row: number, entryId: number, first: number): EpisodeRow[] {
  const start = rows[row];
  if (start === undefined) return [...rows];
  // the run: rows of the entry the row had, of the entry it gets, and rows with none
  const runIds = new Set([entryId, ...(aniListIdOf(start.title) === null ? [] : [aniListIdOf(start.title)!])]);
  const out = [...rows];
  let number = first;
  for (let i = row; i < rows.length; i++) {
    const r = rows[i]!;
    const own = aniListIdOf(r.title);
    if (i > row && r.title !== null && (own === null || !runIds.has(own))) break;
    const same = r.title !== null && own === entryId && r.title.episode === number;
    out[i] = { ...r, title: { title: { source: 'anilist', anilistId: entryId }, episode: number, name: same ? r.title!.name : null }, prefilled: false };
    number += 1;
  }
  return out;
}

/** The number a row given `entryId` starts at: one after the row before when that row has the same entry, else 1. */
export function firstNumberFor(rows: readonly EpisodeRow[], row: number, entryId: number): number {
  const before = rows[row - 1]?.title ?? null;
  return before !== null && aniListIdOf(before) === entryId ? before.episode + 1 : 1;
}

/** The rows of entry `entryId` with their titles from AniList's (`titles`, keyed by episode number); null where it has none. */
export function withTitles(rows: readonly EpisodeRow[], entryId: number, titles: Readonly<Record<number, string>>): EpisodeRow[] {
  return rows.map((r) => (r.title === null || aniListIdOf(r.title) !== entryId ? r : { ...r, title: { ...r.title, name: titles[r.title.episode] ?? null } }));
}

/** What a NAS encode lacks: the episode indices with no title and number. */
export function missingTitles(rows: readonly EpisodeRow[]): number[] {
  return rows.filter((r) => r.title === null).map((r) => r.index);
}

/** The episode indices whose entry is only a suggestion: the backend reads saved choices only, so a NAS encode lacks these too. */
export function suggestedTitles(rows: readonly EpisodeRow[]): number[] {
  return rows.filter((r) => r.title !== null && r.prefilled).map((r) => r.index);
}

/** The saved episodes that share one title and number (one encode id), in groups of indices; the NAS keeps one file per id. */
export function sharedTitles(rows: readonly EpisodeRow[]): number[][] {
  const byPair = new Map<string, number[]>();
  for (const r of rows) {
    if (r.title === null || r.prefilled) continue;
    const pair = encodeId(r.title.title, r.title.episode);
    byPair.set(pair, [...(byPair.get(pair) ?? []), r.index]);
  }
  return [...byPair.values()].filter((g) => g.length > 1);
}

/** Episodes named in words: "Episode 2", "Episodes 1 and 2", "Episodes 1, 3 and 4". */
export function episodesPhrase(indices: readonly number[]): string {
  if (indices.length === 1) return `Episode ${indices[0]}`;
  return `Episodes ${indices.slice(0, -1).join(', ')} and ${indices[indices.length - 1]}`;
}

/** A chapter name as the file keeps it: trimmed, or null for none (empty, or the encoder's own `Chapter <n>`). */
function cleanName(name: string): string | null {
  const t = name.trim();
  return t === '' || /^Chapter \d+$/.test(t) ? null : t;
}

/**
 * The info to save: the chapter names trimmed (empty ones left out) and each row's title keyed by its first chapter.
 * `kept` holds earlier choices; those of chapters that start no row now are kept, so a regrouping loses nothing.
 */
export function toInfo(
  rows: readonly EpisodeRow[],
  chapterNames: Readonly<Record<string, string>>,
  kept: Readonly<Record<string, EpisodeTitle>> = {},
): Omit<EpisodeInfo, 'savedAt'> {
  const names: Record<string, string> = {};
  for (const [key, name] of Object.entries(chapterNames)) {
    const clean = cleanName(name);
    if (clean !== null) names[key] = clean;
  }
  const starts = new Set(rows.map((r) => String(r.firstChapter)));
  const titles: Record<string, EpisodeTitle> = {};
  for (const [key, choice] of Object.entries(kept)) if (!starts.has(key)) titles[key] = choice;
  for (const r of rows) if (r.title !== null) titles[String(r.firstChapter)] = r.title;
  return { chapterNames: names, titles };
}
