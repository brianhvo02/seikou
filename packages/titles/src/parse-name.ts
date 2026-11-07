/**
 * Name parsing (spec §7): turns a folder name or a disc title into candidate titles plus the season, volume, disc, box,
 * year, episodes, bonus and music markers it carries. Original code; the corpus in corpus.ts pins its behaviour.
 *
 * When a name is unclear the parser gives an empty candidate or a null number, never a guess: candidates and numbers
 * feed AniList and TMDB lookups directly, and a wrong one can file a disc under the wrong title.
 */

export interface ParsedName {
  readonly candidates: readonly string[]; // title strings left after stripping, best first; `English (日本語)` gives both
  readonly season: number | null;
  readonly volume: number | null; // Vol./Volume/巻/上巻=1/下巻=2
  readonly disc: number | null; // Disc/D/DISC
  readonly box: number | null;
  readonly year: number | null;
  readonly episodes: readonly [number, number] | null;
  readonly bonus: boolean;
  readonly music: boolean; // [CD] or FLAC together with BDMV; an artist – title pattern under a Music folder is the grouping's call
}

type NumberField = 'season' | 'volume' | 'disc' | 'box' | 'year';

/** What a scan has found so far. A number seen twice with different values is a conflict and ends up null. */
class Found {
  readonly numbers = new Map<NumberField, number | 'conflict'>();
  episodes: readonly [number, number] | null = null;
  bonus = false;
  /** The name carries a BDMV, BD, disc or volume tag, so ` - NN` is not a fansub episode number (ruling T3f). */
  discName = false;
  /** A scene name's year at its very end (`Night_2012`), cut by markYear but maybe part of the title (Y4). */
  sceneEndYear: number | null = null;
  /** Titles with that year kept (`Night 2012`): later candidates, so an entry named so still competes. */
  readonly alternates: string[] = [];

  /** Records an episode range once; a reversed range is unclear and records nothing. */
  setEpisodes(first: number, last: number): void {
    if (this.episodes === null && last >= first) this.episodes = [first, last];
  }

  set(field: NumberField, n: number): void {
    if (!Number.isFinite(n)) return;
    const had = this.numbers.get(field);
    this.numbers.set(field, had === undefined || had === n ? n : 'conflict');
  }

  get(field: NumberField): number | null {
    const n = this.numbers.get(field);
    return typeof n === 'number' ? n : null;
  }
}

/** Where a structure token was: the title is cut here, and the first non-empty piece is the title. */
const CUT = '\u0000';
/** Where a release tag was: also a cut, and an ambiguous tag next to one is a tag too. */
const TAG = '\u0001';
const MARK = `[${CUT}${TAG}]`;

const KANJI_DIGITS: Readonly<Record<string, number>> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** An ASCII number, or a kanji one up to 99 (`八`, `十二`, `二十`). */
const NUM = '(\\d{1,3}|[一二三四五六七八九十]{1,3})';

function toNumber(text: string | undefined): number {
  if (text === undefined) return Number.NaN;
  if (/^\d+$/.test(text)) return Number(text);
  const [tens, ones] = text.split('十');
  if (ones === undefined) return KANJI_DIGITS[text] ?? Number.NaN;
  return (tens === '' ? 1 : (KANJI_DIGITS[tens ?? ''] ?? Number.NaN)) * 10 + (ones === '' ? 0 : (KANJI_DIGITS[ones] ?? Number.NaN));
}

/**
 * Structure tokens, in the order they are tried. Each is replaced by a cut, so the title is the text before it.
 * Ranges come first and set nothing (they name a box or series folder), and `2nd Season` comes before `Season 2`.
 */
const STRUCTURE: readonly { readonly re: RegExp; readonly read: (f: Found, m: string[]) => void }[] = [
  { re: /\bVol(?:ume)?\.?[ ._]*\d{1,3}\s*[-~]\s*(?:Vol(?:ume)?\.?[ ._]*)?\d{1,3}\b/gi, read: () => {} },
  { re: /\bSeason[ ._]*\d{1,2}\s*[-~]\s*(?:Season[ ._]*)?\d{1,2}\b/gi, read: () => {} },
  { re: /\bS\d{1,2}\s*[-~]\s*S\d{1,2}\b/gi, read: () => {} },
  { re: /\bDis[ck][ ._]*\d{1,2}\s*[-~]\s*(?:Dis[ck][ ._]*)?\d{1,2}\b/gi, read: () => {} },
  { re: /\bD\d{1,2}\s*[-~]\s*D?\d{1,2}\b/g, read: () => {} },
  { re: /上巻\s*[・,、&＆~-]?\s*下巻/g, read: (f) => { f.set('volume', 1); f.set('volume', 2); } },
  { re: /第(\d{1,4})話?\s*[-~]\s*第?(\d{1,4})話/g, read: (f, m) => f.setEpisodes(Number(m[1]), Number(m[2])) },
  { re: /第(\d{1,4})話/g, read: (f, m) => f.setEpisodes(Number(m[1]), Number(m[1])) },
  {
    re: /\bS(\d{1,2})(?:E(\d{1,3})(?:-E?(\d{1,3}))?)?\b/gi,
    read: (f, m) => {
      f.set('season', toNumber(m[1]));
      if (m[2] !== undefined) f.setEpisodes(Number(m[2]), Number(m[3] ?? m[2]));
    },
  },
  { re: /\b(\d{1,2})(?:st|nd|rd|th)[ ._]*Season\b/gi, read: (f, m) => f.set('season', toNumber(m[1])) },
  { re: /\bSeason[ ._]*(\d{1,2})\b/gi, read: (f, m) => f.set('season', toNumber(m[1])) },
  { re: new RegExp(`第${NUM}(?:期|シリーズ)`, 'g'), read: (f, m) => f.set('season', toNumber(m[1])) },
  { re: /\bVol(?:ume)?\.?[ ._]*(\d{1,3})\b/gi, read: (f, m) => f.set('volume', toNumber(m[1])) },
  { re: new RegExp(`第?${NUM}巻`, 'g'), read: (f, m) => f.set('volume', toNumber(m[1])) },
  { re: /上巻/g, read: (f) => f.set('volume', 1) },
  { re: /下巻/g, read: (f) => f.set('volume', 2) },
  { re: /\bDis[ck][ ._]*(\d{1,2})\b/gi, read: (f, m) => f.set('disc', toNumber(m[1])) },
  { re: /ディスク(\d{1,2})/g, read: (f, m) => f.set('disc', toNumber(m[1])) },
  { re: /\bD(\d{1,2})\b/g, read: (f, m) => f.set('disc', toNumber(m[1])) },
  { re: /\bBOX[ ._]*(\d{1,2})\b/gi, read: (f, m) => f.set('box', toNumber(m[1])) },
  // a fansub-style episode number: `Foo - 05` before tags or at the end
  // (a year here was taken by markYear first, so a four-digit number left is not a year); never a single digit, and
  // never in a disc name, where it is more likely a volume (ruling T3f)
  {
    re: new RegExp(`\\s-\\s(\\d{2,4})(?:v\\d)?(?=\\s*(?:${MARK}|$))`, 'g'),
    read: (f, m) => { if (!f.discName) f.setEpisodes(Number(m[1]), Number(m[1])); },
  },
];

/** Bonus markers that are never part of a title, so they cut it. */
const BONUS_CUT = /映像特典|特典(?:DISC|ディスク)?|\bBonus\b/gi;
/** `Live`/`Event` mark a bonus disc only as `Live Event` or next to Bonus/特典 (inside brackets, on their own too). */
const BONUS_PHRASE = /\bLive\s*Event\b|(?:\bBonus|特典)\s*(?:Live|Event)\b|\b(?:Live|Event)\s*(?:Bonus\b|特典)/i;
/** Inside brackets, any of these words marks a bonus disc. */
const BONUS_WORD = /\b(?:Live|Event|Bonus)\b|特典/i;

const word = (tokens: readonly string[]): string => tokens.map((t) => `\\b${t}\\b`).join('|');
/** Release, format, codec and region tokens that are never title words: they end a title wherever they appear. */
const STRONG_TAG = new RegExp(
  word([
    '\\d{3,4}[pi]', 'UHD', 'Blu-?ray', 'BD-?BOX', 'BDRip', 'BDMV', 'REMUX', 'AVC', 'HEVC', 'H\\.?26[45]', 'x26[45]', 'MPEG-?2', 'VC-?1', 'LPCM',
    'PCM', 'FLAC', 'AAC', 'AC-?3', 'E-?AC-?3', 'DTS(?:-HD)?(?:[ .]MA)?', 'TrueHD', 'Atmos', 'HDR(?:10)?', 'JPN', 'USA', 'GER', 'FRA',
    'ESP', 'KOR', 'CHN',
  ]) + '|初回(?:生産)?限定版|完全生産限定版|通常版',
  'gi',
);
/** Tags that are also words (`Fin and Feather`, `The Box`): tags only inside brackets or next to another tag. */
const WEAK_TAG = new RegExp(word(['4K', 'BD', 'DVD', 'ISO', 'ITA', 'ENG', 'BOX(?![ ._]*\\d)', 'Fin']), 'gi');
const WEAK_BEFORE_TAG = new RegExp(`(?:${WEAK_TAG.source})(?=[\\s.+\\-]*${TAG})`, 'gi');
const WEAK_AFTER_TAG = new RegExp(`(?<=${TAG}[\\s.+\\-]*)(?:${WEAK_TAG.source})`, 'gi');
/** Group contents that are tags only inside brackets. */
const BRACKET_TAG = /^(?:CD|CUE|LOG|BK|SCANS?|WAV|MP3|アニメ|映画|ドラマ|Anime|Movie|Live|Event|Bonus|映像特典|特典)$/i;
const WHOLE_TAG = new RegExp(`^(?:${STRONG_TAG.source}|${WEAK_TAG.source})$`, 'i');
/** `ABCD-12345`, `XXCL-1234~5`. */
const CATALOGUE = /\b[A-Z]{2,5}-\d{3,5}(?:~\d{1,2})?\b/g;
/** `2025.03.26`, `2025-03-26`. */
const DATE = /\b(?:19|20)\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2}\b/g;
/** A disc folder's generic label, which names no title: `BDROM`, `BD_VIDEO`, `VIDEO_TS`, `DISC_2`, `01`. */
const GENERIC_LABEL = /^(?:(?:BDROM|BD[ _-]?ROM|BD[ _-]?VIDEO|BD|BLU-?RAY|VIDEO_TS|DVD)(?:[ _.-]?\d{1,3})?|DIS[CK](?:[ _.-]?(\d{1,2}))?|\d+)$/i;
/** `Part 2`, `2nd Cour`, `Cour 2`: kept on the title, since AniList titles carry them. */
const PART = /^\s*(?:Part[ ._]*\d{1,2}|\d{1,2}(?:st|nd|rd|th)[ ._]*Cour|Cour[ ._]*\d{1,2})\b/i;
const YEAR = /\b((?:19|20)\d{2})\b/g;
/** A Japanese year, `2013年` or `2013年製作` (made in 2013), not run into a title (`1999年の夏` keeps its title, M6). */
const KANJI_YEAR = /(?<![\p{L}\p{N}])((?:19|20)\d{2})年(?:製作|制作)?(?![\p{L}\p{N}])/gu;
/** Region and language tags, upper case only so that words aren't taken for them: tags inside brackets or parens (M6). */
const REGION_TAG = /^(?:US|USA|JP|JPN|UK|EU|ITA|ENG|FRA|GER|KOR|CHN|HK|TW)$/;
const TRIM = /^[\s\-–—:~_.,・/|+&]+|[\s\-–—:~_.,・/|+&]+$/g;
const CJK_END = /^(.*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(\d{1,2})$/u;

const clean = (piece: string): string => piece.replace(/\s+/g, ' ').replace(TRIM, '');
const WHOLE_WEAK = new RegExp(`^(?:${WEAK_TAG.source})$`, 'i');
/**
 * An upper-case format word leading a title (`BD Foo Vol.2`) may be a tag, but only when the name carries another tag
 * (ruling T3e); `Iso Tribe` and `DVD Club` keep their titles.
 */
const LEADING_FORMAT = /^(?:BD|DVD|ISO|4K)\s+(?=\S)/;
const ANY_STRONG_TAG = new RegExp(STRONG_TAG.source, 'i');
/** BDMV, BD, disc or volume words: the name is a disc's, not a fansub file's. */
const DISC_WORD = /\b(?:BDMV|BD|DIS[CK]|VOL(?:UME)?)(?![a-z])/i;
/** A title that is nothing but tag-words (`DVD`, `ISO`) is no title. */
const onlyTags = (title: string): boolean => title.split(' ').every((w) => WHOLE_WEAK.test(w));
const hasLetter = (text: string): boolean => /\p{L}/u.test(text);

/** Marks release tags: strong ones anywhere, ambiguous ones inside brackets or next to another tag. */
function markTags(text: string, bracket: boolean): string {
  let t = text.replace(STRONG_TAG, TAG);
  if (bracket) return t.replace(WEAK_TAG, TAG);
  for (let before = ''; before !== t; ) {
    before = t;
    t = t.replace(WEAK_BEFORE_TAG, TAG).replace(WEAK_AFTER_TAG, TAG);
  }
  return t;
}

/**
 * Takes a year from the last year-like token directly before the release tags (or at the end of a scene name), after
 * some title text, or after ` - ` at the end (`Foo - 2019`), and only from 1900 to next year:
 * `Glass.Orchard.2049.2017.1080p` is 2017, `….2049.1080p` none.
 */
function markYear(t: string, f: Found, scene: boolean): string {
  const end = new RegExp(`^\\s*(?:${TAG}${scene ? '|$' : ''})`);
  const endAfterDash = new RegExp(`^\\s*(?:${TAG}|$)`);
  let last: RegExpExecArray | null = null;
  for (const m of t.matchAll(YEAR)) {
    const before = t.slice(0, m.index);
    const after = t.slice(m.index + m[0].length);
    if (hasLetter(before) && (end.test(after) || (/\s-\s$/.test(before) && endAfterDash.test(after)))) last = m;
  }
  if (last === null) return t;
  const year = Number(last[1]);
  if (year < 1900 || year > new Date().getFullYear() + 1) return t;
  f.set('year', year);
  if (scene && /^\s*$/.test(t.slice(last.index + last[0].length))) f.sceneEndYear = year;
  return t.slice(0, last.index) + CUT + t.slice(last.index + last[0].length);
}

/** Strips structure and tags from free text, recording what it finds, and returns the title piece left (or ''). */
function scan(text: string, f: Found, opts: { readonly scene: boolean; readonly bracket: boolean }): string {
  let t = markTags(text.replace(DATE, CUT).replace(CATALOGUE, CUT), opts.bracket);
  // a year run into a title (`星の海2020年`) is part of it, and one out of range is left alone (W5)
  t = t.replace(KANJI_YEAR, (whole: string, y: string) => {
    const year = Number(y);
    if (year < 1900 || year > new Date().getFullYear() + 1) return whole;
    f.set('year', year);
    return CUT;
  });
  t = markYear(t, f, opts.scene);
  for (const { re, read } of STRUCTURE) t = t.replace(re, (...m: string[]) => (read(f, m), CUT));
  t = t.replace(BONUS_CUT, () => ((f.bonus = true), CUT));
  const pieces = t.split(new RegExp(MARK));
  const at = pieces.findIndex((p) => hasLetter(clean(p)) && !onlyTags(clean(p)));
  const endYear = f.sceneEndYear;
  f.sceneEndYear = null;
  if (at < 0) return '';
  const part = PART.exec(pieces[at + 1] ?? '');
  const title = clean(`${pieces[at] ?? ''} ${part ? part[0].trim() : ''}`);
  if (endYear !== null) f.alternates.push(`${title} ${endYear}`);
  return title;
}

interface Group {
  readonly bracket: boolean; // [..] or 【..】, else (..)
  readonly content: string;
  readonly start: number;
}

/** A bracket group that holds only tags (`[BDMV]`, `[220629]`, `[FLAC+CUE]`, `[XXCL-1234~5]`, `[Live Event]`). */
function isTagGroup(bracket: boolean, content: string): boolean {
  const c = content.trim();
  if (!bracket) return false;
  if (/^\d{6}$|^\d{8}$/.test(c) || new RegExp(`^(?:${DATE.source}|${CATALOGUE.source})$`).test(c)) return true;
  return c.split(/[+\s,/&]+/).every((tag) => tag === '' || BRACKET_TAG.test(tag) || WHOLE_TAG.test(tag) || REGION_TAG.test(tag));
}

/** Whether a word is a release, format, region or bracket-only tag (`BDMV`, `アニメ`, `US`), as `isTagGroup` reads one. */
export function isTagWord(word: string): boolean {
  const w = word.normalize('NFKC').trim();
  return BRACKET_TAG.test(w) || WHOLE_TAG.test(w) || REGION_TAG.test(w);
}

/** A group of region and language tags only (`(HK)`, `[US]`), in brackets or parens (M6). */
const regionGroup = (content: string): boolean => {
  const tags = content.trim().split(/[+\s,/&]+/).filter((t) => t !== '');
  return tags.length > 0 && tags.every((t) => REGION_TAG.test(t));
};

/**
 * Top-level bracket and paren groups, nesting-aware. The text outside them keeps a mark where each group was: a tag mark
 * for a group of tags (so a tag-word next to it is a tag too), a cut for any other.
 */
function splitGroups(text: string): { outside: string; groups: Group[] } {
  const groups: Group[] = [];
  let outside = '';
  let depth = 0;
  let start = 0;
  let open = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    if ('[【('.includes(c)) {
      if (depth === 0) {
        start = i;
        open = c;
      }
      depth++;
    } else if (depth > 0 && ']】)'.includes(c)) {
      depth--;
      if (depth === 0) {
        const group = { bracket: open !== '(', content: text.slice(start + 1, i), start };
        groups.push(group);
        outside += isTagGroup(group.bracket, splitGroups(group.content).outside) ? TAG : CUT;
      }
    } else if (depth === 0) {
      outside += c;
    }
  }
  if (depth > 0) outside += text.slice(start); // an unclosed group is plain text
  return { outside, groups };
}

/** A group's content: a tag, a date, a year, an episode range, or title text (nested groups are cut out). */
function scanGroup(group: Group, f: Found): string {
  const c = splitGroups(group.content).outside.trim();
  if (group.bracket && BONUS_WORD.test(c)) f.bonus = true;
  if (isTagGroup(group.bracket, c) || regionGroup(c)) return '';
  const year = /^((?:19|20)\d{2})$/.exec(c);
  if (year) {
    f.set('year', Number(year[1]));
    return '';
  }
  const range = group.bracket ? null : /^(\d{1,4})\s*[-~]\s*(\d{1,4})$/.exec(c);
  if (range) {
    f.setEpisodes(Number(range[1]), Number(range[2]));
    return '';
  }
  // a scene-style name in a group (`[Brasswick_2006]`) separates words with dots or underscores, as outside (M6)
  const scene = !/\s/.test(c) && /[._]/.test(c);
  return scan(scene ? c.replace(/[._]/g, ' ') : c, f, { scene, bracket: group.bracket });
}

export function parseName(text: string): ParsedName {
  const f = new Found();
  const nfkc = text.normalize('NFKC').trim();
  f.discName = DISC_WORD.test(nfkc);
  const music = /\[CD\]/i.test(nfkc) || (/\bFLAC\b/i.test(nfkc) && /\bBDMV\b/i.test(nfkc));
  if (BONUS_PHRASE.test(nfkc)) f.bonus = true;

  let candidates: string[] = [];
  const label = GENERIC_LABEL.exec(nfkc);
  if (label) {
    if (label[1] !== undefined) f.set('disc', Number(label[1]));
  } else {
    const { outside: raw, groups } = splitGroups(nfkc);
    // scene names and disc labels separate words with dots or underscores and have no spaces
    const scene = !/\s/.test(raw) && /[._]/.test(raw);
    const capsLabel = scene && /^[A-Z0-9_]+$/.test(raw.replace(new RegExp(MARK, 'g'), '')) && raw.includes('_');
    const outside = scene ? raw.replace(/[._]/g, ' ') : raw;
    let title = scan(outside, f, { scene, bracket: false });
    if (capsLabel) title = clean(title.split(' ').filter((w) => !/^\d+$/.test(w)).join(' ')); // `ABC_TITLE_3_1`
    const brackets = groups.filter((g) => g.bracket).map((g) => ({ g, title: scanGroup(g, f) }));
    const parens = groups.filter((g) => !g.bracket).map((g) => scanGroup(g, f));
    // bracket text is a title only when nothing outside is (the `[BDMV][date][Title][Vol.N]` style), and a lone word in
    // the first group, with a title after it, is a release group
    const bracketTitles = title !== '' ? [] : brackets.filter(({ g, title: t }, i) =>
      t !== '' && !(g.start === 0 && !/\s/.test(t) && brackets.slice(i + 1).some((b) => b.title !== '')));
    const loneTag = groups.length === 1 && groups[0]?.bracket === true && clean(raw.replace(new RegExp(MARK, 'g'), '')) === '' && !/\s/.test(groups[0].content.trim());
    // a leading format word is dropped only when another tag backs it, and the full title stays first (ruling T3e)
    const tagged = groups.some((g) => isTagGroup(g.bracket, g.content)) || ANY_STRONG_TAG.test(nfkc) ||
      (['season', 'volume', 'disc'] as const).some((k) => f.numbers.has(k));
    const stripped = tagged && LEADING_FORMAT.test(title) ? title.replace(LEADING_FORMAT, '') : '';
    candidates = [title, stripped, ...(loneTag ? [] : bracketTitles.map((b) => b.title)), ...parens].filter(hasLetter);
  }
  candidates = [...new Set([...candidates, ...(candidates.length > 0 ? f.alternates : [])])];

  // a disc title like `星降りの旅人 2` ends in its volume; the whole name stays as a candidate for a sequel named so
  const first = candidates[0];
  const tail = first === undefined || f.numbers.has('volume') || f.numbers.has('disc') ? null : CJK_END.exec(first);
  if (tail && first !== undefined) {
    candidates.splice(0, 1, tail[1] ?? first, first);
    f.set('volume', Number(tail[2]));
  }
  return {
    candidates,
    season: f.get('season'),
    volume: f.get('volume'),
    disc: f.get('disc'),
    box: f.get('box'),
    year: f.get('year'),
    episodes: f.episodes,
    bonus: f.bonus,
    music,
  };
}
