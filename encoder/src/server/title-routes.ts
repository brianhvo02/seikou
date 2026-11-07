// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ServerResponse } from 'node:http';
import { RateLimited } from '@seikou/titles/pacer';
import { SourceUnavailable, type Entry } from '@seikou/titles/sources';
import { httpError, json, type RouteTable } from './http';

// The title half of the helper's API. The user searches AniList by hand and picks the show; nothing here guesses it
// from the disc, so the AniList id the rest of the page works with is always one the user chose.

/** One AniList search result as the page lists it. */
export interface TitleHit {
  /** The AniList id. */
  readonly alId: number;
  /** The English name, else the romaji one, else the native one. */
  readonly title: string;
  /** The native (usually Japanese) name; null when AniList has none. */
  readonly nativeTitle: string | null;
  readonly year: number | null;
  /** AniList's format (`TV`, `MOVIE`, `OVA`, ...); null when unknown. */
  readonly format: string | null;
  /** The episode count; null while the show is airing or unknown. */
  readonly episodes: number | null;
  /** URL of the cover at AniList's large size; null when there is none. */
  readonly poster: string | null;
}

/** The `TitleHit` of an AniList entry, or null for an entry whose id is not an AniList id. */
function toHit(entry: Entry): TitleHit | null {
  const m = /^anilist:(\d+)$/.exec(entry.id);
  if (!m) return null;
  const { english, romaji, native } = entry.names;
  return {
    alId: Number(m[1]),
    title: english ?? romaji ?? native ?? '',
    nativeTitle: native,
    year: entry.year,
    format: entry.format,
    episodes: entry.episodes,
    poster: entry.poster?.large ?? null,
  };
}

/**
 * Answers 503 `source-unavailable` naming `source` when `e` is a failing or throttled source and returns true;
 * returns false, answering nothing, for any other error.
 */
export function answerUnavailable(res: ServerResponse, e: unknown, source: string): boolean {
  if (!(e instanceof SourceUnavailable) && !(e instanceof RateLimited)) return false;
  json(res, 503, { error: 'source-unavailable', source });
  return true;
}

/**
 * The title routes:
 *
 *   GET /api/titles/search?q=            `{ candidates: TitleHit[] }` in AniList's order; blank `q` is 400 `empty-query`
 *   GET /api/titles/<alId>/episodes      `{ titles: Record<number, string> }`, empty when AniList has no titles
 *
 * A failing or throttled AniList answers 503 `source-unavailable` with `source: 'anilist'`.
 */
export const titleRoutes: RouteTable = [
  [
    'GET',
    /^\/api\/titles\/search$/,
    async (req, res, _match, ctx) => {
      const q = new URL(req.url ?? '/', 'http://helper.invalid').searchParams.get('q')?.trim() ?? '';
      if (q === '') return httpError(res, 400, 'empty-query', 'Type a title to search for.');
      try {
        const entries = await ctx.sources.anilist.search(q, { urgent: true });
        json(res, 200, { candidates: entries.map(toHit).filter((h): h is TitleHit => h !== null) });
      } catch (e) {
        if (!answerUnavailable(res, e, 'anilist')) throw e;
      }
    },
  ],
  [
    'GET',
    /^\/api\/titles\/(\d+)\/episodes$/,
    async (_req, res, match, ctx) => {
      try {
        const titles = await ctx.sources.episodes.titles(Number(match[1]));
        json(res, 200, { titles: Object.fromEntries(titles) });
      } catch (e) {
        if (!answerUnavailable(res, e, 'anilist')) throw e;
      }
    },
  ],
];
