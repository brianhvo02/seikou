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
import { NasError } from '../nas/client';
import { claimMirror, ClipFetcher } from '../nas/fetch';
import { ensureMirror, FetchError, isMirror, mirrorDirOf, readState } from '../nas/mirror';
import { nasLibraryOf } from '../nas/nas-library';
import { EpisodeSpecError, parseEpisodeSpec, resolvedSpec } from '../plan/episodes';
import { httpError, json, type AppContext, type HelperSession, type RouteTable } from './http';
import { libraryOf } from './library';

// Helper sessions: the backend opens the subtitle helper on any disc, playlist and episode list it is asked for, and
// keeps each such session, under an id of its own, for the server's life. The discs the sessions are on are read
// once and kept here too, so every disc route finds a disc by its key.

/** The longest a request waits for a running library scan to find a disc key it does not know yet. */
const SCAN_WAIT_MS = 60_000;

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
    /**
     * The HTTP status: 400 for a malformed playlist id or episode list, 404 for a missing playlist; on a NAS disc's
     * mirror, 502 when the NAS cannot be reached, 409 when its disc changed, 507 when the drive has no room.
     */
    readonly status: number,
    /** `bad-request`, `bad-episode-spec`, `not-found`, `unreachable`, `disc-changed` or `no-room`. */
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
  const { key, label: folder } = await discKeyOfFolder(root);
  // A mirror's folder is named by its key; its label is the disc's name on the NAS.
  const label = (await isMirror(root)) ? ((await readState(root))?.label ?? folder) : folder;
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

/** Forgets the disc read from `root`, so the next `discOf` reads it again (a mirror whose metadata was rewritten). */
function forgetDisc(app: AppContext, root: string): void {
  discs.get(app)?.delete(root);
}

/** A `SessionError` for a fetch from the NAS that failed while a session was made. */
function fetchFailure(e: unknown): SessionError | null {
  if (e instanceof FetchError) {
    const status = e.code === 'disc-changed' ? 409 : e.code === 'no-room' ? 507 : 502;
    return new SessionError(status, e.code, e.message);
  }
  if (e instanceof NasError) return new SessionError(502, 'unreachable', e.message);
  return null;
}

/** The helper sessions of one app, made on demand and kept for the server's life. */
export class SessionStore {
  private readonly sessions = new Map<string, HelperSession>();
  /** Session ids by disc folder, playlist and episode list. */
  private readonly byInput = new Map<string, string>();
  /** Disc folders by disc key, for every disc a session is on. */
  private readonly discDirs = new Map<string, string>();
  /** NAS discs' mirrors made or refreshed this run, by key; dropped when a read finds the NAS's disc changed. */
  private readonly mirrors = new Map<string, Promise<string | null>>();

  constructor(private readonly app: AppContext) {}

  /**
   * The session for `input`: the existing one when a session on the same disc, playlist and episodes (lists that cut the playlist alike, such as `1-3,4-` and `1-3,4-5` on five chapters, are the same) was made
   * before, else a new one with a random id. Rejects with `SessionError` for a playlist id that is not five digits
   * (400 `bad-request`), a playlist the disc lacks (404 `not-found`) or an episode list the playlist cannot hold
   * (400 `bad-episode-spec`), and with the read error when the folder is not a disc.
   */
  async create(input: SessionInput): Promise<HelperSession> {
    if (!/^\d{5}$/.test(input.playlistId)) throw new SessionError(400, 'bad-request', 'A playlist id is five digits.');
    const disc = await discOf(this.app, input.discDir);
    const mirror = await isMirror(disc.root);
    if (mirror) {
      // planning reads each clip's head, which a mirror holds only once fetched
      const client = this.app.nas.client;
      if (client === null) throw new SessionError(502, 'unreachable', 'The encoder is not paired with the NAS.');
      try {
        await new ClipFetcher({ dataDir: this.app.dataDir, client, key: disc.key }).heads(input.playlistId);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new SessionError(404, 'not-found', `The disc has no playlist ${input.playlistId}.`);
        throw fetchFailure(e) ?? e;
      }
    }
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
    const inputKey = JSON.stringify([disc.root, input.playlistId, resolvedSpec(input.episodeSpec, chapters)]);
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
    // sessions live as long as the server, and so does the claim: another copy opened meanwhile leaves the metadata
    // the session planned from
    if (mirror) claimMirror(this.app.dataDir, disc.key, `session:${session.id}`);
    return session;
  }

  /** The session with `id`, or null. */
  get(id: string): HelperSession | null {
    return this.sessions.get(id) ?? null;
  }

  /**
   * The folder of the disc with `key` when a session is on it or the last library scan found it, else null. Two copies of one disc in different folders
   * have the same key (it is the content's fingerprint, and their bytes are identical), so they share one entry: the
   * folder of the copy a session was last made on.
   */
  byDiscKey(key: string): string | null {
    return this.discDirs.get(key) ?? libraryOf(this.app).dirOf(key);
  }

  /**
   * The folder of the disc with `key`: a session's folder, a local library folder, then a NAS disc's mirror (made or
   * refreshed through `ensureMirror` once per run). A key nobody knows yet while a library scan is running waits for
   * the scan to end (at most `SCAN_WAIT_MS`) and is looked up again, since the library is incomplete until then. While
   * the NAS cannot be reached, a key whose mirror exists resolves to it, so work on fetched data goes on; null when
   * nothing has the key.
   */
  async discDirOf(key: string): Promise<string | null> {
    const known = this.byDiscKey(key);
    if (known !== null) return known;
    const library = libraryOf(this.app);
    if (library.scanning) {
      await library.idle(SCAN_WAIT_MS);
      const found = this.byDiscKey(key);
      if (found !== null) return found;
    }
    return this.mirrorDirFor(key);
  }

  /** The mirror of NAS disc `key`, made or refreshed once per run (see `discDirOf`); null when there is none to be had. */
  async mirrorDirFor(key: string): Promise<string | null> {
    const held = this.mirrors.get(key);
    if (held !== undefined) {
      const dir = await held.catch(() => null);
      if (dir !== null && (await isMirror(dir))) return dir;
      if (this.mirrors.get(key) === held) this.mirrors.delete(key);
    }
    const making = this.makeMirror(key);
    const dir = making.then((m) => m.dir);
    this.mirrors.set(key, dir);
    try {
      const made = await making;
      // only a mirror refreshed from the NAS is kept for the run; one used as it was is looked at again next time
      if (!made.ensured && this.mirrors.get(key) === dir) this.mirrors.delete(key);
      return made.dir;
    } catch (e) {
      if (this.mirrors.get(key) === dir) this.mirrors.delete(key);
      throw e;
    }
  }

  /** Drops the run's memory of mirror `key`, so the next lookup asks the NAS again (a read found its disc changed). */
  forgetMirror(key: string): void {
    this.mirrors.delete(key);
  }

  private async makeMirror(key: string): Promise<{ dir: string | null; ensured: boolean }> {
    let existing: string | null = null;
    try {
      const dir = mirrorDirOf(this.app.dataDir, key);
      if (await isMirror(dir)) existing = dir;
    } catch {
      return { dir: null, ensured: false }; // not a disc key
    }
    const client = this.app.nas.client;
    if (client === null) return { dir: null, ensured: false };
    const kept = { dir: existing, ensured: false };
    const nas = nasLibraryOf(this.app);
    if (nas.scanning || nas.reachable === null) await Promise.race([nas.scan(), new Promise<void>((r) => setTimeout(r, SCAN_WAIT_MS).unref())]);
    const disc = nas.byKey(key);
    if (disc === null) return nas.reachable === false ? kept : { dir: null, ensured: false };
    if (nas.reachable === false) return kept;
    try {
      const { dir } = await ensureMirror(this.app.dataDir, client, disc.discId, key);
      forgetDisc(this.app, dir); // its metadata may have been rewritten from this copy
      return { dir, ensured: true };
    } catch (e) {
      if ((e instanceof FetchError && e.code === 'unreachable') || (e instanceof NasError && e.code === 'unreachable')) return kept;
      if (e instanceof FetchError || e instanceof NasError) return { dir: null, ensured: false };
      throw e;
    }
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
 *                        values. The disc must be one a session is on or the library holds (404 `not-found` otherwise). Errors:
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
      const discDir = await store.discDirOf(discKey);
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
