// SPDX-License-Identifier: LGPL-3.0-or-later
import type { DiscManifest } from '@seikou/nas/nas-api';
import type { Auth } from '../auth';
import type { EncodeIndex } from '../encodes/index-store';
import { json } from '../http';
import type { Handler, Response } from '../http';
import { serveFile } from './discs';
import { requestDevice } from './titles';
import type { TitleLibrary } from './titles';

const ROUTE = /^\/api\/encodes\/(?:(status)|([1-9]\d*-[1-9]\d*)(?:\/(manifest|files\/EPISODE\.MKV))?)$/;
/** A request that arrives during the first scan waits for it this long, then gets 503 `indexing`. */
export const FIRST_SCAN_WAIT_MS = 30_000;

const notFound = (): Response => json(404, { error: 'not found' });

/**
 * The encoded episodes (`ENCODES_DIR`), behind the token guard and the title gate (a guest behind a closed gate gets
 * 404, as from the title routes):
 * `GET /api/encodes/status` (`{ configured, count }`), `GET /api/encodes/<id>` (the entry without its server path),
 * `GET /api/encodes/<id>/manifest` (a `DiscManifest` with the one file `EPISODE.MKV`) and
 * `GET|HEAD /api/encodes/<id>/files/EPISODE.MKV` (the file or a `Range` of it). With that base the engine reads an
 * encode as it reads a NAS disc. Without `encodes` only `status` answers, with `configured: false`.
 */
export function encodeRoutes(auth: Auth, encodes: EncodeIndex | undefined, titles: TitleLibrary | undefined, waitMs = FIRST_SCAN_WAIT_MS): Handler {
  return async (req, url) => {
    const match = ROUTE.exec(url.pathname);
    if (!match || (req.method !== 'GET' && req.method !== 'HEAD')) return null;
    const device = requestDevice(auth, req.headers.authorization, url);
    if (!device) return json(401, { error: 'unauthorized' });
    if (titles && !device.owner && titles.service.gate() !== 'everyone') return notFound();
    const [, status, id, action] = match;
    if (status) {
      if (!encodes) return json(200, { configured: false, count: 0 });
      if (!(await encodes.ready(waitMs))) return json(200, { configured: true, scanning: true });
      const state = encodes.state();
      return json(200, { configured: true, count: encodes.list().length, ...(state.rootMissing ? { rootMissing: true } : {}), ...(state.scanError !== null ? { scanError: state.scanError } : {}) });
    }
    if (!encodes) return notFound();
    if (!(await encodes.ready(waitMs))) return json(503, { error: 'indexing' }, { 'Retry-After': '5' });
    const entry = encodes.get(id!);
    if (!entry) return notFound();
    if (action === undefined) {
      const { path: _path, ...detail } = entry;
      return json(200, detail);
    }
    if (action === 'manifest') {
      const manifest: DiscManifest = { discId: entry.id, name: entry.episodeTitle ?? `Episode ${entry.episode}`, files: [{ path: 'EPISODE.MKV', size: entry.size }], inline: {} };
      return json(200, manifest);
    }
    return serveFile(req, entry.path);
  };
}
