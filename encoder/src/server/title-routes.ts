// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ServerResponse } from 'node:http';
import { RateLimited } from '@seikou/titles/pacer';
import { SourceUnavailable, type Entry } from '@seikou/titles/sources';
import { BadCover } from './covers';
import { httpError, json, type HelperContext, type RouteTable } from './http';

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
  /**
   * The backend's path of the cover (`/api/titles/<alId>/cover`, which serves AniList's large cover from this
   * origin; the page adds its token); null when AniList has none.
   */
  readonly poster: string | null;
}

/** Cover URLs remembered per run: at most this many, the oldest forgotten first. */
const MAX_REMEMBERED_COVERS = 500;

/** Per run, AniList's cover URL of every show a search answered, by AniList id. */
const coverUrls = new WeakMap<HelperContext, Map<number, string>>();

/** Remembers `url` as the cover of `alId` for this run, so the cover route fetches only URLs AniList gave. */
function rememberCover(ctx: HelperContext, alId: number, url: string): void {
  let urls = coverUrls.get(ctx);
  if (!urls) {
    urls = new Map();
    coverUrls.set(ctx, urls);
  }
  urls.delete(alId);
  urls.set(alId, url);
  if (urls.size > MAX_REMEMBERED_COVERS) urls.delete(urls.keys().next().value!);
}

/** The `TitleHit` of an AniList entry, or null for an entry whose id is not an AniList id; remembers its cover. */
function toHit(ctx: HelperContext, entry: Entry): TitleHit | null {
  const m = /^anilist:(\d+)$/.exec(entry.id);
  if (!m) return null;
  const alId = Number(m[1]);
  const { english, romaji, native } = entry.names;
  const cover = entry.poster?.large ?? null;
  if (cover !== null) rememberCover(ctx, alId, cover);
  return {
    alId,
    title: english ?? romaji ?? native ?? '',
    nativeTitle: native,
    year: entry.year,
    format: entry.format,
    episodes: entry.episodes,
    poster: cover === null ? null : `/api/titles/${alId}/cover`,
  };
}

/** An AbortSignal that aborts when the client goes away before its answer is sent. */
function clientGone(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort(new Error('the client went away'));
  });
  return controller.signal;
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
 *   GET /api/titles/<alId>/cover         the show's cover image, fetched from the URL a search of this run got from
 *                                        AniList for it (never one the client names); 404 `not-found` for a show no
 *                                        search answered with a cover, 502 `bad-cover` for an answer that is not an
 *                                        image or is over 5 MB
 *
 * A failing or throttled AniList (or its image host) answers 503 `source-unavailable` with `source: 'anilist'`.
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
        json(res, 200, { candidates: entries.map((e) => toHit(ctx, e)).filter((h): h is TitleHit => h !== null) });
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
  [
    'GET',
    /^\/api\/titles\/(\d+)\/cover$/,
    async (_req, res, match, ctx) => {
      const url = coverUrls.get(ctx)?.get(Number(match[1]));
      if (url === undefined) return httpError(res, 404, 'not-found', 'No search of this run gave a cover for that show.');
      try {
        const cover = await ctx.sources.covers.get(url, clientGone(res));
        res.writeHead(200, {
          'Content-Type': cover.contentType,
          'Content-Length': cover.bytes.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(cover.bytes);
      } catch (e) {
        if (res.destroyed) return;
        if (e instanceof BadCover) return httpError(res, 502, 'bad-cover', e.message);
        if (!answerUnavailable(res, e, 'anilist')) throw e;
      }
    },
  ],
];
