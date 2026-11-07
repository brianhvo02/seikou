import type { IncomingMessage } from 'node:http';
import { parseDiscKey } from '@seikou/nas/disc-key';
import { LockHeldError } from '../atomic-json';
import type { Auth } from '../auth';
import { HttpError, json } from '../http';
import type { Handler } from '../http';
import { isPlaybackPlace, isPlaylistId, PLACE_LIMIT_BYTES } from '../playback-store';
import type { PlaybackStore } from '../playback-store';
import type { Catalogue } from '../titles/catalogue';
import type { Library } from '../library';
import { continueWatching, titleProgress } from '../titles/up-next';
import { decodeSegment, requestDevice } from './titles';
import type { TitleLibrary } from './titles';

const EMPTY: Catalogue = { titles: [], detail: () => null, unsorted: [], hidden: [], art: () => null, provisional: [] };
const LIST = '/api/me/playback';
const PREFIX = `${LIST}/`;
const TITLE_PREFIX = `${PREFIX}title/`;

/** What the list and the title progress work out from; both optional (without them the list holds only resume cards). */
export interface PlaybackCatalogue { readonly titles?: TitleLibrary; readonly library?: Library }

/** The disc ids a disc key stands for: every listed disc with an `f.` key's fingerprint, the one id of a `d.` key. */
function discsOfFor(library: Library | undefined): (discKey: string) => readonly string[] {
  return (discKey) => {
    const parsed = parseDiscKey(discKey);
    if (parsed?.kind === 'disc') return [parsed.discId];
    if (parsed?.kind !== 'fingerprint' || !library) return [];
    return library.evidence().filter((ev) => ev.fingerprint === parsed.fingerprint).map((ev) => ev.discId);
  };
}

/** The body as JSON, a 413 once it passes the limit (declared or streamed), a 400 when it doesn't parse. */
async function readPlace(req: IncomingMessage): Promise<unknown> {
  const tooLarge = new HttpError(413, 'body too large', { Connection: 'close' });
  if (Number(req.headers['content-length'] ?? 0) > PLACE_LIMIT_BYTES) throw tooLarge;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > PLACE_LIMIT_BYTES) throw tooLarge;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'bad request');
  }
}

/**
 * `GET` and `DELETE /api/me/playback/<discKey>`, `PUT` and `DELETE /api/me/playback/<discKey>/<playlistId>`: the
 * token's own person's places. Behind `requireToken`.
 */
export function playbackRoutes(auth: Auth, store: PlaybackStore, catalogue: PlaybackCatalogue = {}): Handler {
  const discsOf = discsOfFor(catalogue.library);
  const keyOf = (discId: string): string => {
    const fingerprint = catalogue.library?.evidence().find((ev) => ev.discId === discId)?.fingerprint;
    return fingerprint ? `f.${fingerprint}` : `d.${discId}`;
  };
  return async (req, url) => {
    const isList = url.pathname === LIST;
    if (!isList && !url.pathname.startsWith(PREFIX)) return null;
    const method = req.method;
    if (method !== 'GET' && method !== 'PUT' && method !== 'DELETE') return json(405, { error: 'method not allowed' }, { Allow: 'GET, PUT, DELETE' });
    const device = requestDevice(auth, req.headers.authorization, url);
    if (!device) return json(401, { error: 'unauthorized' });
    const person = device.personId;
    const titles = catalogue.titles;
    // The title gate hides the library from a guest, and so what the catalogue would add to the list.
    const open = titles !== undefined && (device.owner || titles.service.gate() === 'everyone');
    if (isList) {
      if (method !== 'GET') return json(405, { error: 'method not allowed' }, { Allow: 'GET' });
      const places = store.all(person);
      const items = open ? continueWatching(places, titles.service.catalogue(), discsOf, keyOf) : continueWatching(places.filter((p) => !p.finished), EMPTY, discsOf);
      return json(200, items, { 'Cache-Control': 'no-store' });
    }
    if (url.pathname.startsWith(TITLE_PREFIX)) {
      if (method !== 'GET') return json(405, { error: 'method not allowed' }, { Allow: 'GET' });
      const segments = url.pathname.slice(TITLE_PREFIX.length).split('/');
      const detail = open && segments.length === 1 ? titles.service.catalogue().detail(decodeSegment(segments[0]!)) : null;
      return detail ? json(200, titleProgress(store.all(person), detail, discsOf), { 'Cache-Control': 'no-store' }) : json(404, { error: 'not found' });
    }
    const [discKey, playlistId, ...rest] = url.pathname.slice(PREFIX.length).split('/');
    // `bad-key`: the app drops a place answered so, where a 404 from a NAS without these routes keeps it for later
    if (rest.length > 0 || parseDiscKey(discKey!) === null || (playlistId !== undefined && !isPlaylistId(playlistId))) return json(404, { error: 'bad-key' }, method === 'PUT' ? { Connection: 'close' } : {});
    try {
      if (method === 'GET') {
        if (playlistId !== undefined) return json(405, { error: 'method not allowed' }, { Allow: 'PUT, DELETE' });
        const places = store.get(person, discKey!);
        return places ? json(200, places, { 'Cache-Control': 'no-store' }) : json(404, { error: 'not found' });
      }
      if (method === 'DELETE') {
        store.delete(person, discKey!, playlistId);
        return { status: 204 };
      }
      if (playlistId === undefined) return json(405, { error: 'method not allowed' }, { Allow: 'GET, DELETE', Connection: 'close' });
      const body = await readPlace(req);
      if (!isPlaybackPlace(body)) return json(400, { error: 'bad-place' });
      if (body.discKey !== discKey || body.playlistId !== playlistId) return json(400, { error: 'key-mismatch' });
      return store.put(person, body) === 'stale' ? json(409, { error: 'stale' }) : { status: 204 };
    } catch (err) {
      if (err instanceof LockHeldError) return json(503, { error: 'busy' }, { 'Retry-After': '1' });
      throw err;
    }
  };
}
