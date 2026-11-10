// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ServerResponse } from 'node:http';
import { readBody } from '../../../server/src/http';
import { EpisodeInfoError, EpisodeInfoStore, parseEpisodeInfo } from '../plan/episode-info';
import { knownDisc } from './disc-routes';
import { httpError, json, type RouteTable } from './http';

/** Largest body accepted: 999 names of 100 characters and 999 AniList entries fit well under it. */
const MAX_INFO_BYTES = 64 * 1024;

/** `/api/discs/<discKey>/playlists/<id>/info`, still percent-encoded. */
const INFO_PATH = /^\/api\/discs\/([^/]+)\/playlists\/([^/]+)\/info$/;

/** The playlist id of the path, or null after answering 400 `bad-request` for one that is not five digits. */
function playlistOf(res: ServerResponse, captured: string): string | null {
  let id = '';
  try {
    id = decodeURIComponent(captured);
  } catch {
    // not valid percent-encoding: not a playlist id either
  }
  if (/^\d{5}$/.test(id)) return id;
  httpError(res, 400, 'bad-request', 'A playlist id is five digits.');
  return null;
}

/**
 * The episode info of a library disc's playlist: its chapter names and each episode's AniList entry, kept by
 * `EpisodeInfoStore`.
 *
 *   GET /api/discs/<discKey>/playlists/<id>/info   `{ info }`, null when nothing was saved
 *   PUT /api/discs/<discKey>/playlists/<id>/info   body `{ chapterNames, anilist }`; `{ info }` as stored, `savedAt` set
 *
 * Errors: 404 `disc-changed` for a disc key no session or library holds, 400 `bad-request` for a playlist id that is
 * not five digits, 400 `bad-info` (with `message`) for a body that is not valid info, 413 `too-large` over 64 KiB
 * (with `Connection: close`), 500 `info-unreadable` for a saved file that cannot be read (a PUT replaces it).
 */
export const episodeInfoRoutes: RouteTable = [
  [
    'GET',
    INFO_PATH,
    async (_req, res, match, app) => {
      const disc = await knownDisc(app, res, match[1]!);
      if (!disc) return;
      const playlistId = playlistOf(res, match[2]!);
      if (playlistId === null) return;
      try {
        json(res, 200, { info: await new EpisodeInfoStore(app.dataDir).read(disc.key, playlistId) });
      } catch (e) {
        if (!(e instanceof EpisodeInfoError)) throw e;
        httpError(res, 500, 'info-unreadable', e.message);
      }
    },
  ],
  [
    'PUT',
    INFO_PATH,
    async (req, res, match, app) => {
      const disc = await knownDisc(app, res, match[1]!);
      if (!disc) return;
      const playlistId = playlistOf(res, match[2]!);
      if (playlistId === null) return;
      const bytes = await readBody(req, MAX_INFO_BYTES);
      if (bytes === null) {
        res.setHeader('Connection', 'close');
        return httpError(res, 413, 'too-large', 'That is too much to save.');
      }
      let parsed;
      try {
        let raw: unknown;
        try {
          raw = JSON.parse(bytes.toString('utf8'));
        } catch {
          throw new EpisodeInfoError('bad-info', '$: the body is not valid JSON');
        }
        parsed = parseEpisodeInfo(raw);
      } catch (e) {
        if (!(e instanceof EpisodeInfoError)) throw e;
        return httpError(res, 400, 'bad-info', e.message);
      }
      json(res, 200, { info: await new EpisodeInfoStore(app.dataDir).save(disc.key, playlistId, parsed) });
    },
  ],
];
