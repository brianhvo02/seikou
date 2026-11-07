import type { TitleMusic, TitleSummary } from '@seikou/nas/nas-api';
import { normalizeTitle, titleMatches } from '@seikou/nas/title-text';
import { japaneseOrder } from './title-index';

/**
 * The Music shelf as artists (spec §3, "artists first"): the shelf's release titles grouped by artist, each artist's
 * releases in sections, and the labels the tiles and cards show. Original code.
 */

/** The grouping id of Various artists, as the NAS sends it. */
export const VARIOUS_ID = 'various';
export const VARIOUS_NAME = 'Various artists';

/** One artist tile: its releases, and a synthetic title the alphabet bars index it by. */
export interface ArtistGroup {
  readonly id: string;
  readonly name: string;
  readonly otherName: string | null;
  readonly releases: readonly TitleSummary[];
  /** `names.romaji` is the headline name and `names.native` the other-script one, as `title-index.ts` reads a series. */
  readonly index: TitleSummary;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** A release's artist; a title without music info (an own title) is under Various artists. */
const artistOf = (t: TitleSummary): TitleMusic['artist'] => t.music?.artist ?? { id: VARIOUS_ID, name: VARIOUS_NAME, otherName: null };

/** The name a release card shows: the owner's rename, else the concert name of a concert (ruling R5), else the release title. */
export function releaseName(t: TitleSummary): string {
  const m = t.music;
  if (t.names.display !== null) return t.names.display;
  if (m?.kind === 'concert' && m.concertName) return m.concertName;
  return m?.title || (t.names.english ?? t.names.romaji ?? t.names.native ?? '');
}

/** The year a release card shows, from its date. */
export function releaseYear(t: TitleSummary): string | null {
  return /^\d{4}/.exec(t.music?.date ?? '')?.[0] ?? null;
}

/** Newest first, undated last; then A–Z by the card's name. */
function byDate(a: TitleSummary, b: TitleSummary): number {
  const da = a.music?.date ?? null;
  const db = b.music?.date ?? null;
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da < db ? 1 : -1;
  }
  return collator.compare(releaseName(a), releaseName(b));
}

/** The shelf's titles as artist tiles, A–Z by the headline name, Various artists last. */
export function groupArtists(titles: readonly TitleSummary[]): ArtistGroup[] {
  const byId = new Map<string, { artist: TitleMusic['artist']; releases: TitleSummary[] }>();
  for (const t of titles) {
    const artist = artistOf(t);
    const g = byId.get(artist.id);
    if (g) g.releases.push(t);
    else byId.set(artist.id, { artist, releases: [t] });
  }
  return [...byId.values()]
    .map(({ artist, releases }): ArtistGroup => ({
      id: artist.id,
      name: artist.name,
      otherName: artist.otherName,
      releases: releases.sort(byDate),
      index: {
        id: `artist:${artist.id}`,
        kind: 'music',
        names: { english: null, romaji: artist.name, native: artist.otherName, synonyms: [], display: null },
        poster: null,
        year: null,
        seasons: 0,
        discs: 0,
        addedAt: 0,
        own: false,
      },
    }))
    .sort((a, b) => (a.id === VARIOUS_ID) !== (b.id === VARIOUS_ID) ? (a.id === VARIOUS_ID ? 1 : -1) : collator.compare(a.name, b.name) || collator.compare(a.id, b.id));
}

/**
 * The artist tiles' index titles in the shown order, which the alphabet bars index: A–Z as `groupArtists` sorts them,
 * or 五十音 order, with Various artists last in both (spec §3).
 */
export function artistIndex(groups: readonly ArtistGroup[], order: 'en' | 'ja'): TitleSummary[] {
  const index = groups.map((g) => g.index);
  if (order === 'en') return index;
  const ja = japaneseOrder(index);
  const various = ja.filter((t) => t.id === `artist:${VARIOUS_ID}`);
  return [...ja.filter((t) => t.id !== `artist:${VARIOUS_ID}`), ...various];
}

/** An artist's releases in the page's sections, newest first within each: concerts, albums and singles, and the rest. */
export function artistSections(g: ArtistGroup): { readonly concerts: readonly TitleSummary[]; readonly albums: readonly TitleSummary[]; readonly other: readonly TitleSummary[] } {
  const sorted = [...g.releases].sort(byDate);
  const kind = (t: TitleSummary): string => t.music?.kind ?? 'other';
  return {
    concerts: sorted.filter((t) => kind(t) === 'concert'),
    albums: sorted.filter((t) => kind(t) === 'album' || kind(t) === 'single'),
    other: sorted.filter((t) => kind(t) === 'other'),
  };
}

/** Every name a release is found by. */
function releaseNames(t: TitleSummary): string[] {
  const { display, english, romaji, native, synonyms } = t.names;
  return [releaseName(t), t.music?.title ?? null, t.music?.concertName ?? null, display, english, romaji, native, ...synonyms].filter((n): n is string => n !== null && n !== '');
}

/** The artists matching `query` on their names (every form known) or a release's title, in the grid's order. */
export function searchArtists(groups: readonly ArtistGroup[], query: string): ArtistGroup[] {
  if (normalizeTitle(query) === '') return [];
  return groups.filter((g) => titleMatches(query, [g.name, ...(g.otherName ? [g.otherName] : []), ...g.releases.flatMap(releaseNames)]));
}

/** A tile's count: `1 release`, `N releases`. */
export function artistCount(g: ArtistGroup): string {
  const n = g.releases.length;
  return `${n} ${n === 1 ? 'release' : 'releases'}`;
}

/** The names the owner's Set artist picker suggests: every artist's, with Various artists last and always there. */
export function artistNames(groups: readonly ArtistGroup[]): string[] {
  return [...groups.filter((g) => g.id !== VARIOUS_ID).map((g) => g.name), VARIOUS_NAME];
}

/** What Set artist sends for a typed name: `various` for Various artists, null for a blank (back to the found artist). */
export function artistChoice(typed: string): string | null {
  const t = typed.trim();
  if (t === '') return null;
  return normalizeTitle(t) === normalizeTitle(VARIOUS_NAME) || t.toLowerCase() === VARIOUS_ID ? VARIOUS_ID : t;
}

/** Up to four posters for an artist's collage, newest release first. */
export function collagePosters(g: ArtistGroup): string[] {
  return g.releases.map((r) => r.poster).filter((p): p is string => p !== null).slice(0, 4);
}
