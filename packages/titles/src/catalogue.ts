/**
 * The catalogue: disc matches, metadata entries and the owner's choices made into titles (series, movies,
 * music), each with its seasons, disc slots with copies, episodes and extras, plus the Unsorted and Hidden lists.
 * Built afresh after every matching run or owner change, with no network access. Original code.
 */
import { createHash } from 'node:crypto';
import type {
  DiscRef, DiscSlot, EpisodeRef, OwnerChoice, OwnTitle, SeasonDetail, TitleDetail, TitleKind, TitleMusic, TitleNames, TitleSummary, UnsortedItem, UnsortedReason,
  UnsortedSuggestion,
} from '@seikou/nas/nas-api';
import type { DiscDbHit } from './discdb';
import { guessEpisodes } from './episodes';
import type { DiscEvidence } from './disc-evidence';
import { groupKey, musicRelease } from './match';
import type { DiscMatch } from './match';
import { artistKey, musicInfo, VARIOUS_ID } from './music-info';
import type { MusicRelease } from './music-sources';
import type { OwnerSnapshot } from './owner-store';
import { parseName } from './parse-name';
import type { Entry } from './sources';

/** The library as the app shows it, built by `buildCatalogue` from matches, metadata and the owner's choices. */
export interface Catalogue {
  /** Every title, in natural order of id. */
  readonly titles: readonly TitleSummary[];
  /** One title with its seasons, discs and episodes; null for an unknown id. */
  detail(id: string): TitleDetail | null;
  /** Discs no title could be found for, each with why. */
  readonly unsorted: readonly UnsortedItem[];
  /** Discs the owner hid. */
  readonly hidden: readonly DiscRef[];
  /** A source's URLs, or a folder cover's file (only covers this catalogue found itself); null for an unknown id. */
  art(id: string): { small: string; large: string } | { file: string } | null;
  /** AniList series whose chain isn't loaded back to its root: their id may change once it is. */
  readonly provisional: readonly string[];
}

/** Everything `buildCatalogue` reads. It is all in memory: the catalogue is built without network or disk access. */
export interface CatalogueInput {
  /** The matcher's result for each disc. */
  readonly matches: readonly DiscMatch[];
  /** The metadata entries the matches and the AniList chains name, by entry id. */
  readonly entries: ReadonlyMap<string, Entry>;
  /** What each disc's files and path say. */
  readonly evidence: readonly DiscEvidence[];
  /** The owner's choices, own titles, display names and gate. */
  readonly owner: OwnerSnapshot;
  /** TheDiscDB's index. */
  readonly discdb: { lookup(fp: string): DiscDbHit | null };
  /** Each disc id's first-seen time, in epoch ms. */
  readonly addedAt: ReadonlyMap<string, number>;
  /** Roots in the Downloads group: their copies come after the others. */
  readonly downloadRoots: ReadonlySet<string>;
  /** Music lookups by catalogue number: a release, or null for a miss. */
  readonly music: ReadonlyMap<string, MusicRelease | null>;
  /** The image in each music release folder, by release group, or null for none. */
  readonly folderCovers: ReadonlyMap<string, FolderCover | null>;
}

/** An image in a music release folder (from `findFolderCover`), with the size and time that tell a changed file. */
export interface FolderCover {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

type MusicChoice = Extract<OwnerChoice, { kind: 'music' }>;

/**
 * The music release group of a disc, or null when it isn't music: its music match's release folder, else, for a disc
 * the owner marked as Music, the release folder the matcher would find, else the disc folder itself.
 * @internal
 */
export function musicGroupOf(e: DiscEvidence, match: DiscMatch | undefined, choice: OwnerChoice | undefined): string | null {
  if (choice && choice.kind !== 'music') return null;
  if (match?.status === 'music') return match.group;
  if (choice) return musicRelease(e) ?? e.segments.join('/');
  return null;
}

/**
 * A release's discs in path order (`Disc 2` before `Disc 10`): the first whose lookup hit speaks for the release.
 * @internal
 */
export const byDiscPath = (a: DiscEvidence, b: DiscEvidence): number => naturalOrder(a.path, b.path);

/**
 * The lookup that speaks for a release: the first hit of its discs' catalogue numbers, discs in path order.
 * @internal
 */
export function releaseLookup(discs: readonly DiscEvidence[], music: ReadonlyMap<string, MusicRelease | null>): MusicRelease | null {
  for (const e of [...discs].sort(byDiscPath)) {
    for (const c of e.catalogueNumbers) {
      const hit = music.get(c);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The art id of a folder cover: from its path, size and modification time, so a replaced file gets a new id.
 * @internal
 */
export function folderCoverArtId(cover: FolderCover): string {
  const source = `file:${cover.path}#${cover.size}:${cover.mtimeMs}`;
  return artIdOf({ small: source, large: source });
}

const TV_FORMATS = new Set(['TV', 'TV_SHORT']);
/** Relations that tie a film or OVA to a series; CHARACTER, OTHER and the like don't. */
const STORY_LINKS = new Set(['SEQUEL', 'PREQUEL', 'PARENT', 'SIDE_STORY', 'SUMMARY']);

const naturalOrder = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });
const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const hash = (text: string, length: number): string => createHash('sha256').update(text).digest('hex').slice(0, length);
/** An AniList entry whose format is TV or TV_SHORT. */
export const isAnilistTv = (en: Entry): boolean => en.source === 'anilist' && TV_FORMATS.has(en.format ?? '');

/** An AniList series: a chain of TV entries in start-date order, and each one's season number. */
export interface Series {
  /** The series' id: its root entry's id. */
  readonly id: string;
  /** The root isn't loaded, so the id is the root reached so far. */
  readonly provisional: boolean;
  /** The TV entries of the series, in start-date order. */
  readonly members: readonly Entry[];
  /** A member's place in its chain, for members whose whole PREQUEL chain back to a loaded root is loaded. */
  readonly number: ReadonlyMap<string, number>;
}

/** A disc placed in a title, with its disc number. */
interface Placed {
  readonly e: DiscEvidence;
  readonly disc: number | null;
}

interface SeasonBuild {
  readonly id: string;
  readonly label: string;
  readonly number: number | null;
  readonly order: number;
  readonly discs: Placed[];
  readonly extras: Placed[];
  /** What the episode guess needs, or null for no Episodes tab. */
  readonly info: { readonly episodes: number | null; readonly runtimeMin: number | null } | null;
  /** TheDiscDB episodes are kept when their season is this one; null keeps all. */
  readonly discDbSeason: number | null;
  /** Listed even without discs (an own series' declared seasons). */
  readonly fixed: boolean;
}

interface TitleBuild {
  readonly id: string;
  readonly kind: TitleKind;
  readonly names: TitleNames;
  readonly poster: string | null;
  readonly banner: string | null;
  readonly year: number | null;
  readonly own: boolean;
  /** Movies, music and AniList rows (films, OVAs) keep their discs in one season with no number. */
  readonly single: boolean;
  /** The AniList row entry this title is, to tie it to a series. */
  readonly row: Entry | null;
  readonly series: Series | null;
  readonly seasons: Map<string, SeasonBuild>;
  readonly extras: Placed[];
}

type Target = { readonly title: TitleBuild; readonly season: SeasonBuild | null };

/**
 * AniList series. TV/TV_SHORT entries and the TV ids their SEQUEL/PREQUEL relations name, loaded or
 * not, form a graph; a connected part of it is one series. Its root is the node with no prequel (the earliest by start
 * date if several), so the series id is the first season's even when that entry isn't loaded; while the root isn't
 * loaded the series is provisional. Seasons that aren't loaded are absent, never invented.
 */
export function anilistSeries(entries: ReadonlyMap<string, Entry>): Map<string, Series> {
  const prequels = tvPrequels(entries);
  const isTvNode = (id: string): boolean => {
    const en = entries.get(id);
    return en === undefined || isAnilistTv(en);
  };
  const next = new Map<string, Set<string>>();
  const prev = new Map<string, Set<string>>();
  const node = (id: string): void => {
    if (!next.has(id)) { next.set(id, new Set()); prev.set(id, new Set()); }
  };
  const link = (from: string, to: string): void => {
    node(from);
    node(to);
    next.get(from)!.add(to);
    prev.get(to)!.add(from);
  };
  for (const en of entries.values()) {
    if (!isAnilistTv(en)) continue;
    node(en.id);
    for (const r of en.relations) {
      if (r.id === en.id || !TV_FORMATS.has(r.format ?? '') || !isTvNode(r.id)) continue;
      if (r.type === 'PREQUEL') link(r.id, en.id);
      else if (r.type === 'SEQUEL') link(en.id, r.id);
    }
  }
  // an entry's start date is on the relations pointing at it
  const start = new Map<string, number>();
  for (const en of entries.values()) for (const r of en.relations) if (r.startDate !== null && !start.has(r.id)) start.set(r.id, r.startDate);
  const when = (id: string): number => {
    const year = entries.get(id)?.year ?? null;
    return start.get(id) ?? (year !== null ? year * 10000 : Number.MAX_SAFE_INTEGER);
  };
  const byDate = (a: string, b: string): number => when(a) - when(b) || naturalOrder(a, b);

  const out = new Map<string, Series>();
  for (const first of next.keys()) {
    if (out.has(first) || !entries.has(first)) continue;
    const ids = new Set([first]);
    const queue = [first];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const n of [...next.get(id)!, ...prev.get(id)!]) if (!ids.has(n)) { ids.add(n); queue.push(n); }
    }
    const roots = [...ids].filter((id) => prev.get(id)!.size === 0).sort(byDate);
    if (roots.length === 0) roots.push([...ids].sort(byDate)[0]!); // a cycle
    // longest path from a root, bounded so that a cycle ends
    const depth = new Map(roots.map((id) => [id, 0]));
    const walk = [...roots];
    while (walk.length > 0) {
      const id = walk.shift()!;
      const d = depth.get(id)! + 1;
      for (const n of next.get(id)!) {
        if (d < ids.size && d > (depth.get(n) ?? -1)) { depth.set(n, d); walk.push(n); }
      }
    }
    const members = [...ids].filter((id) => entries.has(id))
      .sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0) || byDate(a, b))
      .map((id) => entries.get(id)!);
    const number = new Map<string, number>();
    for (const en of members) {
      const place = chainPlace(en, entries, prequels);
      if (place !== null) number.set(en.id, place);
    }
    const series: Series = { id: roots[0]!, provisional: number.get(roots[0]!) !== 1, members, number };
    for (const id of ids) out.set(id, series);
  }
  return out;
}

/**
 * The series a film or OVA row hangs under: the first of the row's story relations that names a member of a
 * series with a build in `builds` (by series id), else a build whose series has a member with a story relation to the
 * row. `seriesBuilds` are the builds that have a series.
 */
export function storyParent<T extends { readonly series: Series | null }>(
  row: Entry, seriesOf: ReadonlyMap<string, Series>, builds: ReadonlyMap<string, T>, seriesBuilds: readonly T[],
): T | undefined {
  return row.relations.filter((r) => STORY_LINKS.has(r.type)).map((r) => seriesOf.get(r.id)).map((s) => (s ? builds.get(s.id) : undefined)).find((s) => s !== undefined) ??
    seriesBuilds.find((s) => s.series!.members.some((m) => m.relations.some((r) => r.id === row.id && STORY_LINKS.has(r.type))));
}

/**
 * Each loaded AniList TV entry's TV prequels, worked out once per build: those its own PREQUEL relations name, and
 * the loaded TV entries whose SEQUEL relation names it.
 */
function tvPrequels(entries: ReadonlyMap<string, Entry>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (id: string, prequel: string): void => {
    let set = out.get(id);
    if (!set) out.set(id, (set = new Set()));
    set.add(prequel);
  };
  for (const en of entries.values()) {
    if (!isAnilistTv(en)) continue;
    for (const r of en.relations) {
      if (r.type === 'PREQUEL' && TV_FORMATS.has(r.format ?? '')) add(en.id, r.id);
      else if (r.type === 'SEQUEL') add(r.id, en.id);
    }
  }
  return out;
}

/**
 * An AniList TV entry's place in its chain, counted along single TV prequel links back to a loaded root (a loaded TV
 * entry with no TV prequel), or null when a link leads to an entry that isn't loaded, or branches. A prequel is named
 * by the entry's own PREQUEL relation or by a loaded TV entry's SEQUEL relation to it (`prequels`, from `tvPrequels`).
 */
function chainPlace(en: Entry, entries: ReadonlyMap<string, Entry>, prequels: ReadonlyMap<string, ReadonlySet<string>>): number | null {
  let cur = en;
  for (let place = 1; place <= entries.size; place++) {
    const before = prequels.get(cur.id);
    if (!before || before.size === 0) return place;
    const next = before.size === 1 ? entries.get([...before][0]!) : undefined;
    if (!next || !isAnilistTv(next)) return null;
    cur = next;
  }
  return null; // a cycle
}

/**
 * Makes titles, seasons, disc slots, episodes, extras, Music, Unsorted and Hidden from the matches, the metadata and
 * the owner's choices. An owner's choice for a disc wins over its match. It is deterministic for one input and does
 * no I/O.
 * @example ../examples/build-catalogue.ts
 */
export function buildCatalogue(input: CatalogueInput): Catalogue {
  const { entries, owner } = input;
  const evidenceById = new Map(input.evidence.map((e) => [e.discId, e]));
  const matchById = new Map(input.matches.map((m) => [m.discId, m]));
  const groupSizes = new Map<string, number>();
  for (const e of input.evidence) groupSizes.set(groupKey(e), (groupSizes.get(groupKey(e)) ?? 0) + 1);
  const seriesOf = anilistSeries(entries);
  // AniList season numbers: the chain's count when the whole chain is loaded, else the matcher's (which
  // walked the real chain)
  const matcherSeason = new Map<string, number>();
  for (const m of input.matches) if (m.status === 'filed' && m.season !== null && !matcherSeason.has(m.entryId)) matcherSeason.set(m.entryId, m.season);
  const seasonOf = (series: Series, entryId: string): number | null => series.number.get(entryId) ?? matcherSeason.get(entryId) ?? null;

  const artById = new Map<string, { small: string; large: string }>();
  const artId = (art: { small: string; large: string } | null): string | null => {
    if (art === null) return null;
    const id = artIdOf(art);
    artById.set(id, art);
    return id;
  };

  const builds = new Map<string, TitleBuild>();
  const newTitle = (t: Omit<TitleBuild, 'seasons' | 'extras' | 'row' | 'series'> & { row?: Entry; series?: Series }): TitleBuild => {
    const b: TitleBuild = { ...t, row: t.row ?? null, series: t.series ?? null, seasons: new Map(), extras: [] };
    builds.set(b.id, b);
    return b;
  };
  const season = (b: TitleBuild, s: Omit<SeasonBuild, 'discs' | 'extras' | 'fixed'>, fixed = false): SeasonBuild => {
    let found = b.seasons.get(s.id);
    if (!found) {
      found = { ...s, discs: [], extras: [], fixed };
      b.seasons.set(s.id, found);
    }
    return found;
  };
  const entryNames = (en: Entry): TitleNames => ({ ...en.names, display: null });

  const seriesTitle = (series: Series): TitleBuild => {
    const head = series.members[0]!;
    const known = builds.get(series.id);
    if (known) return known;
    // the other seasons' names are synonyms, so the series is found by any of them
    const headNames = new Set([head.names.english, head.names.romaji, head.names.native, ...head.names.synonyms].filter((n): n is string => n !== null));
    const synonyms = [...new Set([...head.names.synonyms, ...series.members.slice(1).flatMap((m) =>
      [m.names.english, m.names.romaji, m.names.native, ...m.names.synonyms].filter((n): n is string => n !== null && n.trim() !== '' && !headNames.has(n)))])];
    return newTitle({
      id: series.id, kind: 'series', names: { ...entryNames(head), synonyms }, year: head.year, own: false, single: false, series,
      poster: artId(series.members.find((en) => en.poster !== null)?.poster ?? null),
      banner: artId(bannerArt(series.members.find((en) => en.banner !== null)?.banner ?? null)),
    });
  };
  const entryTitle = (en: Entry): TitleBuild => builds.get(en.id) ?? newTitle({
    id: en.id, kind: en.source === 'anilist' ? 'movie' : en.kind, names: entryNames(en), year: en.year, own: false,
    single: en.source === 'anilist' || en.kind === 'movie', row: en.source === 'anilist' ? en : undefined,
    poster: artId(en.poster), banner: artId(bannerArt(en.banner)),
  });
  const singleSeason = (b: TitleBuild, info: SeasonBuild['info']): SeasonBuild =>
    season(b, { id: `${b.id}#discs`, label: '', number: null, order: 0, info, discDbSeason: null });
  const numbered = (b: TitleBuild, n: number, info: SeasonBuild['info'], discDbSeason: number | null, fixed = false): SeasonBuild =>
    season(b, { id: `${b.id}#s${n}`, label: `Season ${n}`, number: n, order: n, info, discDbSeason }, fixed);

  const ownTitle = (t: OwnTitle): TitleBuild => {
    const existing = builds.get(t.id);
    if (existing) return existing;
    const b = newTitle({
      id: t.id, kind: t.kind, names: { english: null, romaji: null, native: null, synonyms: [], display: t.name },
      poster: null, banner: null, year: null, own: true, single: t.kind !== 'series',
    });
    if (t.kind === 'series') for (let n = 1; n <= (t.seasons ?? 0); n++) numbered(b, n, null, null, true);
    return b;
  };
  for (const t of owner.ownTitles) ownTitle(t);

  /**
   * Where a disc filed under `titleId` goes. A match names an AniList season by its entry (`season` null: that entry's
   * season, even for a bonus disc); an owner's choice names the series by any chain id and the season by number.
   * Otherwise `season` null means the only season of a one-season series, or the title's extras for an extras disc.
   * A season the entry or own title doesn't have goes to Unsorted.
   */
  const resolve = (titleId: string, seasonNo: number | null, extras: boolean, byOwner: boolean): Target | UnsortedReason => {
    if (titleId.startsWith('own:')) {
      const t = owner.ownTitles.find((o) => o.id === titleId);
      if (!t) return 'no-title';
      const b = ownTitle(t);
      if (b.single || (seasonNo === null && extras)) return { title: b, season: null };
      const n = seasonNo ?? (t.seasons === 1 ? 1 : null);
      if (n === null || n < 1 || (t.seasons !== null && n > t.seasons)) return 'no-season';
      return { title: b, season: numbered(b, n, null, null) };
    }
    const en = entries.get(titleId);
    // an AniList series, by the id of any entry in its chain, loaded or not
    const series = seriesOf.get(titleId);
    if (series) {
      const b = seriesTitle(series);
      const memberSeason = (m: Entry, n: number): Target => ({
        title: b,
        season: season(b, {
          id: `${m.id}#season`, label: m.names.english ?? m.names.romaji ?? `Season ${n}`, number: n, order: n,
          info: { episodes: m.episodes, runtimeMin: m.runtimeMin }, discDbSeason: null,
        }),
      });
      if (byOwner) {
        // any chain id names the whole series, and only the choice's season picks a season: the loaded
        // entry with that number, else a plain season of that number; with no season, the series' extras or Unsorted
        if (seasonNo === null) return extras ? { title: b, season: null } : 'no-season';
        const m = series.members.find((x) => seasonOf(series, x.id) === seasonNo);
        return m ? memberSeason(m, seasonNo) : { title: b, season: numbered(b, seasonNo, null, null) };
      }
      if (!en) return 'no-title';
      const counted = series.number.get(en.id);
      if (seasonNo !== null && counted !== undefined && counted !== seasonNo) return 'no-season';
      const n = seasonNo ?? seasonOf(series, en.id);
      if (n === null) return extras ? { title: b, season: null } : 'no-season';
      return memberSeason(en, n);
    }
    // filed under an entry that isn't loaded yet
    if (!en) return 'no-title';
    const b = entryTitle(en);
    if (b.single) return { title: b, season: null };
    const n = seasonNo ?? (extras ? null : en.seasons.length === 1 ? en.seasons[0]!.number : undefined);
    if (n === undefined) return 'no-season';
    if (n === null) return { title: b, season: null };
    const s = en.seasons.find((x) => x.number === n);
    if (!s && en.seasons.length > 0) return 'no-season';
    return { title: b, season: numbered(b, n, s ? { episodes: s.episodes, runtimeMin: s.runtimeMin } : null, n) };
  };

  const put = (target: Target, p: Placed, extras: boolean): void => {
    const { title: b, season: s } = target;
    if (s !== null) (extras ? s.extras : s.discs).push(p);
    else if (extras) b.extras.push(p);
    else {
      const row = b.row;
      const info = row !== null && row.format !== 'MOVIE' ? { episodes: row.episodes, runtimeMin: row.runtimeMin } : null;
      singleSeason(b, info).discs.push(p);
    }
  };

  /** The name in an owner's music choice on any disc of a music title, by title id. */
  const musicChoiceNames = new Map<string, string>();
  /** Each music title's release group. */
  const musicGroups = new Map<string, string>();
  const music = (e: DiscEvidence, group: string, name: string, choiceName: string | null): void => {
    const id = `music:${hash(group, 16)}`;
    musicGroups.set(id, group);
    const b = builds.get(id) ?? newTitle({
      id, kind: 'music', names: { english: name, romaji: null, native: null, synonyms: [], display: null },
      poster: null, banner: null, year: null, own: false, single: true,
    });
    if (choiceName !== null && !musicChoiceNames.has(id)) musicChoiceNames.set(id, choiceName);
    singleSeason(b, null).discs.push({ e, disc: null });
  };

  const discRef = (e: DiscEvidence): DiscRef => {
    const cut = e.path.indexOf('/');
    return {
      discId: e.discId,
      root: cut < 0 ? e.path : e.path.slice(0, cut),
      folder: cut < 0 ? '' : e.path.slice(cut + 1),
      displayName: owner.displayNames.get(e.discId) ?? null,
    };
  };

  const hidden: DiscRef[] = [];
  /** `seasons`: the matcher's season for a suggestion, by entry id, where it worked one out. */
  const unsortedDiscs: { e: DiscEvidence; reason: UnsortedReason; suggestions: readonly string[]; seasons: Readonly<Record<string, number>> }[] = [];
  for (const e of input.evidence) {
    const choice = owner.choices.get(e.discId);
    const match = matchById.get(e.discId);
    let target: Target | UnsortedReason;
    let disc: number | null = null;
    let extras = false;
    if (choice) {
      if (choice.kind === 'hidden') {
        hidden.push(discRef(e));
        continue;
      }
      if (choice.kind === 'music') {
        const group = musicGroupOf(e, match, choice)!;
        music(e, group, match?.status === 'music' ? match.name : lastSegment(group), choice.name);
        continue;
      }
      extras = choice.kind === 'extras';
      disc = choice.kind === 'title' ? choice.disc : null;
      target = resolve(choice.titleId, choice.season, extras, true);
      if (typeof target === 'string') {
        const suggestions = match?.status === 'unsorted' ? match.suggestions : match?.status === 'filed' && entries.has(match.entryId) ? [match.entryId] : [];
        unsortedDiscs.push({ e, reason: target, suggestions, seasons: matchSeasons(match) });
        continue;
      }
    } else if (!match) {
      continue; // not matched yet
    } else if (match.status === 'music') {
      music(e, match.group, match.name, null);
      continue;
    } else if (match.status === 'unsorted') {
      unsortedDiscs.push({ e, reason: match.reason, suggestions: match.suggestions, seasons: matchSeasons(match) });
      continue;
    } else {
      extras = match.bonus;
      disc = match.disc;
      target = resolve(match.entryId, match.season, extras, false);
      if (typeof target === 'string') {
        unsortedDiscs.push({ e, reason: target, suggestions: entries.has(match.entryId) ? [match.entryId] : [], seasons: matchSeasons(match) });
        continue;
      }
    }
    put(target, { e, disc }, extras);
  }

  // AniList rows (films, OVAs) tied to a series in the catalogue by a story relation are also listed under it
  const relatedOf = new Map<string, TitleBuild[]>();
  const seriesBuilds = [...builds.values()].filter((s) => s.series !== null);
  for (const b of builds.values()) {
    const row = b.row;
    if (row === null) continue;
    const parent = storyParent(row, seriesOf, builds, seriesBuilds);
    if (!parent) continue;
    relatedOf.set(parent.id, [...(relatedOf.get(parent.id) ?? []), b]);
  }

  const download = (root: string): number => Number(input.downloadRoots.has(root));
  const copyOrder = (a: DiscRef, b: DiscRef): number =>
    download(a.root) - download(b.root) || naturalOrder(a.root, b.root) || naturalOrder(a.folder, b.folder);
  const slots = (placed: readonly Placed[]): DiscSlot[] => {
    const byKey = new Map<string, Placed[]>();
    for (const p of placed) {
      // the same disc number, or the same content without one, is one disc with several copies
      const key = p.disc !== null ? `n${p.disc}` : p.e.fingerprint !== null ? `f${p.e.fingerprint}` : `d${p.e.discId}`;
      byKey.set(key, [...(byKey.get(key) ?? []), p]);
    }
    return [...byKey.values()]
      .map((ps) => {
        const copies = ps.map((p) => discRef(p.e)).sort(copyOrder);
        const number = ps[0]!.disc;
        return { number, label: number !== null ? `Disc ${number}` : (copies[0]!.displayName ?? lastSegment(copies[0]!.folder)), copies };
      })
      .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || naturalOrder(a.copies[0]!.folder, b.copies[0]!.folder));
  };

  /**
   * TheDiscDB's episodes when every disc's first copy has a hit, else the guess. Episodes play from the
   * first copy; a TheDiscDB episode whose playlist that copy lacks plays from a copy that has it, or is left out.
   */
  const episodes = (s: SeasonBuild, discs: readonly DiscSlot[]): EpisodeRef[] | null => {
    if (s.info === null || discs.length === 0) return null;
    const copies = discs.map((d) => d.copies.map((c) => evidenceById.get(c.discId)!));
    const firsts = copies.map((cs) => cs[0]!);
    const hits = firsts.map((e) => (e.fingerprint !== null ? input.discdb.lookup(e.fingerprint) : null));
    if (hits.every((h) => h !== null && h.episodes.length > 0)) {
      const kept = hits.map((h) => h!.episodes.filter((ep) => s.discDbSeason === null || ep.season === s.discDbSeason));
      // TheDiscDB numbers by TMDB's seasons: numbers past this season's episode count belong to another numbering
      const count = s.info.episodes;
      const fits = count === null || kept.every((eps) => eps.every((ep) => ep.episode >= 1 && ep.episode <= count));
      const out = !fits ? [] : copies.flatMap((cs, i) => kept[i]!
        .flatMap((ep): EpisodeRef[] => {
          for (const e of cs) {
            const playlist = e.playlists.find((p) => p.id === ep.playlist);
            if (playlist) return [{ number: ep.episode, name: ep.name, runtimeMin: Math.round(playlist.durationS / 60), discId: e.discId, playlistId: ep.playlist }];
          }
          return [];
        }));
      if (out.length > 0) return out.sort((a, b) => a.number - b.number);
    }
    return guessEpisodes(s.info, firsts.map((e) => ({ discId: e.discId, playlists: e.playlists })), 1);
  };

  const fileArt = new Map<string, string>();
  const releases = musicReleaseInfo(musicGroups, builds, input, artId, (cover) => {
    const id = folderCoverArtId(cover);
    fileArt.set(id, cover.path);
    return id;
  });

  const details = new Map<string, Omit<TitleDetail, 'related'>>();
  const summaries = new Map<string, TitleSummary>();
  for (const b of builds.values()) {
    const seasons: SeasonDetail[] = [...b.seasons.values()]
      .filter((s) => s.fixed || s.discs.length > 0 || s.extras.length > 0)
      .sort((x, y) => x.order - y.order)
      .map((s) => {
        const discs = slots(s.discs);
        return { id: s.id, label: s.label, number: s.number, discs, episodes: b.own ? null : episodes(s, discs), extras: slots(s.extras) };
      });
    const extras = slots(b.extras);
    const placed = [...[...b.seasons.values()].flatMap((s) => [...s.discs, ...s.extras]), ...b.extras];
    const release = releases.get(b.id);
    const summary: TitleSummary = {
      id: b.id, kind: b.kind, poster: release ? release.poster : b.poster, year: b.year,
      // a name in a disc's music choice follows the disc when its folder moves, so it comes first
      names: b.kind === 'music' && !b.own ? { ...b.names, display: musicChoiceNames.get(b.id) ?? owner.displayNames.get(b.id) ?? null } : b.names,
      seasons: b.single ? 0 : seasons.length,
      discs: seasons.reduce((n, s) => n + s.discs.length + s.extras.length, extras.length),
      addedAt: placed.reduce((max, p) => Math.max(max, input.addedAt.get(p.e.discId) ?? 0), 0),
      own: b.own,
      ...(release ? { music: release.music } : {}),
    };
    summaries.set(b.id, summary);
    details.set(b.id, { title: summary, banner: b.banner, seasons, extras });
  }

  const entrySummary = (id: string): TitleSummary | null => {
    const known = summaries.get(id);
    if (known) return known;
    const en = entries.get(id);
    if (!en) return null;
    return { id, kind: en.kind, names: entryNames(en), poster: artId(en.poster), year: en.year, seasons: en.seasons.length, discs: 0, addedAt: 0, own: false };
  };
  /** Whether a suggestion has seasons: an own or listed series, a TMDB series or an AniList TV entry. */
  const hasSeasons = (t: TitleSummary): boolean => {
    const en = entries.get(t.id);
    return en ? (en.source === 'tmdb' ? en.kind === 'series' : isAnilistTv(en)) : t.kind === 'series';
  };
  /** The season the owner's Season field starts at for a suggestion, see `UnsortedSuggestion`. */
  const seasonHint = (t: TitleSummary, e: DiscEvidence, seasons: Readonly<Record<string, number>>): number | null => {
    if (!hasSeasons(t)) return null;
    const series = seriesOf.get(t.id);
    return seasons[t.id] ?? evidenceSeason(e) ?? (series ? seasonOf(series, t.id) : null);
  };
  const unsorted: UnsortedItem[] = unsortedDiscs.map(({ e, reason, suggestions, seasons }) => ({
    discId: e.discId,
    path: e.path,
    discTitles: e.discTitles,
    reason,
    suggestions: suggestions
      .map(entrySummary)
      .filter((s): s is TitleSummary => s !== null)
      .map((s): UnsortedSuggestion => ({ ...s, seasonHint: seasonHint(s, e, seasons) })),
    catalogueNumber: e.catalogueNumbers[0] ?? null,
    group: groupKey(e),
    groupSize: groupSizes.get(groupKey(e)) ?? 1,
  }));

  const byYear = (a: TitleSummary, b: TitleSummary): number => (a.year ?? Infinity) - (b.year ?? Infinity) || naturalOrder(a.id, b.id);
  const titles = [...summaries.values()].sort((a, b) => naturalOrder(a.id, b.id));
  return {
    titles,
    detail(id) {
      const d = details.get(id);
      if (!d) return null;
      return { ...d, related: (relatedOf.get(id) ?? []).map((b) => summaries.get(b.id)!).sort(byYear) };
    },
    unsorted,
    hidden,
    art: (id) => {
      const file = fileArt.get(id);
      return artById.get(id) ?? (file !== undefined ? { file } : null);
    },
    provisional: [...new Set([...seriesOf.values()].filter((x) => x.provisional && builds.has(x.id)).map((x) => x.id))],
  };
}

/**
 * Each music title's music info and poster: the lookup that speaks for the release unless the owner rejected
 * it, the owner's artist, and the folder cover before the lookup's. Then a name-only artist whose name normalizes the
 * same as a looked-up artist's name or alias anywhere in the catalogue takes that artist, so it is one tile.
 */
function musicReleaseInfo(
  groups: ReadonlyMap<string, string>, builds: ReadonlyMap<string, TitleBuild>, input: CatalogueInput,
  artId: (art: { small: string; large: string } | null) => string | null, fileArtId: (cover: FolderCover) => string,
): Map<string, { music: TitleMusic; poster: string | null }> {
  const out = new Map<string, { music: TitleMusic; poster: string | null }>();
  const known = new Map<string, TitleMusic['artist']>();
  for (const [id, group] of [...groups].sort((a, b) => naturalOrder(a[0], b[0]))) {
    const discs = [...builds.get(id)!.seasons.values()].flatMap((s) => s.discs.map((p) => p.e)).sort(byDiscPath);
    const choices = discs.map((e) => input.owner.choices.get(e.discId)).filter((c): c is MusicChoice => c?.kind === 'music');
    const rejectMatch = choices.some((c) => c.rejectMatch === true);
    const ownerArtist = choices.find((c) => typeof c.artist === 'string')?.artist ?? null;
    const lookup = rejectMatch ? null : releaseLookup(discs, input.music);
    const segments = group.split('/');
    const info = musicInfo({
      releaseFolder: segments[segments.length - 1]!, parentFolder: segments.length > 1 ? segments[segments.length - 2]! : null,
      evidence: discs, lookup, ownerArtist, rejectMatch,
    });
    const folder = input.folderCovers.get(group) ?? null;
    out.set(id, { music: info, poster: folder !== null ? fileArtId(folder) : artId(lookup?.cover ?? null) });
    const credited = lookup?.artists[0];
    if (credited && info.artist.id !== VARIOUS_ID && !info.artist.id.startsWith('name:')) {
      for (const name of [credited.name, ...credited.aliases.map((a) => a.name), info.artist.name, info.artist.otherName]) {
        if (name === null || name.trim() === '') continue;
        const key = artistKey(name);
        if (!known.has(key)) known.set(key, info.artist);
      }
    }
  }
  for (const [id, r] of out) {
    if (!r.music.artist.id.startsWith('name:')) continue;
    const joined = known.get(r.music.artist.id.slice('name:'.length));
    if (joined) out.set(id, { ...r, music: { ...r.music, artist: joined } });
  }
  return out;
}

/** The matcher's seasons for an Unsorted match's suggestions, or for a filed match's entry. */
function matchSeasons(m: DiscMatch | undefined): Readonly<Record<string, number>> {
  if (m?.status === 'unsorted') return m.seasons ?? {};
  if (m?.status === 'filed' && m.season !== null) return { [m.entryId]: m.season };
  return {};
}

/** The one season a disc's titles, own folder and the two folders above it name, or null for none or several. */
function evidenceSeason(e: DiscEvidence): number | null {
  const seen = new Set([...e.discTitles.map((t) => t.name), ...e.segments.slice(-3)].map((t) => parseName(t).season).filter((n): n is number => n !== null));
  return seen.size === 1 ? [...seen][0]! : null;
}

/**
 * The art id of a poster or banner's source URLs: 32 lower-case hex digits.
 * @internal
 */
export function artIdOf(art: { readonly small: string; readonly large: string }): string {
  return hash(`${art.small}\n${art.large}`, 32);
}

/** A banner has one size. */
function bannerArt(url: string | null): { small: string; large: string } | null {
  return url === null ? null : { small: url, large: url };
}
