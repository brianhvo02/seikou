import { json } from '../http';
import type { Handler } from '../http';
import type { Library } from '../library';

/** `GET /api/library?path=<root-relative folder>`; `appHandlers` puts the token guard in front of it. Any paired device may call it; an unknown folder is 404 `unknown folder`. */
export function libraryRoute(library: Library): Handler {
  return async (req, url) => {
    if (url.pathname !== '/api/library' || req.method !== 'GET') return null;
    const listing = library.list(url.searchParams.get('path') ?? '');
    if (!listing) return json(404, { error: 'unknown folder' });
    return json(200, { ...listing, scanning: library.scanning });
  };
}
