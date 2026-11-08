// SPDX-License-Identifier: LGPL-3.0-or-later
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody } from '../../../server/src/http';
import { httpError, json, type RouteTable } from './http';
import { ProfileError, profilesOf } from './profiles';

// The settings profiles' routes.

/** Largest body a profile call reads. */
const MAX_BODY = 64 * 1024;

/** Answers a refusal with its status, code, message and, when there is one, the `field` at fault. */
function refuse(res: ServerResponse, e: ProfileError): void {
  json(res, e.status, e.field === undefined ? { error: e.code, message: e.message } : { error: e.code, message: e.message, field: e.field });
}

/** The profile id a path names, percent-decoded; a bad escape names no profile, so it is the same as an unknown id. */
function idOf(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

/** Reads a JSON body; undefined (after answering 413 or 400) when it is too large or not JSON. */
async function bodyOf(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const bytes = await readBody(req, MAX_BODY);
  if (bytes === null) {
    res.setHeader('Connection', 'close');
    httpError(res, 413, 'too-large', 'That request is too large.');
    return undefined;
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    httpError(res, 400, 'bad-request', 'The body must be JSON.');
    return undefined;
  }
}

/**
 * The profile routes:
 *
 *   GET /api/profiles          `{ profiles: Profile[] }`, the built-in `default` first
 *   POST /api/profiles         body `{ name, settings }`; 201 with the new `Profile`
 *   PUT /api/profiles/<id>     body `{ name, settings }`; the changed `Profile`; 404 `not-found`
 *   DELETE /api/profiles/<id>  `{ deleted: true }`; 404 `not-found`
 *
 * A bad value answers 400 `bad-setting` with `field` naming it (`name`, `crf`, `preset`, `filmGrain`, `opusBitrate`,
 * `namePattern`, `extraSvtArgs`, `pgs`, `web`); changing or deleting `default` answers 400 `built-in`; a damaged
 * `profiles.json` answers writes with 500 `profiles-unreadable`.
 */
export const profileRoutes: RouteTable = [
  ['GET', /^\/api\/profiles$/, async (_req, res, _match, app) => json(res, 200, { profiles: await profilesOf(app).list() })],
  [
    'POST',
    /^\/api\/profiles$/,
    async (req, res, _match, app) => {
      const body = await bodyOf(req, res);
      if (body === undefined) return;
      try {
        json(res, 201, await profilesOf(app).create(body));
      } catch (e) {
        if (e instanceof ProfileError) return refuse(res, e);
        throw e;
      }
    },
  ],
  [
    'PUT',
    /^\/api\/profiles\/([^/]+)$/,
    async (req, res, match, app) => {
      const body = await bodyOf(req, res);
      if (body === undefined) return;
      try {
        json(res, 200, await profilesOf(app).update(idOf(match[1]!), body));
      } catch (e) {
        if (e instanceof ProfileError) return refuse(res, e);
        throw e;
      }
    },
  ],
  [
    'DELETE',
    /^\/api\/profiles\/([^/]+)$/,
    async (_req, res, match, app) => {
      try {
        await profilesOf(app).remove(idOf(match[1]!));
        json(res, 200, { deleted: true });
      } catch (e) {
        if (e instanceof ProfileError) return refuse(res, e);
        throw e;
      }
    },
  ],
];
