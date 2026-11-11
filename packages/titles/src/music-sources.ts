/**
 * What a music source (MusicBrainz, Discogs) knows about one release, found by catalogue number.
 * Original code.
 */
import type { SourceUnavailable } from './sources';

/** An artist of a music release. */
export interface MusicArtist {
  /** The source's id for the artist (a MusicBrainz id, or `discogs-artist:` and Discogs's number). */
  readonly id: string;
  readonly name: string;
  /** The name as sorted in a list, else null. */
  readonly sortName: string | null;
  /** Other names of the artist; `locale` is the language a name belongs to and `primary` marks the one the source prefers for it. */
  readonly aliases: readonly { readonly name: string; readonly locale: string | null; readonly primary: boolean }[];
}

/** A release a music source found for a catalogue number. */
export interface MusicRelease {
  readonly source: 'musicbrainz' | 'discogs';
  /** The source's id for the release (a MusicBrainz id, or `discogs:` and Discogs's number). */
  readonly id: string;
  readonly title: string;
  /** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, as precise as the source is; else null. */
  readonly date: string | null;
  readonly artists: readonly MusicArtist[];
  /** MusicBrainz's release-group type (`Album`, `Single`, `EP`, …), else null. */
  readonly primaryType: string | null;
  /** MusicBrainz's secondary types (`Live`, `Compilation`, …). */
  readonly secondaryTypes: readonly string[];
  /** True when the source marks the release as a live recording. */
  readonly live: boolean;
  /** Cover image URLs at two sizes, else null. */
  readonly cover: { readonly small: string; readonly large: string } | null;
}

/** A source of music releases, found by catalogue number. */
export interface MusicSource {
  /** Throws `SourceUnavailable` (a network error, 5xx or rate limiting); null is a miss. */
  byCatalogue(catalogueNumber: string): Promise<MusicRelease | null>;
}

export type { SourceUnavailable };

/** MusicBrainz's "Various Artists" id. */
export const VARIOUS_ARTISTS_MBID = '89ad4ac3-39f7-470e-963a-56509c546377';

/** A catalogue number with case, spaces and punctuation ignored, for comparing. */
export const normalizeCatalogue = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** A neutral description of one exact catalogue hit, for `chooseRelease`. */
export interface ReleaseCandidate<T> {
  readonly item: T;
  readonly bluray: boolean;
  readonly japan: boolean;
  /** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`; null when unknown. */
  readonly date: string | null;
  /** The first credited artist's identity (an id or a name); null when none. */
  readonly artistKey: string | null;
}

/**
 * The release choice rule: among exact catalogue hits prefer one with a Blu-ray medium, then one from Japan, then the
 * earliest date (an unknown date last; ties keep the source's order). Hits whose first artists disagree are a miss.
 */
export function chooseRelease<T>(candidates: readonly ReleaseCandidate<T>[]): T | null {
  if (candidates.length === 0) return null;
  const artists = new Set(candidates.flatMap((c) => (c.artistKey === null ? [] : [c.artistKey])));
  if (artists.size > 1) return null;
  const rank = (c: ReleaseCandidate<T>): [number, number, string] => [c.bluray ? 0 : 1, c.japan ? 0 : 1, c.date ?? '￿'];
  let best = candidates[0]!;
  for (const c of candidates.slice(1)) {
    const a = rank(c);
    const b = rank(best);
    if (a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]) best = c;
  }
  return best.item;
}

/** A source answering from a table keyed by catalogue number (compared ignoring case and spaces), for tests. */
export function fixtureMusicSource(recorded: Readonly<Record<string, MusicRelease>>): MusicSource {
  const table = new Map(Object.entries(recorded).map(([k, v]) => [normalizeCatalogue(k), v]));
  return { byCatalogue: (catalogueNumber) => Promise.resolve(table.get(normalizeCatalogue(catalogueNumber)) ?? null) };
}
