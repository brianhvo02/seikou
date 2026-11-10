// SPDX-License-Identifier: LGPL-3.0-or-later
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NasError, type NasClient } from '../nas/client';
import { NasTitles } from '../nas/nas-titles';
import { MAX_COVER_BYTES } from './covers';
import { httpError, json, type AppContext, type RouteTable } from './http';

// The NAS's catalogue for the Library by show: its shows, a show's seasons, discs and episodes joined to the encoder's
// disc keys and to the Encodes library, and the posters, passed on from the NAS's own art route.

const titlesOf = new WeakMap<AppContext, NasTitles>();

/** The one `NasTitles` of `app`. */
export function nasTitlesOf(app: AppContext): NasTitles {
  let titles = titlesOf.get(app);
  if (!titles) {
    titles = new NasTitles(app);
    titlesOf.set(app, titles);
  }
  return titles;
}

function paired(res: ServerResponse, app: AppContext): NasClient | null {
  if (app.nas.client !== null) return app.nas.client;
  httpError(res, 409, 'nas-not-paired', 'This app is not paired with a NAS. Pair it in Settings first.');
  return null;
}

/** Answers a NAS that forgot this device `nas-not-paired` 409; anything else is not this route's to answer. */
function unauthorized(res: ServerResponse, err: unknown): void {
  if (err instanceof NasError && err.code === 'unauthorized') return httpError(res, 409, 'nas-not-paired', 'The NAS no longer knows this app. Pair it again in Settings.');
  throw err;
}

/** Whether the request asks for the NAS's title details to be read again (`?refresh=1`). */
function refreshOf(req: IncomingMessage): boolean {
  return new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1';
}

/** The kinds of image a poster may be; the NAS answers the one it cached. */
const IMAGE = /^image\/(?:png|jpeg|gif|webp|avif)$/;

async function art(res: ServerResponse, client: NasClient, artId: string, size: string): Promise<void> {
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) gone.abort();
  });
  let answer: Response;
  try {
    answer = await client.request(`art/${artId}?size=${size}`, { signal: AbortSignal.any([gone.signal, AbortSignal.timeout(15_000)]) });
  } catch (err) {
    if (gone.signal.aborted) return;
    if (err instanceof NasError && err.code === 'unauthorized') return unauthorized(res, err);
    return httpError(res, 502, 'unreachable', 'The NAS did not answer.');
  }
  const type = answer.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!answer.ok || !IMAGE.test(type) || answer.body === null) {
    await answer.body?.cancel().catch(() => {});
    return answer.status === 404 ? httpError(res, 404, 'not-found', 'No such poster.') : httpError(res, 502, 'bad-cover', 'The NAS did not answer with an image.');
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
      length += chunk.length;
      if (length > MAX_COVER_BYTES) return httpError(res, 502, 'bad-cover', 'The poster is too large.');
      chunks.push(chunk);
    }
  } catch {
    if (!gone.signal.aborted) httpError(res, 502, 'unreachable', 'The NAS stopped answering.');
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': length, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  res.end(Buffer.concat(chunks));
}

/**
 * The NAS catalogue routes (409 `nas-not-paired` while not paired or after the NAS forgot this device):
 *
 *   GET /api/nas/shows[?refresh=1] `{ shows: [{ titleId, name, poster, kind, seasons, films, encoded, toEncode }],
 *                                 unsorted: [{ key, label, relPath }], reachable, stale }`; while the NAS does not
 *                                 answer, the last answer kept in `<data>/nas-titles.json` with `reachable: false`
 *   GET /api/nas/shows/<titleId>  `{ title, seasons: [{ id, label, number, title, discs: [{ key, discId, label,
 *                                 available, playlists: [{ id, episodes: [{ number, name, encoded }] }], checked }] }], reachable,
 *                                 stale }`; films are seasons with `number: null`; 404 `not-found` for a show the NAS
 *                                 does not list
 *   GET /api/nas/art/<artId>?size= a poster of a show or search result, from the NAS's `art/<id>`; 404 `not-found`
 *                                 for an id that is not 32 hex digits or one the NAS does not know, 502 `bad-cover`
 */
export const nasTitleRoutes: RouteTable = [
  [
    'GET',
    /^\/api\/nas\/shows$/,
    async (req, res, _m, app) => {
      const client = paired(res, app);
      if (client === null) return;
      try {
        json(res, 200, await nasTitlesOf(app).shows(client, { refresh: refreshOf(req) }));
      } catch (err) {
        unauthorized(res, err);
      }
    },
  ],
  [
    'GET',
    /^\/api\/nas\/shows\/([^/]+)$/,
    async (_req, res, match, app) => {
      const client = paired(res, app);
      if (client === null) return;
      let id: string;
      try {
        id = decodeURIComponent(match[1]!);
      } catch {
        return httpError(res, 404, 'not-found', 'No such show.');
      }
      try {
        const show = await nasTitlesOf(app).show(client, id);
        if (show === null) return httpError(res, 404, 'not-found', 'The NAS does not list that show.');
        json(res, 200, show);
      } catch (err) {
        unauthorized(res, err);
      }
    },
  ],
  [
    'GET',
    /^\/api\/nas\/art\/([^/?]+)$/,
    async (req, res, match, app) => {
      const client = paired(res, app);
      if (client === null) return;
      const artId = match[1]!;
      const size = new URL(req.url ?? '/', 'http://localhost').searchParams.get('size') === 'large' ? 'large' : 'small';
      if (!/^[0-9a-f]{32}$/.test(artId)) return httpError(res, 404, 'not-found', 'No such poster.');
      await art(res, client, artId, size);
    },
  ],
];
