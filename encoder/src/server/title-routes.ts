// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ServerResponse } from 'node:http';
import { RateLimited } from '@seikou/titles/pacer';
import { SourceUnavailable, type Entry } from '@seikou/titles/sources';
import { BadCover } from './covers';
import { httpError, json, sessionRoute, type AppContext, type RouteTable } from './http';

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
   * The backend's path of the cover (`/api/sessions/<id>/titles/<alId>/cover`, which serves AniList's large cover
   * from this origin; the page adds its token); null when AniList has none.
   */
  readonly poster: string | null;
}

/** Cover URLs remembered by the backend: at most this many, the oldest forgotten first. */
const MAX_REMEMBERED_COVERS = 500;

/** Per app, AniList's cover URL of every show a search answered (in any session), by AniList id. */
const coverUrls = new WeakMap<AppContext, Map<number, string>>();

/** Remembers `url` as the cover of `alId`, so the cover route fetches only URLs AniList gave. */
function rememberCover(app: AppContext, alId: number, url: string): void {
  let urls = coverUrls.get(app);
  if (!urls) {
    urls = new Map();
    coverUrls.set(app, urls);
  }
  urls.delete(alId);
  urls.set(alId, url);
  if (urls.size > MAX_REMEMBERED_COVERS) urls.delete(urls.keys().next().value!);
}

/**
 * The `TitleHit` of an AniList entry, its cover path under the session `sessionId`, or null for an entry whose id is
 * not an AniList id; remembers its cover.
 */
function toHit(app: AppContext, sessionId: string, entry: Entry): TitleHit | null {
  const m = /^anilist:(\d+)$/.exec(entry.id);
  if (!m) return null;
  const alId = Number(m[1]);
  const { english, romaji, native } = entry.names;
  const cover = entry.poster?.large ?? null;
  if (cover !== null) rememberCover(app, alId, cover);
  return {
    alId,
    title: english ?? romaji ?? native ?? '',
    nativeTitle: native,
    year: entry.year,
    format: entry.format,
    episodes: entry.episodes,
    poster: cover === null ? null : `/api/sessions/${sessionId}/titles/${alId}/cover`,
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
 * A session's title routes, under `/api/sessions/<id>`:
 *
 *   GET /titles/search?q=            `{ candidates: TitleHit[] }` in AniList's order; blank `q` is 400 `empty-query`
 *   GET /titles/<alId>/episodes      `{ titles: Record<number, string> }`, empty when AniList has no titles
 *   GET /titles/<alId>/cover         the show's cover image, fetched from the URL a search (in any session) got from
 *                                    AniList for it (never one the client names); 404 `not-found` for a show no
 *                                    search answered with a cover, 502 `bad-cover` for an answer that is not an
 *                                    image or is over 5 MB
 *
 * A failing or throttled AniList (or its image host) answers 503 `source-unavailable` with `source: 'anilist'`.
 */
export const titleRoutes: RouteTable = [
  [
    'GET',
    /^\/titles\/search$/,
    sessionRoute(async (req, res, _match, app, session) => {
      const q = new URL(req.url ?? '/', 'http://helper.invalid').searchParams.get('q')?.trim() ?? '';
      if (q === '') return httpError(res, 400, 'empty-query', 'Type a title to search for.');
      try {
        const entries = await app.sources.anilist.search(q, { urgent: true });
        json(res, 200, { candidates: entries.map((e) => toHit(app, session.id, e)).filter((h): h is TitleHit => h !== null) });
      } catch (e) {
        if (!answerUnavailable(res, e, 'anilist')) throw e;
      }
    }),
  ],
  [
    'GET',
    /^\/titles\/(\d+)\/episodes$/,
    sessionRoute(async (_req, res, match, app) => {
      try {
        const titles = await app.sources.episodes.titles(Number(match[1]));
        json(res, 200, { titles: Object.fromEntries(titles) });
      } catch (e) {
        if (!answerUnavailable(res, e, 'anilist')) throw e;
      }
    }),
  ],
  [
    'GET',
    /^\/titles\/(\d+)\/cover$/,
    sessionRoute(async (_req, res, match, app) => {
      const url = coverUrls.get(app)?.get(Number(match[1]));
      if (url === undefined) return httpError(res, 404, 'not-found', 'No search gave a cover for that show.');
      try {
        const cover = await app.sources.covers.get(url, clientGone(res));
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
    }),
  ],
];
