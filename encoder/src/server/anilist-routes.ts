// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ServerResponse } from 'node:http';
import { RateLimited } from '@seikou/titles/pacer';
import { SourceUnavailable, type Entry } from '@seikou/titles/sources';
import { httpError, json, type AppContext, type RouteTable } from './http';
import { aniListIdOf, answerCover, answerEpisodes, answerSearch, answerUnavailable, toHit, type CoverPath, type TitleHit } from './title-routes';

// The AniList lookups at app level, for the pages that work without a helper session (the Episodes page): the same
// search, episode titles and covers as a session's title routes, and an entry with its next season.

/** The app's cover route of an AniList id. */
const appCoverPath: CoverPath = (alId) => `/api/anilist/${alId}/cover`;

/** The formats of a series' season; a `SEQUEL` in another format (a film, an OVA, a special) is not a next season. */
const SERIES_FORMATS: ReadonlySet<string> = new Set(['TV', 'TV_SHORT', 'ONA']);

/** One AniList entry with its next season, as `GET /api/anilist/<id>` answers it. */
export interface AniListEntry extends TitleHit {
  /** The next season: the entry's `SEQUEL` with a series format, the earliest to start when there are several. */
  readonly sequel: TitleHit | null;
}

/**
 * A FuzzyDateInt (YYYYMMDD, 00 for an unknown month or day, null without a year) as a key that sorts by year, then
 * month, then day, an unknown part after every known one and no date after every date.
 */
function dateKey(date: number | null): number {
  if (date === null) return Number.POSITIVE_INFINITY;
  const year = Math.floor(date / 10_000);
  const month = Math.floor(date / 100) % 100 || 13;
  const day = date % 100 || 32;
  return year * 10_000 + month * 100 + day;
}

/**
 * The AniList id of an entry's next season: of its `SEQUEL` relations in a series format (`TV`, `TV_SHORT`, `ONA`),
 * the earliest by start date (ties keep AniList's order); null when it has none.
 */
export function pickSequel(relations: Entry['relations']): number | null {
  let best: { readonly alId: number; readonly key: number } | null = null;
  for (const r of relations) {
    if (r.type !== 'SEQUEL' || r.format === null || !SERIES_FORMATS.has(r.format)) continue;
    const alId = aniListIdOf(r.id);
    if (alId === null) continue;
    const key = dateKey(r.startDate);
    if (best === null || key < best.key) best = { alId, key };
  }
  return best?.alId ?? null;
}

/** The AniList id of a matched path segment, or null after answering 404 `not-found` for one that is not a positive integer. */
function idOf(res: ServerResponse, captured: string): number | null {
  const alId = Number(captured);
  if (Number.isSafeInteger(alId) && alId > 0) return alId;
  httpError(res, 404, 'not-found', 'No such AniList entry.');
  return null;
}

/** The `TitleHit` of the next season `alId`, or null when AniList does not know it or fails to answer. */
async function sequelHit(app: AppContext, alId: number): Promise<TitleHit | null> {
  try {
    const entry = await app.sources.anilist.entry(`anilist:${alId}`);
    return entry === null ? null : toHit(app, entry, appCoverPath);
  } catch (e) {
    if (e instanceof SourceUnavailable || e instanceof RateLimited) return null; // the entry itself is still worth answering
    throw e;
  }
}

/**
 * The app's AniList routes:
 *
 *   GET /api/anilist/search?q=        `{ candidates: TitleHit[] }` in AniList's order, posters at the cover route
 *                                     below; blank `q` is 400 `empty-query`
 *   GET /api/anilist/<id>             `{ entry: AniListEntry }`; 404 `not-found` for an id AniList does not know
 *   GET /api/anilist/<id>/episodes    `{ titles: Record<number, string> }`, empty when AniList has no titles
 *   GET /api/anilist/<id>/cover       as a session's cover route, from the covers any lookup of this run remembered
 *
 * A failing or throttled AniList answers 503 `source-unavailable` with `source: 'anilist'`, except for the second
 * lookup of an entry's sequel, whose failure answers the entry with `sequel: null`.
 */
export const aniListRoutes: RouteTable = [
  ['GET', /^\/api\/anilist\/search$/, (req, res, _match, app) => answerSearch(req, res, app, appCoverPath)],
  [
    'GET',
    /^\/api\/anilist\/(\d+)$/,
    async (_req, res, match, app) => {
      const alId = idOf(res, match[1]!);
      if (alId === null) return;
      let entry: Entry | null;
      try {
        entry = await app.sources.anilist.entry(`anilist:${alId}`);
      } catch (e) {
        if (!answerUnavailable(res, e, 'anilist')) throw e;
        return;
      }
      const hit = entry === null ? null : toHit(app, entry, appCoverPath);
      if (entry === null || hit === null) return httpError(res, 404, 'not-found', 'No such AniList entry.');
      const sequelId = pickSequel(entry.relations);
      const sequel = sequelId === null ? null : await sequelHit(app, sequelId);
      const answer: AniListEntry = { ...hit, sequel };
      json(res, 200, { entry: answer });
    },
  ],
  [
    'GET',
    /^\/api\/anilist\/(\d+)\/episodes$/,
    async (_req, res, match, app) => {
      const alId = idOf(res, match[1]!);
      if (alId !== null) await answerEpisodes(res, app, alId);
    },
  ],
  [
    'GET',
    /^\/api\/anilist\/(\d+)\/cover$/,
    async (_req, res, match, app) => {
      const alId = idOf(res, match[1]!);
      if (alId !== null) await answerCover(res, app, alId);
    },
  ],
];
