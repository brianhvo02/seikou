// SPDX-License-Identifier: LGPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { DiscManifest } from '@seikou/nas/nas-api';
import { readBody } from '../../../server/src/http';
// Seikou's NAS server builds manifests this way; the helper answers exactly as the NAS does.
import { buildManifest } from '../../../server/src/manifest';
import { discKeyOfFolder } from '../disc/disc-key';
import { loadPlaylist } from '../disc/playlist';
import { EpisodeSpecError, parseEpisodeSpec } from '../plan/episodes';
import { httpError, json, type AppContext, type HelperSession, type RouteTable } from './http';

// Helper sessions: the backend opens the subtitle helper on any disc, playlist and episode list it is asked for, and
// keeps each such session, under an id of its own, for the server's life. The discs the sessions are on are read
// once and kept here too, so every disc route finds a disc by its key.

/** What the backend knows about one disc, read once. */
export interface DiscInfo {
  /** Real path of the folder that holds BDMV. */
  readonly root: string;
  /** The folder's name. */
  readonly label: string;
  /** The disc's key (`f.<content fingerprint>`, or `d.<id>` for a disc with no streams). */
  readonly key: string;
  /** The NAS manifest the disc routes answer. */
  readonly manifest: DiscManifest;
}

/** A request for a session the backend cannot make, with the HTTP `status` and error `code` to answer it with. */
export class SessionError extends Error {
  constructor(
    /** The HTTP status: 400 for a malformed playlist id or episode list, 404 for a missing playlist. */
    readonly status: number,
    /** `bad-request`, `bad-episode-spec` or `not-found`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What a session is made from. */
export interface SessionInput {
  /** The disc folder (the one holding BDMV) or its BDMV folder. */
  readonly discDir: string;
  /** Five-digit playlist name. */
  readonly playlistId: string;
  /** The episode list, as `parseEpisodeSpec` reads it. */
  readonly episodeSpec: string;
}

/** Discs read per app, by the real path of the folder that holds BDMV. */
const discs = new WeakMap<AppContext, Map<string, Promise<DiscInfo>>>();

async function readDisc(root: string): Promise<DiscInfo> {
  const { key, label } = await discKeyOfFolder(root);
  // The manifest's id is the folder's own hash, not the key, as the NAS gives manifests an id of their own.
  const id16 = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const manifest = await buildManifest(root, { id: id16, name: label });
  return { root, label, key, manifest };
}

/**
 * The disc in `dir` (the folder holding BDMV, or the BDMV folder), read once per app; a failed read is tried again on
 * the next call. Rejects when the folder is missing or has no `BDMV/index.bdmv`.
 */
export async function discOf(app: AppContext, dir: string): Promise<DiscInfo> {
  const given = await realpath(dir);
  const root = basename(given).toUpperCase() === 'BDMV' ? dirname(given) : given;
  let known = discs.get(app);
  if (!known) {
    known = new Map();
    discs.set(app, known);
  }
  let disc = known.get(root);
  if (!disc) {
    const reading = readDisc(root);
    disc = reading;
    known.set(root, reading);
    reading.catch(() => {
      if (known.get(root) === reading) known.delete(root);
    });
  }
  return disc;
}

/** The helper sessions of one app, made on demand and kept for the server's life. */
export class SessionStore {
  private readonly sessions = new Map<string, HelperSession>();
  /** Session ids by disc folder, playlist and episode list. */
  private readonly byInput = new Map<string, string>();
  /** Disc folders by disc key, for every disc a session is on. */
  private readonly discDirs = new Map<string, string>();

  constructor(private readonly app: AppContext) {}

  /**
   * The session for `input`: the existing one when a session on the same disc, playlist and episode list was made
   * before, else a new one with a random id. Rejects with `SessionError` for a playlist id that is not five digits
   * (400 `bad-request`), a playlist the disc lacks (404 `not-found`) or an episode list the playlist cannot hold
   * (400 `bad-episode-spec`), and with the read error when the folder is not a disc.
   */
  async create(input: SessionInput): Promise<HelperSession> {
    if (!/^\d{5}$/.test(input.playlistId)) throw new SessionError(400, 'bad-request', 'A playlist id is five digits.');
    const disc = await discOf(this.app, input.discDir);
    let chapters: number;
    try {
      chapters = (await loadPlaylist(disc.root, input.playlistId)).chapters.length;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new SessionError(404, 'not-found', `The disc has no playlist ${input.playlistId}.`);
      throw e;
    }
    try {
      parseEpisodeSpec(input.episodeSpec, chapters);
    } catch (e) {
      if (e instanceof EpisodeSpecError) throw new SessionError(400, 'bad-episode-spec', e.message);
      throw e;
    }
    const inputKey = JSON.stringify([disc.root, input.playlistId, input.episodeSpec]);
    const existing = this.byInput.get(inputKey);
    if (existing !== undefined) return this.sessions.get(existing)!;
    const session: HelperSession = {
      id: randomBytes(8).toString('hex'),
      discDir: disc.root,
      discKey: disc.key,
      playlistId: input.playlistId,
      episodeSpec: input.episodeSpec,
    };
    this.sessions.set(session.id, session);
    this.byInput.set(inputKey, session.id);
    this.discDirs.set(disc.key, disc.root);
    return session;
  }

  /** The session with `id`, or null. */
  get(id: string): HelperSession | null {
    return this.sessions.get(id) ?? null;
  }

  /** The folder of the disc with `key` when a session is on it, else null. */
  byDiscKey(key: string): string | null {
    return this.discDirs.get(key) ?? null;
  }
}

const stores = new WeakMap<AppContext, SessionStore>();

/** The one `SessionStore` of `app`, made on first use. */
export function sessionsOf(app: AppContext): SessionStore {
  let store = stores.get(app);
  if (!store) {
    store = new SessionStore(app);
    stores.set(app, store);
  }
  return store;
}

/** Largest body `POST /api/sessions` reads. */
const MAX_SESSION_BODY = 16 * 1024;

/**
 * The session routes of the app:
 *
 *   POST /api/sessions   body `{ discKey, playlistId, episodeSpec }`; answers `{ id }`, the same id for the same three
 *                        values. The disc must be one a session is already on (404 `not-found` otherwise). Errors:
 *                        400 `bad-request` (a malformed body or playlist id), 400 `bad-episode-spec`, 404 `not-found`
 *                        (disc or playlist), 413 `too-large`.
 *
 * A session's own routes are under `/api/sessions/<id>`; an unknown id answers 404 `no-session`.
 */
export const sessionStoreRoutes: RouteTable = [
  [
    'POST',
    /^\/api\/sessions$/,
    async (req, res, _match, app) => {
      const bytes = await readBody(req, MAX_SESSION_BODY);
      if (bytes === null) {
        res.setHeader('Connection', 'close');
        return httpError(res, 413, 'too-large', 'That request is too large.');
      }
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(bytes.toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
      } catch {
        // answered below as a malformed body
      }
      const { discKey, playlistId, episodeSpec } = body;
      if (typeof discKey !== 'string' || typeof playlistId !== 'string' || typeof episodeSpec !== 'string') {
        return httpError(res, 400, 'bad-request', 'The body must be { "discKey", "playlistId", "episodeSpec" }.');
      }
      const store = sessionsOf(app);
      const discDir = store.byDiscKey(discKey);
      if (discDir === null) return httpError(res, 404, 'not-found', 'No disc the backend knows has that key.');
      try {
        const session = await store.create({ discDir, playlistId, episodeSpec });
        json(res, 200, { id: session.id });
      } catch (e) {
        if (e instanceof SessionError) return httpError(res, e.status, e.code, e.message);
        throw e;
      }
    },
  ],
];
