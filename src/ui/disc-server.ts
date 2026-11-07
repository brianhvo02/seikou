/**
 * Discs served by the development disc server (tools/disc-server), which speaks the NAS server's disc API: the same
 * `RemoteDiscSpec` (manifest with inlined metadata, then range reads) the NAS screens open. The page learns about a
 * disc from its own URL: `?disc=<disc API base>&token=<token>` names one disc (`…/api/discs/<id>/`), `?token=<token>`
 * alone lists the discs of the server the page was loaded from (the server serves the built player too). Both name the
 * page's own origin only.
 */

import type { RemoteDiscSpec } from '@seikou/engine/disc/disc-spec';
import type { DiscManifest, LibraryListing } from '@seikou/nas/nas-api';

export interface ServerLink {
  readonly token: string;
  /** The disc's API base (`…/api/discs/<id>/`, ending with '/'), or null to offer every disc in the list. */
  readonly disc: string | null;
  /** The server's API base (`…/api/`). */
  readonly api: string;
}

export interface ServerDisc {
  readonly name: string;
  /** The disc's API base, ending with '/'. */
  readonly base: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A request to the disc server that has not answered after this long has failed (a stalled server must not hang the page). */
export const SERVER_REQUEST_TIMEOUT_MS = 20_000;

const DISC_PATH = /^(.*\/api\/)discs\/([^/]+)\/?$/;

/**
 * The link in a page URL, or null. A `disc` URL on another origin than the page is ignored: links come from the disc
 * server that served the page, so the token only ever goes back to it, and a `?disc=` link to the production player
 * cannot make it fetch from (or send a token to) a server named in the link.
 */
export function serverLinkFromLocation(href: string): ServerLink | null {
  const page = new URL(href);
  const token = page.searchParams.get('token');
  if (!token) return null;
  const discParam = page.searchParams.get('disc');
  if (discParam === null) return { token, disc: null, api: `${page.origin}/api/` };
  let disc: URL;
  try {
    disc = new URL(discParam, page);
  } catch {
    return null;
  }
  if (disc.protocol !== 'https:' && disc.protocol !== 'http:') return null;
  if (disc.origin !== page.origin) return null;
  const m = DISC_PATH.exec(disc.pathname);
  if (!m) return null;
  return { token, disc: `${disc.origin}${m[1]}discs/${m[2]}/`, api: `${disc.origin}${m[1]}` };
}

/** A GET with the token as `Authorization: Bearer` (as NasClient sends it), cut off after SERVER_REQUEST_TIMEOUT_MS. */
async function get(url: string, token: string, fetchFn: FetchLike, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(SERVER_REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Could not reach the disc server for ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`The disc server answered ${response.status} for ${what}${response.status === 401 ? ' (the token is from an earlier run of the server)' : ''}.`);
  }
  return response;
}

/** The discs a link offers, named from the server's library listing. A linked disc is offered even when the list fails. */
export async function listServerDiscs(link: ServerLink, fetchFn: FetchLike = (url, init) => fetch(url, init)): Promise<ServerDisc[]> {
  const listed = get(`${link.api}library?path=`, link.token, fetchFn, 'the disc list').then(async (response) => {
    const body = (await response.json()) as LibraryListing;
    return body.discs.map((d) => ({ name: d.name, base: `${link.api}discs/${encodeURIComponent(d.id)}/` }));
  });
  if (link.disc === null) return listed;
  const disc = link.disc;
  const id = decodeURIComponent(disc.slice(disc.lastIndexOf('/', disc.length - 2) + 1, -1));
  const named = await listed.catch(() => [] as ServerDisc[]);
  return [{ name: named.find((d) => d.base === disc)?.name ?? id, base: disc }];
}

/** What the engine opens for a served disc: its manifest (`GET <base>manifest`) with the base and token. */
export async function serverDiscSpec(disc: ServerDisc, token: string, fetchFn: FetchLike = (url, init) => fetch(url, init)): Promise<RemoteDiscSpec> {
  const response = await get(`${disc.base}manifest`, token, fetchFn, `${disc.name}'s manifest`);
  const manifest = (await response.json()) as DiscManifest;
  if (!Array.isArray(manifest.files) || typeof manifest.inline !== 'object' || manifest.inline === null) {
    throw new Error(`The disc server sent a bad manifest for ${disc.name}.`);
  }
  return { kind: 'remote', base: disc.base, token, manifest };
}
