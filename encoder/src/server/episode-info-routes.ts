// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ServerResponse } from 'node:http';
import { nasTitleId, sameTitle, type EncodeTitle } from '@seikou/nas/encode-title';
import { readBody } from '../../../server/src/http';
import { loadPlaylist } from '../disc/playlist';
import { errorOfBody, NasError } from '../nas/client';
import { EpisodeInfoError, EpisodeInfoStore, hasChapterNames, migrateRecordChapters, parseEpisodeInfo, titlesSignature, type EpisodeInfo } from '../plan/episode-info';
import { EpisodeSpecError, parseEpisodeSpec, sameEpisodeList } from '../plan/episodes';
import { RecordError, RecordStore, withoutChapterNames } from '../subs/record';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
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
 * record whose names are all empty or `Chapter <n>` is only emptied, without reading the playlist. It runs under the
 * info's lock (`EpisodeInfoStore.locked`), as every other write of the info does.
 */
export async function migrateChapterNames(dataDir: string, discDir: string, discKey: string, playlistId: string): Promise<void> {
  const store = new EpisodeInfoStore(dataDir);
  try {
    // under the info's lock, so a save of the info (the PUT, the check) never lands between this read and write
    await store.locked(discKey, playlistId, async () => {
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
        const info = await store.read(discKey, playlistId); // unreadable: keep the names in the record until it can be read
        const chapterCount = (await loadPlaylist(discDir, playlistId)).chapters.length;
        const moved = migrateRecordChapters(info, record, record.episodeSpec, chapterCount);
        if (moved !== null) await store.save(discKey, playlistId, moved);
      }
      await records.write(withoutChapterNames(record));
    });
  } catch (e) {
    if (!(e instanceof EpisodeInfoError)) throw e;
  }
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
      const stored = await store.locked(disc.key, playlistId, async () => {
        // the page sends names and titles only: a mark already saved stays (it holds only while the titles are as it saw them)
        let kept: EpisodeInfo['checked'];
        if (parsed.checked === undefined) {
          try {
            kept = (await store.read(disc.key, playlistId))?.checked;
          } catch (e) {
            if (!(e instanceof EpisodeInfoError)) throw e;
          }
        }
        return store.save(disc.key, playlistId, kept === undefined ? parsed : { ...parsed, checked: kept });
      });
      json(res, 200, { info: stored });
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
      // a subtitle record made for other episodes would not match what is checked
      try {
        const record = await new RecordStore(app.dataDir).read(disc.key, playlistId);
        if (record !== null && !sameEpisodeList(record.episodeSpec, episodeSpec, chapters)) {
          return httpError(res, 409, 'record-mismatch', `The saved subtitles were made for episodes grouped as ${record.episodeSpec}. Group them that way, or line up the subtitles again.`);
        }
      } catch (e) {
        if (!(e instanceof RecordError)) throw e;
      }
      const store = new EpisodeInfoStore(app.dataDir);
      const done = await store.locked(disc.key, playlistId, async () => {
        const saved = await store.read(disc.key, playlistId);
        const titles = firsts.map((n) => saved?.titles[String(n)]);
        if (saved === null || firsts.length === 0 || titles.some((t) => t === undefined)) return null;
        const { chapterNames, titles: all } = saved;
        const info = await store.save(disc.key, playlistId, { chapterNames, titles: all, checked: { episodeSpec, signature: titlesSignature(all), at: new Date().toISOString() } });
        return { info, titles: titles.map((t) => t!.title) };
      }).catch((e: unknown) => {
        if (e instanceof EpisodeInfoError) return e;
        throw e;
      });
      if (done instanceof EpisodeInfoError) return httpError(res, 500, 'info-unreadable', done.message);
      if (done === null) return httpError(res, 409, 'needs-title', 'Every episode needs a title and a number before the disc can be checked.');
      // the disc's other playlists with saved titles count too: all of them must be under one show
      const others = await otherTitles(app.dataDir, disc.key, playlistId);
      json(res, 200, { info: done.info, ...(await fileOnNas(app, disc.key, [...done.titles, ...others])) });
    },
  ],
];

/** The titles saved for the disc's playlists other than `playlistId`; a file that cannot be read counts for none. */
async function otherTitles(dataDir: string, key: string, playlistId: string): Promise<EncodeTitle[]> {
  let names: string[];
  try {
    names = await readdir(join(dataDir, 'chapters', key));
  } catch {
    return [];
  }
  const store = new EpisodeInfoStore(dataDir);
  const out: EncodeTitle[] = [];
  for (const n of names) {
    const m = /^(\d{5})\.json$/.exec(n);
    if (!m || m[1] === playlistId) continue;
    try {
      for (const t of Object.values((await store.read(key, m[1]))?.titles ?? {})) out.push(t.title);
    } catch (e) {
      if (!(e instanceof EpisodeInfoError)) throw e;
    }
  }
  return out;
}

/** What the check did to the NAS's library; a failure's `message` is a whole sentence. */
type NasChoiceAnswer = { nasChoice: 'saved' | 'unchanged' | 'mixed' } | { nasChoice: 'failed'; message: string };

/** The failure for an AniList entry the NAS's catalogue doesn't hold, so whether it is a series' season can't be told. */
const UNKNOWN_ANILIST = "The NAS doesn't know this AniList entry yet, so it was left as it is. File it with “File differently…” in Seikou instead.";

/**
 * The one place the encoder writes the NAS's library: when every episode of a checked playlist is under one title and
 * the NAS files the disc under another (or in Unsorted), the owner's choice for the disc is set to that title. An
 * AniList entry that is a season of a series is chosen as the series with that season's number (a series without a
 * season is Unsorted on the NAS); one the NAS's catalogue doesn't hold is left alone (`failed`). The choice names no
 * disc number (the old slot's number doesn't apply where the disc goes). The NAS's answer decides; the details of the titles involved are
 * read again so the Library shows the change. A disc the NAS does not hold, an unpaired app and episodes of two shows
 * change nothing.
 */
async function fileOnNas(app: AppContext, key: string, titles: readonly EncodeTitle[]): Promise<NasChoiceAnswer> {
  const client = app.nas.client;
  if (client === null) return { nasChoice: 'unchanged' };
  const title = titles[0]!;
  if (titles.some((t) => !sameTitle(t, title))) return { nasChoice: 'mixed' };
  const nas = nasTitlesOf(app);
  try {
    const found = await nas.discMatch(client, key, { fresh: true });
    if (found === null || (found.title !== null && sameTitle(found.title, title))) return { nasChoice: 'unchanged' };
    let target: { titleId: string; season: number | null } = { titleId: nasTitleId(title), season: title.source === 'tmdb-tv' || title.source === 'own' ? title.season : null };
    if (title.source === 'anilist') {
      const place = await nas.anilistPlace(client, title.anilistId);
      if (place === null) return { nasChoice: 'failed', message: UNKNOWN_ANILIST };
      target = place;
    }
    const refresh = (): Promise<void> => nas.refreshAfterChoice(client, [...new Set([found.titleId, target.titleId].filter((t): t is string => t !== null))]);
    // every copy of the disc the NAS holds gets the choice; one refusal fails the whole
    for (const discId of found.discIds) {
      const res = await client.request(`admin/discs/${encodeURIComponent(discId)}/choice`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice: { kind: 'title', titleId: target.titleId, season: target.season, disc: null } }),
      });
      if (!res.ok) {
        const why = await errorOfBody(res);
        await refresh();
        return { nasChoice: 'failed', message: `The NAS refused the change: ${why ?? `it answered ${res.status}`}.` };
      }
      await res.body?.cancel();
    }
    await refresh();
    return { nasChoice: 'saved' };
  } catch (e) {
    if (e instanceof NasError) return { nasChoice: 'failed', message: `The NAS couldn't be told: ${e.message}` };
    throw e;
  }
}
