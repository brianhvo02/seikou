// SPDX-License-Identifier: LGPL-3.0-or-later
import { readBody } from '../../../server/src/http';
import { parseRecord, RecordError, RecordStore } from '../subs/record';
import { prepareDisc } from './disc-routes';
import { httpError, json, type RouteTable } from './http';

// The saved record's half of the helper's API: the page saves what the user chose for the run's disc and playlist,
// and restores it on load.

/** Largest record body accepted; a record of a long series with every track listed is a few hundred kilobytes. */
const MAX_RECORD_BYTES = 2 * 1024 * 1024;

/**
 * The record routes:
 *
 *   GET /api/record   `{ record, missing }` for the run's disc and playlist. `record` is null when none was saved
 *                     (never a 404); `missing` lists, by release label, the cached files the record names that are
 *                     gone, so the page can say which release to fetch again. A record file on disk that is not
 *                     valid answers 200 with `record: null`, `missing: []` and
 *                     `error: { code: 'record-unreadable', message }`, so the page starts fresh; saving then
 *                     overwrites the broken file.
 *   PUT /api/record   body: a record. It is validated, its disc key, playlist and episode spec must equal the run's
 *                     (409 `session-mismatch`), `savedAt` is set to the server's clock, and the stored record is
 *                     answered. Errors: 400 `bad-record` with `message` and `path` (the JSON path of the first bad
 *                     field; a body that is not JSON has path `$`), 409 `session-mismatch`, 413 `too-large` over
 *                     2 MB (with `Connection: close`).
 */
export const recordRoutes: RouteTable = [
  [
    'GET',
    /^\/api\/record$/,
    async (_req, res, _match, ctx) => {
      const session = await prepareDisc(ctx);
      const store = new RecordStore(ctx.dataDir);
      let record;
      try {
        record = await store.read(session.discKey, session.playlistId);
      } catch (e) {
        if (!(e instanceof RecordError)) throw e;
        return json(res, 200, { record: null, missing: [], error: { code: 'record-unreadable', message: e.message } });
      }
      json(res, 200, { record, missing: record ? await store.missingFiles(record) : [] });
    },
  ],
  [
    'PUT',
    /^\/api\/record$/,
    async (req, res, _match, ctx) => {
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
      const session = await prepareDisc(ctx);
      if (parsed.disc.key !== session.discKey || parsed.playlist !== session.playlistId || parsed.episodeSpec !== session.episodeSpec) {
        return httpError(res, 409, 'session-mismatch', 'The record is for another disc, playlist or episode list.');
      }
      const record = { ...parsed, savedAt: new Date().toISOString() };
      await new RecordStore(ctx.dataDir).write(record);
      json(res, 200, record);
    },
  ],
];
