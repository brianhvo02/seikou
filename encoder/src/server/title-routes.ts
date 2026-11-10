// SPDX-License-Identifier: LGPL-3.0-or-later
import type { IncomingMessage, ServerResponse } from 'node:http';
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
   * The backend's path of the cover (`/api/sessions/<id>/titles/<alId>/cover` from a session's routes,
   * `/api/anilist/<alId>/cover` from the app's), which serves AniList's large cover from this origin (the page adds
   * its token); null when AniList has none.
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

/** The backend's path of the cover route of an AniList id, which differs between the session and the app routes. */
export type CoverPath = (alId: number) => string;

/** The AniList id of an entry id such as `anilist:900101`, or null for an id of another source. */
export function aniListIdOf(id: string): number | null {
  const m = /^anilist:(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/**
 * The `TitleHit` of an AniList entry, its cover at `coverPath`, or null for an entry whose id is not an AniList id;
 * remembers its cover.
 */
export function toHit(app: AppContext, entry: Entry, coverPath: CoverPath): TitleHit | null {
  const alId = aniListIdOf(entry.id);
  if (alId === null) return null;
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
    poster: cover === null ? null : coverPath(alId),
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

/** Answers an AniList search for the request's `q`: `{ candidates }` with covers at `coverPath`, or 400 `empty-query`. */
export async function answerSearch(req: IncomingMessage, res: ServerResponse, app: AppContext, coverPath: CoverPath): Promise<void> {
  const q = new URL(req.url ?? '/', 'http://helper.invalid').searchParams.get('q')?.trim() ?? '';
  if (q === '') return httpError(res, 400, 'empty-query', 'Type a title to search for.');
  try {
    const entries = await app.sources.anilist.search(q, { urgent: true });
    json(res, 200, { candidates: entries.map((e) => toHit(app, e, coverPath)).filter((h): h is TitleHit => h !== null) });
  } catch (e) {
    if (!answerUnavailable(res, e, 'anilist')) throw e;
  }
}

/** Answers AniList's episode titles of `alId`: `{ titles }`, empty when it has none. */
export async function answerEpisodes(res: ServerResponse, app: AppContext, alId: number): Promise<void> {
  try {
    const titles = await app.sources.episodes.titles(alId);
    json(res, 200, { titles: Object.fromEntries(titles) });
  } catch (e) {
    if (!answerUnavailable(res, e, 'anilist')) throw e;
  }
}

/** Answers the cover of `alId` from the URL a lookup of this run got from AniList, or 404, 502 `bad-cover` or 503. */
export async function answerCover(res: ServerResponse, app: AppContext, alId: number): Promise<void> {
  const url = coverUrls.get(app)?.get(alId);
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
    sessionRoute((req, res, _match, app, session) => answerSearch(req, res, app, (alId) => `/api/sessions/${session.id}/titles/${alId}/cover`)),
  ],
  ['GET', /^\/titles\/(\d+)\/episodes$/, sessionRoute((_req, res, match, app) => answerEpisodes(res, app, Number(match[1])))],
  ['GET', /^\/titles\/(\d+)\/cover$/, sessionRoute((_req, res, match, app) => answerCover(res, app, Number(match[1])))],
];
