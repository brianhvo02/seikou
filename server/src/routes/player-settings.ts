// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Auth } from '../auth';
import { json, readBody } from '../http';
import type { Handler } from '../http';
import { isPlayerSettings, PLAYER_SETTINGS_LIMIT_BYTES } from '../player-settings-store';
import type { PlayerSettingsStore } from '../player-settings-store';
import { requestDevice } from './titles';

const ROUTE = '/api/me/player-settings';

/**
 * `GET` and `PUT /api/me/player-settings`: the token's own person's `PlayerSettings`. A `PUT` takes exactly the
 * settings' fields (400 for anything else, 413 past 4 KiB) and answers what it stored. Behind `requireToken`.
 */
export function playerSettingsRoutes(auth: Auth, store: PlayerSettingsStore): Handler {
  return async (req, url) => {
    if (url.pathname !== ROUTE) return null;
    if (req.method !== 'GET' && req.method !== 'PUT') return json(405, { error: 'method not allowed' }, { Allow: 'GET, PUT' });
    const device = requestDevice(auth, req.headers.authorization, url);
    if (!device) return json(401, { error: 'unauthorized' }, req.method === 'PUT' ? { Connection: 'close' } : {});
    if (req.method === 'GET') return json(200, store.get(device.personId), { 'Cache-Control': 'no-store' });
    if (Number(req.headers['content-length'] ?? 0) > PLAYER_SETTINGS_LIMIT_BYTES) return json(413, { error: 'body too large' }, { Connection: 'close' });
    const raw = await readBody(req, PLAYER_SETTINGS_LIMIT_BYTES);
    if (raw === null) return json(413, { error: 'body too large' }, { Connection: 'close' });
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return json(400, { error: 'bad request' });
    }
    if (!isPlayerSettings(body)) return json(400, { error: 'bad-settings' });
    store.put(device.personId, body);
    return json(200, store.get(device.personId));
  };
}
