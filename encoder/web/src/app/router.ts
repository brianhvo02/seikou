// SPDX-License-Identifier: LGPL-3.0-or-later
import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactElement } from 'react';

// The app's client-side routes: a pure parse and build pair over the address, and the history plumbing the pages use.

/** The Library's views: the NAS's shows, the NAS's discs by folder, the discs on this Mac. */
export type LibraryView = 'shows' | 'folder' | 'mac';

/** A season page a disc or Episodes page was opened from, to go back to once the disc is checked. */
export interface SeasonRef {
  readonly titleId: string;
  readonly seasonId: string;
}

/** A page of the app. */
export type Route =
  /** `view` left out: By show when paired, else every disc. */
  | { readonly kind: 'library'; readonly view?: LibraryView }
  | { readonly kind: 'disc'; readonly discKey: string; readonly from?: SeasonRef }
  | { readonly kind: 'episodes'; readonly discKey: string; readonly playlistId: string; readonly from?: SeasonRef }
  /** A NAS show: its seasons and films. */
  | { readonly kind: 'show'; readonly titleId: string }
  /** A season (or film) of a NAS show, disc by disc. */
  | { readonly kind: 'season'; readonly titleId: string; readonly seasonId: string }
  /** The batch queue of a season's episodes still to encode. */
  | { readonly kind: 'seasonQueue'; readonly titleId: string; readonly seasonId: string }
  | { readonly kind: 'helper'; readonly sessionId: string }
  | { readonly kind: 'settings' }
  | { readonly kind: 'test'; readonly jobId: string }
  | { readonly kind: 'queue' }
  | { readonly kind: 'job'; readonly jobId: string }
  | {
      /** The dialog that queues an encode, opened with its disc, playlist and episode list. */
      readonly kind: 'queueNew';
      readonly discKey: string;
      readonly playlistId: string;
      readonly spec: string;
      /** Encode without the saved subtitle choices. */
      readonly noSubtitles: boolean;
      /** The id of the profile to start with, such as the one a test encode picked; the first profile when left out. */
      readonly profile?: string;
    }
  | { readonly kind: 'notFound' };

const enc = encodeURIComponent;

/** The season named by `?show=&season=`, or undefined. */
function seasonRefOf(q: URLSearchParams): SeasonRef | undefined {
  const titleId = q.get('show');
  const seasonId = q.get('season');
  return titleId && seasonId ? { titleId, seasonId } : undefined;
}

/**
 * The route of an address: `/[?view=shows|folder|mac]` the library, `/disc/<key>`, `/disc/<key>/<playlist>`
 * (episodes; both take `?show=&season=`, the season they were opened from), `/shows/<title>`,
 * `/shows/<title>/<season>`, `/shows/<title>/<season>/queue`, `/helper/<session>`, `/settings`, `/test/<job>`, `/queue`,
 * `/queue/new?disc=&playlist=&spec=[&noSubtitles=1][&profile=<id>]` and `/queue/<job>`. Anything else, and
 * `/queue/new` without its three parameters, is `notFound`.
 */
export function parseRoute(pathname: string, search = ''): Route {
  const parts = pathname.split('/').filter((p) => p !== '');
  const seg = (i: number): string => {
    try {
      return decodeURIComponent(parts[i]!);
    } catch {
      return parts[i]!;
    }
  };
  const [head, second, third] = parts;
  const q = new URLSearchParams(search);
  if (head === undefined) {
    const view = q.get('view');
    return view === 'shows' || view === 'folder' || view === 'mac' ? { kind: 'library', view } : { kind: 'library' };
  }
  const from = seasonRefOf(q);
  if (head === 'disc' && second !== undefined && parts.length === 2) return { kind: 'disc', discKey: seg(1), ...(from ? { from } : {}) };
  if (head === 'disc' && third !== undefined && parts.length === 3) return { kind: 'episodes', discKey: seg(1), playlistId: seg(2), ...(from ? { from } : {}) };
  if (head === 'shows' && parts.length === 2) return { kind: 'show', titleId: seg(1) };
  if (head === 'shows' && parts.length === 3) return { kind: 'season', titleId: seg(1), seasonId: seg(2) };
  if (head === 'shows' && parts.length === 4 && parts[3] === 'queue') return { kind: 'seasonQueue', titleId: seg(1), seasonId: seg(2) };
  if (head === 'helper' && parts.length === 2 && /^[0-9a-f]{16}$/.test(second!)) return { kind: 'helper', sessionId: second! };
  if (head === 'settings' && parts.length === 1) return { kind: 'settings' };
  if (head === 'test' && parts.length === 2) return { kind: 'test', jobId: seg(1) };
  if (head === 'queue') {
    if (parts.length === 1) return { kind: 'queue' };
    if (parts.length === 2 && second === 'new') {
      const discKey = q.get('disc');
      const playlistId = q.get('playlist');
      const spec = q.get('spec');
      const profile = q.get('profile');
      if (discKey && playlistId && spec) {
        return { kind: 'queueNew', discKey, playlistId, spec, noSubtitles: q.get('noSubtitles') === '1', ...(profile ? { profile } : {}) };
      }
      return { kind: 'notFound' };
    }
    if (parts.length === 2) return { kind: 'job', jobId: seg(1) };
  }
  return { kind: 'notFound' };
}

/** The path and query of `route`, with the run's token (`t`) taken from `search`, so an internal link keeps it. */
export function routeHref(route: Route, search = ''): string {
  const q = new URLSearchParams();
  const token = new URLSearchParams(search).get('t');
  if (token !== null) q.set('t', token);
  let path: string;
  const from = (ref: SeasonRef | undefined): void => {
    if (ref === undefined) return;
    q.set('show', ref.titleId);
    q.set('season', ref.seasonId);
  };
  switch (route.kind) {
    case 'library':
      path = '/';
      if (route.view !== undefined) q.set('view', route.view);
      break;
    case 'notFound':
      path = '/';
      break;
    case 'disc':
      path = `/disc/${enc(route.discKey)}`;
      from(route.from);
      break;
    case 'episodes':
      path = `/disc/${enc(route.discKey)}/${enc(route.playlistId)}`;
      from(route.from);
      break;
    case 'show':
      path = `/shows/${enc(route.titleId)}`;
      break;
    case 'season':
      path = `/shows/${enc(route.titleId)}/${enc(route.seasonId)}`;
      break;
    case 'seasonQueue':
      path = `/shows/${enc(route.titleId)}/${enc(route.seasonId)}/queue`;
      break;
    case 'helper':
      path = `/helper/${route.sessionId}`;
      break;
    case 'settings':
      path = '/settings';
      break;
    case 'test':
      path = `/test/${enc(route.jobId)}`;
      break;
    case 'queue':
      path = '/queue';
      break;
    case 'job':
      path = `/queue/${enc(route.jobId)}`;
      break;
    case 'queueNew':
      path = '/queue/new';
      q.set('disc', route.discKey);
      q.set('playlist', route.playlistId);
      q.set('spec', route.spec);
      if (route.noSubtitles) q.set('noSubtitles', '1');
      if (route.profile !== undefined) q.set('profile', route.profile);
      break;
  }
  const query = q.toString();
  return query === '' ? path : `${path}?${query}`;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

/** Goes to `href` (a path and query) with a new history entry and tells the pages. */
export function navigate(href: string): void {
  history.pushState(null, '', href);
  for (const listener of [...listeners]) listener();
}

const snapshot = (): string => location.pathname + location.search;

/** The route of the address bar, kept current as the user navigates, with the address's search string. */
export function useRoute(): { readonly route: Route; readonly search: string } {
  const address = useSyncExternalStore(subscribe, snapshot);
  const at = address.indexOf('?');
  const pathname = at === -1 ? address : address.slice(0, at);
  const search = at === -1 ? '' : address.slice(at);
  return { route: parseRoute(pathname, search), search };
}

/** Props of a `Link`: an anchor's, with the route it leads to instead of an `href`. */
export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** The page the link leads to; the run's token is carried along. */
  readonly to: Route;
}

/** An anchor to a route of the app that navigates without a page load (a modified click opens it the browser's way). */
export function Link({ to, onClick, ...rest }: LinkProps): ReactElement {
  const href = routeHref(to, location.search);
  const handle = (e: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return createElement('a', { ...rest, href, onClick: handle });
}
