// SPDX-License-Identifier: LGPL-3.0-or-later
import { stat } from 'node:fs/promises';
import type { DiscManifest } from '@seikou/nas/nas-api';
import { buildEncodeCatalogue } from '@seikou/titles/encode-catalogue';
import type { EncodeCatalogue } from '@seikou/titles/encode-catalogue';
import type { Auth } from '../auth';
import type { EncodeEntry, EncodeIndex } from '../encodes/index-store';
import { MAX_CHUNK_BYTES, UPLOAD_ID, UploadError } from '../encodes/uploads';
import type { UploadStore } from '../encodes/uploads';
import { BodyTooLargeError, bodyStream, HttpError, json, readJson, viaChannel } from '../http';
import type { Handler, Response } from '../http';
import { serveFile } from './discs';
import { requestDevice } from './titles';
import type { TitleLibrary } from './titles';

const ROUTE = /^\/api\/encodes\/(?:(status)|([1-9]\d*-[1-9]\d*)(?:\/(manifest|files\/EPISODE\.MKV))?)$/;
/** A request that arrives during the first scan waits for it this long, then gets 503 `indexing`. */
export const FIRST_SCAN_WAIT_MS = 30_000;

const SHOWS_ROUTE = /^\/api\/encodes\/shows(?:\/(\d+))?$/;
const UPLOAD_ROUTE = /^\/api\/encodes\/uploads(?:\/([^/]+)(\/complete)?)?$/;
const DELETE_ROUTE = /^\/api\/encodes\/([1-9]\d*-[1-9]\d*)$/;
const CONTENT_RANGE = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/;

const notFound = (): Response => json(404, { error: 'not found' });

/**
 * The encoded episodes (`ENCODES_DIR`), behind the token guard and the title gate (a guest behind a closed gate gets
 * 404, as from the title routes):
 * `GET /api/encodes/status` (`{ configured, count }`), `GET /api/encodes/<id>` (the entry without its server path),
 * `GET /api/encodes/<id>/manifest` (a `DiscManifest` with the one file `EPISODE.MKV`) and
 * `GET|HEAD /api/encodes/<id>/files/EPISODE.MKV` (the file or a `Range` of it). With that base the engine reads an
 * encode as it reads a NAS disc. Without `encodes` only `status` answers, with `configured: false`.
 * The library: `GET /api/encodes/shows` (`{ shows: { id, name, poster, episodeCount, anilistIds }[], unfiled? }`, `anilistIds` the AniList entries of a show's seasons, `unfiled`, the files
 * the index could not file, as paths under `ENCODES_DIR`, for owners only) and `GET /api/encodes/shows/<id>` (an `EncodeShow`), grouped by AniList as
 * the disc catalogue is. They answer from the entries the title service has cached and never wait for AniList.
 */
export function encodeRoutes(auth: Auth, encodes: EncodeIndex | undefined, titles: TitleLibrary | undefined, waitMs = FIRST_SCAN_WAIT_MS, uploads?: UploadStore): Handler {
  const answer = (err: unknown, close: boolean): Response => {
    if (err instanceof UploadError) return json(err.status, { error: err.message, ...err.extra }, { ...err.headers, ...(close ? { Connection: 'close' } : {}) });
    if (err instanceof HttpError) return json(err.status, { error: err.message }, { ...err.headers, ...(close ? { Connection: 'close' } : {}) });
    throw err;
  };

  /** The owner's writes: uploads (`POST uploads`, `PUT|GET|DELETE uploads/<id>`, `POST uploads/<id>/complete`) and `DELETE <id>`. */
  const write: Handler = async (req, url) => {
    const upload = UPLOAD_ROUTE.exec(url.pathname);
    const del = upload || req.method !== 'DELETE' ? null : DELETE_ROUTE.exec(url.pathname);
    if (!upload && !del) return null;
    const method = req.method ?? 'GET';
    const [, id, complete] = upload ?? [];
    const allowed = del ? ['DELETE'] : !id ? ['POST'] : complete ? ['POST'] : ['PUT', 'GET', 'DELETE'];
    if (!allowed.includes(method)) return json(405, { error: 'method not allowed' }, { Allow: allowed.join(', ') });
    const device = requestDevice(auth, req.headers.authorization, url);
    // a refused PUT leaves its body unread, so the connection can't carry another request
    const close = method === 'PUT';
    const shut: Record<string, string> = close ? { Connection: 'close' } : {};
    if (!device) return json(401, { error: 'unauthorized' }, shut);
    if (!device.owner) return json(403, { error: 'forbidden' }, shut);
    if (viaChannel(req)) return json(403, { error: 'https-only' }, shut);
    if (!encodes || !uploads) return json(404, { error: 'not-configured' }, shut);
    try {
      if (del) {
        if (!(await encodes.ready(waitMs))) return json(503, { error: 'indexing' }, { 'Retry-After': '5' });
        if (!encodes.get(del[1]!)) return notFound();
        await encodes.remove(del[1]!);
        return { status: 204 };
      }
      if (!id) {
        const body = (await readJson(req)) as Record<string, unknown> | null;
        if (!body || typeof body !== 'object') return json(400, { error: 'bad request' });
        return json(200, { id: await uploads.create(device.id, body) });
      }
      if (!UPLOAD_ID.test(id)) return json(404, { error: 'not found' }, shut);
      if (complete) {
        const done = await uploads.complete(id);
        return json(200, done.entry ? { entry: stripPath(done.entry) } : { entry: null, filed: done.filed });
      }
      if (method === 'GET') return json(200, await uploads.status(id));
      if (method === 'DELETE') {
        await uploads.abort(id);
        return { status: 204 };
      }
      const status = await uploads.status(id);
      const m = CONTENT_RANGE.exec(String(req.headers['content-range'] ?? ''));
      if (!m) return json(400, { error: 'bad Content-Range' }, { Connection: 'close' });
      const [a, b, size] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (size !== status.size || a > b || b >= size) return json(400, { error: 'range outside the upload' }, { Connection: 'close' });
      const length = b - a + 1;
      if (length > MAX_CHUNK_BYTES) return json(413, { error: 'chunk too large' }, { Connection: 'close' });
      if (Number(req.headers['content-length'] ?? NaN) !== length) return json(400, { error: 'body length does not match the range' }, { Connection: 'close' });
      try {
        await uploads.put(id, a, b, size, () => bodyStream(req, length));
      } catch (err) {
        if (err instanceof BodyTooLargeError) return json(400, { error: 'body longer than its range' }, { Connection: 'close' });
        throw err;
      }
      return { status: 204 };
    } catch (err) {
      return answer(err, close);
    }
  };

  const catalogue = (): EncodeCatalogue => encodeCatalogueOf(encodes!, titles);

  const library: Handler = async (req, url) => {
    const match = SHOWS_ROUTE.exec(url.pathname);
    if (!match || (req.method !== 'GET' && req.method !== 'HEAD')) return null;
    const device = requestDevice(auth, req.headers.authorization, url);
    if (!device) return json(401, { error: 'unauthorized' });
    if (titles && !device.owner && titles.service.gate() !== 'everyone') return notFound();
    if (!encodes) return notFound();
    if (!(await encodes.ready(waitMs))) return json(503, { error: 'indexing' }, { 'Retry-After': '5' });
    const built = catalogue();
    if (match[1] !== undefined) {
      const show = built.show(match[1]);
      return show ? json(200, show) : notFound();
    }
    const shows = built.shows.map((s) => ({
      id: s.id, name: s.name, poster: s.poster, episodeCount: s.seasons.reduce((n, x) => n + x.episodes.length, 0), anilistIds: s.seasons.map((x) => x.anilistId),
    }));
    return json(200, { shows, ...(device.owner ? { unfiled: encodes.unfiled().map((u) => ({ path: encodes.relativePath(u.path), size: u.size })) } : {}) });
  };

  const read: Handler = async (req, url) => {
    const match = ROUTE.exec(url.pathname);
    if (!match || (req.method !== 'GET' && req.method !== 'HEAD')) return null;
    const device = requestDevice(auth, req.headers.authorization, url);
    if (!device) return json(401, { error: 'unauthorized' });
    if (titles && !device.owner && titles.service.gate() !== 'everyone') return notFound();
    const [, status, id, action] = match;
    if (status) {
      if (!encodes) return json(200, { configured: false, count: 0 });
      if (!(await encodes.ready(waitMs))) return json(200, { configured: true, scanning: true });
      const state = encodes.state();
      return json(200, { configured: true, count: encodes.list().length, ...(state.rootMissing ? { rootMissing: true } : {}), ...(state.rootEmpty ? { rootEmpty: true } : {}), ...(state.scanError !== null ? { scanError: state.scanError } : {}) });
    }
    if (!encodes) return notFound();
    if (!(await encodes.ready(waitMs))) return json(503, { error: 'indexing' }, { 'Retry-After': '5' });
    const entry = encodes.get(id!);
    if (!entry) return notFound();
    if (action === undefined) {
      const { path: _path, ...detail } = entry;
      return json(200, detail);
    }
    if (action === 'manifest') {
      // the live size, so the engine's idea of the file and the bytes served agree while a file settles
      let size: number;
      try {
        size = (await stat(entry.path)).size;
      } catch {
        return notFound();
      }
      const manifest: DiscManifest = { discId: entry.id, name: entry.episodeTitle ?? `Episode ${entry.episode}`, files: [{ path: 'EPISODE.MKV', size }], inline: {} };
      return json(200, manifest);
    }
    return serveFile(req, entry.path);
  };
  return async (req, url) => (await write(req, url)) ?? (await library(req, url)) ?? read(req, url);
}

/** The encodes grouped by AniList, from the entries the title service has cached; the posters are registered for the art route. */
export function encodeCatalogueOf(encodes: EncodeIndex, titles: TitleLibrary | undefined): EncodeCatalogue {
  const list = encodes.list();
  const entries = titles ? titles.service.entriesFor([...new Set(list.map((e) => e.anilistId))]) : new Map();
  const built = buildEncodeCatalogue(list, entries);
  titles?.service.addEncodeArt(built.art);
  return built;
}

function stripPath(entry: EncodeEntry): Omit<EncodeEntry, 'path'> {
  const { path: _path, ...detail } = entry;
  return detail;
}
