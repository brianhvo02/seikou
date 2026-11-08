// SPDX-License-Identifier: LGPL-3.0-or-later
import { readBody } from '../../../server/src/http';
import { parseRecord, RecordError, RecordStore } from '../subs/record';
import { httpError, json, sessionRoute, type RouteTable } from './http';

// The saved record's half of the helper's API: the page saves what the user chose for the session's disc and
// playlist, and restores it on load.

/** Largest record body accepted; a record of a long series with every track listed is a few hundred kilobytes. */
const MAX_RECORD_BYTES = 2 * 1024 * 1024;

/**
 * A session's record routes, under `/api/sessions/<id>`:
 *
 *   GET /record   `{ record, missing }` for the session's disc and playlist. `record` is null when none was saved
 *                 (never a 404), and also when the saved one is for another episode list, which is then named in
 *                 `otherEpisodeSpec`; `missing` lists, by release (its `id`, null for a record with no release,
 *                 and its label as `release`), the cached files the record names that are gone, so the page can
 *                 say which release to fetch again. A record file on disk that is not valid answers 200 with
 *                 `record: null`, `missing: []` and `error: { code: 'record-unreadable', message }`, so the page
 *                 starts fresh; saving then overwrites the broken file.
 *   PUT /record   body: a record. It is validated, its disc key, playlist and episode spec must equal the session's
 *                 (409 `session-mismatch`), `savedAt` is set to the server's clock, and the stored record is
 *                 answered. A record saved for another episode list of the playlist is replaced only with
 *                 `?replace=1`; without it the answer is 409 `other-episode-spec` with that list as `episodeSpec`.
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
      if (record && record.episodeSpec !== session.episodeSpec) {
        return json(res, 200, { record: null, missing: [], otherEpisodeSpec: record.episodeSpec });
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
      if (parsed.disc.key !== session.discKey || parsed.playlist !== session.playlistId || parsed.episodeSpec !== session.episodeSpec) {
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
        if (stored && stored.episodeSpec !== session.episodeSpec) {
          return json(res, 409, {
            error: 'other-episode-spec',
            message: `Subtitle choices are saved for episodes ${stored.episodeSpec}; saving here replaces them.`,
            episodeSpec: stored.episodeSpec,
          });
        }
      }
      const record = { ...parsed, savedAt: new Date().toISOString() };
      await store.write(record);
      json(res, 200, record);
    }),
  ],
];
