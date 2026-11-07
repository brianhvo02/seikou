// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { rankReleases } from '@seikou/fansubs/choose';
import { FetchCache } from '@seikou/fansubs/fetch-cache';
import type { SeaDexRelease } from '@seikou/fansubs/seadex';
import { NotFoundOnTosho } from '@seikou/fansubs/tosho';
import { readBody } from '../../../server/src/http';
import { ReleaseCache, UploadRejected, type CachedRelease } from '../subs/release-cache';
import { matchRelease } from '../subs/release-match';
import { SubtitleEncodingError } from '../subs/srt-to-ass';
import { httpError, json, type HelperContext, type RouteTable } from './http';
import { answerUnavailable } from './title-routes';

// The fansub half of the helper's API: SeaDex's recommendations for the show the user picked, Anime Tosho search and
// fetch, the user's own uploads, and the releases the cache holds, each with its match against the session's episodes.

/** Budget of the download cache under `<data>/cache/fansubs`. */
const FETCH_CACHE_BYTES = 512 * 1024 * 1024;
/** Largest single upload: a font's limit, since the release cache holds subtitle files to a lower one. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Files one upload batch may hold. */
const MAX_BATCH_FILES = 200;
const BATCH_PATTERN = /^[0-9a-f]{16}$/;

const caches = new WeakMap<HelperContext, ReleaseCache>();

/** The one `ReleaseCache` of this run, made on first use from the context's data directory and Anime Tosho source; every route that reads releases shares it. */
export function releaseCacheOf(ctx: HelperContext): ReleaseCache {
  let cache = caches.get(ctx);
  if (!cache) {
    const fetchCache = new FetchCache(join(ctx.dataDir, 'cache', 'fansubs'), FETCH_CACHE_BYTES);
    cache = new ReleaseCache(ctx.dataDir, { tosho: ctx.sources.tosho, fetchCache });
    caches.set(ctx, cache);
  }
  return cache;
}

/** The session's episode numbers, 1 to N: one episode per comma-separated token of the spec. */
function episodeNumbers(ctx: HelperContext): number[] {
  const n = ctx.episodeSpec.split(',').filter((t) => t.trim() !== '').length;
  return Array.from({ length: n }, (_, i) => i + 1);
}

/** The request's query parameters. */
function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://helper.invalid').searchParams;
}

/** The `offset` query parameter (episodes the release numbered before this disc's first), 0 when absent; null when it is not a whole number. */
function offsetOf(req: IncomingMessage): number | null {
  const raw = queryOf(req).get('offset');
  if (raw === null || raw === '') return 0;
  return /^-?\d{1,6}$/.test(raw) ? Number(raw) : null;
}

/** Answers `release` with its `match` against the session's episodes. */
function answerRelease(res: ServerResponse, ctx: HelperContext, release: CachedRelease, offset: number): void {
  json(res, 200, { ...release, match: matchRelease(release.files, episodeNumbers(ctx), offset) });
}

/**
 * Runs `body`, turning an upstream failure into its answer: 503 `source-unavailable` for a failing or throttled
 * `source`, 404 `not-on-tosho` for a release or download Anime Tosho lacks. Other errors propagate.
 */
async function upstream(res: ServerResponse, source: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (e) {
    if (e instanceof NotFoundOnTosho) return httpError(res, 404, 'not-on-tosho', 'Anime Tosho does not have that release.');
    if (!answerUnavailable(res, e, source)) throw e;
  }
}

/** Percent-decodes a path part; null when it does not decode. */
function decode(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/** Whether `name` is a plain file name: no slash, backslash, NUL, `.` or `..`, at most 255 bytes. */
function plainName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name) && Buffer.byteLength(name) <= 255;
}

/** Answers 413 with `Connection: close`, so a client still sending its body is cut off. */
function tooLarge(res: ServerResponse): void {
  res.setHeader('Connection', 'close');
  httpError(res, 413, 'too-large', 'That file is too large.');
}

/** The folder a batch's files wait in until commit. */
const batchDir = (ctx: HelperContext, batch: string): string => join(ctx.dataDir, 'uploads', batch);

interface SeaDexRow {
  readonly group: string;
  readonly tracker: string;
  readonly isBest: boolean;
  readonly dualAudio: boolean;
  readonly tags: readonly string[];
  readonly toshoId: number | null;
  readonly unavailable: null | 'private-tracker' | 'not-on-tosho';
}

/**
 * The fansub routes:
 *
 *   GET  /api/fansubs/seadex?anilist=<id>     `{ notes, comparison, url, releases }`: the public releases in
 *                                             `rankReleases` order, then the private-tracker ones, each with its
 *                                             Anime Tosho id (`toshoId`) or why it has none (`unavailable`)
 *   GET  /api/fansubs/search?q=               Anime Tosho releases `{ toshoId, title, date }[]`, date in epoch seconds
 *   POST /api/fansubs/fetch?offset=           body `{ toshoId }`; the cached release plus `match`
 *   PUT  /api/uploads/<batch>/<name>          one raw file of an upload batch (`batch`: 16 lower-case hex digits)
 *   POST /api/uploads/<batch>/commit?offset=  stores the batch as a local release and removes it; answers as fetch does
 *   GET  /api/releases/<key>?offset=          a cached release plus `match`
 *   GET  /api/releases/<key>/fonts/<name>     a font of the release
 *
 * `match` is `matchRelease` of the release's files against the session's episodes 1 to N, with `offset` as the
 * episode offset. Errors: 400 `bad-request` or `empty-query`, 404 `not-on-tosho` or `not-found`, 413 `too-large`,
 * 422 `upload-rejected` or `bad-encoding`, 503 `source-unavailable` with the failing `source`.
 */
export const fansubRoutes: RouteTable = [
  [
    'GET',
    /^\/api\/fansubs\/seadex$/,
    async (req, res, _match, ctx) => {
      const raw = queryOf(req).get('anilist') ?? '';
      if (!/^\d{1,9}$/.test(raw)) return httpError(res, 400, 'bad-request', 'anilist must be an AniList id.');
      const alId = Number(raw);
      await upstream(res, 'seadex', async () => {
        const entry = await ctx.sources.seadex.entry(alId, { urgent: true });
        const releases: SeaDexRow[] = [];
        const row = async (r: SeaDexRelease): Promise<SeaDexRow> => {
          const toshoId = r.infoHash === null ? null : ((await ctx.sources.tosho.byHash(r.infoHash, { urgent: true }))?.id ?? null);
          const unavailable = r.infoHash === null ? 'private-tracker' : toshoId === null ? 'not-on-tosho' : null;
          return { group: r.group, tracker: r.tracker, isBest: r.isBest, dualAudio: r.dualAudio, tags: r.tags, toshoId, unavailable };
        };
        if (entry) {
          for (const { release } of rankReleases(entry)) releases.push(await row(release));
          for (const r of entry.releases) if (r.infoHash === null) releases.push(await row(r));
        }
        json(res, 200, { notes: entry?.notes ?? '', comparison: entry?.comparison ?? '', url: `https://releases.moe/${alId}/`, releases });
      });
    },
  ],
  [
    'GET',
    /^\/api\/fansubs\/search$/,
    async (req, res, _match, ctx) => {
      const q = queryOf(req).get('q')?.trim() ?? '';
      if (q === '') return httpError(res, 400, 'empty-query', 'Type something to search for.');
      await upstream(res, 'tosho', async () => {
        const found = await ctx.sources.tosho.search(q, { urgent: true });
        json(res, 200, found.map((r) => ({ toshoId: r.id, title: r.title, date: r.date })));
      });
    },
  ],
  [
    'POST',
    /^\/api\/fansubs\/fetch$/,
    async (req, res, _match, ctx) => {
      const offset = offsetOf(req);
      if (offset === null) return httpError(res, 400, 'bad-request', 'offset must be a whole number.');
      const bytes = await readBody(req, 16 * 1024);
      if (bytes === null) return tooLarge(res);
      let toshoId: unknown;
      try {
        toshoId = (JSON.parse(bytes.toString('utf8')) as { toshoId?: unknown } | null)?.toshoId;
      } catch {
        toshoId = undefined;
      }
      if (typeof toshoId !== 'number' || !Number.isSafeInteger(toshoId) || toshoId <= 0) {
        return httpError(res, 400, 'bad-request', 'The body must be { "toshoId": <number> }.');
      }
      const id = toshoId;
      await upstream(res, 'tosho', async () => answerRelease(res, ctx, await releaseCacheOf(ctx).fetchTosho(id), offset));
    },
  ],
  [
    'PUT',
    /^\/api\/uploads\/([^/]+)\/([^/]+)$/,
    async (req, res, match, ctx) => {
      const batch = decode(match[1]!);
      const name = decode(match[2]!);
      if (batch === null || !BATCH_PATTERN.test(batch) || name === null || !plainName(name)) {
        return httpError(res, 400, 'bad-request', 'Bad batch or file name.');
      }
      const dir = batchDir(ctx, batch);
      const present = await readdir(dir).catch(() => [] as string[]);
      if (present.length >= MAX_BATCH_FILES && !present.includes(name)) {
        return httpError(res, 400, 'bad-request', 'Too many files in one upload.');
      }
      const body = await readBody(req, MAX_UPLOAD_BYTES);
      if (body === null) return tooLarge(res);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), body);
      json(res, 200, { name, size: body.length });
    },
  ],
  [
    'POST',
    /^\/api\/uploads\/([^/]+)\/commit$/,
    async (req, res, match, ctx) => {
      const batch = decode(match[1]!);
      const offset = offsetOf(req);
      if (batch === null || !BATCH_PATTERN.test(batch) || offset === null) return httpError(res, 400, 'bad-request', 'Bad batch or offset.');
      const dir = batchDir(ctx, batch);
      let release: CachedRelease;
      try {
        const names = await readdir(dir).catch(() => [] as string[]);
        const files = await Promise.all(names.map(async (name) => ({ name, bytes: new Uint8Array(await readFile(join(dir, name))) })));
        release = await releaseCacheOf(ctx).addLocal(files);
      } catch (e) {
        // the batch goes before the answer, so a retry never finds it half removed
        await rm(dir, { recursive: true, force: true });
        if (e instanceof UploadRejected) return json(res, 422, { error: 'upload-rejected', message: e.message, fileName: e.fileName });
        if (e instanceof SubtitleEncodingError) return json(res, 422, { error: 'bad-encoding', message: e.message });
        throw e;
      }
      await rm(dir, { recursive: true, force: true });
      answerRelease(res, ctx, release, offset);
    },
  ],
  [
    'GET',
    /^\/api\/releases\/([^/]+)$/,
    async (req, res, match, ctx) => {
      const offset = offsetOf(req);
      if (offset === null) return httpError(res, 400, 'bad-request', 'offset must be a whole number.');
      const release = await releaseCacheOf(ctx).get(decode(match[1]!) ?? '');
      if (!release) return httpError(res, 404, 'not-found', 'No such release.');
      answerRelease(res, ctx, release, offset);
    },
  ],
  [
    'GET',
    /^\/api\/releases\/([^/]+)\/fonts\/([^/]+)$/,
    async (_req, res, match, ctx) => {
      const cache = releaseCacheOf(ctx);
      const release = await cache.get(decode(match[1]!) ?? '');
      const name = decode(match[2]!);
      const font = release?.fonts.find((f) => f.name === name);
      if (!font) return httpError(res, 404, 'not-found', 'No such font.');
      const bytes = await cache.read(font.path);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'no-store',
      });
      res.end(bytes);
    },
  ],
];
