// SPDX-License-Identifier: LGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { parseMpls } from '@seikou/bdmv/mpls-parser';
import type { DiscManifest } from '@seikou/nas/nas-api';
// Seikou's NAS server builds manifests and resolves disc paths this way; the helper answers exactly as the NAS does,
// so the engine opens the disc through the same RemoteSource.
import { buildManifest, resolveDiscFile } from '../../../server/src/manifest';
import { discKeyOfFolder } from '../disc/disc-key';
import { bdmvRoot, listPlaylists, loadPlaylist } from '../disc/playlist';
import { readPlaylistPmts } from '../disc/pmt';
import { probeClip, type ClipProbe } from '../disc/probe';
import { selectAudio } from '../plan/audio-streams';
import { EpisodeSpecError, firstFramePlaylistUs, parseEpisodeSpec, planEpisodes, type EpisodePlan, type EpisodeSpec } from '../plan/episodes';
import { httpError, json, sendFile, type HelperContext, type Route, type RouteTable } from './http';

// The disc half of the helper's API: the session, and the NAS disc API (manifest with inlined metadata, range reads)
// for the one disc this run serves, plus the playlist list and the episode plan in playlist time.

/** What the page learns first: which disc and episode list this run is about, and whether alignment can run. */
export interface SessionInfo {
  /** The disc's key (`f.<content fingerprint>`, or `d.<id>` for a disc with no streams), the `<discKey>` of the disc routes. */
  readonly discKey: string;
  /** The disc folder's name, for the page's heading. */
  readonly label: string;
  readonly playlistId: string;
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
  readonly pid: number;
  /** STN stream coding type (0x80 LPCM, 0x81 AC-3, 0x83 TrueHD, ...). */
  readonly codingType: number;
  /** ISO 639-2 code as the playlist gives it, such as `jpn`; empty when the disc names none. */
  readonly language: string;
}

/** The answer of `GET /api/episodes`. */
export interface EpisodesAnswer {
  readonly episodes: readonly EpisodeTimes[];
  readonly audio: readonly AudioStreamInfo[];
  /** Main-path PG (subtitle) streams of the first play item. */
  readonly pgCount: number;
}

/** What one run knows about its disc, worked out once. */
interface DiscState {
  /** Real path of the folder that holds BDMV. */
  readonly root: string;
  readonly label: string;
  readonly key: string;
  readonly manifest: DiscManifest;
  /** The episode plan, worked out on first use (it reads the start of each clip). */
  episodes: Promise<PlannedEpisodes> | null;
}

/** The episode plan as the encoder will cut it, and the answer of `GET /api/episodes` made from it. */
interface PlannedEpisodes {
  readonly plans: readonly EpisodePlan[];
  readonly answer: EpisodesAnswer;
}

const states = new WeakMap<HelperContext, Promise<DiscState>>();

/** A request the session cannot answer from the disc, as a 4xx with a code (`status`, `code`) to answer. */
export class DiscRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function loadState(ctx: HelperContext): Promise<DiscState> {
  const given = await realpath(ctx.discDir);
  const root = basename(given).toUpperCase() === 'BDMV' ? dirname(given) : given;
  const { key, label } = await discKeyOfFolder(root);
  // The manifest's id is the folder's own hash, not the key, as the NAS gives manifests an id of their own.
  const id16 = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const manifest = await buildManifest(root, { id: id16, name: label });
  return { root, label, key, manifest, episodes: null };
}

function stateOf(ctx: HelperContext): Promise<DiscState> {
  let state = states.get(ctx);
  if (!state) {
    state = loadState(ctx);
    states.set(ctx, state);
    state.catch(() => states.delete(ctx)); // a failed read is tried again on the next request
  }
  return state;
}

/**
 * Reads the disc of `ctx` once and keeps what the disc routes answer from: its key, label and manifest. The server
 * calls it before listening, so a folder that is not a disc fails the start. Rejects when the folder is missing or
 * has no `BDMV/index.bdmv`.
 */
export async function prepareDisc(ctx: HelperContext): Promise<SessionInfo> {
  const { key, label } = await stateOf(ctx);
  return { discKey: key, label, playlistId: ctx.playlistId, episodeSpec: ctx.episodeSpec, toolsReady: ctx.tools !== null };
}

async function planTimes(ctx: HelperContext, root: string): Promise<PlannedEpisodes> {
  const playlist = await loadPlaylist(root, ctx.playlistId);
  let specs: EpisodeSpec[];
  try {
    specs = parseEpisodeSpec(ctx.episodeSpec, playlist.chapters.length);
  } catch (e) {
    if (e instanceof EpisodeSpecError) throw new DiscRequestError(422, 'bad-episode-spec', e.message);
    throw e;
  }
  if (playlist.items[0]?.audioPids[0] === undefined) throw new DiscRequestError(422, 'no-audio', `Playlist ${ctx.playlistId} has no audio stream`);
  const probes = new Map<string, ClipProbe>();
  for (const item of playlist.items) if (!probes.has(item.clipId)) probes.set(item.clipId, await probeClip(item));
  // Alignment listens to the playlist's first STN audio stream, which BestSource finds through each clip's PMT.
  const firstAudio = selectAudio(playlist, probes, null, 1).slice(0, 1);
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
  const mpls = parseMpls(new Uint8Array(await readFile(join(bdmvRoot(root), 'PLAYLIST', `${ctx.playlistId}.mpls`))));
  const stn = mpls.playItems[0]!.stn;
  const audio = stn.audio.filter((e) => !e.subPath).map((e) => ({ pid: e.pid, codingType: e.codingType, language: e.lang }));
  return { plans, answer: { episodes, audio, pgCount: stn.pg.filter((e) => !e.subPath).length } };
}

/** The run's episode plan, worked out once and shared by every route; a failure is tried again on the next call. */
async function plannedEpisodes(ctx: HelperContext): Promise<PlannedEpisodes> {
  const state = await stateOf(ctx);
  if (!state.episodes) {
    const planned = planTimes(ctx, state.root);
    state.episodes = planned;
    planned.catch(() => {
      if (state.episodes === planned) state.episodes = null;
    });
  }
  return state.episodes;
}

/**
 * The encoder's plan of each episode of the run, in episode order (index 0 is episode 1), the same plan
 * `GET /api/episodes` answers from. Rejects with `DiscRequestError` (422 `bad-episode-spec` or `no-audio`) when the
 * episode list does not fit the playlist or the playlist has no audio.
 */
export async function episodePlans(ctx: HelperContext): Promise<readonly EpisodePlan[]> {
  return (await plannedEpisodes(ctx)).plans;
}

/** The disc key capture of a disc route, or an answered 404 `disc-changed` when it names another disc. */
async function sameDisc(ctx: HelperContext, res: ServerResponse, captured: string): Promise<DiscState | null> {
  const state = await stateOf(ctx);
  if (decodeURIComponent(captured) === state.key) return state;
  httpError(res, 404, 'disc-changed', 'This run of the helper serves another disc.');
  return null;
}

/** `/api/discs/<discKey>/files/<path>`, still percent-encoded. */
const FILE_PATH = /^\/api\/discs\/([^/]+)\/files\/(.+)$/;

/** Answers a disc file, whole or one range; the path is matched in any case under BDMV or CERTIFICATE. */
const serveDiscFile: Route = async (req, res, match, ctx) => {
  const state = await sameDisc(ctx, res, match[1]!);
  if (!state) return;
  const rel = match[2]!.split('/').map(decodeURIComponent).join('/');
  const file = await resolveDiscFile(state.root, rel);
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
 * The disc routes. Paths are matched still percent-encoded:
 *
 *   GET /api/session                       SessionInfo
 *   GET /api/discs/<discKey>/manifest      DiscManifest, as Seikou's NAS answers it
 *   GET|HEAD /api/discs/<discKey>/files/<path>   the file (any case, under BDMV or CERTIFICATE), whole or one Range
 *   GET /api/playlists                     every playlist with its length (45 kHz) and clips
 *   GET /api/episodes                      EpisodesAnswer
 *
 * Another disc key answers 404 `disc-changed` (the engine then says the disc changed); a missing file 404 `not-found`.
 */
export const discRoutes: RouteTable = [
  ['GET', /^\/api\/session$/, async (_req, res, _match, ctx) => json(res, 200, await prepareDisc(ctx))],
  [
    'GET',
    /^\/api\/discs\/([^/]+)\/manifest$/,
    async (_req, res, match, ctx) => {
      const state = await sameDisc(ctx, res, match[1]!);
      if (state) json(res, 200, state.manifest);
    },
  ],
  ['GET', FILE_PATH, serveDiscFile],
  ['HEAD', FILE_PATH, serveDiscFile],
  [
    'GET',
    /^\/api\/playlists$/,
    async (_req, res, _match, ctx) => {
      const { root } = await stateOf(ctx);
      json(res, 200, await listPlaylists(root));
    },
  ],
  [
    'GET',
    /^\/api\/episodes$/,
    async (_req, res, _match, ctx) => {
      try {
        json(res, 200, (await plannedEpisodes(ctx)).answer);
      } catch (e) {
        if (e instanceof DiscRequestError) return httpError(res, e.status, e.code, e.message);
        throw e;
      }
    },
  ],
];
