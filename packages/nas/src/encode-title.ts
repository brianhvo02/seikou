// SPDX-License-Identifier: LGPL-3.0-or-later

/**
 * The title an encoded episode belongs to: an AniList entry, a TMDB series' season, a TMDB film, or one of the
 * owner's own titles (by its uuid, lower-case with dashes, with a season or none).
 */
export type EncodeTitle =
  | { readonly source: 'anilist'; readonly anilistId: number }
  | { readonly source: 'tmdb-tv'; readonly tmdbId: number; readonly season: number }
  | { readonly source: 'tmdb-movie'; readonly tmdbId: number }
  | { readonly source: 'own'; readonly ownId: string; readonly season: number | null };

const N = '[1-9]\\d{0,14}';
const WHOLE = new RegExp(`^${N}$`);
const ANILIST_PART = WHOLE;
const TV_PART = new RegExp(`^tv(${N})s(${N})$`);
const MOVIE_PART = new RegExp(`^mv(${N})$`);
const OWN_PART = new RegExp(`^own([0-9a-f]{32})(?:s(${N}))?$`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TMDB_TAG = new RegExp(`^tmdb-(tv|movie):(${N})$`);

const withDashes = (hex: string): string =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/**
 * The title's part of encode ids, place keys and folders: `<anilistId>`, `tv<tmdbId>s<season>`, `mv<tmdbId>`, or
 * `own<32 hex>` (the uuid without dashes) with `s<season>` when it has a season.
 */
export function titlePart(t: EncodeTitle): string {
  switch (t.source) {
    case 'anilist':
      return String(t.anilistId);
    case 'tmdb-tv':
      return `tv${t.tmdbId}s${t.season}`;
    case 'tmdb-movie':
      return `mv${t.tmdbId}`;
    case 'own':
      return `own${t.ownId.replaceAll('-', '')}${t.season === null ? '' : `s${t.season}`}`;
  }
}

/**
 * The id of the encodes show a title belongs to: `tv<tmdbId>` (a TMDB series' seasons share it), `mv<tmdbId>`, or
 * `own<32 hex>` (an own title's seasons share it). Null for an AniList entry, whose show id is the root of its
 * relation chain, which only the catalogue knows.
 */
export function showIdOfTitle(t: EncodeTitle): string | null {
  switch (t.source) {
    case 'anilist':
      return null;
    case 'tmdb-tv':
      return `tv${t.tmdbId}`;
    case 'tmdb-movie':
      return `mv${t.tmdbId}`;
    case 'own':
      return `own${t.ownId.replaceAll('-', '')}`;
  }
}

/** The title a title part names; null for anything that `titlePart` would not write. */
export function parseTitlePart(s: string): EncodeTitle | null {
  if (ANILIST_PART.test(s)) return { source: 'anilist', anilistId: Number(s) };
  const tv = TV_PART.exec(s);
  if (tv) return { source: 'tmdb-tv', tmdbId: Number(tv[1]), season: Number(tv[2]) };
  const movie = MOVIE_PART.exec(s);
  if (movie) return { source: 'tmdb-movie', tmdbId: Number(movie[1]) };
  const own = OWN_PART.exec(s);
  if (own) return { source: 'own', ownId: withDashes(own[1]!), season: own[2] === undefined ? null : Number(own[2]) };
  return null;
}

/** Whether two titles are the same (same source and every field equal). */
export function sameTitle(a: EncodeTitle, b: EncodeTitle): boolean {
  return titlePart(a) === titlePart(b);
}

/** The NAS title id the show is filed under: 'anilist:<n>', 'tmdb-tv:<n>', 'tmdb-movie:<n>', 'own:<uuid>'. */
export function nasTitleId(t: EncodeTitle): string {
  switch (t.source) {
    case 'anilist':
      return `anilist:${t.anilistId}`;
    case 'tmdb-tv':
      return `tmdb-tv:${t.tmdbId}`;
    case 'tmdb-movie':
      return `tmdb-movie:${t.tmdbId}`;
    case 'own':
      return `own:${t.ownId}`;
  }
}

/** The tags that name the title (not EPISODE): { ANILIST_ID } or { SEIKOU_TITLE, SEASON? }. */
export function titleTags(t: EncodeTitle): Record<string, string> {
  switch (t.source) {
    case 'anilist':
      return { ANILIST_ID: String(t.anilistId) };
    case 'tmdb-tv':
      return { SEIKOU_TITLE: nasTitleId(t), SEASON: String(t.season) };
    case 'tmdb-movie':
      return { SEIKOU_TITLE: nasTitleId(t) };
    case 'own':
      return t.season === null ? { SEIKOU_TITLE: nasTitleId(t) } : { SEIKOU_TITLE: nasTitleId(t), SEASON: String(t.season) };
  }
}

/** A tag's whole number of 1 or more (surrounding blanks allowed); undefined when the tag is absent or blank. */
function wholeTag(text: string | undefined): number | null | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return WHOLE.test(trimmed) ? Number(trimmed) : null;
}

/**
 * The title the tags name, or null (malformed, or a tmdb-tv without SEASON). ANILIST_ID wins: when it is present it
 * alone decides, so a malformed ANILIST_ID is null whatever SEIKOU_TITLE says. SEASON is required for `tmdb-tv`,
 * optional for `own` and ignored for `tmdb-movie`; a malformed SEASON makes a series or own title null.
 */
export function titleFromTags(tags: Readonly<Record<string, string>>): EncodeTitle | null {
  const anilistId = wholeTag(tags.ANILIST_ID);
  if (anilistId !== undefined) return anilistId === null ? null : { source: 'anilist', anilistId };
  const id = tags.SEIKOU_TITLE?.trim();
  if (!id) return null;
  const season = wholeTag(tags.SEASON);
  const tmdb = TMDB_TAG.exec(id);
  if (tmdb) {
    const tmdbId = Number(tmdb[2]);
    if (tmdb[1] === 'movie') return { source: 'tmdb-movie', tmdbId };
    return typeof season === 'number' ? { source: 'tmdb-tv', tmdbId, season } : null;
  }
  if (id.startsWith('own:') && UUID.test(id.slice(4))) {
    if (season === null) return null;
    return { source: 'own', ownId: id.slice(4), season: season ?? null };
  }
  return null;
}
