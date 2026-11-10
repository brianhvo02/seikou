/**
 * The title service: matches new and changed discs after every library scan, keeps the last catalogue (and what built
 * it) in `<dataDir>/metadata.json` so a restart serves it with no network access, and refreshes on a schedule: Unsorted
 * is retried weekly, entries older than 30 days are fetched again monthly. After matching it looks music releases up by
 * catalogue number (MusicBrainz, then Discogs) and finds their folder covers, on the same schedule. Original code.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AnilistPlace, TitleSummary } from '@seikou/nas/nas-api';
import { nasTitleId } from '@seikou/nas/encode-title';
import type { EncodeTitle } from '@seikou/nas/encode-title';
import type { EncodeNames } from '@seikou/titles/encode-catalogue';
import { normalizeTitle } from '@seikou/nas/title-text';
import { isCode, replaceAtomically } from '@seikou/titles/atomic-json';
import type { LibraryRoot } from '../config';
import type { Library } from '../library';
import type { ArtCache } from '@seikou/titles/art';
import { anilistSeries, artIdOf, buildCatalogue, byDiscPath, isAnilistTv, musicGroupOf } from '@seikou/titles/catalogue';
import type { Catalogue, FolderCover } from '@seikou/titles/catalogue';
import { loadDiscDb } from '@seikou/titles/discdb';
import type { DiscDbHit } from '@seikou/titles/discdb';
import type { DiscEvidence } from './evidence';
import { CIRCUIT_BREAKER, groupKey, MATCH_RULES_VERSION, matchDiscs } from '@seikou/titles/match';
import type { DiscMatch, MatchResult } from '@seikou/titles/match';
import type { MusicRelease, MusicSource } from '@seikou/titles/music-sources';
import type { OwnerStore } from '@seikou/titles/owner-store';
import { parseName } from '@seikou/titles/parse-name';
import { SourceUnavailable, withSharperPoster } from '@seikou/titles/sources';
import type { Entry, MetadataSource } from '@seikou/titles/sources';

const DAY_MS = 86_400_000;
const RETRY_UNSORTED_MS = 7 * DAY_MS;
const REFRESH_MS = 30 * DAY_MS;
/** Search results older than this are dropped from the cache (and so from metadata.json). */
const SEARCH_CACHE_MS = 30 * DAY_MS;
/** How often the timer checks whether a retry or refresh is due. */
const TICK_MS = DAY_MS;
/** Entries loaded per PREQUEL/SEQUEL chain, at most (ruling T8a). */
const MAX_CHAIN_ENTRIES = 30;
const TV_FORMATS = new Set(['TV', 'TV_SHORT']);
/** The matcher's cache keys for entries looked up by id (`anilist-entry:anilist:1`, `tmdb-entry:tmdb-tv:2`). */
const ENTRY_KEY = /^(?:anilist|tmdb)-entry:(.+)$/;
/** An AniList entry the encodes catalogue asked for and the source didn't give isn't asked for again this soon. */
const ENCODE_RETRY_MS = 10 * 60_000;
/** The ids a loaded entry leads to: its TV prequels and sequels, and, for a film or OVA, the TV entries its story links name. */
function chainIds(en: Entry): string[] {
  const tv = TV_FORMATS.has(en.format ?? '');
  const links = tv ? ['PREQUEL', 'SEQUEL'] : ['PREQUEL', 'SEQUEL', 'PARENT', 'SIDE_STORY', 'SUMMARY'];
  return en.relations.filter((r) => links.includes(r.type) && TV_FORMATS.has(r.format ?? '')).map((r) => r.id);
}
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isNullableNumber = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A stored encode entry with the fields the encodes catalogue reads, all of the right shape. */
function isStoredEntry(id: string, en: unknown): en is Entry {
  if (!/^(?:anilist|tmdb-tv|tmdb-movie):\d+$/.test(id) || !isRecord(en) || en.id !== id || !isNullableString(en.format) || !isNullableNumber(en.year)) return false;
  if (en.startDate !== undefined && !isNullableNumber(en.startDate)) return false;
  const names = en.names;
  if (!isRecord(names) || !isNullableString(names.english) || !isNullableString(names.romaji) || !isNullableString(names.native)) return false;
  if (en.poster !== null && !(isRecord(en.poster) && typeof en.poster.small === 'string' && typeof en.poster.large === 'string')) return false;
  return Array.isArray(en.relations) && en.relations.every((r) =>
    isRecord(r) && typeof r.type === 'string' && typeof r.id === 'string' && isNullableString(r.format) && isNullableNumber(r.startDate));
}
/** Posters of lookup results kept for `GET art/<id>`, at most (ruling T9e). */
const MAX_LOOKUP_ART = 500;
/** A run saves and publishes its progress after this many groups, or this long, whichever comes first (ruling F4). */
const CHECKPOINT_GROUPS = 25;
const CHECKPOINT_MS = 3 * 60_000;

export interface TitleStatus { readonly running: boolean; readonly groupsDone: number; readonly groupsTotal: number; readonly filed: number; readonly unsorted: number; readonly music: number; readonly lastRunAt: number | null; readonly tmdb: boolean; readonly gate: 'owners' | 'everyone' }

export interface TitleServiceOptions {
  readonly library: Pick<Library, 'evidence'>;
  readonly owner: OwnerStore;
  readonly dataDir: string;
  readonly anilist: MetadataSource;
  readonly tmdb: MetadataSource | null;
  readonly discdb: { lookup(fp: string): DiscDbHit | null };
  readonly art: ArtCache;
  /** Music lookups by catalogue number; null for none. */
  readonly musicbrainz: MusicSource | null;
  /** Asked when MusicBrainz misses or has no cover (only its cover is used then); null without a token. */
  readonly discogs: MusicSource | null;
  /** The image in a release folder (absolute path), with its size and modification time, or null. */
  readonly folderCover: (releaseDir: string) => Promise<FolderCover | null>;
  /** A music release folder's absolute path: the disc's location less its folders below the release group. */
  readonly locateRelease: (discId: string, group: string) => string | null;
  /** Roots in the Downloads group (see `downloadRootNames`). */
  readonly downloadRoots?: ReadonlySet<string>;
  /** `TITLE_LIBRARY`, used while the owner hasn't set the gate. Default 'owners'. */
  readonly titleLibrary?: 'owners' | 'everyone';
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => () => void;
}

interface Dated<T> {
  readonly at: number;
  readonly value: T;
}

/** metadata.json. */
interface MetadataFile {
  readonly version: 2;
  readonly matches: readonly DiscMatch[];
  readonly entries: Record<string, Dated<Entry>>;
  /**
   * The matcher's cache: search results and entries looked up by id, with when they were fetched, as entry ids over
   * `pool` (M1), so an entry several searches found is kept once.
   */
  readonly cache: Record<string, Dated<string[]>>;
  /** Every entry the cache names, once; an entry looked up by id wins over a search's copy, which may lack seasons. */
  readonly pool: Record<string, Entry>;
  /** Each present disc's evidence key and group. */
  readonly discs: Record<string, { readonly key: string; readonly group: string }>;
  /** Each disc id's first-seen time. */
  readonly firstSeen: Record<string, number>;
  readonly lastRunAt: number | null;
  readonly lastRetryAt: number | null;
  readonly lastRefreshAt: number | null;
  /**
   * The `MATCH_RULES_VERSION` the matches were made under; missing in files from before it, which then re-match too.
   * Optional, so such a file still loads.
   */
  readonly rulesVersion?: number;
  /** Music lookups by catalogue number (null: a miss), with when they were made. Optional: older files lack it. */
  readonly music?: Record<string, Dated<MusicRelease | null>>;
  /** Each music release group's folder cover, with the key of its discs' evidence it was found for. Optional too. */
  readonly folderCovers?: Record<string, MusicCoverRecord>;
}

interface MusicCoverRecord {
  readonly key: string;
  readonly cover: FolderCover | null;
}

const evidenceKey = (e: DiscEvidence): string => createHash('sha256').update(JSON.stringify(e)).digest('hex').slice(0, 32);
const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
/** A box folder's box family, the folder its box folders share (T8b), or null when the group isn't a box folder. */
const boxFamily = (group: string): string | null => (parseName(lastSegment(group)).box !== null ? parentOf(group) : null);
const sourceOf = (id: string): 'anilist' | 'tmdb' | null => (id.startsWith('anilist:') ? 'anilist' : id.startsWith('tmdb-') ? 'tmdb' : null);

function defaultTimer(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
}

/**
 * A music release folder's absolute path from its disc's (`discAbs`, the disc folder or ISO file): the disc's folder
 * names below the release group (`segments` start below the root) are taken off. Null when the group isn't above it.
 */
export function releaseFolderOf(discAbs: string, segments: readonly string[], group: string): string | null {
  const names = group.split('/');
  if (names.length > segments.length || names.some((n, i) => n !== segments[i])) return null;
  let dir = discAbs;
  for (let i = names.length; i < segments.length; i++) dir = dirname(dir);
  return dir;
}

/** The names of the roots whose group is "Downloads": their copies are listed after the others. */
export function downloadRootNames(roots: readonly LibraryRoot[]): Set<string> {
  return new Set(roots.filter((r) => r.group === 'Downloads').map((r) => r.name));
}

/** The TheDiscDB index at `file`, or none when it is missing or unreadable (ruling R2), which is logged once. */
export function loadDiscDbOrNone(file: string, log: (message: string) => void = console.log): { lookup(fp: string): DiscDbHit | null } {
  try {
    return loadDiscDb(file);
  } catch (err) {
    log(`TheDiscDB index ${file} not loaded (${err instanceof Error ? err.message : String(err)}): matching without TheDiscDB`);
    return { lookup: () => null };
  }
}

/**
 * Test-only sources (ruling R3, `METADATA_FIXTURE`): recorded search results keyed by query stand in for AniList and
 * TMDB. A query matches under `normalizeTitle`; each source answers its own entries, and entries by id from all of them.
 */
export function fixtureSources(recorded: Readonly<Record<string, readonly Entry[]>>): { anilist: MetadataSource; tmdb: MetadataSource } {
  const byQuery = new Map(Object.entries(recorded).map(([q, es]) => [normalizeTitle(q), es]));
  const byId = new Map(Object.values(recorded).flat().map((en) => [en.id, en]));
  const source = (name: 'anilist' | 'tmdb'): MetadataSource => ({
    search: async (query) => (byQuery.get(normalizeTitle(query)) ?? []).filter((en) => en.source === name),
    entry: async (id) => (sourceOf(id) === name ? (byId.get(id) ?? null) : null),
  });
  return { anilist: source('anilist'), tmdb: source('tmdb') };
}

export class TitleService {
  private readonly file: string;
  private readonly now: () => number;
  readonly art: ArtCache;
  private matches = new Map<string, DiscMatch>();
  private entries = new Map<string, Dated<Entry>>();
  private cache = new Map<string, Dated<Entry[]>>();
  private discs = new Map<string, { key: string; group: string }>();
  private readonly firstSeen = new Map<string, number>();
  private lastRunAt: number | null = null;
  private lastRetryAt: number | null = null;
  private lastRefreshAt: number | null = null;
  /** Music lookups by catalogue number. */
  private music = new Map<string, Dated<MusicRelease | null>>();
  /** Folder covers by music release group. */
  private folderCovers = new Map<string, MusicCoverRecord>();
  /** The matching rules the matches were made under (null: unknown, from a file before the field). */
  private rulesVersion: number | null = null;
  private built!: Catalogue;
  private running: Promise<void> | null = null;
  private again = false;
  private groupsDone = 0;
  private groupsTotal = 0;
  private cancelTimer: () => void = () => {};
  /** Lookup results' poster URLs by art id, least recently used first. */
  private readonly lookupArt = new Map<string, { small: string; large: string }>();
  /** Posters of the encodes catalogue's shows, by art id. */
  private readonly encodeArt = new Map<string, { small: string; large: string }>();
  /** AniList and TMDB entries loaded for the encodes catalogue, by entry id (`anilist:1`, `tmdb-tv:2`), kept in memory. */
  private readonly encodeEntries = new Map<string, Entry>();
  /** Ids to fetch for the encodes, each with its place in the walk that wanted it (1 for a start id). */
  private readonly encodeWanted = new Map<string, number>();
  private readonly encodeFailedAt = new Map<string, number>();
  private encodeFetching: Promise<void> | null = null;
  /** Set by `close`: no background fetch starts or goes on after it. */
  private closed = false;
  private encodeEntriesDirty = false;
  private readonly encodeFile: string;
  /** A hash of what metadata.json holds, besides `lastRunAt`, so a run that changed nothing doesn't write it (M1). */
  private savedHash: string | null = null;

  constructor(private readonly opts: TitleServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.art = opts.art;
    mkdirSync(opts.dataDir, { recursive: true });
    this.file = join(opts.dataDir, 'metadata.json');
    this.encodeFile = join(opts.dataDir, 'encode-entries.json');
    this.loadEncodeEntries();
    this.load();
    this.rebuild();
    this.arm();
  }

  /** The last built catalogue; served while a run is going. */
  catalogue(): Catalogue {
    return this.built;
  }

  status(): TitleStatus {
    let filed = 0;
    let music = 0;
    for (const t of this.built.titles) {
      if (t.kind === 'music') music += t.discs;
      else filed += t.discs;
    }
    return {
      running: this.running !== null, groupsDone: this.groupsDone, groupsTotal: this.groupsTotal, filed, unsorted: this.built.unsorted.length, music,
      lastRunAt: this.lastRunAt, tmdb: this.opts.tmdb !== null, gate: this.gate(),
    };
  }

  /** The owner's setting, else the config's. */
  gate(): 'owners' | 'everyone' {
    return this.opts.owner.gate() ?? this.opts.titleLibrary ?? 'owners';
  }

  /**
   * Matches new and changed discs (and their groups), plus Unsorted when the weekly retry is due, then rebuilds and
   * saves. A call during a run returns that run, which goes round once more so it sees the latest scan.
   */
  runNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          try {
            await this.run();
          } catch (err) {
            console.error('title matching failed', err);
          }
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /**
   * The owner's search (spec §9): AniList or TMDB through their paced sources, ahead of background matching, or the
   * own titles by name. A title the catalogue lists comes back as listed. Other results' posters are registered for
   * `lookupArtUrls` (ruling T9e). No TMDB key: no results. A source that is down throws `SourceUnavailable`; aborting
   * `signal` rejects with its reason.
   */
  async lookup(query: string, source: 'anilist' | 'tmdb' | 'own', signal?: AbortSignal): Promise<TitleSummary[]> {
    const listed = new Map(this.built.titles.map((t) => [t.id, t]));
    if (source === 'own') {
      const q = normalizeTitle(query);
      if (q === '') return [];
      return this.opts.owner.snapshot().ownTitles
        .filter((t) => normalizeTitle(t.name).includes(q))
        .map((t) => listed.get(t.id) ?? {
          id: t.id, kind: t.kind, names: { english: null, romaji: null, native: null, synonyms: [], display: t.name }, poster: null, year: null,
          seasons: t.kind === 'series' ? (t.seasons ?? 0) : 0, discs: 0, addedAt: 0, own: true,
        });
    }
    const src = source === 'anilist' ? this.opts.anilist : this.opts.tmdb;
    if (!src) return [];
    const found = await src.search(query, { urgent: true, signal });
    return found.map((en) => {
      const known = listed.get(en.id);
      if (known) return known;
      return {
        id: en.id, kind: en.kind, names: { ...en.names, display: null }, poster: en.poster === null ? null : this.registerArt(en.poster),
        year: en.year, seasons: en.seasons.length, discs: 0, addedAt: 0, own: false,
      };
    });
  }

  /**
   * Where an owner's choice files a disc under AniList entry `anilistId` (`GET admin/anilist-place`), whether or not a
   * disc of it is filed: a TV entry is its series, by the id the catalogue keys the series by, and its place in the chain
   * (the same numbering the catalogue gives it, falling back to the matcher's season as the catalogue does); any other
   * entry is a title of its own with no season. The entry and its TV PREQUEL/SEQUEL chain (at most 30, as a run walks
   * it) come from what is held, else from AniList, urgent and abortable like the owner's lookups; the entries the
   * answer used are kept with the filed entries, so a choice made from the answer files the disc there at once.
   * `not-found` when AniList doesn't know the entry; `no-season` when its chain gives it no season number (a prequel
   * AniList didn't give, or a branch) and no match filed it with one, or another member of the series has the same
   * number. A source that is down throws `SourceUnavailable`.
   */
  async anilistPlace(anilistId: number, signal?: AbortSignal): Promise<AnilistPlace | 'not-found' | 'no-season'> {
    const src = this.opts.anilist;
    const now = this.now();
    const fetched = new Map<string, Entry>();
    const get = async (id: string): Promise<Entry | null> => {
      const known = this.knownEntry(id) ?? fetched.get(id);
      if (known) return known;
      const en = await src.entry(id, { urgent: true, signal });
      if (en) fetched.set(id, en);
      return en;
    };
    const start = await get(`anilist:${anilistId}`);
    if (!start) return 'not-found';
    const named = (en: Entry): string | null => en.names.english ?? en.names.romaji;
    if (!isAnilistTv(start)) {
      this.keepUsed([start], fetched, now);
      return { titleId: start.id, season: null, name: named(start) ?? start.names.native ?? start.id };
    }
    const chain = new Map<string, Entry>();
    const queue = [start.id];
    while (queue.length > 0 && chain.size < MAX_CHAIN_ENTRIES) {
      const id = queue.shift()!;
      if (chain.has(id)) continue;
      const en = await get(id);
      if (!en) continue;
      chain.set(id, en);
      for (const r of en.relations) {
        if ((r.type === 'PREQUEL' || r.type === 'SEQUEL') && TV_FORMATS.has(r.format ?? '') && !chain.has(r.id)) queue.push(r.id);
      }
    }
    this.keepUsed([...chain.values()], fetched, now);
    // the series as the catalogue will build it: over the filed entries with this chain among them
    const entries = new Map([...this.entries].map(([id, d]) => [id, d.value]));
    for (const [id, en] of chain) if (!entries.has(id)) entries.set(id, en);
    const series = anilistSeries(entries).get(start.id)!;
    // the catalogue's numbering: the chain's count, else the matcher's season (ruling T7h)
    const matcherSeason = new Map<string, number>();
    for (const m of this.matches.values()) if (m.status === 'filed' && m.season !== null && !matcherSeason.has(m.entryId)) matcherSeason.set(m.entryId, m.season);
    const seasonOf = (id: string): number | null => series.number.get(id) ?? matcherSeason.get(id) ?? null;
    const season = seasonOf(start.id);
    if (season === null) return 'no-season';
    // a choice names the season by number, which files into the first member with it: another with the same number
    // (a fork in the chain) would take the disc
    if (series.members.some((m) => m.id !== start.id && seasonOf(m.id) === season)) return 'no-season';
    return { titleId: series.id, season, name: named(start) ?? `Season ${season}` };
  }

  /**
   * Keeps the entries `anilistPlace` answered from (`used`, wherever they were held: fetched, the matcher's cache or the
   * encodes' entries) with the filed entries, which alone build the catalogue, so a choice made from the answer files
   * the disc there at once; and those it fetched (`fetched`) in the matcher's cache, so the next run needs no lookup.
   * A run already under way replaces the filed entries with its own copy when it ends; the choice's own run (`no-title`
   * then) loads them again.
   */
  private keepUsed(used: readonly Entry[], fetched: ReadonlyMap<string, Entry>, now: number): void {
    let changed = false;
    for (const en of used) {
      if (this.entries.has(en.id)) continue;
      this.entries.set(en.id, { at: now, value: en });
      changed = true;
    }
    for (const [id, en] of fetched) {
      this.cache.set(`anilist-entry:${id}`, { at: now, value: [en] });
      changed = true;
    }
    if (changed) this.save();
  }

  /** The source URLs of a lookup result's poster, by art id, or null; a hit counts as a use. */
  lookupArtUrls(artId: string): { small: string; large: string } | null {
    const urls = this.lookupArt.get(artId);
    if (!urls) return null;
    this.lookupArt.delete(artId);
    this.lookupArt.set(artId, urls);
    return urls;
  }

  /**
   * Registers a poster from a source's answer under its art id, dropping the least recently used beyond 500. An id the
   * catalogue holds for other URLs isn't taken over, and the result gets no poster.
   */
  private registerArt(poster: { readonly small: string; readonly large: string }): string | null {
    const id = artIdOf(poster);
    const held = this.built.art(id);
    if (held) return 'small' in held && held.small === poster.small && held.large === poster.large ? id : null;
    this.lookupArt.delete(id);
    this.lookupArt.set(id, { small: poster.small, large: poster.large });
    while (this.lookupArt.size > MAX_LOOKUP_ART) this.lookupArt.delete(this.lookupArt.keys().next().value!);
    return id;
  }

  /**
   * The AniList entries of `ids` and of the TV PREQUEL/SEQUEL chains they sit on (a film's story links to TV entries
   * too), from what is known (filed entries, the matcher's cache, earlier loads), by AniList number. Never waits for the
   * network: entries not known yet are fetched in the background through the paced source, so a later call has them.
   * A lookup that found nothing is not repeated for ten minutes. Held entries off every chain of `ids` are dropped.
   */
  entriesFor(ids: readonly number[]): ReadonlyMap<number, Entry> {
    const out = new Map<number, Entry>();
    const missing = new Map<string, number>();
    const walked = new Set<string>();
    for (const start of ids) {
      const queue = [`anilist:${start}`];
      let count = 0;
      while (queue.length > 0 && count < MAX_CHAIN_ENTRIES) {
        const id = queue.shift()!;
        if (walked.has(id)) continue;
        walked.add(id);
        count++;
        const en = this.knownEntry(id);
        if (!en) {
          if (!missing.has(id)) missing.set(id, count);
          continue;
        }
        out.set(Number(id.slice('anilist:'.length)), en);
        for (const next of chainIds(en)) if (!walked.has(next)) queue.push(next);
      }
    }
    if (ids.length > 0) {
      const chains = this.chainsOf(ids);
      this.pruneEncodeEntries((id) => sourceOf(id) !== 'anilist' || chains.has(id));
    }
    this.fetchMissing(missing);
    return out;
  }

  /**
   * Names for the encodes of TMDB and own titles in `titles` (AniList's come from `entriesFor`), for
   * `buildEncodeCatalogue`. A TMDB title is named by its entry (filed, from the matcher's cache, or loaded for the
   * encodes), its poster registered for the art route; a missing entry is fetched in the background through the paced
   * TMDB source (never without `TMDB_API_KEY`) and kept in `encode-entries.json`, so a later call has it. An own title
   * is named from the owner's own titles, and a deleted one gets null. Never waits for the network. Held TMDB entries
   * no title in `titles` names are dropped.
   */
  encodeNames(titles: readonly EncodeTitle[]): EncodeNames {
    const own = new Map(this.opts.owner.snapshot().ownTitles.map((t) => [t.id, t]));
    const tmdbIds = new Set(titles.filter((t) => t.source === 'tmdb-tv' || t.source === 'tmdb-movie').map(nasTitleId));
    if (tmdbIds.size > 0) this.pruneEncodeEntries((id) => sourceOf(id) !== 'tmdb' || tmdbIds.has(id));
    if (this.opts.tmdb) {
      // a TMDB entry has no chain to follow: each is wanted at the walk's end
      this.fetchMissing(new Map([...tmdbIds].filter((id) => !this.knownEntry(id)).map((id) => [id, MAX_CHAIN_ENTRIES])));
    }
    return (t) => {
      if (t.source === 'anilist') return null;
      if (t.source === 'own') {
        const title = own.get(nasTitleId(t));
        return title ? { name: title.name, poster: null, film: title.kind === 'movie' } : null;
      }
      const en = this.knownEntry(nasTitleId(t));
      const name = en ? (en.names.english ?? en.names.romaji ?? en.names.native) : null;
      if (!en || name === null) return null;
      let poster: string | null = null;
      if (en.poster) {
        poster = artIdOf(en.poster);
        this.addEncodeArt(new Map([[poster, en.poster]]));
      }
      return { name, poster, film: t.source === 'tmdb-movie' };
    };
  }

  /** An entry already held: filed, from the matcher's cache, or loaded for the encodes. */
  private knownEntry(id: string): Entry | undefined {
    return this.entries.get(id)?.value ?? this.cache.get(`${sourceOf(id) ?? 'anilist'}-entry:${id}`)?.value[0] ?? this.encodeEntries.get(id);
  }

  /**
   * Every id on the chains of `ids` as the held entries' own relations draw them, with no limit and no network: from a
   * start id along `chainIds`, and back to any held TV entry whose prequel or sequel is on the chain (so an entry past
   * an id that isn't held stays on it). Entries outside it are the ones no encode reaches.
   */
  private chainsOf(ids: readonly number[]): Set<string> {
    const keep = new Set<string>();
    const expand = (start: string): void => {
      const queue = [start];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (keep.has(id)) continue;
        keep.add(id);
        const en = this.knownEntry(id);
        if (en) for (const next of chainIds(en)) if (!keep.has(next)) queue.push(next);
      }
    };
    for (const n of ids) expand(`anilist:${n}`);
    for (let grew = true; grew;) {
      grew = false;
      for (const [id, en] of this.encodeEntries) {
        if (keep.has(id) || !TV_FORMATS.has(en.format ?? '') || !chainIds(en).some((next) => keep.has(next))) continue;
        expand(id);
        grew = true;
      }
    }
    return keep;
  }

  /**
   * Starts the background fetch of `ids` (one at a time, so the source's pacing holds); a second call adds to it. Each id
   * carries its place in the walk, and a loaded entry's chain is followed only as far as the walk reads a chain.
   */
  private fetchMissing(ids: ReadonlyMap<string, number>): void {
    if (this.closed) return;
    const now = this.now();
    for (const [id, place] of ids) {
      const failed = this.encodeFailedAt.get(id);
      if (failed !== undefined && now - failed < ENCODE_RETRY_MS) continue;
      this.encodeWanted.set(id, Math.min(place, this.encodeWanted.get(id) ?? place));
    }
    if (this.encodeFetching || this.encodeWanted.size === 0) return;
    this.encodeFetching = (async () => {
      try {
        while (!this.closed && this.encodeWanted.size > 0) {
          const [id, place] = this.encodeWanted.entries().next().value!;
          this.encodeWanted.delete(id);
          if (this.knownEntry(id)) continue;
          const src = this.sourceFor(id);
          try {
            const en = src ? await src.entry(id) : null;
            if (!en) {
              this.encodeFailedAt.set(id, this.now());
              continue;
            }
            this.encodeEntries.set(id, en);
            this.encodeEntriesDirty = true;
            if (place >= MAX_CHAIN_ENTRIES) continue;
            for (const next of chainIds(en)) {
              if (!this.knownEntry(next) && !this.encodeWanted.has(next)) this.encodeWanted.set(next, place + 1);
            }
          } catch (err) {
            // an unexpected error is backed off like a miss, so a request doesn't retry it every time
            if (!(err instanceof SourceUnavailable)) console.error('loading an entry for the encodes failed', err);
            this.encodeFailedAt.set(id, this.now());
          }
        }
      } finally {
        this.encodeWanted.clear();
        this.encodeFetching = null;
        // the disc catalogue doesn't change when these arrive; the encodes catalogue is built per request
        if (this.encodeEntriesDirty) this.saveEncodeEntries();
      }
    })();
  }

  /** Drops loaded encode entries `keep` refuses (off the chains of the encode index's ids, or named by no encode) and saves if any went. */
  private pruneEncodeEntries(keep: (id: string) => boolean): void {
    for (const id of [...this.encodeEntries.keys()]) {
      if (keep(id)) continue;
      this.encodeEntries.delete(id);
      this.encodeEntriesDirty = true;
    }
    if (this.encodeEntriesDirty && !this.encodeFetching) this.saveEncodeEntries();
  }

  /** Writes `encode-entries.json` (its own file: matching runs rebuild and prune metadata.json); a failure is logged. */
  private saveEncodeEntries(): void {
    try {
      replaceAtomically(this.encodeFile, JSON.stringify({ version: 1, entries: Object.fromEntries(this.encodeEntries) }));
      this.encodeEntriesDirty = false;
    } catch (err) {
      console.error('saving encode-entries.json failed', err);
    }
  }

  /** Reads `encode-entries.json`; a missing or malformed file leaves the entries to be fetched again. */
  private loadEncodeEntries(): void {
    try {
      const data = JSON.parse(readFileSync(this.encodeFile, 'utf8')) as { version?: unknown; entries?: unknown };
      if (data.version !== 1 || typeof data.entries !== 'object' || data.entries === null) return;
      for (const [id, en] of Object.entries(data.entries)) {
        if (isStoredEntry(id, en)) this.encodeEntries.set(id, en);
      }
    } catch {
      // absent or unreadable: fetched again
    }
  }

  /** Registers the posters an encodes catalogue names (art id to source URLs), for `encodeArtUrls`; the newest 500 stay. */
  addEncodeArt(art: ReadonlyMap<string, { readonly small: string; readonly large: string }>): void {
    for (const [id, urls] of art) {
      this.encodeArt.delete(id);
      this.encodeArt.set(id, { small: urls.small, large: urls.large });
    }
    while (this.encodeArt.size > MAX_LOOKUP_ART) this.encodeArt.delete(this.encodeArt.keys().next().value!);
  }

  /** The source URLs of an encode poster by art id, or null. */
  encodeArtUrls(artId: string): { small: string; large: string } | null {
    return this.encodeArt.get(artId) ?? null;
  }

  /** Resolves when the background fetch for `entriesFor` and `encodeNames` is idle (tests). */
  async encodeEntriesIdle(): Promise<void> {
    while (this.encodeFetching) await this.encodeFetching;
  }

  /** Builds the catalogue again from what is known, with no network access: after an owner change. */
  rebuild(): void {
    this.built = buildCatalogue({
      matches: [...this.matches.values()],
      entries: new Map([...this.entries].map(([id, d]) => [id, d.value])),
      evidence: this.opts.library.evidence(),
      owner: this.opts.owner.snapshot(),
      discdb: this.opts.discdb,
      addedAt: this.firstSeen,
      downloadRoots: this.opts.downloadRoots ?? new Set(),
      music: new Map([...this.music].map(([k, d]) => [k, d.value])),
      folderCovers: new Map([...this.folderCovers].map(([g, r]) => [g, r.cover])),
    });
  }

  /** Stops the schedule and the background fetch of encode entries (a lookup under way finishes; nothing follows it). */
  close(): void {
    this.closed = true;
    this.encodeWanted.clear();
    this.cancelTimer();
  }

  private arm(): void {
    this.cancelTimer = (this.opts.setTimer ?? defaultTimer)(() => {
      if (this.due(this.lastRetryAt, RETRY_UNSORTED_MS) || this.due(this.lastRefreshAt, REFRESH_MS)) void this.runNow();
      this.arm();
    }, TICK_MS);
  }

  private due(last: number | null, every: number): boolean {
    return last !== null && this.now() - last >= every;
  }

  private async run(): Promise<void> {
    const { owner } = this.opts;
    const now = this.now();
    const evidence = this.opts.library.evidence();
    owner.reattach(evidence.map((e) => ({ id: e.discId, fingerprint: e.fingerprint })));
    for (const e of evidence) if (!this.firstSeen.has(e.discId)) this.firstSeen.set(e.discId, now);
    const retryDue = this.due(this.lastRetryAt, RETRY_UNSORTED_MS);

    // groups to match: those with a new or changed disc, a disc that left, a source failure, or Unsorted on retry day;
    // every group when the matching rules changed since the matches were made (the cache still saves the lookups)
    const keys = new Map(evidence.map((e) => [e.discId, { key: evidenceKey(e), group: groupKey(e) }]));
    const rulesChanged = this.rulesVersion !== MATCH_RULES_VERSION;
    const dirty = new Set<string>();
    for (const [id, d] of keys) {
      const before = this.discs.get(id);
      const m = this.matches.get(id);
      if (rulesChanged || !before || before.key !== d.key || !m || (m.status === 'unsorted' && (m.reason === 'source-unreachable' || retryDue))) dirty.add(d.group);
    }
    for (const [id, d] of this.discs) if (!keys.has(id)) dirty.add(d.group);
    // a box family is matched whole, so rule 4 numbers its discs across all its boxes (T8b)
    const families = new Set([...dirty].map(boxFamily).filter((f): f is string => f !== null));
    if (families.size > 0) for (const d of keys.values()) if (families.has(boxFamily(d.group) ?? '\0')) dirty.add(d.group);
    const toMatch = evidence.filter((e) => dirty.has(groupKey(e)));

    // new rules may read entries' start dates (M11), which entries cached before them lack: those the discs name are
    // fetched again first, so the re-match from the cache sees them
    if (rulesChanged) await this.refreshStartDates(now);

    // the matcher's cache; on retry day, search results and entry lookups that found nothing, older than a week, are
    // looked up again (T8c)
    const cache = new Map<string, Entry[]>();
    for (const [k, d] of this.cache) {
      if (retryDue && (!ENTRY_KEY.test(k) || d.value.length === 0) && now - d.at >= RETRY_UNSORTED_MS) continue;
      cache.set(k, d.value);
    }
    this.groupsDone = 0;
    this.groupsTotal = new Set(toMatch.map(groupKey)).size;

    // every CHECKPOINT_GROUPS groups or CHECKPOINT_MS, whichever comes first, the progress is saved and published, so a
    // restart resumes from the cache and the library fills in as the first run goes (ruling F4)
    let sinceCheckpoint = 0;
    let checkpointAt = this.now();
    const onGroupDone = async (progress: () => { matches: DiscMatch[]; entries: Map<string, Entry> }): Promise<void> => {
      this.groupsDone++;
      sinceCheckpoint++;
      if (sinceCheckpoint < CHECKPOINT_GROUPS && this.now() - checkpointAt < CHECKPOINT_MS) return;
      sinceCheckpoint = 0;
      checkpointAt = this.now();
      const p = progress();
      await this.checkpoint(p.matches, p.entries, keys, cache, now);
    };
    const result: MatchResult = toMatch.length === 0
      ? { matches: [], entries: new Map<string, Entry>(), aborted: false }
      : await matchDiscs(toMatch, { anilist: this.opts.anilist, tmdb: this.opts.tmdb, discdb: this.opts.discdb, cache, onGroupDone });

    if (result.aborted) {
      // the sources are down (M3): what was matched before the failures is kept, the rest waits for the next run
      console.error(`title matching stopped: AniList or TMDB was unreachable for ${CIRCUIT_BREAKER} folders in a row; the rest are matched on the next run`);
      const reached = result.matches.filter((m) => !(m.status === 'unsorted' && m.reason === 'source-unreachable'));
      await this.checkpoint(reached, result.entries, keys, cache, now);
      await this.lookUpMusic(evidence, keys, now, retryDue);
      return;
    }

    const discs = new Map(keys);
    const matches = new Map<string, DiscMatch>();
    for (const e of evidence) {
      const m = this.matches.get(e.discId);
      if (m) matches.set(e.discId, m);
    }
    let failed = this.merge(result.matches, matches, discs, null);

    const entries = new Map(this.entries);
    this.addEntries(entries, result.entries, now);
    const loaded = await this.loadEntries(entries, matches, cache, now);
    failed ||= loaded.failed;
    // unreferenced entries go, unless a lookup failed and the walk is incomplete (C5)
    if (!failed) for (const id of entries.keys()) if (!loaded.keep.has(id)) entries.delete(id);

    // monthly: entries older than 30 days are fetched again
    let refreshed = true;
    if (this.due(this.lastRefreshAt, REFRESH_MS)) {
      try {
        for (const [id, d] of entries) {
          if (now - d.at < REFRESH_MS) continue;
          const src = this.sourceFor(id);
          const en = src ? await src.entry(id) : null;
          if (!en) continue;
          entries.set(id, { at: now, value: en });
          cache.set(`${sourceOf(id)}-entry:${id}`, [en]);
        }
      } catch (err) {
        if (!(err instanceof SourceUnavailable)) throw err;
        refreshed = false;
      }
    }

    const nextCache = this.datedCache(cache, now);
    for (const [k, d] of nextCache) {
      // search results and lookups that found nothing go after 30 days; other entry lookups stay while their entry does
      const id = ENTRY_KEY.exec(k)?.[1];
      if (id === undefined || d.value.length === 0 ? now - d.at >= SEARCH_CACHE_MS : !failed && !entries.has(id)) nextCache.delete(k);
    }

    this.matches = matches;
    this.entries = entries;
    this.cache = nextCache;
    this.discs = discs;
    this.lastRunAt = now;
    // only a run that got through sets the version: a stopped one (M3) leaves the rest to re-match next time
    this.rulesVersion = MATCH_RULES_VERSION;
    if (this.lastRetryAt === null || retryDue) this.lastRetryAt = now;
    if (this.lastRefreshAt === null || (refreshed && this.due(this.lastRefreshAt, REFRESH_MS))) this.lastRefreshAt = now;
    this.rebuild();
    this.save();
    await this.lookUpMusic(evidence, keys, now, retryDue);
  }

  /**
   * After matching (spec §3, Sources and Covers): finds each music release's folder cover when its discs' evidence
   * changed or on retry day, then looks its catalogue numbers up, discs in path order, until one hits. A cached hit is
   * looked up again after 30 days and a miss after 7; a source that is down keeps what was cached, and CIRCUIT_BREAKER
   * failures in a row end the lookups until the next run. A release whose match the owner rejected isn't looked up.
   * Progress is published and saved as matching's is, so the catalogue never waits for it.
   */
  private async lookUpMusic(evidence: readonly DiscEvidence[], keys: ReadonlyMap<string, { key: string; group: string }>, now: number, retryDue: boolean): Promise<void> {
    const { choices } = this.opts.owner.snapshot();
    const releases = new Map<string, DiscEvidence[]>();
    for (const e of evidence) {
      const group = musicGroupOf(e, this.matches.get(e.discId), choices.get(e.discId));
      if (group !== null) releases.set(group, [...(releases.get(group) ?? []), e]);
    }
    for (const discs of releases.values()) discs.sort(byDiscPath);

    const covers = new Map<string, MusicCoverRecord>();
    for (const [group, discs] of releases) {
      const key = createHash('sha256').update(discs.map((e) => keys.get(e.discId)?.key ?? evidenceKey(e)).join('\n')).digest('hex').slice(0, 32);
      const before = this.folderCovers.get(group);
      if (before && before.key === key && !retryDue) {
        covers.set(group, before);
        continue;
      }
      const dir = this.opts.locateRelease(discs[0]!.discId, group);
      let cover: FolderCover | null = null;
      if (dir !== null) {
        try {
          cover = await this.opts.folderCover(dir);
        } catch (err) {
          console.error('music folder cover lookup failed', err);
          cover = before?.cover ?? null;
        }
      }
      covers.set(group, { key, cover });
    }
    this.folderCovers = covers;

    const referenced = new Set([...releases.values()].flat().flatMap((e) => e.catalogueNumbers));
    for (const c of this.music.keys()) if (!referenced.has(c)) this.music.delete(c);
    if (this.opts.musicbrainz || this.opts.discogs) {
      let failures = 0;
      let since = 0;
      let checkpointAt = this.now();
      const rejected = (e: DiscEvidence): boolean => {
        const c = choices.get(e.discId);
        return c?.kind === 'music' && c.rejectMatch === true;
      };
      lookups: for (const discs of releases.values()) {
        if (discs.some(rejected)) continue;
        for (const e of discs) {
          for (const c of e.catalogueNumbers) {
            const cached = this.music.get(c);
            if (cached && now - cached.at < (cached.value ? REFRESH_MS : RETRY_UNSORTED_MS)) {
              if (cached.value) continue lookups;
              continue;
            }
            try {
              const { found, coverLater } = await this.musicRelease(c);
              // a hit whose cover Discogs couldn't be asked for is due again in a week, not a month
              this.music.set(c, { at: coverLater ? now - (REFRESH_MS - RETRY_UNSORTED_MS) : now, value: found });
              failures = 0;
              if (found) continue lookups;
            } catch (err) {
              if (!(err instanceof SourceUnavailable)) throw err;
              if (++failures >= CIRCUIT_BREAKER) {
                console.error(`music lookups stopped: MusicBrainz or Discogs was unreachable for ${CIRCUIT_BREAKER} catalogue numbers in a row`);
                break lookups;
              }
              if (cached?.value) continue lookups;
            } finally {
              if (++since >= CHECKPOINT_GROUPS || this.now() - checkpointAt >= CHECKPOINT_MS) {
                since = 0;
                checkpointAt = this.now();
                this.rebuild();
                this.save();
              }
            }
          }
        }
      }
    }
    this.rebuild();
    this.save();
  }

  /**
   * MusicBrainz's release for a catalogue number, else Discogs'; MusicBrainz's with Discogs' cover when it has none.
   * Throws `SourceUnavailable` only when MusicBrainz is down, or it missed and Discogs is down: a MusicBrainz hit is
   * kept when Discogs is down, with `coverLater` set so the cover is asked for again sooner.
   */
  private async musicRelease(catalogueNumber: string): Promise<{ found: MusicRelease | null; coverLater: boolean }> {
    const { musicbrainz, discogs } = this.opts;
    const mb = musicbrainz ? await musicbrainz.byCatalogue(catalogueNumber) : null;
    if (!discogs || mb?.cover) return { found: mb, coverLater: false };
    let dg: MusicRelease | null;
    try {
      dg = await discogs.byCatalogue(catalogueNumber);
    } catch (err) {
      if (mb && err instanceof SourceUnavailable) return { found: mb, coverLater: true };
      throw err;
    }
    if (!mb) return { found: dg, coverLater: false };
    return { found: dg?.cover ? { ...mb, cover: dg.cover } : mb, coverLater: false };
  }

  /**
   * Saves a run's progress and publishes it (ruling F4): the matches so far over the previous ones, their discs'
   * evidence keys (discs not reached yet keep their old keys, so a restart matches them again), the entries they name
   * with their chains, and the cache, so a restart repeats no lookup. Nothing is pruned until the run ends.
   */
  private async checkpoint(reached: readonly DiscMatch[], found: ReadonlyMap<string, Entry>, keys: ReadonlyMap<string, { key: string; group: string }>, cache: Map<string, Entry[]>, now: number): Promise<void> {
    const matches = new Map(this.matches);
    const discs = new Map(this.discs);
    this.merge(reached, matches, discs, keys);
    const entries = new Map(this.entries);
    this.addEntries(entries, found, now);
    await this.loadEntries(entries, matches, cache, now);
    this.matches = matches;
    this.discs = discs;
    this.entries = entries;
    this.cache = this.datedCache(cache, now);
    this.rebuild();
    this.save();
  }

  /**
   * Puts a run's matches into `matches` and their evidence keys into `discs` (from `keys`; null when `discs` already
   * holds the new keys). A disc filed before stays filed when a source was unreachable (Review Focus 2), and keeps its
   * old key, so it is matched again (T8d). Answers whether a source was unreachable.
   */
  private merge(results: readonly DiscMatch[], matches: Map<string, DiscMatch>, discs: Map<string, { key: string; group: string }>, keys: ReadonlyMap<string, { key: string; group: string }> | null): boolean {
    let failed = false;
    for (const m of results) {
      const before = this.matches.get(m.discId);
      if (m.status === 'unsorted' && m.reason === 'source-unreachable') {
        failed = true;
        if (before && before.status !== 'unsorted') {
          const old = this.discs.get(m.discId);
          if (old) discs.set(m.discId, old);
          continue;
        }
      }
      matches.set(m.discId, m);
      const key = keys?.get(m.discId);
      if (key) discs.set(m.discId, key);
    }
    return failed;
  }

  /** Adds the entries a run found; a TMDB series found by search, without seasons, gives way to one with them (I1). */
  private addEntries(entries: Map<string, Dated<Entry>>, found: ReadonlyMap<string, Entry>, now: number): void {
    for (const [id, en] of found) {
      const known = entries.get(id);
      if (!known || (known.value.seasons.length === 0 && en.seasons.length > 0)) entries.set(id, { at: now, value: en });
    }
  }

  /**
   * Loads the entries owner choices name (C3), every entry on the TV PREQUEL/SEQUEL chain of a filed AniList entry so
   * its series has its root (C2), and each TMDB series' full entry with its seasons where only a search's copy is known
   * (I1). Answers the ids to keep, and whether a lookup failed.
   */
  private async loadEntries(entries: Map<string, Dated<Entry>>, matches: ReadonlyMap<string, DiscMatch>, cache: Map<string, Entry[]>, now: number): Promise<{ keep: Set<string>; failed: boolean }> {
    const byId = async (id: string): Promise<Entry | null> => {
      const src = this.sourceFor(id);
      if (!src) return null;
      const key = `${sourceOf(id)}-entry:${id}`;
      let hit = cache.get(key);
      if (!hit) {
        const en = await src.entry(id);
        hit = en ? [en] : [];
        cache.set(key, hit);
      }
      return hit[0] ?? null;
    };
    const load = async (id: string): Promise<Entry | null> => {
      const known = entries.get(id);
      if (known) return known.value;
      const en = await byId(id);
      if (en) entries.set(id, { at: now, value: en });
      return en;
    };
    const keep = new Set<string>();
    try {
      const anilistStarts: string[] = [];
      for (const c of this.opts.owner.snapshot().choices.values()) {
        if (c.kind !== 'title' && c.kind !== 'extras') continue;
        if (sourceOf(c.titleId) === null) continue;
        keep.add(c.titleId);
        if ((await load(c.titleId)) && sourceOf(c.titleId) === 'anilist') anilistStarts.push(c.titleId);
      }
      for (const m of matches.values()) {
        if (m.status === 'filed') keep.add(m.entryId);
        if (m.status === 'unsorted') for (const id of m.suggestions) keep.add(id);
        if (m.status === 'filed' && sourceOf(m.entryId) === 'anilist') anilistStarts.push(m.entryId);
      }
      const walked = new Set<string>();
      for (const start of anilistStarts) {
        const queue = [start];
        let count = 0;
        while (queue.length > 0 && count < MAX_CHAIN_ENTRIES) {
          const id = queue.shift()!;
          if (walked.has(id)) continue;
          walked.add(id);
          keep.add(id);
          count++;
          const en = await load(id);
          if (!en) continue;
          for (const r of en.relations) {
            if ((r.type === 'PREQUEL' || r.type === 'SEQUEL') && TV_FORMATS.has(r.format ?? '') && !walked.has(r.id)) queue.push(r.id);
          }
        }
      }
      for (const id of keep) {
        const known = entries.get(id)?.value;
        if (!known || known.source !== 'tmdb' || known.kind !== 'series' || known.seasons.length > 0) continue;
        const full = await byId(id);
        if (full && full.seasons.length > 0) entries.set(id, { at: now, value: full });
      }
    } catch (err) {
      if (!(err instanceof SourceUnavailable)) throw err;
      return { keep, failed: true };
    }
    return { keep, failed: false };
  }

  /**
   * Fetches again, by id and paced like any lookup, each cached entry that a disc's match names (filed or suggested)
   * and that has no `startDate` field, from before entries carried one (M11). The fresh entry replaces every cached
   * copy. One that fails is kept as it is, and CIRCUIT_BREAKER failures in a row end the batch; progress is saved
   * every CHECKPOINT_GROUPS entries or CHECKPOINT_MS, as a matching run is.
   */
  private async refreshStartDates(now: number): Promise<void> {
    const named = new Set<string>();
    for (const m of this.matches.values()) {
      if (m.status === 'filed') named.add(m.entryId);
      else if (m.status === 'unsorted') for (const id of m.suggestions) named.add(id);
    }
    const lacking = new Set<string>();
    const consider = (en: Entry): void => { if (named.has(en.id) && !('startDate' in en)) lacking.add(en.id); };
    for (const d of this.entries.values()) consider(d.value);
    for (const d of this.cache.values()) for (const en of d.value) consider(en);
    let failures = 0;
    let since = 0;
    let checkpointAt = this.now();
    for (const id of [...lacking].sort()) {
      const src = this.sourceFor(id);
      if (!src) continue;
      let en: Entry | null;
      try {
        en = await src.entry(id);
        failures = 0;
      } catch (err) {
        if (!(err instanceof SourceUnavailable)) throw err;
        if (++failures >= CIRCUIT_BREAKER) break;
        continue;
      }
      if (!en) continue;
      const fresh = en;
      const entry = this.entries.get(id);
      if (entry) this.entries.set(id, { at: now, value: fresh });
      for (const [k, d] of this.cache) if (d.value.some((x) => x.id === id)) this.cache.set(k, { at: d.at, value: d.value.map((x) => (x.id === id ? fresh : x)) });
      this.cache.set(`${sourceOf(id)}-entry:${id}`, { at: now, value: [fresh] });
      if (++since >= CHECKPOINT_GROUPS || this.now() - checkpointAt >= CHECKPOINT_MS) {
        since = 0;
        checkpointAt = this.now();
        this.save();
      }
    }
    this.save();
  }

  private sourceFor(id: string): MetadataSource | null {
    return sourceOf(id) === 'anilist' ? this.opts.anilist : sourceOf(id) === 'tmdb' ? this.opts.tmdb : null;
  }

  /** The run's cache with fetch times: an unchanged result keeps its time; keys the run didn't see are kept. */
  private datedCache(cache: ReadonlyMap<string, Entry[]>, now: number): Map<string, Dated<Entry[]>> {
    const next = new Map<string, Dated<Entry[]>>();
    for (const [k, v] of cache) {
      const before = this.cache.get(k);
      next.set(k, before && before.value === v ? before : { at: now, value: v });
    }
    for (const [k, d] of this.cache) if (!next.has(k)) next.set(k, d);
    return next;
  }

  /** Reads metadata.json; a malformed one is set aside as `metadata.json.corrupt-<time>` and matching starts afresh (T8e). */
  private load(): void {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (isCode(err, 'ENOENT')) return;
      data = undefined;
    }
    if (!validMetadata(data)) {
      const aside = `${this.file}.corrupt-${this.now()}`;
      try {
        renameSync(this.file, aside);
        console.error(`${this.file} is malformed; moved to ${aside}, matching starts afresh`);
      } catch (err) {
        console.error(`${this.file} is malformed and could not be moved; matching starts afresh`, err);
      }
      return;
    }
    this.matches = new Map(data.matches.map((m) => [m.discId, m]));
    // posters stored before the sizes went up are asked for at the new sizes, with no lookup
    this.entries = new Map(Object.entries(data.entries).map(([k, d]) => [k, { at: d.at, value: withSharperPoster(d.value) }]));
    this.cache = new Map(Object.entries(data.cache).map(([k, d]) => [k, { at: d.at, value: d.value.map((id) => withSharperPoster(data.pool[id]!)) }]));
    this.discs = new Map(Object.entries(data.discs));
    for (const [id, at] of Object.entries(data.firstSeen)) this.firstSeen.set(id, at);
    this.lastRunAt = data.lastRunAt;
    this.lastRetryAt = data.lastRetryAt;
    this.lastRefreshAt = data.lastRefreshAt;
    this.rulesVersion = data.rulesVersion ?? null;
    this.music = new Map(Object.entries(data.music ?? {}));
    this.folderCovers = new Map(Object.entries(data.folderCovers ?? {}));
    this.savedHash = this.contentHash(this.serialize());
  }

  /** Writes metadata.json, unless nothing but `lastRunAt` changed since it was last written or read (M1). */
  private save(): void {
    const data = this.serialize();
    const hash = this.contentHash(data);
    if (hash === this.savedHash) return;
    replaceAtomically(this.file, JSON.stringify(data));
    this.savedHash = hash;
  }

  private contentHash(data: MetadataFile): string {
    return createHash('sha256').update(JSON.stringify({ ...data, lastRunAt: null })).digest('hex');
  }

  private serialize(): MetadataFile {
    const pool: Record<string, Entry> = {};
    const cache: Record<string, Dated<string[]>> = {};
    for (const [k, d] of this.cache) {
      cache[k] = { at: d.at, value: d.value.map((en) => en.id) };
      for (const en of d.value) if (!(en.id in pool)) pool[en.id] = en;
    }
    // an entry looked up by id is the full one
    for (const [k, d] of this.cache) if (ENTRY_KEY.test(k)) for (const en of d.value) pool[en.id] = en;
    return {
      version: 2,
      matches: [...this.matches.values()],
      entries: Object.fromEntries(this.entries),
      cache,
      pool,
      discs: Object.fromEntries(this.discs),
      firstSeen: Object.fromEntries(this.firstSeen),
      lastRunAt: this.lastRunAt,
      lastRetryAt: this.lastRetryAt,
      lastRefreshAt: this.lastRefreshAt,
      ...(this.rulesVersion !== null ? { rulesVersion: this.rulesVersion } : {}),
      music: Object.fromEntries(this.music),
      folderCovers: Object.fromEntries(this.folderCovers),
    };
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isTime = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
const isEntry = (v: unknown): boolean =>
  isObject(v) && isString(v.id) && (v.source === 'anilist' || v.source === 'tmdb') && isObject(v.names) && Array.isArray(v.relations) && Array.isArray(v.seasons);
const isDated = (v: unknown, value: (x: unknown) => boolean): boolean => isObject(v) && isTime(v.at) && value(v.value);
const isMatch = (v: unknown): boolean => {
  if (!isObject(v) || !isString(v.discId)) return false;
  if (v.status === 'filed') return isString(v.entryId) && Array.isArray(v.via);
  if (v.status === 'music') return isString(v.group) && isString(v.name);
  return v.status === 'unsorted' && isString(v.reason) && Array.isArray(v.suggestions) && v.suggestions.every(isString) &&
    (v.seasons === undefined || values(v.seasons, (n) => Number.isSafeInteger(n)));
};
const values = (v: unknown, each: (x: unknown) => boolean): boolean => isObject(v) && Object.values(v).every(each);
const isStringOrNull = (v: unknown): boolean => v === null || isString(v);
const isMusicArtist = (v: unknown): boolean =>
  isObject(v) && isString(v.id) && isString(v.name) && isStringOrNull(v.sortName) && Array.isArray(v.aliases) &&
  v.aliases.every((a) => isObject(a) && isString(a.name) && isStringOrNull(a.locale) && typeof a.primary === 'boolean');
const isMusicRelease = (v: unknown): boolean =>
  v === null || (isObject(v) && (v.source === 'musicbrainz' || v.source === 'discogs') && isString(v.id) && isString(v.title) && isStringOrNull(v.date) &&
    Array.isArray(v.artists) && v.artists.every(isMusicArtist) && isStringOrNull(v.primaryType) && Array.isArray(v.secondaryTypes) &&
    v.secondaryTypes.every(isString) && typeof v.live === 'boolean' && (v.cover === null || (isObject(v.cover) && isString(v.cover.small) && isString(v.cover.large))));
const isCoverRecord = (v: unknown): boolean =>
  isObject(v) && isString(v.key) && (v.cover === null || (isObject(v.cover) && isString(v.cover.path) && isTime(v.cover.size) && isTime(v.cover.mtimeMs)));

/** Whether a parsed metadata.json has the shape `MetadataFile` describes, down to its elements. */
function validMetadata(data: unknown): data is MetadataFile {
  return isObject(data) && data.version === 2 &&
    Array.isArray(data.matches) && data.matches.every(isMatch) &&
    values(data.entries, (d) => isDated(d, isEntry)) &&
    values(data.pool, isEntry) &&
    values(data.cache, (d) => isDated(d, (x) => Array.isArray(x) && x.every((id) => isString(id) && Object.hasOwn(data.pool as object, id)))) &&
    values(data.discs, (d) => isObject(d) && isString(d.key) && isString(d.group)) &&
    values(data.firstSeen, isTime) &&
    [data.lastRunAt, data.lastRetryAt, data.lastRefreshAt].every((t) => t === null || isTime(t)) &&
    (data.rulesVersion === undefined || Number.isSafeInteger(data.rulesVersion)) &&
    (data.music === undefined || values(data.music, (d) => isDated(d, isMusicRelease))) &&
    (data.folderCovers === undefined || values(data.folderCovers, isCoverRecord));
}
