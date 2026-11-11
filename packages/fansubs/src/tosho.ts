/** Anime Tosho client: the JSON feed (https://feed.animetosho.net/json) and the storage downloads. Original code. */
import { RateLimited } from '@seikou/titles/pacer';
import { TooLargeArchive } from './archive';
import type { PacedOptions, Pacer } from '@seikou/titles/pacer';
import { retryAfterMs, SourceUnavailable } from '@seikou/titles/sources';

/** The most a track's .xz download may be. */
export const TRACK_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/** The most a font pack's download may be. */
export const PACK_DOWNLOAD_BYTES = 256 * 1024 * 1024;

/** One subtitle track of a file on Anime Tosho. */
export interface ToshoTrack {
  /** Index among the file's subtitle attachments, from 0. */
  readonly track: number;
  /** ISO 639-2, `und` when missing. */
  readonly language: string;
  readonly name: string;
  /** The subtitle format, such as `ASS` or `SRT`. */
  readonly format: string;
  /** Where the track's `.xz` download is. */
  readonly url: string;
  /** The file's default and forced flags for the track. */
  readonly isDefault: boolean;
  readonly forced: boolean;
}

/** One file of an Anime Tosho release. */
export interface ToshoFile {
  readonly id: number;
  readonly name: string;
  /** The file's size in bytes. */
  readonly size: number;
  /** Its subtitle tracks. */
  readonly tracks: readonly ToshoTrack[];
}

/** One release on Anime Tosho. */
export interface ToshoRelease {
  readonly id: number;
  readonly title: string;
  /** The torrent's info hash, 40 hex digits. */
  readonly infoHash: string;
  /** The feed's status word for the release. */
  readonly status: string;
  /** The feed's `is_seadex` flag for the release. */
  readonly isSeadex: boolean;
  /** Seconds since the epoch, as the feed gives it. */
  readonly date: number;
  /** The release's files; empty for a search result, which doesn't load them. */
  readonly files: readonly ToshoFile[];
}

/** The part of Anime Tosho this package uses. */
export interface Tosho {
  /** The release with this info hash, files loaded, or null when the feed has none. */
  byHash(infoHash: string, opts?: PacedOptions): Promise<ToshoRelease | null>;
  /** The release with this id, files loaded, or null when the feed has none. */
  byId(id: number, opts?: PacedOptions): Promise<ToshoRelease | null>;
  /** The first page (at most 30 releases), files not loaded. */
  search(query: string, opts?: PacedOptions): Promise<readonly ToshoRelease[]>;
  /** The bytes at `url`; past `maxBytes` (declared or as they arrive) it throws `TooLargeArchive`. */
  download(url: string, opts?: PacedOptions, maxBytes?: number): Promise<Buffer>;
  /** The URL of the file's font pack (a `.7z`) in Anime Tosho's storage; the pack may not exist (`download` then throws `NotFoundOnTosho`). */
  fontPackUrl(fileId: number): string;
}

/** Thrown by a download for which Anime Tosho answers 404, or whose URL leaves the hosts a download may use or redirects too often. */
export class NotFoundOnTosho extends Error {
  override name = 'NotFoundOnTosho';
  constructor(url: string) {
    super(`not found on Anime Tosho: ${url}`);
  }
}

interface RawAttachment {
  readonly type?: string;
  readonly url?: string;
  readonly info?: {
    readonly format?: string | null;
    readonly language_code?: string | null;
    readonly name?: string | null;
    readonly default?: boolean | null;
    readonly forced?: boolean | null;
  } | null;
}
interface RawFile {
  readonly id: number;
  readonly filename?: string | null;
  readonly size?: number | null;
  readonly attachments?: readonly RawAttachment[] | null;
}
interface RawRelease {
  readonly id: number;
  readonly title?: string | null;
  readonly info_hash?: string | null;
  readonly status?: string | null;
  readonly is_seadex?: boolean | null;
  readonly timestamp?: number | null;
  readonly files?: readonly RawFile[] | null;
}

function toFile(f: RawFile): ToshoFile {
  const tracks = (f.attachments ?? [])
    .filter((a) => a.type === 'subtitle' && typeof a.url === 'string')
    .map((a, track): ToshoTrack => ({
      track,
      language: a.info?.language_code || 'und',
      name: a.info?.name ?? '',
      format: a.info?.format ?? '',
      url: a.url!,
      isDefault: a.info?.default === true,
      forced: a.info?.forced === true,
    }));
  return { id: f.id, name: f.filename ?? '', size: f.size ?? 0, tracks };
}

function toRelease(r: RawRelease): ToshoRelease {
  return {
    id: r.id,
    title: r.title ?? '',
    infoHash: r.info_hash ?? '',
    status: r.status ?? '',
    isSeadex: r.is_seadex === true,
    date: r.timestamp ?? 0,
    files: (r.files ?? []).map(toFile),
  };
}

/** A response's body, refused by its Content-Length or once more than `maxBytes` have arrived. */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const tooLarge = (): TooLargeArchive => new TooLargeArchive(`download over ${maxBytes} bytes`);
  if (Number(res.headers.get('Content-Length') ?? 0) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof TooLargeArchive) throw e;
    throw new SourceUnavailable('animetosho: download interrupted');
  }
  return Buffer.concat(chunks, size);
}

const MAX_REDIRECTS = 3;
const LOOPBACK = new Set(['127.0.0.1', 'localhost']);

/**
 * Which URLs the client fetches (the feed hands it track URLs): https on the configured bases' hosts or on animetosho.net
 * and its subdomains; http on a loopback host only when a configured base is one (the tests' stand-in).
 */
function urlCheck(bases: { feed: string; site: string }): (url: string) => boolean {
  const hosts = new Set<string>();
  let loopback = false;
  for (const b of [bases.feed, bases.site]) {
    const u = new URL(b);
    hosts.add(u.hostname);
    if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) loopback = true;
  }
  return (url) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol === 'http:') return loopback && LOOPBACK.has(u.hostname);
    return u.protocol === 'https:' && (hosts.has(u.hostname) || u.hostname === 'animetosho.net' || u.hostname.endsWith('.animetosho.net'));
  };
}

/**
 * An Anime Tosho client. `fetch` is injected, `pacer` spaces the calls, `userAgent` is sent with each, and `bases` are the
 * feed's and the storage site's URLs. A download follows at most three redirects and only to Anime Tosho's own hosts
 * (and loopback for tests), else it throws `NotFoundOnTosho`. A network error, a bad status or an unreadable answer
 * throws `SourceUnavailable`.
 * @example ../examples/create-tosho.ts
 */
export function createTosho(fetch: typeof globalThis.fetch, pacer: Pacer, userAgent: string, bases: { feed: string; site: string }): Tosho {
  const allowed = urlCheck(bases);
  /** One paced GET, following at most three redirects and checking every URL; the raw response when it is fine. */
  const get = async (url: string, accept: string, notFound: () => Error): Promise<Response> => {
    let res: Response;
    let at = url;
    for (let hop = 0; ; hop++) {
      if (!allowed(at)) throw new NotFoundOnTosho(url);
      try {
        res = await fetch(at, { headers: { 'User-Agent': userAgent, Accept: accept }, redirect: 'manual' });
      } catch {
        throw new SourceUnavailable('animetosho: network error');
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('Location') : null;
      if (location === null) break;
      await res.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new NotFoundOnTosho(url);
      at = new URL(location, at).href;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (res.status === 429) throw new RateLimited(retryAfterMs(res.headers.get('Retry-After')));
      if (res.status === 404) throw notFound();
      throw new SourceUnavailable(`animetosho: HTTP ${res.status}`);
    }
    return res;
  };

  const feed = (query: string, opts?: PacedOptions): Promise<unknown> =>
    pacer.run(async () => {
      const res = await get(`${bases.feed}/json?${query}`, 'application/json', () => new SourceUnavailable('animetosho: HTTP 404'));
      try {
        return await res.json();
      } catch {
        throw new SourceUnavailable('animetosho: unreadable response');
      }
    }, opts);

  const torrent = async (query: string, opts?: PacedOptions): Promise<ToshoRelease | null> => {
    const body = (await feed(`show=torrent&${query}`, opts)) as (RawRelease & { error?: unknown }) | null;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new SourceUnavailable('animetosho: unexpected response');
    if ('error' in body) return null;
    if (typeof body.id !== 'number') throw new SourceUnavailable('animetosho: unexpected response');
    return toRelease(body);
  };

  return {
    byHash: (infoHash, opts) => torrent(`btih=${encodeURIComponent(infoHash)}`, opts),
    byId: (id, opts) => torrent(`id=${id}`, opts),
    async search(query, opts) {
      const body = await feed(`q=${encodeURIComponent(query)}`, opts);
      if (!Array.isArray(body)) {
        if (typeof body === 'object' && body !== null && 'error' in body) return [];
        throw new SourceUnavailable('animetosho: unexpected response');
      }
      return (body as RawRelease[]).slice(0, 30).map((r) => toRelease({ ...r, files: [] }));
    },
    download: (url, opts, maxBytes = PACK_DOWNLOAD_BYTES) =>
      pacer.run(async () => {
        const res = await get(url, '*/*', () => new NotFoundOnTosho(url));
        return readCapped(res, maxBytes);
      }, opts),
    fontPackUrl: (fileId) => `${bases.site}/download/file/${fileId}/attachments`,
  };
}
