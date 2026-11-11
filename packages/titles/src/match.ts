/**
 * Cautious matching: discs are grouped by parent folder, their names are looked up on AniList and TMDB, and a
 * disc is filed only when the four acceptance rules hold. Everything else goes to Unsorted with a reason, because a
 * confident wrong match is worse than Unsorted. Original code.
 */
import type { UnsortedReason } from '@seikou/nas/nas-api';
import { normalizeStrict, normalizeTitle } from '@seikou/nas/title-text';
import type { DiscDbHit } from './discdb';
import type { DiscEvidence } from './disc-evidence';
import { isTagWord, parseName } from './parse-name';
import type { ParsedName } from './parse-name';
import { SourceUnavailable } from './sources';
import type { Entry, MetadataSource } from './sources';

type Via = 'disc-title' | 'folder' | 'discdb';

/**
 * One disc's result. For a filed disc, `season` is:
 * - TMDB TV: the season number from the evidence;
 * - AniList TV/TV_SHORT: the entry's place in its chain of TV prequels (1 for an entry with none);
 * - AniList MOVIE/OVA/ONA/SPECIAL and any movie: null, since these are their own rows under the title;
 * - a bonus disc whose season isn't resolved: null, meaning the title's extras. `bonus` tells this apart from the above.
 */
export type DiscMatch =
  | { readonly discId: string; readonly status: 'filed'; readonly entryId: string; readonly season: number | null; readonly disc: number | null; readonly bonus: boolean; readonly via: readonly Via[] }
  | { readonly discId: string; readonly status: 'music'; readonly group: string; readonly name: string }
  | {
    readonly discId: string; readonly status: 'unsorted'; readonly reason: UnsortedReason;
    readonly suggestions: readonly string[]; // entry ids, up to 3
    /** The season the matcher worked out for a suggestion (see `season` above), by entry id, when it did. */
    readonly seasons?: Readonly<Record<string, number>>;
  };

/** What `matchDiscs` needs from its host: the sources, the lookup cache and a progress hook. */
export interface MatchContext {
  /** AniList. */
  readonly anilist: MetadataSource;
  /** TMDB; null without an API key, when only AniList is used. */
  readonly tmdb: MetadataSource | null;
  /** TheDiscDB's index, looked up by a disc's content fingerprint. */
  readonly discdb: { lookup(fp: string): DiscDbHit | null };
  /** Search results by source and normalised query (and AniList entries by id), so lookups happen once per run. */
  readonly cache: Map<string, Entry[]>;
  /**
   * Called as each group (a parent folder) is done, for progress, with that group's discs' matches so far (rule 4 is
   * applied to the groups done) and the entries they name, so a long run can save its progress.
   */
  readonly onGroupDone?: (progress: () => { matches: DiscMatch[]; entries: Map<string, Entry> }) => void | Promise<void>;
}

/** The result of a run. `aborted`: the sources failed for CIRCUIT_BREAKER groups in a row, so the run stopped. */
export interface MatchResult {
  /** One match per disc handled. */
  readonly matches: DiscMatch[];
  /** The metadata entries the matches and their suggestions name, by id. */
  readonly entries: Map<string, Entry>;
  readonly aborted: boolean;
}

/**
 * How well a candidate fits an entry. EXACT: the candidate equals one of the entry's names under `normalizeStrict` (or
 * as romaji without macrons, `Kori` for `Kōri`), or equals a name with its structure stripped (`Brasswick Season 2` →
 * `Brasswick`) and the stripped season agrees with the evidence's. BASE (a partial fit): it equals a stripped name
 * otherwise, or a name only under `normalizeTitle`'s vowel and kana folding (`Good`/`God`), so it is never proof alone.
 */
const EXACT = 2;
const BASE = 1;
/** A parse's later candidates (a stripped variant, the un-stripped `X 2`) are less certain: they score at most BASE. */
const LATER_CANDIDATE_MAX = BASE;
/**
 * A rival entry "comes close" (rule 1) when its score is at least this share of the best entry's score. Scores are
 * small sums of EXACT and BASE over the pieces of evidence, so a rival fitting the same pieces with only BASE fits
 * (half of EXACT) still comes close, and an equal score, a tie, always does.
 */
const COMES_CLOSE_RATIO = 0.5;
/** Years further apart than this mean a different entry, and two sources' entries aren't twins. */
const YEAR_SLACK = 1;
/** A TMDB series may be dated by an early special: its first-air year may be this far before an AniList chain root's. */
const TMDB_TV_EARLY = 3;
/** Suggestions offered with an Unsorted disc. */
const MAX_SUGGESTIONS = 3;
/** Folder evidence goes at most this many folders above the disc folder. */
const MAX_ANCESTORS = 2;
/**
 * Folders this many levels above the disc folder or more (above its parent) may support a match but are never its only
 * evidence.
 */
const FAR_ANCESTOR = 2;
/**
 * The root's top-level folders: evidence like any folder, but like any folder the only evidence just when the disc
 * folder sits right under it; two or more levels up it only supports other evidence.
 */
const TOP_LEVEL_DEPTH = 0;
/**
 * The matching rules' version. Bump it whenever the matching rules change (what files, where, or as what): the title
 * service then re-matches every disc on its next run, from its lookup cache, so the library follows the new rules.
 */
export const MATCH_RULES_VERSION = 4;
/** Groups failing in a row (SourceUnavailable) before a run stops, leaving the rest for the next run. */
export const CIRCUIT_BREAKER = 5;
/** Prequel links followed to find an AniList entry's place in its chain. */
const MAX_CHAIN = 20;

/** Category names that are never candidates, in folder names or disc titles. */
const CATEGORIES = new Set([
  'Film', 'Films', 'Movie', 'Movies', 'TV', 'TV Shows', 'Show', 'Shows', 'Series', 'Drama', 'Dramas', 'Anime', 'Animation', 'Animated',
  'Documentaries', 'Docs', 'Music', 'Concerts', 'Live', 'Video', 'Videos', 'Media', 'Collection', 'Collections', 'Library', 'Misc',
  'Other', 'Others', 'New', 'Old', 'Archive', 'Backup', 'Rips', 'Remux', 'Downloads', 'Discs', 'BDMVs', 'Blu-ray', 'Blu-rays',
  'BluRay', 'BD', 'DVD', 'UHD', '4K', 'Kids', 'Family', '映画', 'アニメ', 'ドラマ', '音楽', '特撮',
].map(normalizeStrict));

/** `Vol.1-6`, `Disc 1~4`-like folder notes: the release's disc count. */
const RELEASE_COUNT = /(?:\bvol(?:ume)?|\bdis[ck]|\bbd)\.?\s*0*1\s*[-~〜]\s*0*(\d{1,2})\b/i;
const MACRON = /[āīūēō]/;
const MACRONS: Readonly<Record<string, string>> = { ā: 'a', ī: 'i', ū: 'u', ē: 'e', ō: 'o' };
const ASCII = /^[\x00-\x7f]*$/;
const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/**
 * Sequel markers in an AniList name, besides the seasons parseName reads (`2nd Season`, `Season 2`, `第2期`): `Part N`,
 * `Final Season`, `Second Season`, `Cour N`, `Nth Cour`, `第Nクール` (N > 1), `Zoku`, `続`, `完結編`.
 */
const SEQUEL_MARK = new RegExp([
  '\\bpart\\s*0*(?:[2-9]|\\d{2,})\\b',
  '\\bfinal\\s+season\\b',
  '\\b(?:second|third|fourth|fifth)\\s+(?:season|cour)\\b',
  '\\bcour\\s*0*(?:[2-9]|\\d{2,})\\b',
  '\\b(?:[2-9]|\\d{2,})(?:nd|rd|th)\\s+cour\\b',
  '第\\s*0*(?:[2-9]|\\d{2,})\\s*クール',
  '\\bzoku\\b',
  '(?:^|[\\s・:])続(?=[\\s・:]|$)',
  '完結編',
].join('|'), 'i');
/** Roman sequel numerals, upper case only so that words aren't taken for them. */
const SEQUEL_ROMAN = /\b(?:II|III|IV)\b/;
const TV_FORMATS = new Set(['TV', 'TV_SHORT']);
/** AniList entries that a related TV entry beats when the evidence is series-shaped. */
const SIDE_FORMATS = new Set(['OVA', 'ONA', 'SPECIAL', 'TV_SHORT']);
/** Relations that tie an AniList entry to a series' story; CHARACTER, ALTERNATIVE, OTHER and the like don't (as in the catalogue). */
const STORY_LINKS = new Set(['SEQUEL', 'PREQUEL', 'PARENT', 'SIDE_STORY', 'SUMMARY']);
/** AniList formats whose entry can be the twin of a TMDB movie. */
const FILM_FORMATS = new Set(['MOVIE', 'SPECIAL', 'OVA']);
/** A disc folder's label that names only a disc (`BD`, `BDROM`, `BD_VIDEO`, `DISC_2`); `Blu-ray`, `DVD` and such are categories. */
const STRUCTURE_LABEL = /^(?:BD(?:[ _-]?(?:ROM|VIDEO))?|DIS[CK])(?:[ _.-]?\d{1,3})?$/i;
/** A disc folder's label: capitals, digits and underscores (`100M_FEATURE`, `TO_BE_HERO_X_V4_D2`), with a letter. */
const DISC_LABEL = /^(?=.*[A-Z])(?=.*_)[A-Z0-9_]+$/;
/** A disc folder's generic label with no number, which takes its release folder's volume. */
const GENERIC_DISC = /^(?:BD(?:[ _-]?(?:ROM|VIDEO))?|BDMV|DIS[CK]|VIDEO)$/i;
/** Genres besides anime that can share a bracket with the anime tag. */
const OTHER_GENRES = /^(?:ドラマ|drama|実写|live|特撮|action)$/i;
/** Common kanji variants (itaiji) folded to one form, as disc titles and metadata spell names either way. */
const KANJI_VARIANTS: Readonly<Record<string, string>> = {
  弍: '弐', 髙: '高', 﨑: '崎', 嵜: '崎', 邊: '辺', 邉: '辺', 齊: '斉', 齋: '斎', 濱: '浜', 澤: '沢', 國: '国', 實: '実',
  圓: '円', 櫻: '桜', 學: '学', 聲: '声', 廣: '広', 嶋: '島', 嶌: '島', 惠: '恵', 眞: '真', 萬: '万', 會: '会', 體: '体', 鐵: '鉄',
  傳: '伝', 氣: '気', 劍: '剣', 劒: '剣', 剱: '剣', 劔: '剣', 號: '号', 黑: '黒', 靑: '青', 戀: '恋', 藝: '芸', 舊: '旧', 繪: '絵',
  應: '応', 驛: '駅', 樂: '楽', 對: '対', 戰: '戦', 獸: '獣', 稻: '稲', 莊: '荘', 龜: '亀', 鬪: '闘', 鬥: '闘', 曉: '暁',
};
const KANJI_VARIANT = new RegExp(`[${Object.keys(KANJI_VARIANTS).join('')}]`, 'gu');

/** No Blu-ray disc came out before this (YYYYMMDD): an earlier "date" is some other number. */
const BLU_RAY_FIRST = 20060601;

/**
 * The disc's release date as YYYYMMDD, from a bracketed `[YYMMDD]` (20YY) or `[YYYYMMDD]` on the disc folder or the
 * two folders above it, nearest first; only a valid date from 2006-06-01 on that isn't in the future.
 */
function releaseDate(segments: readonly string[]): number | null {
  const today = new Date();
  const now = today.getFullYear() * 10_000 + (today.getMonth() + 1) * 100 + today.getDate();
  for (const seg of segments.slice(-3).reverse()) {
    for (const m of seg.normalize('NFKC').matchAll(/[[【](\d{6}|\d{8})[\]】]/g)) {
      const d = m[1]!;
      const [y, mo, da] = d.length === 6 ? [2000 + Number(d.slice(0, 2)), Number(d.slice(2, 4)), Number(d.slice(4, 6))] : [Number(d.slice(0, 4)), Number(d.slice(4, 6)), Number(d.slice(6, 8))];
      const date = new Date(Date.UTC(y, mo - 1, da));
      const valid = y >= 1900 && date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === da;
      const value = y * 10_000 + mo * 100 + da;
      if (valid && value <= now && value >= BLU_RAY_FIRST) return value;
    }
  }
  return null;
}

/**
 * Whether an entry started after a release date: by its start date (an unknown month or day, `00`, counts as the
 * earliest it could be), else by its year alone.
 */
function startedAfter(en: Entry, released: number): boolean {
  const start = en.startDate ?? (en.year !== null ? en.year * 10_000 : null);
  if (start === null) return false;
  const month = Math.floor(start / 100) % 100;
  const day = start % 100;
  // compare at the precision the start date has
  if (month === 0) return Math.floor(start / 10_000) > Math.floor(released / 10_000);
  if (day === 0) return Math.floor(start / 100) > Math.floor(released / 100);
  return start > released;
}

/** The discs under a folder, in its subfolders too, leaving out those in or named as a bonus folder. */
function discsUnder(folder: string, evidence: readonly DiscEvidence[]): number {
  const depth = folder === '' ? 0 : folder.split('/').length;
  return evidence.filter((e) => e.path.startsWith(`${folder}/`) && !e.path.split('/').slice(depth).some((seg) => parseName(seg).bonus)).length;
}

/** The parent folder path of the disc folder or ISO. */
export function groupKey(e: DiscEvidence): string {
  const cut = e.path.lastIndexOf('/');
  return cut < 0 ? '' : e.path.slice(0, cut);
}

/** One name the evidence carries: a disc title, a folder segment or a TheDiscDB hit, and what lookups found for it. */
interface Piece {
  readonly kind: Via;
  readonly own: boolean; // the disc's own title or folder, not an ancestor's
  readonly far: boolean; // a folder FAR_ANCESTOR or more levels above the disc folder
  readonly label?: boolean; // the disc folder's label (`GLASS_ORCHARD_D1`): a weak candidate
  readonly parse: ParsedName;
  readonly found: Entry[];
  readonly hit?: DiscDbHit;
}

interface Scored {
  readonly entry: Entry;
  readonly score: number;
  readonly exact: boolean;
  readonly kinds: ReadonlySet<Via>;
}

type Compat = { readonly ok: true; readonly season: number | null } | { readonly ok: false; readonly unresolved: boolean };

/** A disc that passed rules 1-3, waiting for rule 4 (its place). */
interface Pending {
  readonly e: DiscEvidence;
  readonly group: string;
  readonly releaseCount: number | null;
  readonly entry: Entry;
  readonly season: number | null;
  readonly disc: number | null;
  readonly box: number | null;
  readonly bonus: boolean;
  readonly via: readonly Via[];
  /**
   * `box` is a volume, numbered across the volumes like boxes: of a `Volume M/Disc K` folder pair, or of a
   * name carrying both (`Title Vol.1 Disc 2`, `第8巻 DISC2`).
   */
  readonly volumeBox: boolean;
  /** The folder the disc's box family shares (see `boxFamily`); a volume in the disc's own name: its group folder. */
  readonly family: string;
  /** Placed like a movie: an AniList entry whose twin is a TMDB movie. */
  readonly filmLike: boolean;
  /** Where the disc's own number (`disc`) came from: its own volume number or its own disc number. */
  readonly numberFrom: 'volume' | 'disc' | null;
  /** The disc's numbers can't be read into a place (a volume-and-disc name inside a box): it has none. */
  readonly unplaceable: boolean;
  /** Numbered by its release folder's volume, as a generic disc folder. */
  readonly fromParent: boolean;
  /** For such a disc: the discs under its release folder, subfolders included, whatever their match, bonus ones left out. */
  readonly folderDiscs: number;
}

const naturalOrder = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });
const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Matches every disc in `evidence` to a metadata entry, a music grouping or Unsorted, group by group (a
 * group is a parent folder). Source lookups go through `ctx.cache`, so each query is made once per run. When the sources
 * fail for `CIRCUIT_BREAKER` groups in a row, the run stops early with `aborted` set and the remaining groups are left
 * for the next run. It does not touch the disk; `ctx.onGroupDone` is how a caller saves progress.
 */
export async function matchDiscs(evidence: readonly DiscEvidence[], ctx: MatchContext): Promise<MatchResult> {
  const groups = new Map<string, DiscEvidence[]>();
  for (const e of evidence) {
    const key = groupKey(e);
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const byDisc = new Map<string, DiscMatch>();
  const entries = new Map<string, Entry>();
  const pending: Pending[] = [];
  /** Groups matched in this run; one that failed or wasn't reached isn't. */
  const matched = new Set<string>();
  // a disc of box 2 and up is numbered only once every group of its box family is matched, so a checkpoint (or a run
  // that lost a group to an unreachable source) never files one that the whole family would leave Unsorted
  const familyMatched = (p: Pending): boolean => {
    const prefix = p.family;
    for (const g of groups.keys()) if ((prefix === '' || g === prefix || g.startsWith(`${prefix}/`)) && !matched.has(g)) return false;
    return true;
  };
  const unreachable = (e: DiscEvidence): DiscMatch => ({ discId: e.discId, status: 'unsorted', reason: 'source-unreachable', suggestions: [] });
  const progress = (): { matches: DiscMatch[]; entries: Map<string, Entry> } => {
    const placed = new Map(entries);
    const out = new Map(byDisc);
    for (const m of placeDiscs(pending, placed, familyMatched)) out.set(m.discId, m);
    return { matches: [...out.values()], entries: placed };
  };
  let failures = 0;
  let aborted = false;
  for (const [key, discs] of groups) {
    if (aborted) {
      for (const e of discs) byDisc.set(e.discId, unreachable(e));
      continue;
    }
    const lookup: DiscEvidence[] = [];
    for (const e of discs) {
      const music = musicRelease(e);
      if (music) byDisc.set(e.discId, { discId: e.discId, status: 'music', group: music, name: lastSegment(music) });
      else lookup.push(e);
    }
    if (lookup.length > 0) {
      try {
        const r = await matchGroup(key, lookup, ctx, entries, evidence);
        for (const m of r.done) byDisc.set(m.discId, m);
        pending.push(...r.pending);
        matched.add(key);
        failures = 0;
      } catch (err) {
        if (!(err instanceof SourceUnavailable)) throw err;
        for (const e of lookup) byDisc.set(e.discId, unreachable(e));
        aborted = ++failures >= CIRCUIT_BREAKER;
      }
    } else {
      matched.add(key);
    }
    await ctx.onGroupDone?.(progress);
  }
  for (const m of placeDiscs(pending, entries, familyMatched)) byDisc.set(m.discId, m);
  return { matches: evidence.map((e) => byDisc.get(e.discId)!), entries, aborted };
}

/**
 * The folder a disc's box family shares: the parent of the deepest folder on its path that names a box (`Brasswick BOX
 * 2`), or for a volume numbered like a box, of the deepest folder above the disc folder that names a volume; or ''
 * (the whole run) when no folder does.
 */
function boxFamily(path: string, volumeBox: boolean): string {
  const parts = path.split('/');
  for (let j = parts.length - (volumeBox ? 2 : 1); j > 0; j--) {
    const parse = parseName(parts[j]!);
    if ((volumeBox ? parse.volume : parse.box) !== null) return parts.slice(0, j).join('/');
  }
  return '';
}

/**
 * A folder that names only structure, a season, volume, disc or box (`Season 1`, `Volume 2`, `Vol.4`, `Box 1`,
 * `DISC_2`, `BD`), and no title: it isn't a level when deciding how far up a folder is.
 */
function structureOnly(text: string): boolean {
  const p = parseName(text);
  if (p.candidates.length > 0 || p.bonus || p.music || p.year !== null || p.episodes !== null) return false;
  return p.season !== null || p.volume !== null || p.disc !== null || p.box !== null || STRUCTURE_LABEL.test(text.normalize('NFKC').trim());
}

/**
 * The release folder of a music disc, or null when the disc isn't music: the deepest segment whose name shows a CD-plus-BD
 * release, else, under a `Music` folder, the disc's parent folder (or the disc folder itself when its parent is `Music`).
 */
export function musicRelease(e: DiscEvidence): string | null {
  const segs = e.segments;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (parseName(segs[i]!).music) return segs.slice(0, i + 1).join('/');
  }
  const underMusic = segs.slice(0, -1).some((s) => s.trim().toLowerCase() === 'music');
  if (!underMusic && !e.discTitles.some((t) => parseName(t.name).music)) return null;
  const parent = segs.length - 2;
  const parentIsShelf = parent < 0 || segs[parent]!.trim().toLowerCase() === 'music';
  return segs.slice(0, parentIsShelf ? segs.length : segs.length - 1).join('/');
}

/** A folder name's or disc title's parse, without candidates that are category names. */
function nameParse(text: string): ParsedName {
  const parse = parseName(text);
  return { ...parse, candidates: parse.candidates.filter((c) => !CATEGORIES.has(normalizeStrict(c))) };
}

async function matchGroup(group: string, discs: readonly DiscEvidence[], ctx: MatchContext, entries: Map<string, Entry>, evidence: readonly DiscEvidence[]):
  Promise<{ done: DiscMatch[]; pending: Pending[] }> {
  const search = async (source: string, src: MetadataSource, query: string, year: number | null): Promise<Entry[]> => {
    // keyed strictly, so `God X` doesn't reuse what `Good X` found
    const key = `${source}:${normalizeStrict(query)}${year === null ? '' : `:${year}`}`;
    let hit = ctx.cache.get(key);
    if (!hit) {
      hit = await src.search(query, year === null ? undefined : { year });
      ctx.cache.set(key, hit);
    }
    return hit;
  };
  /** Every candidate on AniList, and on TMDB too when there is a key, so a same-titled live-action entry is seen. */
  const lookUp = async (parse: ParsedName): Promise<Entry[]> => {
    const found: Entry[] = [];
    for (const cand of parse.candidates) {
      if (normalizeTitle(cand) === '') continue;
      found.push(...(await search('anilist', ctx.anilist, cand, parse.year)));
      if (ctx.tmdb) found.push(...(await search('tmdb', ctx.tmdb, cand, parse.year)));
    }
    return found;
  };

  // folders above the discs, from the group folder up to the first one that names something, at most MAX_ANCESTORS
  // levels up; a root's top-level folder counts (category names are dropped by nameParse), and is far like any other
  //; a folder naming only structure (`Season 1`, `Volume 2`) isn't a level for the folders above it
  const segs = discs[0]!.segments;
  const ancestors: Piece[] = [];
  const ancestorText: string[] = [];
  let level = 0;
  for (let i = segs.length - 2; i >= TOP_LEVEL_DEPTH && ++level <= MAX_ANCESTORS; i--) {
    const parse = nameParse(segs[i]!);
    const found = await lookUp(parse);
    ancestors.push({ kind: 'folder', own: false, far: level >= FAR_ANCESTOR, parse, found });
    ancestorText.push(segs[i]!.normalize('NFKC'));
    if (found.some((en) => parse.candidates.some((c) => quality(en, c, parse.season) > 0))) break;
    if (structureOnly(segs[i]!)) level--;
  }
  const count = ancestorText.map((t) => RELEASE_COUNT.exec(t)?.[1]).find((n) => n !== undefined);
  const releaseCount = count === undefined ? null : Number(count);

  const done: DiscMatch[] = [];
  const pending: Pending[] = [];
  for (const e of discs) {
    const own: Piece[] = [];
    for (const t of e.discTitles) {
      const parse = nameParse(t.name);
      own.push({ kind: 'disc-title', own: true, far: false, parse, found: await lookUp(parse) });
    }
    const segParse = nameParse(e.segments[e.segments.length - 1] ?? '');
    const segment = e.segments[e.segments.length - 1] ?? '';
    own.push({ kind: 'folder', own: true, far: false, label: DISC_LABEL.test(segment), parse: segParse, found: await lookUp(segParse) });
    const named = [...own, ...ancestors];

    const hit = e.fingerprint ? ctx.discdb.lookup(e.fingerprint) : null;
    const pieces = [...named];
    if (hit) {
      // TheDiscDB's title is looked up only when nothing else names an entry: it confirms, or stands unopposed
      const parse = parseName(hit.title);
      const nothingElse = !named.some((p) => p.found.some((en) => fit(p, en, null) > 0));
      pieces.push({ kind: 'discdb', own: true, far: false, parse, hit, found: nothingElse ? await lookUp(parse) : [] });
    }

    const result = await decide(e, pieces, hit, discs.length, ctx, entries);
    if ('status' in result) done.push(result);
    else pending.push({ ...result, group, releaseCount, folderDiscs: result.fromParent ? discsUnder(group, evidence) : 1 });
  }
  return { done, pending };
}

/**
 * Rules 1-3 for one disc: an Unsorted match, or the entry and season waiting for rule 4. `siblings`: the discs in the
 * disc's group, itself included.
 */
async function decide(e: DiscEvidence, given: readonly Piece[], hit: DiscDbHit | null, siblings: number, ctx: MatchContext, entries: Map<string, Entry>):
  Promise<DiscMatch | Omit<Pending, 'group' | 'releaseCount' | 'folderDiscs'>> {
  // a disc folder's label is set aside, when other evidence fits an entry, if its own exact fits are ambiguous (two or
  // more entries) or include an entry the other evidence fits: it adds nothing then. A label naming exactly one entry
  // that nothing else fits is kept, so a misplaced disc shows as a disagreement. Its disc number always counts
  //
  const otherFits = new Set(given.flatMap((p) => (p.label ? [] : p.found.filter((en) => fit(p, en, null) > 0).map((en) => en.id))));
  const setAside = (p: Piece): boolean => {
    const exact = new Set(p.found.filter((en) => fit(p, en, null) === EXACT).map((en) => en.id));
    return exact.size >= 2 || [...exact].some((id) => otherFits.has(id));
  };
  const pieces = otherFits.size > 0 ? given.map((p) => (p.label && setAside(p) ? { ...p, parse: { ...p.parse, candidates: [] }, found: [] } : p)) : given;
  const compat = new Map<string, Compat>();
  const unsorted = (reason: UnsortedReason, suggest: readonly Entry[]): DiscMatch => {
    const ids = [...new Set(suggest.map((en) => en.id))].slice(0, MAX_SUGGESTIONS);
    for (const en of suggest) if (ids.includes(en.id)) entries.set(en.id, en);
    const seasons: Record<string, number> = {};
    for (const id of ids) {
      const c = compat.get(id);
      if (c?.ok && c.season !== null) seasons[id] = c.season;
    }
    return { discId: e.discId, status: 'unsorted', reason, suggestions: ids, ...(Object.keys(seasons).length > 0 ? { seasons } : {}) };
  };
  const named = pieces.filter((p) => p.kind !== 'discdb');

  const seasonsSeen = new Set<number>();
  for (const p of named) if (p.parse.season !== null) seasonsSeen.add(p.parse.season);
  if (hit?.season != null) seasonsSeen.add(hit.season);
  const evSeason: number | null | 'conflict' = seasonsSeen.size > 1 ? 'conflict' : seasonsSeen.size === 1 ? [...seasonsSeen][0]! : null;
  const fitSeason = evSeason === 'conflict' ? null : evSeason;
  const years = named.map((p) => p.parse.year).filter((y): y is number => y !== null);
  if (hit?.year != null) years.push(hit.year);

  // everything the lookups found, before the year, season and format filters; an entry that started after the disc's
  // release date (`[170426]` on its release folder) can't be on it, and is no fit at all, when an entry
  // of its story that started in time is there too (a later season against the first): an unrelated
  // same-named entry, an original or a remake, still competes
  const released = releaseDate(e.segments);
  const all = new Map<string, Entry>();
  for (const p of pieces) for (const en of p.found) all.set(en.id, en);
  if (released !== null) {
    const late = [...all.values()].filter((en) => startedAfter(en, released));
    const inTime = [...all.values()].filter((en) => !startedAfter(en, released));
    for (const en of late) if (inTime.some((o) => storyLinked(o, en))) all.delete(en.id);
  }
  let scored: Scored[] = [];
  for (const en of all.values()) {
    if (!yearFits(en, years)) continue;
    let score = 0;
    let exact = false;
    const kinds = new Set<Via>();
    for (const p of pieces) {
      const q = fit(p, en, fitSeason);
      if (q === 0) continue;
      score += q;
      exact ||= q === EXACT;
      kinds.add(p.kind);
    }
    if (score > 0) scored.push({ entry: en, score, exact, kinds });
  }
  // TMDB's search answers have no seasons: each fitting TMDB series is fetched by id, and the full entry is used from
  // here on, so the season checks and the catalogue see its seasons
  for (const [i, s] of scored.entries()) {
    if (s.entry.source !== 'tmdb' || s.entry.kind !== 'series') continue;
    const full = await tmdbEntry(s.entry, ctx);
    all.set(full.id, full);
    scored[i] = { ...s, entry: full };
  }
  // series-shaped evidence (a season number, an episode range, or a volume number among two or more sibling discs) is
  // no film's: TMDB and AniList movies aren't competitors there once a series fits, and an exactly fitting AniList TV
  // entry beats the OVA, ONA, SPECIAL and TV_SHORT entries tied to it by a story link; disc numbers alone
  // never make it so, since a film comes on two discs too; a film whose own name carries a volume
  // (`Blade Night: Vol. 1`) may be what the volumes are, so it still competes
  const filmOut = (en: Entry): boolean => en.kind === 'movie' && !names(en).some((n) => parseName(n).volume !== null);
  const seriesShaped = evSeason !== null || named.some((p) => p.parse.episodes !== null) ||
    (siblings >= 2 && named.some((p) => p.parse.volume !== null));
  const filmsOut = seriesShaped && scored.some((s) => s.entry.kind !== 'movie');
  const dropped = new Set<string>();
  if (seriesShaped) {
    if (filmsOut) for (const s of scored) if (filmOut(s.entry)) dropped.add(s.entry.id);
    const tv = scored.filter((s) => s.exact && s.entry.source === 'anilist' && TV_FORMATS.has(s.entry.format ?? '') && !dropped.has(s.entry.id));
    for (const s of scored) {
      const side = s.entry.source === 'anilist' && SIDE_FORMATS.has(s.entry.format ?? '');
      if (side && tv.some((t) => t.entry.id !== s.entry.id && (t.entry.format === 'TV' || s.entry.format !== 'TV_SHORT') && storyLinked(t.entry, s.entry))) dropped.add(s.entry.id);
    }
    scored = scored.filter((s) => !dropped.has(s.entry.id));
  }
  // the anime tag (`[アニメ]`, `[Anime]` on any folder): a live-action entry is no fit
  if (e.segments.some(animeTagged)) for (const en of all.values()) if (en.animation === false) dropped.add(en.id);
  // Japanese evidence decides: an entry whose Japanese names are all other titles than the evidence's
  // Japanese ones (not even with a season stripped, or under kana folding) is no competitor to a fitting entry whose
  // Japanese name the evidence names strictly, provided that entry fits every candidate the dropped one fits, so a
  // folder's mismatched `English (日本語)` halves stay several-fit. Entries with no Japanese name are left alone,
  // and with no entry named so, nothing is dropped.
  const candidates = [...new Set(named.flatMap((p) => p.parse.candidates))];
  const japaneseTitles = candidates.filter((c) => JAPANESE.test(c));
  const japaneseNames = (en: Entry): string[] => [en.names.native, ...en.names.synonyms].filter((n): n is string => n !== null && JAPANESE.test(n));
  const namedStrictly = (en: Entry): boolean => japaneseNames(en).some((n) => japaneseTitles.some((c) => sameTitle(c, n)));
  // for keeping competitors in, a name holding the other at all (`劇場版 X`, `X2`, `新X`, `X冬の章`) is the same title
  // too: leniency here only leaves the disc several-fit
  const namedLoosely = (en: Entry): boolean => japaneseNames(en).some((n) => japaneseTitles.some((c) => {
    const base = parseName(n).candidates[0] ?? n;
    const sc = folded(c);
    const sn = folded(n);
    const holds = sc !== '' && sn !== '' && (sc.includes(sn) || sn.includes(sc)); // kanji variants folded too
    return holds || sameTitle(c, n) || sameTitle(c, base) || foldedTitle(c, n) || foldedTitle(c, base);
  }));
  // for a lone fit, a Japanese name agrees with a Japanese title it holds or is held in, after kana and kanji-variant
  // folds, since disc titles are noisy (extra words such as `本編` or `BOX`, truncation, itaiji); only no containment
  // at all contradicts it
  const agreesInJapanese = (en: Entry): boolean => japaneseNames(en).some((n) => japaneseTitles.some((c) => {
    const fc = folded(c);
    const fn = folded(n);
    return fc !== '' && fn !== '' && (fc.includes(fn) || fn.includes(fc));
  }));
  const fitsOf = (en: Entry): string[] => candidates.filter((c) => quality(en, c, fitSeason) > 0);
  if (japaneseTitles.length > 0) {
    const named = scored.filter((s) => !dropped.has(s.entry.id) && namedStrictly(s.entry)).map((s) => new Set(fitsOf(s.entry)));
    for (const en of all.values()) {
      if (japaneseNames(en).length === 0 || namedLoosely(en)) continue;
      const own = fitsOf(en);
      if (named.some((fits) => own.every((c) => fits.has(c)))) dropped.add(en.id);
    }
  }
  // an AniList series with no start year (not aired yet) is no competitor to a dated entry of its franchise
  for (const s of scored) {
    const en = s.entry;
    if (en.source !== 'anilist' || en.kind !== 'series' || en.year !== null) continue;
    if (scored.some((o) => o !== s && !dropped.has(o.entry.id) && o.entry.year !== null && o.entry.source === 'anilist' && storyLinked(o.entry, en))) dropped.add(en.id);
  }
  scored = scored.filter((s) => !dropped.has(s.entry.id));
  // an exactly fitting AniList entry wins over TMDB only when every TMDB entry titled like the evidence, of any year
  // the evidence's year allows (any when it has none), is its animated twin; any other same-titled TMDB entry (live action, unknown genre, another kind or year) means the
  // evidence may be that one; and a twin is exactly one TMDB entry, so two twins of one AniList
  // entry mean one of them is another show
  const anilistExact = scored.filter((s) => s.entry.source === 'anilist' && s.exact).map((s) => s.entry);
  let twinIds = new Set<string>();
  let notTwins: Entry[] = [];
  let severalTwins: Entry[] = [];
  /** AniList entries whose twin is a TMDB movie. */
  const filmTwinned = new Set<string>();
  if (anilistExact.length > 0) {
    const info = new Map<string, TwinInfo>();
    for (const a of anilistExact) {
      const tv = a.kind === 'series' && TV_FORMATS.has(a.format ?? '');
      const place = tv ? await anilistPlace(a, ctx) : null;
      info.set(a.id, { tv, rootYear: place?.root?.year ?? null, place: place?.place ?? null });
    }
    const tmdb = [...all.values()].filter((en) => en.source === 'tmdb' && !dropped.has(en.id) && !(filmsOut && filmOut(en)));
    const titles = named.flatMap((p) => p.parse.candidates);
    // of any year when the evidence has none; with a year, one more than YEAR_SLACK off isn't a fit, so it no
    // longer blocks the AniList entry and its twin
    const evidenceTitled = tmdb.filter((t) => yearFits(t, years) && names(t).some((n) => titles.some((c) => sameTitle(c, n))));
    // TMDB entries named like an AniList entry in any of its languages, even when not like the evidence:
    // a live-action one in the year window may be what the disc holds
    const anilistTitled = tmdb.filter((t) => anilistExact.some((a) => seriesNames(a).some((x) => names(t).some((y) => sameTitle(x, y)))));
    const liveAction = anilistTitled.filter((t) => t.animation !== true && anilistExact.some((a) => inYearWindow(a, info.get(a.id)!.rootYear, t, true)));
    const twinsOf = new Map<string, Entry[]>();
    for (const a of anilistExact) {
      const found: Entry[] = [];
      for (const t of new Set([...evidenceTitled, ...anilistTitled])) if (await isTwin(a, info.get(a.id)!, t, named, fitSeason, ctx)) found.push(t);
      twinsOf.set(a.id, found);
    }
    const allTwins = new Set([...twinsOf.values()].flat());
    notTwins = [...new Set([...evidenceTitled.filter((t) => !allTwins.has(t)), ...liveAction])];
    const several = anilistExact.find((a) => twinsOf.get(a.id)!.length > 1);
    if (several) severalTwins = [several, ...twinsOf.get(several.id)!];
    else if (notTwins.length === 0) twinIds = new Set([...allTwins].map((t) => t.id));
    for (const [id, ts] of twinsOf) if (twinIds.size > 0 && ts.some((t) => t.kind === 'movie')) filmTwinned.add(id);
  }
  scored = scored.filter((s) => !twinIds.has(s.entry.id));
  if (scored.length === 0) return unsorted('no-title', []);

  for (const s of scored) compat.set(s.entry.id, await compatible(s.entry, evSeason, ctx));
  const fitting = scored.filter((s) => { const c = compat.get(s.entry.id)!; return c.ok || c.unresolved; }).sort((a, b) => b.score - a.score);
  // titles fit, but every one contradicts the evidence's season
  if (fitting.length === 0) return unsorted('no-season', scored.map((s) => s.entry));
  const best = fitting[0]!;
  const ranked = fitting.map((s) => s.entry);

  // two pieces of evidence naming different entries is a disagreement, never a pick: counted
  // over everything the lookups found, before the year, season and format filters, so no filter can hide it (twins
  // dropped above are the best entry's own title); a TheDiscDB hit that names none of the entries found counts too
  const universe = [...all.values()].filter((en) => !twinIds.has(en.id));
  const disagree = pieces.some((p) => {
    const fits = universe.filter((en) => fit(p, en, fitSeason) > 0);
    return fits.length > 0 ? !fits.includes(best.entry) : p.kind === 'discdb';
  });
  if (disagree) return unsorted('sources-disagree', [...ranked, ...universe.filter((en) => pieces.some((p) => fit(p, en, fitSeason) > 0))]);
  // a folder above the disc folder's parent may support a match but is never its only evidence
  if (!pieces.some((p) => !p.far && fit(p, best.entry, fitSeason) > 0)) return unsorted('no-title', [best.entry]);
  if (severalTwins.length > 0) return unsorted('several-fit', severalTwins);
  if (notTwins.length > 0) return unsorted('several-fit', [...ranked, ...notTwins]);
  // rule 1: exactly one entry fits, and no other comes close; AniList and TMDB each fitting exactly, without being
  // twins, fit different things
  const close = fitting.slice(1).some((s) => s.score >= best.score * COMES_CLOSE_RATIO || (s.exact && s.entry.source !== best.entry.source));
  if (close) return unsorted('several-fit', ranked);
  // rule 2: an exact fit, and two independent kinds of evidence agree, or the exact match has no competitor at all
  const competitor = fitting.length > 1;
  if (competitor && (!best.exact || best.kinds.size < 2)) return unsorted('several-fit', ranked);
  if (!best.exact) return unsorted(names(best.entry).some((n) => parseName(n).season !== null) ? 'no-season' : 'no-title', ranked);
  // the evidence's Japanese titles name something else than the entry's Japanese names: the disc may be another work
  // of the same name, so it isn't filed
  if (japaneseTitles.length > 0 && japaneseNames(best.entry).length > 0 && !agreesInJapanese(best.entry)) return unsorted('sources-disagree', [best.entry]);

  const bonus = named.some((p) => p.parse.bonus);
  // rule 3: the season or movie is resolved; a bonus disc without a season goes to the title's extras
  const c = compat.get(best.entry.id)!;
  if (!c.ok && !bonus) return unsorted('no-season', [best.entry]);
  const season = c.ok ? c.season : null;
  const episodes = named.find((p) => p.parse.episodes !== null)?.parse.episodes ?? null;
  const count = episodeCount(best.entry, season);
  if (!bonus && episodes !== null && count !== null && episodes[1] > count) return unsorted('episode-past-season', [best.entry]);

  // a generic disc folder (`BDROM`) in a single disc's release folder (`[BDMV][Title][Vol.2][JPN]`) takes that folder's
  // volume as its own; a range (`Vol.1-6`) parses as no volume
  const parent = named.find((p) => !p.own && p.kind === 'folder');
  const generic = GENERIC_DISC.test(lastSegment(e.path).normalize('NFKC').trim()) && parent !== undefined && parent.parse.volume !== null &&
    parent.parse.disc === null && parent.parse.box === null; // a parent naming a disc or box too is no single-disc release
  const own = generic
    ? [...named.filter((p) => p.own), { ...parent, own: true, parse: { ...parent.parse, disc: null } }]
    : named.filter((p) => p.own);
  const box = named.find((p) => p.parse.box !== null)?.parse.box ?? null;
  const via = (['disc-title', 'folder', 'discdb'] as const).filter((k) => best.kinds.has(k));
  const ownVolumes = new Set(own.map((p) => p.parse.volume).filter((n): n is number => n !== null));
  const ownDiscs = new Set(own.map((p) => p.parse.disc).filter((n): n is number => n !== null));
  const base = { e, entry: best.entry, season, bonus, via, filmLike: filmTwinned.has(best.entry.id), unplaceable: false, fromParent: false };
  // inside a box, a name with a volume and a disc number has three numbers and no rule to place it by
  if (box !== null && own.some((p) => p.parse.volume !== null && p.parse.disc !== null)) {
    return { ...base, disc: null, box, volumeBox: false, family: boxFamily(e.path, false), numberFrom: null, unplaceable: true };
  }
  // a name carrying a volume and a disc number (`Title Vol.1 Disc 2`): the volume is a box, numbered across the
  // volumes like `Volume M/Disc K` folders, within the group folder
  if (box === null && own.some((p) => p.parse.volume !== null && p.parse.disc !== null)) {
    const one = ownVolumes.size === 1 && ownDiscs.size === 1;
    return { ...base, disc: one ? [...ownDiscs][0]! : null, box: one ? [...ownVolumes][0]! : null, volumeBox: one, family: groupKey(e), numberFrom: null };
  }
  const numbers = new Set(own.map((p) => p.parse.volume ?? p.parse.disc).filter((n): n is number => n !== null));
  // a `Volume M/Disc K` pair: the volume numbers the discs across the volumes, like a box, so Disc 1 of
  // Volume 2 never shares a slot with Disc 1 of Volume 1
  const volume = box === null && ownVolumes.size === 0 && ownDiscs.size > 0
    ? named.find((p) => !p.own && p.kind === 'folder' && p.parse.volume !== null)?.parse.volume ?? null
    : null;
  return {
    ...base, disc: numbers.size === 1 ? [...numbers][0]! : null, box: box ?? volume,
    volumeBox: volume !== null, family: boxFamily(e.path, volume !== null), fromParent: generic && numbers.size === 1,
    numberFrom: numbers.size !== 1 ? null : ownVolumes.size > 0 ? 'volume' : 'disc',
  };
}

/**
 * Rule 4: each disc's place. Its own number counts. In a box set, discs are numbered across the boxes in (box, disc)
 * order, only when every box from 1 up is present and each box's disc numbers run from 1 with no gap;
 * otherwise discs of box 2 and up have no place. Volumes holding numbered discs count as boxes. Unnumbered
 * discs are numbered in folder order when their group folder gives the release's disc count and they are exactly that
 * many. A bonus disc needs no number, nor does a movie (or an AniList entry whose twin is a TMDB movie) that is the
 * only disc of its entry in its group. A disc of box 2 and up waits for `familyMatched`.
 */
function placeDiscs(pending: readonly Pending[], entries: Map<string, Entry>, familyMatched: (p: Pending) => boolean): DiscMatch[] {
  const out: DiscMatch[] = [];
  const same = (a: Pending, b: Pending): boolean => !b.bonus && a.entry.id === b.entry.id && a.season === b.season;
  for (const p of pending) {
    entries.set(p.entry.id, p.entry);
    let disc: number | null = p.disc;
    let placed = p.bonus;
    if (!placed && p.unplaceable) {
      // no place
    } else if (!placed && p.box !== null && p.box > 1) {
      // boxes run within one family and one kind (volumes or boxes), so another edition or a box set never shifts them
      const boxed = pending.filter((q) => same(p, q) && q.box !== null && q.volumeBox === p.volumeBox && q.family === p.family);
      const running = familyMatched(p) ? boxRunning(boxed) : null;
      disc = running?.get(p) ?? null;
      placed = disc !== null;
    } else if (!placed && disc !== null) {
      placed = true;
    } else if (!placed) {
      const siblings = pending.filter((q) => same(p, q) && q.group === p.group && (q.box ?? 1) === 1).sort((a, b) => naturalOrder(a.e.path, b.e.path));
      if ((p.entry.kind === 'movie' || p.filmLike) && siblings.length === 1) placed = true;
      else if (p.releaseCount !== null && p.releaseCount === siblings.length && siblings.every((q) => q.disc === null)) {
        disc = siblings.indexOf(p) + 1;
        placed = true;
      }
    }
    out.push(placed
      ? { discId: p.e.discId, status: 'filed', entryId: p.entry.id, season: p.season, disc, bonus: p.bonus, via: p.via }
      : unnumbered(p));
  }
  // two discs in one slot whose numbers come from different schemes (`Volume 1/Disc 2` numbered across volumes, a
  // `Volume 2` disc folder by its own volume, `BD/Disc 2` by its own disc number, `Box 1/Disc 2` within its box), in
  // one group folder or two, can't both be right, and the catalogue would merge them as copies. Once two
  // origins clash, no disc of the entry and season numbered by either keeps its number, so a title never mixes
  // numbering schemes. Discs numbered the same way in one slot are copies or editions of one disc, as
  // before, and so are discs with the same content.
  const byId = new Map(pending.map((p) => [p.e.discId, p]));
  /** How a disc's number was read: across volumes, within a box, its own volume or disc number, or folder order. */
  const kind = (p: Pending): string =>
    p.volumeBox ? 'v' : p.box !== null ? 'b' : p.numberFrom === 'volume' ? 'own-vol' : p.numberFrom === 'disc' ? 'own-disc' : 'order';
  const scheme = (p: Pending): string => (p.box !== null ? `${kind(p)}${p.box}:${p.disc}` : kind(p));
  /** A numbering's origin: its kind, and for volumes or boxes numbered across, its family. */
  const origin = (p: Pending): string => (p.box !== null ? `${kind(p)}@${p.family}` : kind(p));
  const slotKey = (p: Pending): string => `${p.entry.id}\u0000${p.season}`;
  const numbered = out.flatMap((m) => (m.status === 'filed' && m.disc !== null && !m.bonus ? [{ m, p: byId.get(m.discId)! }] : []));
  const clashing = new Set<string>();
  for (const a of numbered) {
    for (const b of numbered) {
      if (a === b || a.m.entryId !== b.m.entryId || a.m.season !== b.m.season || a.m.disc !== b.m.disc || scheme(a.p) === scheme(b.p)) continue;
      if (a.p.e.fingerprint !== null && a.p.e.fingerprint === b.p.e.fingerprint) continue;
      clashing.add(`${slotKey(a.p)}\u0000${origin(a.p)}`);
    }
  }
  // and one numbering kind per entry and season, whatever the slots: `Volume 1/Disc 1` and a bare `Volume 2` can't both
  // be right, since `Disc 1` says Volume 1 has more discs
  const kinds = new Map<string, Set<string>>();
  for (const { p } of numbered) kinds.set(slotKey(p), (kinds.get(slotKey(p)) ?? new Set()).add(kind(p)));
  // a generic disc folder takes its release folder's volume only as that release's single disc: once any of those
  // folders holds another disc, whatever it matched, no disc numbered so keeps its number
  const shared = new Set<string>();
  for (const p of pending) if (p.fromParent && p.folderDiscs > 1) shared.add(slotKey(p));
  return out.map((m) => {
    if (m.status !== 'filed' || m.disc === null || m.bonus) return m;
    const p = byId.get(m.discId)!;
    const mixed = clashing.has(`${slotKey(p)}\u0000${origin(p)}`) || kinds.get(slotKey(p))!.size > 1;
    return mixed || (p.fromParent && shared.has(slotKey(p))) ? unnumbered(p) : m;
  });
}

function unnumbered(p: Pending): DiscMatch {
  return { discId: p.e.discId, status: 'unsorted', reason: 'no-disc-number', suggestions: [p.entry.id], ...(p.season !== null ? { seasons: { [p.entry.id]: p.season } } : {}) };
}

/** Running disc numbers across boxes 1..max, or null when a box is missing, a disc unnumbered or a box's numbers have a gap. */
function boxRunning(boxed: readonly Pending[]): Map<Pending, number> | null {
  const max = Math.max(...boxed.map((q) => q.box!));
  const running = new Map<Pending, number>();
  let offset = 0;
  for (let b = 1; b <= max; b++) {
    const inBox = boxed.filter((q) => q.box === b);
    if (inBox.length === 0 || inBox.some((q) => q.disc === null)) return null;
    const numbers = new Set(inBox.map((q) => q.disc!));
    const size = Math.max(...numbers);
    if (numbers.size !== size) return null;
    for (const q of inBox) running.set(q, offset + q.disc!);
    offset += size;
  }
  return running;
}

/**
 * The best fit of any of a piece's candidates; a TheDiscDB hit also fits the TMDB entry it names. The Japanese half of
 * a folder's `English (日本語)` name is the same title as the first, so it fits as fully.
 */
function fit(p: Piece, en: Entry, season: number | null): number {
  if (p.hit?.tmdbId && en.id === `tmdb-${p.hit.kind === 'series' ? 'tv' : 'movie'}:${p.hit.tmdbId}`) return EXACT;
  let best = 0;
  const cands = p.parse.candidates;
  cands.forEach((cand, i) => {
    const q = quality(en, cand, season);
    best = Math.max(best, i === 0 || (p.kind === 'folder' && japaneseHalf(cands, i)) ? q : Math.min(q, LATER_CANDIDATE_MAX));
  });
  return best;
}

function names(en: Entry): string[] {
  return [en.names.english, en.names.romaji, en.names.native, ...en.names.synonyms].filter((n): n is string => n !== null && n.trim() !== '');
}

/** Equal under `normalizeStrict`, or romaji (ASCII) equal to a name with macrons once they are dropped. */
function sameTitle(a: string, b: string): boolean {
  const sa = normalizeStrict(a);
  const sb = normalizeStrict(b);
  if (sa === '' || sb === '') return false;
  if (sa === sb) return true;
  const unmacron = (s: string): string => s.replace(/[āīūēō]/g, (c) => MACRONS[c] ?? c);
  return (ASCII.test(sa) && MACRON.test(sb) && unmacron(sb) === sa) || (ASCII.test(sb) && MACRON.test(sa) && unmacron(sa) === sb);
}

/** True when the names agree only under `normalizeTitle`'s folding. */
const foldedTitle = (a: string, b: string): boolean => normalizeTitle(a) !== '' && normalizeTitle(a) === normalizeTitle(b);

/** EXACT, BASE or 0: see the constants. */
function quality(en: Entry, candidate: string, season: number | null): number {
  let q = 0;
  for (const name of names(en)) {
    if (sameTitle(candidate, name)) return EXACT;
    if (foldedTitle(candidate, name)) q = BASE;
    const parsed = parseName(name);
    const base = parsed.candidates[0];
    if (base === undefined) continue;
    if (sameTitle(candidate, base)) {
      if (parsed.season !== null && parsed.season === season) return EXACT;
      q = BASE;
    } else if (foldedTitle(candidate, base)) {
      q = BASE;
    }
  }
  return q;
}

/** False when the evidence has years and the entry's year is more than YEAR_SLACK from all of them. */
function yearFits(en: Entry, years: readonly number[]): boolean {
  return en.year === null || years.length === 0 || years.some((y) => Math.abs(y - en.year!) <= YEAR_SLACK);
}

/**
 * Whether a TMDB entry's year fits an AniList entry's. A TMDB series is dated by its first season, so for a
 * series the window runs from the AniList chain root's year (the first TV season; this entry's own year when the chain
 * is unknown) to this entry's year, each widened by YEAR_SLACK (the start by `early` when given, TMDB_TV_EARLY for a
 * twin series); a movie keeps YEAR_SLACK on both sides. A missing year
 * fits when `unknownFits`.
 */
function inYearWindow(a: Entry, rootYear: number | null, t: Entry, unknownFits: boolean, early = YEAR_SLACK): boolean {
  if (a.year === null || t.year === null) return unknownFits;
  const from = (a.kind === 'series' ? (rootYear ?? a.year) : a.year) - early;
  return t.year >= from && t.year <= a.year + YEAR_SLACK;
}

/** What `isTwin` needs to know of an AniList entry: whether it is TV, its chain root's year and its place in the chain. */
interface TwinInfo {
  readonly tv: boolean;
  readonly rootYear: number | null;
  readonly place: number | null;
}

/**
 * How an AniList entry and a TMDB entry name the same title, or null when they aren't twins: TMDB marks it animated, the
 * same kind, a year in the window, and a name strictly equal to one of the AniList names (`name`), or only
 * to one with its season stripped (`base`: TMDB names the series, AniList the season, `Harbor Line Season 3`), or the
 * two fit the two halves of one folder's `English (日本語)` name (`segment`). An AniList MOVIE, SPECIAL or
 * OVA and a TMDB movie are twins too, by a strictly equal name only.
 */
function twinMatch(a: Entry, rootYear: number | null, t: Entry, named: readonly Piece[], season: number | null): 'name' | 'base' | 'segment' | null {
  const film = a.kind !== t.kind && t.kind === 'movie' && FILM_FORMATS.has(a.format ?? '');
  // a TMDB series' first-air year may be up to TMDB_TV_EARLY years before the AniList chain root's
  const early = a.kind === 'series' && t.kind === 'series' ? TMDB_TV_EARLY : YEAR_SLACK;
  if (t.animation !== true || (a.kind !== t.kind && !film) || !inYearWindow(a, rootYear, t, false, early)) return null;
  // in the widened years only, TMDB must carry a Japanese name the AniList entry shares, so a same-named Western
  // cartoon doesn't pass for the twin
  const widened = early > YEAR_SLACK && t.year !== null && a.year !== null && t.year < (rootYear ?? a.year) - YEAR_SLACK;
  if (widened && !names(t).some((n) => JAPANESE.test(n) && names(a).some((m) => folded(m) === folded(n)))) return null;
  if (names(a).some((x) => names(t).some((y) => sameTitle(x, y)))) return 'name';
  if (film) return null;
  if (seriesNames(a).some((x) => names(t).some((y) => sameTitle(x, y)))) return 'base';
  // TMDB must also carry a Japanese name that is the folder's Japanese half or an AniList name: without one nothing
  // ties the two halves to one work, and with another one TMDB's entry is another work
  const japanese = names(t).filter((n) => JAPANESE.test(n));
  return named.some((p) => {
    const cands = p.parse.candidates;
    const tied = japanese.some((n) => cands.some((c, i) => japaneseHalf(cands, i) && sameTitle(n, c)) || names(a).some((m) => sameTitle(n, m)));
    return p.kind === 'folder' && tied && halves(cands).some(([x, y]) => quality(a, x, season) === EXACT && names(t).some((n) => sameTitle(y, n)));
  }) ? 'segment' : null;
}

/**
 * Whether a parse's candidate `i` is the Japanese half of the tidy layout's `English (日本語)`: a later candidate in
 * Japanese script after a first one with none. A stripped variant (`BD Foo` → `Foo`), a volume split (`星降りの旅人 2`)
 * or a note in parens (`(Director's Cut)`) isn't one.
 */
function japaneseHalf(candidates: readonly string[], i: number): boolean {
  return i > 0 && JAPANESE.test(candidates[i] ?? '') && !JAPANESE.test(candidates[0] ?? '');
}

/** Both orders of each `English (日本語)` pair among a parse's candidates. */
function halves(candidates: readonly string[]): [string, string][] {
  return candidates.flatMap((c, i): [string, string][] => (japaneseHalf(candidates, i) ? [[candidates[0]!, c], [c, candidates[0]!]] : []));
}

/** Whether a folder name carries the anime tag, `[アニメ]` or `[Anime]`, alone or among other tags in its brackets. */
function animeTagged(segment: string): boolean {
  // a bracket of tags only (`[Not Anime]` doesn't count), with no other genre beside it in any of the folder's
  // brackets (`[Anime+Drama]`, `[アニメ][特撮]` don't count)
  const brackets = [...segment.normalize('NFKC').matchAll(/[[【]([^\]】]*)[\]】]/g)].map((m) => (m[1] ?? '').split(/[+\s,/&]+/).filter((t) => t !== ''));
  if (brackets.some((tokens) => tokens.some((t) => OTHER_GENRES.test(t)))) return false;
  return brackets.some((tokens) => tokens.some((t) => t === 'アニメ' || t.toLowerCase() === 'anime') && tokens.every(isTagWord));
}

/** A name under `normalizeStrict`, with katakana folded to hiragana (no long-vowel folding) and kanji variants to one form. */
function folded(text: string): string {
  return normalizeStrict(text)
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(KANJI_VARIANT, (c) => KANJI_VARIANTS[c] ?? c);
}

/** Whether two AniList entries are tied by a story link, in either direction. */
function storyLinked(a: Entry, b: Entry): boolean {
  return a.relations.some((r) => r.id === b.id && STORY_LINKS.has(r.type)) || b.relations.some((r) => r.id === a.id && STORY_LINKS.has(r.type));
}

/**
 * Whether a TMDB entry is an AniList entry's twin. A TMDB TV series must also have at least as many seasons as the
 * AniList TV entry's place in its chain; when that can't be told (the season count or the place is unknown), only a
 * full-name match counts, never a `base` or `segment` one.
 */
async function isTwin(a: Entry, info: TwinInfo, t: Entry, named: readonly Piece[], season: number | null, ctx: MatchContext): Promise<boolean> {
  const how = twinMatch(a, info.rootYear, t, named, season);
  if (how === null) return false;
  if (!info.tv || t.kind !== 'series') return true;
  if (how === 'name' && (info.place === null || info.place <= 1)) return true;
  if (info.place === null) return false;
  const count = await tmdbSeasonCount(t, ctx);
  return count === 0 ? how === 'name' : count >= info.place;
}

/** A TMDB series' season count, fetched by id through the cache when the search result has none; 0 when unknown. */
async function tmdbSeasonCount(t: Entry, ctx: MatchContext): Promise<number> {
  if (t.seasons.length > 0) return t.seasons.length;
  return (await tmdbEntry(t, ctx)).seasons.length;
}

/** A TMDB entry by id, through the cache (`tmdb-entry:<id>`), with its seasons; the search result when there is none. */
async function tmdbEntry(t: Entry, ctx: MatchContext): Promise<Entry> {
  if (!ctx.tmdb) return t;
  const key = `tmdb-entry:${t.id}`;
  let hit = ctx.cache.get(key);
  if (!hit) {
    const en = await ctx.tmdb.entry(t.id);
    hit = en ? [en] : [];
    ctx.cache.set(key, hit);
  }
  return hit[0] ?? t;
}

/** An AniList entry's names, each also with its season stripped. */
function seriesNames(a: Entry): string[] {
  return names(a).flatMap((n) => [n, parseName(n).candidates[0] ?? n]);
}

/** An AniList entry by id, through the cache. */
async function anilistEntry(id: string, ctx: MatchContext): Promise<Entry | null> {
  const key = `anilist-entry:${id}`;
  let hit = ctx.cache.get(key);
  if (!hit) {
    const en = await ctx.anilist.entry(id);
    hit = en ? [en] : [];
    ctx.cache.set(key, hit);
  }
  return hit[0] ?? null;
}

/**
 * An AniList TV/TV_SHORT entry's place in its chain of TV prequels, the chain's root (its first TV season), and the
 * season its names carry. With no TV prequel it is 1 and its own root, unless its name carries a sequel marker, when the
 * prequel is missing from the data and the place and root are unknown.
 */
async function anilistPlace(en: Entry, ctx: MatchContext): Promise<{ place: number | null; named: number | null; root: Entry | null }> {
  const seen = new Set(names(en).map((n) => parseName(n).season).filter((s): s is number => s !== null));
  const named = seen.size === 1 ? [...seen][0]! : null;
  const tvPrequels = (x: Entry) => x.relations.filter((r) => r.type === 'PREQUEL' && TV_FORMATS.has(r.format ?? ''));
  if (tvPrequels(en).length === 0) {
    const sequel = seen.size > 1 || (named !== null && named > 1) ||
      names(en).some((n) => SEQUEL_MARK.test(n.normalize('NFKC')) || SEQUEL_ROMAN.test(n.normalize('NFKC')));
    return sequel ? { place: null, named, root: null } : { place: 1, named, root: en };
  }
  let cur = en;
  for (let place = 1; place <= MAX_CHAIN; place++) {
    const prev = tvPrequels(cur);
    if (prev.length === 0) return { place, named, root: cur };
    if (prev.length > 1) break;
    const next = await anilistEntry(prev[0]!.id, ctx);
    if (!next) break;
    cur = next;
  }
  return { place: null, named, root: null };
}

/** Whether an entry can be the evidence's season (rule 3), and which season it files under (see DiscMatch). */
async function compatible(en: Entry, evSeason: number | null | 'conflict', ctx: MatchContext): Promise<Compat> {
  if (evSeason === 'conflict') return { ok: false, unresolved: true };
  const row = en.kind === 'movie' || (en.source === 'anilist' && !TV_FORMATS.has(en.format ?? ''));
  if (row) return evSeason === null ? { ok: true, season: null } : { ok: false, unresolved: false };
  if (en.source === 'anilist') {
    const { place, named } = await anilistPlace(en, ctx);
    if (place === null) return { ok: false, unresolved: true };
    if (evSeason === null || evSeason === place || evSeason === named) return { ok: true, season: place };
    return { ok: false, unresolved: false };
  }
  if (evSeason !== null) return en.seasons.some((s) => s.number === evSeason) ? { ok: true, season: evSeason } : { ok: false, unresolved: false };
  return en.seasons.length === 1 ? { ok: true, season: en.seasons[0]!.number } : { ok: false, unresolved: true };
}

function episodeCount(en: Entry, season: number | null): number | null {
  if (en.kind === 'movie') return null;
  if (en.source === 'anilist') return en.episodes;
  return en.seasons.find((s) => s.number === season)?.episodes ?? null;
}
