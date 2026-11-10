// SPDX-License-Identifier: LGPL-3.0-or-later
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseRange } from '../../../server/src/ranges';
import type { NasClient } from '../nas/client';
import type { ToolPaths } from '../pipeline/chain';
import type { SeaDex } from '@seikou/fansubs/seadex';
import type { Tosho } from '@seikou/fansubs/tosho';
import type { MetadataSource } from '@seikou/titles/sources';

// The small HTTP vocabulary every route module of the helper backend shares: the app context and the helper session
// a route runs in, the shape of a route, and the JSON and error answers.

/** The outside services the helper asks. Tests and the offline mode pass recorded answers instead of the network. */
export interface HelperSources {
  /** SeaDex: the recommended releases of a show by AniList id. */
  readonly seadex: SeaDex;
  /** Anime Tosho: release search and the downloads of subtitle tracks and font packs. */
  readonly tosho: Tosho;
  /** AniList search, for the user's pick of the show. */
  readonly anilist: MetadataSource;
  /** Episode titles by episode number (from 1) of an AniList id; empty when AniList has none. */
  readonly episodes: { titles(alId: number): Promise<ReadonlyMap<number, string>> };
  /** Cover images by the URL AniList gave for them, which the backend passes on to the page from its own origin. */
  readonly covers: CoverSource;
}

/** A cover image: its bytes and its `image/...` content type. */
export interface CoverImage {
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/** Fetches cover images. */
export interface CoverSource {
  /**
   * The image at `url`. Rejects with `SourceUnavailable` when the image host cannot be reached, answers an error or
   * is too slow, and with `BadCover` when the answer is not a PNG, JPEG, GIF, WebP or AVIF image or is too large.
   */
  get(url: string, signal: AbortSignal): Promise<CoverImage>;
}

/** What the backend holds for its whole life, whatever discs and helper sessions it serves. */
export interface AppContext {
  /** Where records, fetched releases and caches are kept (see `appDataDir`). */
  readonly dataDir: string;
  /** The secret every `/api/` request must carry, as `Authorization: Bearer` or the `t` query parameter. */
  readonly token: string;
  /** The built page, served without a token; null serves no page. */
  readonly webDir: string | null;
  /** The external tools alignment needs, or null when they are not installed. */
  readonly tools: ToolPaths | null;
  /** The outside services. */
  readonly sources: HelperSources;
  /** The library folders the backend may read discs from; a disc opened by `serve` needs none. */
  readonly roots: readonly string[];
  /** The NAS the encoder is paired with; the holder's `client` is replaced when the page pairs or unpairs. */
  readonly nas: NasHolder;
}

/** Holds the NAS client: null while the encoder is not paired. */
export interface NasHolder {
  client: NasClient | null;
}

/**
 * One helper session: the subtitle helper working on one disc, one playlist and one episode list, fixed when the
 * session is made. A session lives as long as the server.
 */
export interface HelperSession {
  /** 16 lower-case hex digits, the `<id>` of `/api/sessions/<id>/...` and of the page's `/helper/<id>`. */
  readonly id: string;
  /** Real path of the disc folder (the one holding BDMV). */
  readonly discDir: string;
  /** The disc's key, the `<discKey>` of the disc routes and of the saved record. */
  readonly discKey: string;
  /** Five-digit playlist name, such as `00000`. */
  readonly playlistId: string;
  /** The episode list as the user typed it, such as `1-3,4-6` (see `parseEpisodeSpec`). */
  readonly episodeSpec: string;
}

/**
 * One API route. `match` is the route's pattern run on the request's path (still percent-encoded, without the query),
 * so a route decodes its own captures. The request is already authorised and its path checked. `session` is the
 * helper session a session route was called under, null for an app route. A route must answer; a rejection becomes a
 * 500 `internal` answer when nothing has been sent yet.
 */
export type Route = (
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpExecArray,
  app: AppContext,
  session: HelperSession | null,
) => Promise<void>;

/** A route that runs only under a helper session. */
export type SessionRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpExecArray,
  app: AppContext,
  session: HelperSession,
) => Promise<void>;

/**
 * A route module's table: method (`GET`, `HEAD`, `PUT`, `POST`, ...), a pattern anchored on the whole path, and the
 * route. An app table's patterns match the whole path (`/api/...`); a session table's match what follows
 * `/api/sessions/<id>` (empty for the session itself, else starting with a slash).
 */
export type RouteTable = readonly (readonly [method: string, pattern: RegExp, route: Route])[];

/** `route` as a `Route` for a session table, which the server always calls with a session. */
export function sessionRoute(route: SessionRoute): Route {
  return (req, res, match, app, session) => {
    if (session === null) return Promise.reject(new Error('a session route was called without a session'));
    return route(req, res, match, app, session);
  };
}

/** Answers `body` as JSON with `status`; API answers are never cached. */
export function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** Answers the error `{ error: code, message? }` with `status`. `code` is a short kebab-case word the page can test. */
export function httpError(res: ServerResponse, status: number, code: string, message?: string): void {
  json(res, status, message === undefined ? { error: code } : { error: code, message });
}

/**
 * Answers a file of `size` bytes at `path`, whole (200) or the one range the request's `Range` header asks (206),
 * streamed from disk so no more than the range is read; 416 when the range starts past the end. HEAD answers the
 * headers only. A client that goes away stops the read.
 */
export function sendFile(req: IncomingMessage, res: ServerResponse, path: string, size: number, headers: Record<string, string>): void {
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  res.writeHead(range ? 206 : 200, {
    ...headers,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(length),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(path, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
