/** The CORS rules the NAS server and the rendezvous Worker share; pure, so either runtime can use it. */

/**
 * Origins the player is served from: production, Pages previews and local dev/preview. `bluray-web.pages.dev` is the
 * site's old address, kept while devices still paired there move to `bluray.pages.dev` (see docs/roadmap.md).
 */
const ALLOWED_ORIGIN = /^(https:\/\/([a-z0-9-]+\.)?bluray(-web)?\.pages\.dev|http:\/\/localhost:(5173|4173))$/;

/** CORS headers for a response to `origin`; every response carries `Vary` and CORP, and exposes `ETag` (the BD-J store's) and `Retry-After` (a level read the NAS is still encoding). */
export function corsHeaders(origin: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Expose-Headers': 'ETag, Retry-After',
  };
  if (origin != null && ALLOWED_ORIGIN.test(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

/** How long a browser may cache a preflight answer, in seconds. */
export const PREFLIGHT_MAX_AGE = '600';
