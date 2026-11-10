// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ServerResponse } from 'node:http';
import { nasTitleId, sameTitle, type EncodeTitle } from '@seikou/nas/encode-title';
import { readBody } from '../../../server/src/http';
import { loadPlaylist } from '../disc/playlist';
import { errorOfBody, NasError } from '../nas/client';
import { EpisodeInfoError, EpisodeInfoStore, hasChapterNames, migrateRecordChapters, parseEpisodeInfo, titlesSignature, type EpisodeInfo } from '../plan/episode-info';
import { EpisodeSpecError, parseEpisodeSpec } from '../plan/episodes';
import { RecordError, RecordStore, withoutChapterNames } from '../subs/record';
import { knownDisc } from './disc-routes';
import { httpError, json, type AppContext, type RouteTable } from './http';
import { nasTitlesOf } from './nas-title-routes';

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
const PREFILL_PATH = /^\/api\/discs\/([^/]+)\/playlists\/([^/]+)\/nas-prefill$/;
const CHECK_PATH = /^\/api\/discs\/([^/]+)\/playlists\/([^/]+)\/check$/;
/** Largest check body accepted. */
const MAX_CHECK_BYTES = 4 * 1024;

/**
 * The episode list that cuts `chapters` chapters into `episodes` equal groups of consecutive chapters
 * (`1-2,3-4,5-6,7-8`), or null when they do not divide evenly (or there are no episodes or no chapters).
 */
export function evenSpec(episodes: number, chapters: number): string | null {
  if (!Number.isInteger(episodes) || episodes < 1 || chapters < episodes || chapters % episodes !== 0) return null;
  const size = chapters / episodes;
  return Array.from({ length: episodes }, (_, i) => `${i * size + 1}-${(i + 1) * size}`).join(',');
}

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
 * The episode info of a library disc's playlist: its chapter names and each episode's title, kept by
 * `EpisodeInfoStore`.
 *
 *   GET /api/discs/<discKey>/playlists/<id>/info   `{ info }`, null when nothing was saved
 *   PUT /api/discs/<discKey>/playlists/<id>/info   body `{ chapterNames, titles }`; `{ info }` as stored, `savedAt` set
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
      const store = new EpisodeInfoStore(app.dataDir);
      // the page sends names and titles only: a mark already saved stays (it holds only while the titles are as it saw them)
      let kept: EpisodeInfo['checked'];
      if (parsed.checked === undefined) {
        try {
          kept = (await store.read(disc.key, playlistId))?.checked;
        } catch (e) {
          if (!(e instanceof EpisodeInfoError)) throw e;
        }
      }
      json(res, 200, { info: await store.save(disc.key, playlistId, kept === undefined ? parsed : { ...parsed, checked: kept }) });
    },
  ],
  [
    'GET',
    PREFILL_PATH,
    async (_req, res, match, app) => {
      const disc = await knownDisc(app, res, match[1]!);
      if (!disc) return;
      const playlistId = playlistOf(res, match[2]!);
      if (playlistId === null) return;
      const none = { episodes: [], title: null, episodeSpec: null };
      const client = app.nas.client;
      if (client === null) return json(res, 200, none);
      try {
        const found = await nasTitlesOf(app).discMatch(client, disc.key);
        const episodes = (found?.episodes ?? []).filter((e) => e.playlistId === playlistId).map((e) => ({ number: e.number, name: e.name }));
        if (found === null || episodes.length === 0) return json(res, 200, { ...none, title: found?.title ?? null });
        let chapters = 0;
        try {
          chapters = (await loadPlaylist(disc.root, playlistId)).chapters.length;
        } catch {
          // no grouping without the playlist
        }
        json(res, 200, { episodes, title: found.title, episodeSpec: evenSpec(episodes.length, chapters) });
      } catch (e) {
        if (!(e instanceof NasError)) throw e;
        json(res, 200, none); // a best-effort suggestion: the page goes without it
      }
    },
  ],
  [
    'POST',
    CHECK_PATH,
    async (req, res, match, app) => {
      const disc = await knownDisc(app, res, match[1]!);
      if (!disc) return;
      const playlistId = playlistOf(res, match[2]!);
      if (playlistId === null) return;
      const bytes = await readBody(req, MAX_CHECK_BYTES);
      if (bytes === null) {
        res.setHeader('Connection', 'close');
        return httpError(res, 413, 'too-large', 'That is too much.');
      }
      let episodeSpec: unknown;
      try {
        episodeSpec = (JSON.parse(bytes.toString('utf8')) as { episodeSpec?: unknown }).episodeSpec;
      } catch {
        episodeSpec = undefined;
      }
      if (typeof episodeSpec !== 'string') return httpError(res, 400, 'bad-request', 'Send { episodeSpec }.');
      let chapters: number;
      try {
        chapters = (await loadPlaylist(disc.root, playlistId)).chapters.length;
      } catch {
        return httpError(res, 404, 'not-found', 'The disc has no such playlist.');
      }
      let firsts: number[];
      try {
        firsts = parseEpisodeSpec(episodeSpec, chapters).map((s) => s.from);
      } catch (e) {
        if (!(e instanceof EpisodeSpecError)) throw e;
        return httpError(res, 400, 'bad-request', e.message);
      }
      const store = new EpisodeInfoStore(app.dataDir);
      let saved: EpisodeInfo | null;
      try {
        saved = await store.read(disc.key, playlistId);
      } catch (e) {
        if (!(e instanceof EpisodeInfoError)) throw e;
        return httpError(res, 500, 'info-unreadable', e.message);
      }
      const titles = firsts.map((n) => saved?.titles[String(n)]);
      if (saved === null || firsts.length === 0 || titles.some((t) => t === undefined)) {
        return httpError(res, 409, 'needs-title', 'Every episode needs a title and a number before the disc can be checked.');
      }
      const { chapterNames, titles: all } = saved;
      const info = await store.save(disc.key, playlistId, { chapterNames, titles: all, checked: { episodeSpec, signature: titlesSignature(all), at: new Date().toISOString() } });
      json(res, 200, { info, ...(await fileOnNas(app, disc.key, titles.map((t) => t!.title))) });
    },
  ],
];

/** What the check did to the NAS's library. */
type NasChoiceAnswer = { nasChoice: 'saved' | 'unchanged' | 'mixed' } | { nasChoice: 'failed'; message: string };

/**
 * The one place the encoder writes the NAS's library: when every episode of a checked playlist is under one title and
 * the NAS files the disc under another (or in Unsorted), the owner's choice for the disc is set to that title. The
 * NAS's answer decides; the details of the titles involved are read again so the Library shows the change. A disc the
 * NAS does not hold, an unpaired app and episodes of two shows change nothing.
 */
async function fileOnNas(app: AppContext, key: string, titles: readonly EncodeTitle[]): Promise<NasChoiceAnswer> {
  const client = app.nas.client;
  if (client === null) return { nasChoice: 'unchanged' };
  const title = titles[0]!;
  if (titles.some((t) => !sameTitle(t, title))) return { nasChoice: 'mixed' };
  const nas = nasTitlesOf(app);
  try {
    const found = await nas.discMatch(client, key);
    if (found === null || (found.title !== null && sameTitle(found.title, title))) return { nasChoice: 'unchanged' };
    const season = title.source === 'tmdb-tv' || title.source === 'own' ? title.season : null;
    const res = await client.request(`admin/discs/${encodeURIComponent(found.discId)}/choice`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice: { kind: 'title', titleId: nasTitleId(title), season, disc: null } }),
    });
    if (!res.ok) {
      const why = await errorOfBody(res);
      return { nasChoice: 'failed', message: why ?? `the NAS answered ${res.status}` };
    }
    await res.body?.cancel();
    await nas.refreshAfterChoice(client, [...new Set([found.titleId, nasTitleId(title)].filter((t): t is string => t !== null))]);
    return { nasChoice: 'saved' };
  } catch (e) {
    if (e instanceof NasError) return { nasChoice: 'failed', message: e.message };
    throw e;
  }
}
