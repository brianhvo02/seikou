/**
 * The bundled TheDiscDB index (server/data/discdb-index.json, built by scripts/build-discdb-index.ts from
 * TheDiscDb/data, MIT): a disc's ContentHash to its title and the episodes its playlists hold.
 */
import { readFileSync } from 'node:fs';

export interface DiscDbHit {
  readonly title: string;
  readonly year: number | null;
  readonly kind: 'series' | 'movie';
  readonly tmdbId: string | null;
  readonly season: number | null;
  readonly episodes: readonly { readonly playlist: string; readonly season: number; readonly episode: number; readonly name: string | null }[];
}

/** The index file's shape. `source` records where and from which commit it was built. */
export interface DiscDbIndex {
  readonly source: { readonly repo: string; readonly commit: string; readonly license: string };
  readonly discs: Readonly<Record<string, DiscDbHit>>;
}

/**
 * Reads the index file. Throws (synchronously) when the file is missing, isn't JSON or isn't an index;
 * the caller decides what that means (Task 8: no TheDiscDB, logged once).
 */
export function loadDiscDb(file: string): { lookup(fingerprint: string): DiscDbHit | null } {
  const index = JSON.parse(readFileSync(file, 'utf8')) as Partial<DiscDbIndex>;
  if (!index.discs || typeof index.discs !== 'object') throw new Error(`${file}: not a TheDiscDB index`);
  const discs = new Map(Object.entries(index.discs));
  return { lookup: (fingerprint) => discs.get(fingerprint.toUpperCase()) ?? null };
}

/** MD5 of nothing: the ContentHash of a disc without m2ts files. */
const EMPTY_HASH = 'D41D8CD98F00B204E9800998ECF8427E';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const int = (v: unknown): number | null => {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  return /^\d+$/.test(s) ? Number(s) : null;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A title's kind from its `metadata.json` `Type`, or null for anything but `Series` and `Movie`. */
export function discDbKind(metadata: unknown): DiscDbHit['kind'] | null {
  const type = obj(metadata).Type;
  return type === 'Series' ? 'series' : type === 'Movie' ? 'movie' : null;
}

/**
 * One TheDiscDb/data disc record (`discNN.json`) with its title's `metadata.json`, as an index entry,
 * or null for a DVD, a disc without a hash, or a title without a name or with a `Type` other than `Series`
 * or `Movie`. The name is `Title` (the clean name), not `FullTitle` (which often adds a year or is the
 * original-language title). Both inputs are untrusted JSON.
 */
export function indexDisc(disc: unknown, metadata: unknown): { hash: string; hit: DiscDbHit } | null {
  const d = obj(disc);
  const m = obj(metadata);
  const hash = str(d.ContentHash)?.toUpperCase() ?? null;
  const title = str(m.Title) ?? str(m.FullTitle);
  const kind = discDbKind(m);
  if (!hash || !/^[0-9A-F]{32}$/.test(hash) || hash === EMPTY_HASH || !title || !kind) return null;
  if (str(d.Format)?.toUpperCase() === 'DVD') return null;
  const episodes: DiscDbHit['episodes'][number][] = [];
  for (const t of Array.isArray(d.Titles) ? d.Titles : []) {
    const item = obj(obj(t).Item);
    const playlist = /^(\d{5})\.mpls$/i.exec(str(obj(t).SourceFile) ?? '')?.[1];
    const season = int(item.Season);
    const episode = int(item.Episode);
    if (item.Type !== 'Episode' || !playlist || season === null || episode === null) continue;
    episodes.push({ playlist, season, episode, name: str(item.Title) });
  }
  const seasons = new Set(episodes.map((e) => e.season));
  const tmdb = obj(m.ExternalIds).Tmdb;
  return {
    hash,
    hit: {
      title,
      year: int(m.Year),
      kind,
      tmdbId: str(typeof tmdb === 'number' ? String(tmdb) : tmdb),
      season: seasons.size === 1 ? [...seasons][0]! : null,
      episodes,
    },
  };
}

/**
 * One entry per hash. Records that share a hash and name the same title (kind, TMDB id and title) keep the
 * first; a hash whose records name different titles is left out, since it can't say which one a disc is.
 */
export function mergeIndex(records: readonly { hash: string; hit: DiscDbHit }[]): { discs: Record<string, DiscDbHit>; conflicts: number } {
  const discs = new Map<string, DiscDbHit | null>();
  const same = (a: DiscDbHit, b: DiscDbHit): boolean => a.kind === b.kind && a.tmdbId === b.tmdbId && a.title === b.title;
  for (const { hash, hit } of records) {
    const prev = discs.get(hash);
    if (prev === undefined) discs.set(hash, hit);
    else if (prev !== null && !same(prev, hit)) discs.set(hash, null);
  }
  const out: Record<string, DiscDbHit> = {};
  let conflicts = 0;
  for (const [hash, hit] of discs) {
    if (hit) out[hash] = hit;
    else conflicts++;
  }
  return { discs: out, conflicts };
}
