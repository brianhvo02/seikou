import type { TitleKind } from '@seikou/nas/nas-api';

export type NasRoute =
  | { kind: 'library'; shelf: TitleKind | null; q: string }
  | { kind: 'title'; titleId: string }
  | { kind: 'season'; titleId: string; seasonKey: string }
  | { kind: 'extras'; titleId: string }
  | { kind: 'folders'; path: string }
  | { kind: 'unsorted' }
  | { kind: 'hidden' }
  | { kind: 'settings' }
  /** An artist's page on the Music shelf, by the artist's grouping id. */
  | { kind: 'artist'; artistId: string }
  /** `resume`: from a Continue watching card, which resumes the place without asking (`&resume=1`). */
  | { kind: 'play'; discKey: string; playlistId: string | null; timeS: number | null; resume: boolean }
  /** The Encodes tab: the encoded episodes' shows, filtered by `q`. */
  | { kind: 'encodes'; q: string }
  /** An encodes show, by its root AniList id (which can change once the chain has loaded: docs/known-issues.md). */
  | { kind: 'encodeShow'; showId: string }
  /** An encoded episode, `<anilistId>-<episode>`, from `timeS` when given; `resume` as for `play`. */
  | { kind: 'encodePlay'; encodeId: string; timeS: number | null; resume: boolean };

/** The Encodes tab's routes. */
export type EncodesRoute = Extract<NasRoute, { kind: 'encodes' | 'encodeShow' | 'encodePlay' }>;

export function isEncodesRoute(route: NasRoute | null): route is EncodesRoute {
  return route !== null && (route.kind === 'encodes' || route.kind === 'encodeShow' || route.kind === 'encodePlay');
}

const SHELVES: readonly string[] = ['series', 'movie', 'music'];
const LIBRARY: NasRoute = { kind: 'library', shelf: null, q: '' };
const ENCODES: NasRoute = { kind: 'encodes', q: '' };

function shelfOf(value: string | null): TitleKind | null {
  return value !== null && SHELVES.includes(value) ? (value as TitleKind) : null;
}

function timeOf(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Math.floor(Number(value));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** The route a URL names; null when it is not under /nas. */
export function parseNasRoute(url: URL): NasRoute | null {
  const raw = url.pathname.split('/');
  if (raw[0] !== '' || raw[1] !== 'nas') return null;
  let seg: string[];
  try {
    seg = raw.slice(2).map(decodeURIComponent);
  } catch {
    return LIBRARY;
  }
  if (seg.length > 0 && seg[seg.length - 1] === '') seg.pop();
  const params = url.searchParams;
  const [head, a, b, c] = seg;
  if (seg.length === 0) {
    return { kind: 'library', shelf: shelfOf(params.get('shelf')), q: params.get('q') ?? '' };
  }
  if (head === 'title' && a) {
    if (seg.length === 2) return { kind: 'title', titleId: a };
    if (seg.length === 3 && b === 'extras') return { kind: 'extras', titleId: a };
    if (seg.length === 4 && b === 'season' && c) return { kind: 'season', titleId: a, seasonKey: c };
  } else if (head === 'folders') {
    return { kind: 'folders', path: seg.slice(1).join('/') };
  } else if (seg.length === 1 && (head === 'unsorted' || head === 'hidden' || head === 'settings')) {
    return { kind: head };
  } else if (head === 'artist' && a && seg.length === 2) {
    return { kind: 'artist', artistId: a };
  } else if (head === 'encodes') {
    if (seg.length === 1) return { kind: 'encodes', q: params.get('q') ?? '' };
    if (seg.length === 3 && a === 'show' && b) return { kind: 'encodeShow', showId: b };
    if (seg.length === 3 && a === 'play' && b) return { kind: 'encodePlay', encodeId: b, timeS: timeOf(params.get('t')), resume: params.get('resume') === '1' };
    return ENCODES;
  } else if (head === 'play' && a && seg.length === 2) {
    return { kind: 'play', discKey: a, playlistId: params.get('pl') || null, timeS: timeOf(params.get('t')), resume: params.get('resume') === '1' };
  }
  return LIBRARY;
}

const enc = (s: string): string => encodeURIComponent(s);

/** Path and search for a route, without an origin. */
export function nasRoutePath(route: NasRoute): string {
  switch (route.kind) {
    case 'library': {
      const p = new URLSearchParams();
      if (route.shelf) p.set('shelf', route.shelf);
      if (route.q) p.set('q', route.q);
      const s = p.toString();
      return s ? `/nas?${s}` : '/nas';
    }
    case 'title':
      return `/nas/title/${enc(route.titleId)}`;
    case 'season':
      return `/nas/title/${enc(route.titleId)}/season/${enc(route.seasonKey)}`;
    case 'extras':
      return `/nas/title/${enc(route.titleId)}/extras`;
    case 'folders':
      return route.path === '' ? '/nas/folders' : `/nas/folders/${route.path.split('/').map(enc).join('/')}`;
    case 'unsorted':
    case 'hidden':
    case 'settings':
      return `/nas/${route.kind}`;
    case 'artist':
      return `/nas/artist/${enc(route.artistId)}`;
    case 'play': {
      const p = new URLSearchParams();
      if (route.playlistId) p.set('pl', route.playlistId);
      if (route.timeS !== null) p.set('t', String(Math.floor(route.timeS)));
      if (route.resume) p.set('resume', '1');
      const s = p.toString();
      return `/nas/play/${enc(route.discKey)}${s ? `?${s}` : ''}`;
    }
    case 'encodes':
      return route.q ? `/nas/encodes?${new URLSearchParams({ q: route.q }).toString()}` : '/nas/encodes';
    case 'encodeShow':
      return `/nas/encodes/show/${enc(route.showId)}`;
    case 'encodePlay': {
      const p = new URLSearchParams();
      if (route.timeS !== null) p.set('t', String(Math.floor(route.timeS)));
      if (route.resume) p.set('resume', '1');
      const s = p.toString();
      return `/nas/encodes/play/${enc(route.encodeId)}${s ? `?${s}` : ''}`;
    }
  }
}

/**
 * A season's key in the address bar: the text after `<titleId>#` for the title's own seasons (`s2`, `discs`), else the
 * whole id, because an AniList series' seasons are its member entries (`<member id>#season`) and share that text.
 */
export function seasonKeyOf(titleId: string, seasonId: string): string {
  const own = `${titleId}#`;
  return seasonId.startsWith(own) ? seasonId.slice(own.length) : seasonId;
}

export function seasonIdOf(titleId: string, seasonKey: string): string {
  return seasonKey.includes('#') ? seasonKey : `${titleId}#${seasonKey}`;
}
