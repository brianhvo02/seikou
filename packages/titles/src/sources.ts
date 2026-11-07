/** What a metadata source (AniList, TMDB) knows about one series or film. */

export type SourceName = 'anilist' | 'tmdb';

export interface EntryNames {
  readonly english: string | null;
  readonly romaji: string | null;
  readonly native: string | null;
  readonly synonyms: readonly string[];
}

export interface Entry {
  readonly source: SourceName;
  readonly id: string; // 'anilist:154587', 'tmdb-tv:65930', 'tmdb-movie:12345'
  readonly kind: 'series' | 'movie';
  readonly format: string | null; // AniList TV/TV_SHORT/MOVIE/OVA/ONA/SPECIAL
  readonly names: EntryNames;
  /** Animated: TMDB's Animation genre (16), null when TMDB gave no genres; always true on AniList. */
  readonly animation: boolean | null;
  readonly year: number | null;
  /**
   * When it started: AniList's startDate, TMDB's first-air or release date, as YYYYMMDD with 00 for an unknown month
   * or day. Optional: entries saved before it have none (M11).
   */
  readonly startDate?: number | null;
  readonly episodes: number | null;
  readonly runtimeMin: number | null;
  /** TMDB TV only, numbered from 1: season 0 (TMDB's "Specials") is left out. */
  readonly seasons: readonly { readonly number: number; readonly episodes: number; readonly runtimeMin: number | null }[];
  /** AniList only. `startDate` is AniList's FuzzyDateInt, YYYYMMDD with 00 for an unknown month or day. */
  readonly relations: readonly { readonly type: string; readonly id: string; readonly format: string | null; readonly startDate: number | null }[];
  readonly poster: { readonly small: string; readonly large: string } | null; // source URLs
  readonly banner: string | null;
}

export interface MetadataSource {
  /** `urgent` and `signal` are for the owner's lookups: see `PacedOptions`. */
  search(query: string, opts?: { year?: number; kind?: 'series' | 'movie'; urgent?: boolean; signal?: AbortSignal }): Promise<Entry[]>;
  entry(id: string): Promise<Entry | null>;
}

/** Network errors, 429 after retries, 5xx. */
export class SourceUnavailable extends Error {
  override name = 'SourceUnavailable';
}

/** Seconds from a Retry-After header as ms, or null when it is missing or a date. */
export function retryAfterMs(header: string | null): number | null {
  if (header === null || !/^\s*\d+(\.\d+)?\s*$/.test(header)) return null;
  return Math.round(Number(header) * 1000);
}

type Poster = NonNullable<Entry['poster']>;

/**
 * A poster stored before the sizes went up (2026-10-21) at the sizes asked for now: AniList's small and medium cover
 * files (its `medium` and `large`) become medium and large (`large` and `extraLarge`), TMDB's w185 and w500 become
 * w342 and w780. Each source names the size in the URL's path, so no lookup is needed; a poster already at the new
 * sizes, or from anywhere else, comes back as it is.
 */
export function sharperPoster(poster: Poster): Poster {
  const small = poster.small
    .replace(/^(https:\/\/s4\.anilist\.co\/file\/anilistcdn\/media\/[a-z]+\/cover\/)small\//, '$1medium/')
    .replace(/^(https:\/\/image\.tmdb\.org\/t\/p\/)w185\//, '$1w342/');
  const large = poster.large
    .replace(/^(https:\/\/s4\.anilist\.co\/file\/anilistcdn\/media\/[a-z]+\/cover\/)medium\//, '$1large/')
    .replace(/^(https:\/\/image\.tmdb\.org\/t\/p\/)w500\//, '$1w780/');
  return small === poster.small && large === poster.large ? poster : { small, large };
}

/** `entry` with its poster at the sizes asked for now (`sharperPoster`); the same object when nothing changes. */
export function withSharperPoster(entry: Entry): Entry {
  if (entry.poster === null) return entry;
  const poster = sharperPoster(entry.poster);
  return poster === entry.poster ? entry : { ...entry, poster };
}

/** The User-Agent of MusicBrainz and Discogs requests; both ask to be able to reach whoever runs the client. */
export function lookupUserAgent(contact: string | null): string {
  return `seikou/1.0 (https://github.com/brianhvo02/seikou${contact === null ? '' : `; ${contact}`})`;
}
