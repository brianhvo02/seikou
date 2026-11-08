// SPDX-License-Identifier: LGPL-3.0-or-later
import { readFile, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { parseMpls } from '@seikou/bdmv/mpls-parser';
// Seikou's NAS server resolves disc paths this way; the helper answers exactly as the NAS does, so the engine opens
// the disc through the same RemoteSource.
import { resolveDiscFile } from '../../../server/src/manifest';
import { bdmvRoot, listPlaylists, loadPlaylist } from '../disc/playlist';
import { readPlaylistPmts } from '../disc/pmt';
import { probeClip, type ClipProbe } from '../disc/probe';
import { firstStnAudio } from '../plan/audio-streams';
import { EpisodeSpecError, firstFramePlaylistUs, parseEpisodeSpec, planEpisodes, type EpisodePlan, type EpisodeSpec } from '../plan/episodes';
import { httpError, json, sendFile, sessionRoute, type AppContext, type HelperSession, type Route, type RouteTable } from './http';
import { discOf, sessionsOf, type DiscInfo } from './sessions';

// The disc half of the helper's API: the NAS disc API (manifest with inlined metadata, range reads) for every disc a
// session is on, and, per session, what the session is about, the disc's playlists and the episode plan in playlist
// time.

/** What the page learns first: which disc and episode list the session is about, and whether alignment can run. */
export interface SessionInfo {
  /** The disc's key (`f.<content fingerprint>`, or `d.<id>` for a disc with no streams), the `<discKey>` of the disc routes. */
  readonly discKey: string;
  /** The disc folder's name, for the page's heading. */
  readonly label: string;
  /** Five-digit playlist name. */
  readonly playlistId: string;
  /** The episode list as typed. */
  readonly episodeSpec: string;
  /** Whether the external tools alignment needs were found. */
  readonly toolsReady: boolean;
}

/** One episode in playlist time: where it starts, how long it lasts, and where its chapters start. */
export interface EpisodeTimes {
  /** 1-based position in the episode list. */
  readonly index: number;
  /**
   * Microseconds of playlist time: the episode's first frame, the zero of the encode, the alignment and the retimed
   * track (its first chapter mark rounded to the nearest frame).
   */
  readonly startUs: number;
  /** Microseconds: the episode's whole frames at the video's rate. */
  readonly durationUs: number;
  /** Microseconds of playlist time, on the episode's frame grid; the first equals `startUs`. */
  readonly chapters: readonly { readonly startUs: number }[];
}

/** A main-path audio stream of the playlist's first play item, in the order players number them. */
export interface AudioStreamInfo {
  /** The stream's PID. */
  readonly pid: number;
  /** STN stream coding type (0x80 LPCM, 0x81 AC-3, 0x83 TrueHD, ...). */
  readonly codingType: number;
  /** ISO 639-2 code as the playlist gives it, such as `jpn`; empty when the disc names none. */
  readonly language: string;
}

/** The answer of `GET /api/sessions/<id>/episodes`. */
export interface EpisodesAnswer {
  /** The session's episodes in order. */
  readonly episodes: readonly EpisodeTimes[];
  /** The playlist's main-path audio streams. */
  readonly audio: readonly AudioStreamInfo[];
  /** Main-path PG (subtitle) streams of the first play item. */
  readonly pgCount: number;
}

/** The episode plan as the encoder will cut it, and the answer of `GET /api/sessions/<id>/episodes` made from it. */
interface PlannedEpisodes {
  readonly plans: readonly EpisodePlan[];
  readonly answer: EpisodesAnswer;
}

/** Each session's episode plan, worked out on first use (it reads the start of each clip). */
const planned = new WeakMap<HelperSession, Promise<PlannedEpisodes>>();

/** A request the session cannot answer from the disc, as a 4xx with a code (`status`, `code`) to answer. */
export class DiscRequestError extends Error {
  constructor(
    /** The HTTP status. */
    readonly status: number,
    /** The error code. */
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What `GET /api/sessions/<id>` answers for `session`. */
export async function sessionInfo(app: AppContext, session: HelperSession): Promise<SessionInfo> {
  const { label } = await discOf(app, session.discDir);
  return { discKey: session.discKey, label, playlistId: session.playlistId, episodeSpec: session.episodeSpec, toolsReady: app.tools !== null };
}

async function planTimes(session: HelperSession): Promise<PlannedEpisodes> {
  const root = session.discDir;
  const playlist = await loadPlaylist(root, session.playlistId);
  let specs: EpisodeSpec[];
  try {
    specs = parseEpisodeSpec(session.episodeSpec, playlist.chapters.length);
  } catch (e) {
    if (e instanceof EpisodeSpecError) throw new DiscRequestError(422, 'bad-episode-spec', e.message);
    throw e;
  }
  if (playlist.items[0]?.audioPids[0] === undefined) throw new DiscRequestError(422, 'no-audio', `Playlist ${session.playlistId} has no audio stream`);
  const probes = new Map<string, ClipProbe>();
  for (const item of playlist.items) if (!probes.has(item.clipId)) probes.set(item.clipId, await probeClip(item));
  // Alignment listens to the playlist's first STN audio stream, which BestSource finds through each clip's PMT.
  const first = firstStnAudio(playlist, probes);
  const firstAudio = first === null ? [] : [first];
  const plans = planEpisodes(playlist, probes, specs, firstAudio, await readPlaylistPmts(playlist));

  const episodes = plans.map((plan): EpisodeTimes => {
    const startUs = firstFramePlaylistUs(playlist, plan);
    return {
      index: plan.index,
      startUs,
      durationUs: Number(plan.durationNs / 1000n),
      chapters: plan.chapters.map((c) => ({ startUs: startUs + Number(c.startNs / 1000n) })),
    };
  });

  // Languages and PG streams come from the playlist's STN table: the clip-info file lists every stream of the clip,
  // the STN only the ones a player offers, in its numbering.
  const mpls = parseMpls(new Uint8Array(await readFile(join(bdmvRoot(root), 'PLAYLIST', `${session.playlistId}.mpls`))));
  const stn = mpls.playItems[0]!.stn;
  const audio = stn.audio.filter((e) => !e.subPath).map((e) => ({ pid: e.pid, codingType: e.codingType, language: e.lang }));
  return { plans, answer: { episodes, audio, pgCount: stn.pg.filter((e) => !e.subPath).length } };
}

/** The session's episode plan, worked out once and shared by every route; a failure is tried again on the next call. */
function plannedEpisodes(session: HelperSession): Promise<PlannedEpisodes> {
  let plan = planned.get(session);
  if (!plan) {
    const working = planTimes(session);
    plan = working;
    planned.set(session, working);
    working.catch(() => {
      if (planned.get(session) === working) planned.delete(session);
    });
  }
  return plan;
}

/**
 * The encoder's plan of each episode of the session, in episode order (index 0 is episode 1), the same plan
 * `GET /api/sessions/<id>/episodes` answers from. Rejects with `DiscRequestError` (422 `bad-episode-spec` or
 * `no-audio`) when the episode list does not fit the playlist or the playlist has no audio.
 */
export async function episodePlans(session: HelperSession): Promise<readonly EpisodePlan[]> {
  return (await plannedEpisodes(session)).plans;
}

/** The disc a disc route's key capture names, or an answered 404 `disc-changed` when the backend knows no such disc. */
export async function knownDisc(app: AppContext, res: ServerResponse, captured: string): Promise<DiscInfo | null> {
  let key: string;
  try {
    key = decodeURIComponent(captured);
  } catch {
    key = '';
  }
  const dir = sessionsOf(app).byDiscKey(key);
  if (dir !== null) {
    const disc = await discOf(app, dir);
    if (disc.key === key) return disc;
  }
  httpError(res, 404, 'disc-changed', 'The helper serves no disc with that key.');
  return null;
}

/** `/api/discs/<discKey>/files/<path>`, still percent-encoded. */
const FILE_PATH = /^\/api\/discs\/([^/]+)\/files\/(.+)$/;

/** Answers a disc file, whole or one range; the path is matched in any case under BDMV or CERTIFICATE. */
const serveDiscFile: Route = async (req, res, match, app) => {
  const disc = await knownDisc(app, res, match[1]!);
  if (!disc) return;
  const rel = match[2]!.split('/').map(decodeURIComponent).join('/');
  const file = await resolveDiscFile(disc.root, rel);
  let size: number | null = null;
  if (file) {
    try {
      size = (await stat(file)).size;
    } catch {
      // vanished since the manifest was built
    }
  }
  if (file === null || size === null) return httpError(res, 404, 'not-found', 'The disc has no such file.');
  sendFile(req, res, file, size, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
};

/**
 * The app's disc routes, for every disc a session is on. Paths are matched still percent-encoded:
 *
 *   GET /api/discs/<discKey>/manifest      DiscManifest, as Seikou's NAS answers it
 *   GET|HEAD /api/discs/<discKey>/files/<path>   the file (any case, under BDMV or CERTIFICATE), whole or one Range
 *
 * An unknown disc key answers 404 `disc-changed` (the engine then says the disc changed); a missing file 404
 * `not-found`.
 */
export const discRoutes: RouteTable = [
  [
    'GET',
    /^\/api\/discs\/([^/]+)\/manifest$/,
    async (_req, res, match, app) => {
      const disc = await knownDisc(app, res, match[1]!);
      if (disc) json(res, 200, disc.manifest);
    },
  ],
  ['GET', FILE_PATH, serveDiscFile],
  ['HEAD', FILE_PATH, serveDiscFile],
];

/**
 * A session's disc routes, under `/api/sessions/<id>`:
 *
 *   GET (the session itself)   SessionInfo
 *   GET /playlists             every playlist of the session's disc with its length (45 kHz) and clips
 *   GET /episodes              EpisodesAnswer; 422 `bad-episode-spec` or `no-audio`
 */
export const discSessionRoutes: RouteTable = [
  ['GET', /^$/, sessionRoute(async (_req, res, _match, app, session) => json(res, 200, await sessionInfo(app, session)))],
  ['GET', /^\/playlists$/, sessionRoute(async (_req, res, _match, _app, session) => json(res, 200, await listPlaylists(session.discDir)))],
  [
    'GET',
    /^\/episodes$/,
    sessionRoute(async (_req, res, _match, _app, session) => {
      try {
        json(res, 200, (await plannedEpisodes(session)).answer);
      } catch (e) {
        if (e instanceof DiscRequestError) return httpError(res, e.status, e.code, e.message);
        throw e;
      }
    }),
  ],
];
