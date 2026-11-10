// SPDX-License-Identifier: LGPL-3.0-or-later
import { ApiError, episodeInfoCalls, errorOf, type FetchLike } from '../api';
import type { RemoteDiscSpec } from '@seikou/engine';
import type { DiscManifest, OwnTitle, TitleSummary } from '@seikou/nas/nas-api';
import type { AniListEntry, EncodeSettings, EpisodeInfo, Job, LibraryAnswer, NasPairingRequest, NasStatus, NewJob, NewTest, PlaylistDetail, PlaylistSummary, Profile, QueuedJob, TitleHit } from '../api-types';

// The app pages' client for the backend's library routes, carrying the run's token.

/** The backend's app-level routes as methods. Every method rejects with `ApiError`. */
export interface AppApi {
  /** The library folders and the discs found under them. */
  library(): Promise<LibraryAnswer>;
  /** Starts a scan of the library folders (or joins the one running). */
  rescan(): Promise<void>;
  /** Saves the library folders (absolute paths) and starts a scan; resolves with the folders now in force. */
  setRoots(roots: readonly string[]): Promise<readonly string[]>;
  /** The playlists of a library disc, longest first. */
  playlists(discKey: string): Promise<PlaylistSummary[]>;
  /** One playlist of a library disc with its chapters and the episode list of its saved subtitle record. */
  playlist(discKey: string, playlistId: string): Promise<PlaylistDetail>;
  /** The chapter names and episode titles saved for a disc's playlist, or null when none are. */
  episodeInfo(discKey: string, playlistId: string): Promise<EpisodeInfo | null>;
  /** Saves a disc's playlist's chapter names and episode titles; resolves with them as stored. */
  saveEpisodeInfo(discKey: string, playlistId: string, info: Omit<EpisodeInfo, 'savedAt'>): Promise<EpisodeInfo>;
  /** Opens (or finds) the subtitle helper's session for a disc, playlist and episode list; resolves with its id. */
  createSession(discKey: string, playlistId: string, episodeSpec: string): Promise<string>;
  /** What the engine needs to read a library disc: the disc API's base address, the token and the manifest. */
  remoteDisc(discKey: string): Promise<RemoteDiscSpec>;
  /** The settings profiles, the built-in default first. */
  profiles(): Promise<Profile[]>;
  /** Makes a profile; rejects with `ApiError` whose `details.field` names a bad value. */
  createProfile(name: string, settings: EncodeSettings): Promise<Profile>;
  /** Replaces a stored profile's name and settings; rejects like `createProfile`. */
  updateProfile(id: string, name: string, settings: EncodeSettings): Promise<Profile>;
  /** Deletes a stored profile. */
  deleteProfile(id: string): Promise<void>;
  /** The queue, oldest first; rejects with `ApiError` code `jobs-unreadable` while the queue file is damaged, `queue-elsewhere` while another process runs it. */
  jobs(): Promise<Job[]>;
  /**
   * Queues an encode; rejects with `ApiError` (`record-mismatch` carries `recordEpisodeSpec` and `episodeSpec` in
   * `details`, `output-in-use` a `suggestedOutDir`). A re-encode into an earlier encode's files resolves with
   * `warning: 'replaces-files'`.
   */
  createJob(job: NewJob): Promise<QueuedJob>;
  /** Queues a test encode of one to three profiles; it runs ahead of the encodes. */
  createTest(test: NewTest): Promise<Job>;
  /** Stops a queued or running job; resolves with the job once it has stopped. */
  cancelJob(id: string): Promise<Job>;
  /** Queues a failed, interrupted or cancelled job again. */
  retryJob(id: string): Promise<Job>;
  /** Removes a finished job from the queue (its files stay). */
  removeJob(id: string): Promise<void>;
  /** The last `tail` lines of a job's log (at most 2000). */
  jobLog(id: string, tail: number): Promise<string[]>;
  /** The output folder the queue dialog offers for a disc's playlist. */
  jobDefaults(discKey: string, playlistId: string): Promise<{ readonly outDir: string }>;
  /** The address of the job event stream, with the token in its query because an `EventSource` cannot send headers. */
  jobEventsUrl(): string;
  /** The address of a file a job wrote (`path` is relative to its output folder), with the token in its query. */
  outputUrl(jobId: string, path: string): string;
  /** The address of sample `n` (from 1) of a test's profile, with the token in its query. */
  sampleUrl(jobId: string, profileId: string, n: number): string;
  /** AniList's results for `q`, in AniList's order, each `poster` a URL of the backend's cover route with the token. */
  searchAniList(q: string): Promise<TitleHit[]>;
  /** One AniList entry with its next season, posters as in `searchAniList`; rejects with `ApiError` `not-found` for an unknown id. */
  aniListEntry(id: number): Promise<AniListEntry>;
  /** AniList's episode titles for a show, keyed by episode number; empty when it has none. */
  aniListEpisodes(id: number): Promise<Record<number, string>>;
  /** Whether the encoder is paired with a NAS, and whether that NAS answers now (it waits up to 5 s for it). */
  nas(): Promise<NasStatus>;
  /**
   * Pairs with the NAS as an owner device; rejects with `ApiError` `bad-address`, `bad-code`, `not-owner`,
   * `too-many-tries` or `unreachable`, each with a message to show.
   */
  pairNas(request: NasPairingRequest): Promise<NasStatus>;
  /**
   * The NAS's search of one source (`anilist`, `tmdb` or the owner's `own` titles); rejects with `ApiError`
   * `nas-not-paired`, `source-unreachable` (503), `too-many-lookups` or `lookup-busy` (429), `unreachable`.
   */
  lookupTitles(q: string, source: 'anilist' | 'tmdb' | 'own'): Promise<TitleSummary[]>;
  /** Makes an own title on the NAS for a show no source lists (`seasons` only for a series); rejects like `lookupTitles`. */
  createOwnTitle(title: { readonly kind: 'series' | 'movie'; readonly name: string; readonly seasons: number | null }): Promise<OwnTitle>;
  /** Forgets the pairing on this machine (the NAS keeps listing the device until an owner removes it). */
  unpairNas(): Promise<void>;
}

/** The client for the backend at `base` (an origin, or `''` for the page's own) with the run's `token`, sent as `Authorization: Bearer`. */
export function createAppApi(base: string, token: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)): AppApi {
  const root = base.replace(/\/$/, '');

  async function fetchText(path: string): Promise<string> {
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    } catch {
      throw new ApiError(0, 'network', 'The app is not answering. Is seikou-encode app still running?');
    }
    if (!res.ok) throw await errorOf(res);
    return res.text();
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, init);
    } catch {
      throw new ApiError(0, 'network', 'The app is not answering. Is seikou-encode app still running?');
    }
    if (!res.ok) throw await errorOf(res);
    return (await res.json()) as T;
  }

  // The backend names each cover by its own path; an <img> sends no Authorization header, so the token goes in ?t=.
  const withToken = (hit: TitleHit): TitleHit => (hit.poster === null ? hit : { ...hit, poster: `${root}${hit.poster}?t=${encodeURIComponent(token)}` });

  return {
    library: () => request('GET', '/api/library'),
    async rescan() {
      await request('POST', '/api/library/rescan');
    },
    async setRoots(roots) {
      return (await request<{ roots: string[] }>('PUT', '/api/settings/roots', { roots })).roots;
    },
    async playlists(discKey) {
      const { playlists } = await request<{ playlists: PlaylistSummary[] }>('GET', `/api/discs/${encodeURIComponent(discKey)}/playlists`);
      return playlists;
    },
    playlist: (discKey, playlistId) =>
      request('GET', `/api/discs/${encodeURIComponent(discKey)}/playlists/${encodeURIComponent(playlistId)}`),
    ...episodeInfoCalls(request),
    async createSession(discKey, playlistId, episodeSpec) {
      return (await request<{ id: string }>('POST', '/api/sessions', { discKey, playlistId, episodeSpec })).id;
    },
    async remoteDisc(discKey) {
      const key = encodeURIComponent(discKey);
      const manifest = await request<DiscManifest>('GET', `/api/discs/${key}/manifest`);
      const base = new URL(`${root}/api/discs/${key}/`, root === '' ? location.href : undefined).href;
      return { kind: 'remote', base, token, manifest };
    },
    async profiles() {
      return (await request<{ profiles: Profile[] }>('GET', '/api/profiles')).profiles;
    },
    createProfile: (name, settings) => request('POST', '/api/profiles', { name, settings }),
    updateProfile: (id, name, settings) => request('PUT', `/api/profiles/${encodeURIComponent(id)}`, { name, settings }),
    async deleteProfile(id) {
      await request('DELETE', `/api/profiles/${encodeURIComponent(id)}`);
    },
    async jobs() {
      return (await request<{ jobs: Job[] }>('GET', '/api/jobs')).jobs;
    },
    createJob: (job) => request('POST', '/api/jobs', { kind: 'encode', ...job }),
    createTest: (test) => request('POST', '/api/jobs', { kind: 'test', ...test }),
    cancelJob: (id) => request('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`),
    retryJob: (id) => request('POST', `/api/jobs/${encodeURIComponent(id)}/retry`),
    async removeJob(id) {
      await request('DELETE', `/api/jobs/${encodeURIComponent(id)}`);
    },
    async jobLog(id, tail) {
      const res = await fetchText(`/api/jobs/${encodeURIComponent(id)}/log?tail=${tail}`);
      return res === '' ? [] : res.replace(/\n$/, '').split('\n');
    },
    jobDefaults: (discKey, playlistId) =>
      request('GET', `/api/jobs/defaults?disc=${encodeURIComponent(discKey)}&playlist=${encodeURIComponent(playlistId)}`),
    jobEventsUrl: () => `${root}/api/jobs/events?t=${encodeURIComponent(token)}`,
    outputUrl: (jobId, path) =>
      `${root}/api/outputs/${encodeURIComponent(jobId)}/${path.split('/').map(encodeURIComponent).join('/')}?t=${encodeURIComponent(token)}`,
    sampleUrl: (jobId, profileId, n) =>
      `${root}/api/tests/${encodeURIComponent(jobId)}/${encodeURIComponent(profileId)}/${n}.webm?t=${encodeURIComponent(token)}`,
    async searchAniList(q) {
      const { candidates } = await request<{ candidates: TitleHit[] }>('GET', `/api/anilist/search?${new URLSearchParams({ q }).toString()}`);
      return candidates.map(withToken);
    },
    async aniListEntry(id) {
      const { entry } = await request<{ entry: AniListEntry }>('GET', `/api/anilist/${id}`);
      return { ...withToken(entry), sequel: entry.sequel === null ? null : withToken(entry.sequel) };
    },
    async aniListEpisodes(id) {
      return (await request<{ titles: Record<number, string> }>('GET', `/api/anilist/${id}/episodes`)).titles;
    },
    nas: () => request('GET', '/api/nas'),
    pairNas: (body) => request('POST', '/api/nas/pair', body),
    async lookupTitles(q, source) {
      return (await request<{ titles: TitleSummary[] }>('GET', `/api/nas/lookup?${new URLSearchParams({ q, source }).toString()}`)).titles;
    },
    createOwnTitle: (title) => request('POST', '/api/nas/own-titles', title),
    async unpairNas() {
      await request('DELETE', '/api/nas');
    },
  };
}
