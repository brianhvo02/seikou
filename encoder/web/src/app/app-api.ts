// SPDX-License-Identifier: LGPL-3.0-or-later
import { ApiError, errorOf, type FetchLike } from '../api';
import type { RemoteDiscSpec } from '@seikou/engine';
import type { DiscManifest } from '@seikou/nas/nas-api';
import type { EncodeSettings, LibraryAnswer, PlaylistDetail, PlaylistSummary, Profile } from '../api-types';

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
}

/** The client for the backend at `base` (an origin, or `''` for the page's own) with the run's `token`, sent as `Authorization: Bearer`. */
export function createAppApi(base: string, token: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)): AppApi {
  const root = base.replace(/\/$/, '');

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
  };
}
