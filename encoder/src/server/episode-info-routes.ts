// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ServerResponse } from 'node:http';
import { readBody } from '../../../server/src/http';
import { loadPlaylist } from '../disc/playlist';
import { EpisodeInfoError, EpisodeInfoStore, hasChapterNames, migrateRecordChapters, parseEpisodeInfo } from '../plan/episode-info';
import { RecordError, RecordStore, withoutChapterNames } from '../subs/record';
import { knownDisc } from './disc-routes';
import { httpError, json, type RouteTable } from './http';

/** Largest body accepted: 999 names of 100 characters and 999 AniList entries fit well under it. */
const MAX_INFO_BYTES = 64 * 1024;

/**
 * Moves the chapter names an older encoder saved in the subtitle record of a disc's playlist into its episode info,
 * once: names the info already has win (`migrateRecordChapters`), the info is written only when something moves, and
 * the record is then saved again with every episode's `chapters` emptied (its `savedAt` kept), so the migration never
 * runs twice and a name the user removes since stays removed. Both the info and the record routes call it before they
 * answer, so whichever the page asks first migrates. A record or info file that cannot be read is left as it is; a
 * record whose names are all empty or `Chapter <n>` is only emptied, without reading the playlist.
 */
export async function migrateChapterNames(dataDir: string, discDir: string, discKey: string, playlistId: string): Promise<void> {
  const records = new RecordStore(dataDir);
  let record;
  try {
    record = await records.read(discKey, playlistId);
  } catch (e) {
    if (e instanceof RecordError) return;
    throw e;
  }
  if (record === null || !record.episodes.some((e) => e.metadata.chapters.length > 0)) return;
  if (hasChapterNames(record)) {
    const store = new EpisodeInfoStore(dataDir);
    let info;
    try {
      info = await store.read(discKey, playlistId);
    } catch (e) {
      if (e instanceof EpisodeInfoError) return; // keep the names in the record until the info can be read
      throw e;
    }
    const chapterCount = (await loadPlaylist(discDir, playlistId)).chapters.length;
    const moved = migrateRecordChapters(info, record, record.episodeSpec, chapterCount);
    if (moved !== null) await store.save(discKey, playlistId, moved);
  }
  await records.write(withoutChapterNames(record));
}

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
 * Before answering, GET moves an older record's chapter names into the info (`migrateChapterNames`).
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
      await migrateChapterNames(app.dataDir, disc.root, disc.key, playlistId);
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
