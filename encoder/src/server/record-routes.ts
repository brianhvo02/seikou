// SPDX-License-Identifier: LGPL-3.0-or-later
import { readBody } from '../../../server/src/http';
import { loadPlaylist } from '../disc/playlist';
import { EpisodeInfoError, EpisodeInfoStore, migrateRecordChapters } from '../plan/episode-info';
import { sameEpisodeList } from '../plan/episodes';
import { parseRecord, RecordError, RecordStore, withoutChapterNames, type SubtitleRecord } from '../subs/record';
import { httpError, json, sessionRoute, type AppContext, type HelperSession, type RouteTable } from './http';
import { jobsUsingRecord } from './jobs';

// The saved record's half of the helper's API: the page saves what the user chose for the session's disc and
// playlist, and restores it on load.

/** Largest record body accepted; a record of a long series with every track listed is a few hundred kilobytes. */
const MAX_RECORD_BYTES = 2 * 1024 * 1024;

/** How many queued or interrupted encodes use the record of the session's playlist saved for episodes `spec`. */
async function queuedJobsOf(app: AppContext, session: HelperSession, spec: string): Promise<number> {
  const chapterCount = (await loadPlaylist(session.discDir, session.playlistId)).chapters.length;
  return jobsUsingRecord(app.dataDir, session.discKey, session.playlistId, spec, chapterCount);
}

/** Whether `spec` cuts the session's playlist into the session's episodes, however it is written. */
async function isSessionsList(session: HelperSession, spec: string): Promise<boolean> {
  if (spec === session.episodeSpec) return true;
  const chapterCount = (await loadPlaylist(session.discDir, session.playlistId)).chapters.length;
  return sameEpisodeList(spec, session.episodeSpec, chapterCount);
}

/**
 * Moves the chapter names an older encoder saved in `record` into the episode info file of the session's disc and
 * playlist, by the record's own episode list; names the file already has win, and the file is written only when
 * something moves. A file that cannot be read is left alone.
 */
async function migrateChapterNames(app: AppContext, session: HelperSession, record: SubtitleRecord): Promise<void> {
  if (!record.episodes.some((e) => e.metadata.chapters.length > 0)) return;
  const store = new EpisodeInfoStore(app.dataDir);
  let info;
  try {
    info = await store.read(session.discKey, session.playlistId);
  } catch (e) {
    if (e instanceof EpisodeInfoError) return;
    throw e;
  }
  const chapterCount = (await loadPlaylist(session.discDir, session.playlistId)).chapters.length;
  const moved = migrateRecordChapters(info, record, record.episodeSpec, chapterCount);
  if (moved !== null) await store.save(session.discKey, session.playlistId, moved);
}

/**
 * A session's record routes, under `/api/sessions/<id>`:
 *
 *   GET /record   `{ record, missing }` for the session's disc and playlist. `record` is null when none was saved
 *                 (never a 404), and also when the saved one is for another episode list (one that cuts the playlist
 *                 differently; `1-3,4-` and `1-3,4-5` on five chapters are the same list), which is then named in
 *                 `otherEpisodeSpec`, with `queuedJobs`, how many queued or interrupted encodes use that record
 *                 (`jobsUsingRecord`) and would stop with a mismatch once it is replaced; `missing` lists, by release (its `id`, null for a record with no release,
 *                 and its label as `release`), the cached files the record names that are gone, so the page can
 *                 say which release to fetch again. A record file on disk that is not valid answers 200 with
 *                 `record: null`, `missing: []` and `error: { code: 'record-unreadable', message }`, so the page
 *                 starts fresh; saving then overwrites the broken file. Chapter names an older encoder saved in the
                 record are first moved into the episode info file (`migrateRecordChapters`; names already there win).
 *   PUT /record   body: a record. It is validated, its disc key, playlist and episode spec must equal the session's
 *                 (409 `session-mismatch`), `savedAt` is set to the server's clock, every episode's
                 `metadata.chapters` is saved as `[]` (chapter names live in the episode info), and the stored record is
 *                 answered. A record saved for another episode list of the playlist is replaced only with
 *                 `?replace=1`; without it the answer is 409 `other-episode-spec` with that list as `episodeSpec`
 *                 and `queuedJobs` as for GET.
 *                 Errors: 400 `bad-record` with `message` and `path` (the JSON path of the first bad field; a body
 *                 that is not JSON has path `$`), 409 `session-mismatch` or `other-episode-spec`, 413 `too-large`
 *                 over 2 MB (with `Connection: close`).
 */
export const recordRoutes: RouteTable = [
  [
    'GET',
    /^\/record$/,
    sessionRoute(async (_req, res, _match, app, session) => {
      const store = new RecordStore(app.dataDir);
      let record;
      try {
        record = await store.read(session.discKey, session.playlistId);
      } catch (e) {
        if (!(e instanceof RecordError)) throw e;
        return json(res, 200, { record: null, missing: [], error: { code: 'record-unreadable', message: e.message } });
      }
      if (record) await migrateChapterNames(app, session, record);
      if (record && !(await isSessionsList(session, record.episodeSpec))) {
        return json(res, 200, { record: null, missing: [], otherEpisodeSpec: record.episodeSpec, queuedJobs: await queuedJobsOf(app, session, record.episodeSpec) });
      }
      json(res, 200, { record, missing: record ? await store.missingFiles(record) : [] });
    }),
  ],
  [
    'PUT',
    /^\/record$/,
    sessionRoute(async (req, res, _match, app, session) => {
      const bytes = await readBody(req, MAX_RECORD_BYTES);
      if (bytes === null) {
        res.setHeader('Connection', 'close');
        return httpError(res, 413, 'too-large', 'That record is too large.');
      }
      let parsed;
      try {
        let raw: unknown;
        try {
          raw = JSON.parse(bytes.toString('utf8'));
        } catch {
          throw new RecordError('$: the body is not valid JSON');
        }
        parsed = parseRecord(raw);
      } catch (e) {
        if (!(e instanceof RecordError)) throw e;
        const split = e.message.indexOf(': ');
        const path = split < 0 ? '$' : e.message.slice(0, split);
        return json(res, 400, { error: 'bad-record', message: e.message, path });
      }
      if (parsed.disc.key !== session.discKey || parsed.playlist !== session.playlistId || !(await isSessionsList(session, parsed.episodeSpec))) {
        return httpError(res, 409, 'session-mismatch', 'The record is for another disc, playlist or episode list.');
      }
      const store = new RecordStore(app.dataDir);
      const replace = new URL(req.url ?? '/', 'http://helper.invalid').searchParams.get('replace') === '1';
      if (!replace) {
        // a record another episode list of this playlist saved is replaced only when the page says so
        let stored = null;
        try {
          stored = await store.read(session.discKey, session.playlistId);
        } catch (e) {
          if (!(e instanceof RecordError)) throw e; // an unreadable file is replaced, as before
        }
        if (stored && !(await isSessionsList(session, stored.episodeSpec))) {
          return json(res, 409, {
            error: 'other-episode-spec',
            message: `Subtitle choices are saved for episodes ${stored.episodeSpec}; saving here replaces them.`,
            episodeSpec: stored.episodeSpec,
            queuedJobs: await queuedJobsOf(app, session, stored.episodeSpec),
          });
        }
      }
      const record = { ...withoutChapterNames(parsed), savedAt: new Date().toISOString() };
      await store.write(record);
      json(res, 200, record);
    }),
  ],
];
