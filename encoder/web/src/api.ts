// SPDX-License-Identifier: LGPL-3.0-or-later
/** The helper page's client for its local backend: one typed method per route, every request carrying the run's token. */
import type {
  AlignAnswer,
  EpisodesAnswer,
  FansubAlignment,
  RecordAnswer,
  ReleaseAnswer,
  SeaDexAnswer,
  SessionInfo,
  SubtitleRecord,
  TitleHit,
  ToshoHit,
} from './api-types';

/**
 * A failed request. `status` is the HTTP status (0 when the backend could not be reached), `code` the backend's
 * error code (`unauthorized`, `source-unavailable`, `tools-missing`, ...; `network` or `http-<status>` when the
 * answer carried none) and `message` a sentence to show. `details` holds the error body's other fields, such as
 * `source` for `source-unavailable`, `path` for `bad-record` or `fileName` for `upload-rejected`.
 */
export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    /** HTTP status, or 0 when the backend could not be reached. */
    readonly status: number,
    /** The backend's error code. */
    readonly code: string,
    message: string,
    /** The error body's other fields. */
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** The backend's routes as methods. Every method rejects with `ApiError`. */
export interface HelperApi {
  /** The run's disc, playlist, episode spec and whether lining up can run. */
  session(): Promise<SessionInfo>;
  /** The run's episodes in playlist time, the audio streams and the PG count. */
  episodes(): Promise<EpisodesAnswer>;
  /** AniList's results for `q`, in AniList's order. */
  searchTitles(q: string): Promise<TitleHit[]>;
  /** AniList's episode titles for a show, keyed by episode number; empty when it has none. */
  episodeTitles(alId: number): Promise<Record<number, string>>;
  /** SeaDex's entry for a show. */
  seadex(alId: number): Promise<SeaDexAnswer>;
  /** Anime Tosho releases matching `q`. */
  searchTosho(q: string): Promise<ToshoHit[]>;
  /** Fetches an Anime Tosho release's tracks and fonts (or answers the cached ones) and matches it at `offset`. */
  fetchRelease(toshoId: number, offset: number): Promise<ReleaseAnswer>;
  /** Uploads the user's own subtitle and font files as one release and matches it at `offset`. */
  upload(files: readonly File[], offset: number): Promise<ReleaseAnswer>;
  /** A cached release by its key, matched at `offset`. */
  release(key: string, offset: number): Promise<ReleaseAnswer>;
  /** Lines a release file's tracks up against an episode's disc audio; slow the first time (it decodes the audio). */
  align(episode: number, release: string, fileId: string, signal?: AbortSignal): Promise<AlignAnswer>;
  /** URL of a track retimed with `timing` (`original` gives the release's own bytes), token included. */
  subtitleUrl(episode: number, release: string, fileId: string, trackId: string, timing: FansubAlignment): string;
  /** URL of a release's font by its original name, token included. */
  fontUrl(release: string, name: string): string;
  /** The saved record for this run (null when none) and the cached files it names that are gone. */
  record(): Promise<RecordAnswer>;
  /** Saves the record; answers it as stored, with `savedAt` set by the server. */
  saveRecord(record: SubtitleRecord): Promise<SubtitleRecord>;
}

/** The `fetch` the client uses; tests pass their own. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** UTF-8 JSON as base64url without padding, as the subtitle route's `timing` parameter expects. */
export function base64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 16 random lower-case hex digits, the name of one upload batch. */
function batchId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The `ApiError` an answer that is not ok stands for. */
async function errorOf(res: Response): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    // not JSON: the status alone says what happened
  }
  const { error, message, ...details } = body;
  const code = typeof error === 'string' ? error : `http-${res.status}`;
  const text = typeof message === 'string' ? message : defaultMessage(res.status, code);
  return new ApiError(res.status, code, text, details);
}

/** A sentence for an error the backend sent without a message. */
function defaultMessage(status: number, code: string): string {
  if (code === 'source-unavailable') return 'The service is not answering. Try again in a moment.';
  if (code === 'unauthorized') return 'This page needs the address the helper printed, with its token.';
  return `The helper answered ${status}.`;
}

/**
 * The client for the backend at `base` (an origin such as `http://127.0.0.1:4195`, or `''` for the page's own) with
 * the run's `token`. The token goes in an `Authorization` header on requests and in `?t=` on the URLs the engine
 * fetches itself (subtitle and font URLs). It is kept only in this object.
 */
export function createApi(base: string, token: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)): HelperApi {
  const root = base.replace(/\/$/, '');

  async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      if (body instanceof Blob) {
        headers['Content-Type'] = 'application/octet-stream';
        init.body = body;
      } else {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }
    if (signal) init.signal = signal;
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, init);
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new ApiError(0, 'network', 'The helper is not answering. Is seikou-encode serve still running?');
    }
    if (!res.ok) throw await errorOf(res);
    return (await res.json()) as T;
  }

  const q = (params: Record<string, string | number>): string => new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const enc = encodeURIComponent;

  return {
    session: () => request('GET', '/api/session'),
    episodes: () => request('GET', '/api/episodes'),
    searchTitles: async (text) => (await request<{ candidates: TitleHit[] }>('GET', `/api/titles/search?${q({ q: text })}`)).candidates,
    episodeTitles: async (alId) => (await request<{ titles: Record<number, string> }>('GET', `/api/titles/${alId}/episodes`)).titles,
    seadex: (alId) => request('GET', `/api/fansubs/seadex?${q({ anilist: alId })}`),
    searchTosho: (text) => request('GET', `/api/fansubs/search?${q({ q: text })}`),
    fetchRelease: (toshoId, offset) => request('POST', `/api/fansubs/fetch?${q({ offset })}`, { toshoId }),
    async upload(files, offset) {
      const batch = batchId();
      // one file at a time: the backend keeps each in the batch folder until commit
      for (const file of files) await request('PUT', `/api/uploads/${batch}/${enc(file.name)}`, file);
      return request('POST', `/api/uploads/${batch}/commit?${q({ offset })}`);
    },
    release: (key, offset) => request('GET', `/api/releases/${enc(key)}?${q({ offset })}`),
    align: (episode, release, fileId, signal) => request('POST', `/api/episodes/${episode}/align`, { release, fileId }, signal),
    subtitleUrl(episode, release, fileId, trackId, timing) {
      const params: Record<string, string> = { release, file: fileId, track: trackId };
      if (timing.kind !== 'original') params.timing = base64UrlJson(timing);
      params.t = token;
      return `${root}/api/episodes/${episode}/subtitle?${q(params)}`;
    },
    fontUrl: (release, name) => `${root}/api/releases/${enc(release)}/fonts/${enc(name)}?${q({ t: token })}`,
    record: () => request('GET', '/api/record'),
    saveRecord: (record) => request('PUT', '/api/record', record),
  };
}
