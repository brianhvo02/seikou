import type { TitleSummary } from '@seikou/nas/nas-api';
import { displayName } from './title-model';

/**
 * The library's alphabet bars: an English index (# and A–Z, over the A–Z order) and a Japanese one (the gojūon rows,
 * over the gojūon order of each title's reading). A reading comes from a kana native name, else from the romaji name
 * read as kana; a title with neither goes to the last group, 他. Original code.
 */

export const ENGLISH_KEYS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'] as const;
/** The Japanese bar's keys: the ten gojūon rows by their first kana, and 他 for the rest. */
export const KANA_ROWS = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ', '他'] as const;
/** A key of the Japanese bar. */
export type KanaRow = (typeof KANA_ROWS)[number];

/** The English bar's key of a title: the first letter of its displayed name, or # for anything else. */
export function englishKey(t: TitleSummary): string {
  const first = displayName(t).trim().normalize('NFKD').charAt(0).toUpperCase();
  return first >= 'A' && first <= 'Z' ? first : '#';
}

/** Katakana to hiragana; anything else is kept. */
const toHiragana = (s: string): string => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const KANA = /^[ぁ-ゖァ-ヺ]/;

/** Romaji syllables (Hepburn, with the common wāpuro spellings) as hiragana; longest first when read. */
const SYLLABLES: Readonly<Record<string, string>> = {
  a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お',
  ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ', kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ',
  ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご', gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ',
  sa: 'さ', shi: 'し', si: 'し', su: 'す', se: 'せ', so: 'そ', sha: 'しゃ', shu: 'しゅ', sho: 'しょ', she: 'しぇ',
  za: 'ざ', ji: 'じ', zi: 'じ', zu: 'ず', ze: 'ぜ', zo: 'ぞ', ja: 'じゃ', ju: 'じゅ', jo: 'じょ', je: 'じぇ',
  ta: 'た', chi: 'ち', ti: 'ち', tsu: 'つ', tu: 'つ', te: 'て', to: 'と', cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ', che: 'ちぇ',
  da: 'だ', di: 'ぢ', du: 'づ', de: 'で', do: 'ど',
  na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の', nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ',
  ha: 'は', hi: 'ひ', fu: 'ふ', hu: 'ふ', he: 'へ', ho: 'ほ', hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ', fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ',
  ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ', bya: 'びゃ', byu: 'びゅ', byo: 'びょ',
  pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ', pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ',
  ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も', mya: 'みゃ', myu: 'みゅ', myo: 'みょ',
  ya: 'や', yu: 'ゆ', yo: 'よ',
  ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ', rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ',
  wa: 'わ', wo: 'を', vu: 'ゔ',
};
const LONG: Readonly<Record<string, string>> = { 'ā': 'aa', 'ī': 'ii', 'ū': 'uu', 'ē': 'ee', 'ō': 'ou', 'â': 'aa', 'î': 'ii', 'û': 'uu', 'ê': 'ee', 'ô': 'ou' };

/**
 * A romaji name read as hiragana, for ordering: syllables longest first, a doubled consonant as っ, n before a
 * consonant (or n', or a final n) as ん; letters that make no syllable are left out. Null when nothing reads.
 */
export function romajiToKana(romaji: string): string | null {
  const s = romaji.toLowerCase().replace(/[āīūēōâîûêô]/g, (c) => LONG[c]!).replace(/[^a-z']/g, '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'") {
      i++;
      continue;
    }
    if (c === 'n' && (i + 1 === s.length || s[i + 1] === "'" || !/[aiueoy]/.test(s[i + 1]!))) {
      out += 'ん';
      i++;
      continue;
    }
    if (c !== 'n' && /[bcdfghjkmprstvwz]/.test(c) && s[i + 1] === c) {
      out += 'っ';
      i++;
      continue;
    }
    // "tch" (matcha) doubles the ch
    if (c === 't' && s.startsWith('ch', i + 1)) {
      out += 'っ';
      i++;
      continue;
    }
    const len = [3, 2, 1].find((n) => SYLLABLES[s.slice(i, i + n)] !== undefined);
    if (len === undefined) {
      i++;
      continue;
    }
    out += SYLLABLES[s.slice(i, i + len)]!;
    i += len;
  }
  return out === '' ? null : out;
}

/** A title's reading as hiragana: its native name when that starts with kana, else its romaji name read as kana. */
export function reading(t: TitleSummary): string | null {
  const native = t.names.native?.trim() ?? '';
  if (KANA.test(native)) return toHiragana(native);
  return t.names.romaji ? romajiToKana(t.names.romaji) : null;
}

/** The first kana of each gojūon row, in order; a reading belongs to the last row whose first kana sorts at or before it. */
const ROW_STARTS: readonly [KanaRow, string][] = [['あ', 'ぁ'], ['か', 'か'], ['さ', 'さ'], ['た', 'た'], ['な', 'な'], ['は', 'は'], ['ま', 'ま'], ['や', 'ゃ'], ['ら', 'ら'], ['わ', 'ゎ']];

/** The Japanese bar's row of a title: the gojūon row its reading starts in, or 他 without a reading. */
export function kanaRow(t: TitleSummary): KanaRow {
  const r = reading(t);
  if (r === null) return '他';
  // dakuten and handakuten (が, ぱ) fall in their row by code point; ゔ is read as う
  const first = r.charAt(0) === 'ゔ' ? 'う' : r.charAt(0);
  if (first < 'ぁ' || first > 'ゖ') return '他';
  let row: KanaRow = 'あ';
  for (const [name, start] of ROW_STARTS) if (first >= start) row = name;
  return row;
}

const japaneseCollator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
const englishCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** `titles` in gojūon order of their readings; titles without one last (他), A–Z by their displayed name. */
export function japaneseOrder(titles: readonly TitleSummary[]): TitleSummary[] {
  const keyed = titles.map((t) => ({ t, r: kanaRow(t) === '他' ? null : reading(t) }));
  return keyed
    .sort((a, b) => {
      if (a.r === null || b.r === null) return a.r === b.r ? englishCollator.compare(displayName(a.t), displayName(b.t)) : a.r === null ? 1 : -1;
      return japaneseCollator.compare(a.r, b.r) || englishCollator.compare(displayName(a.t), displayName(b.t));
    })
    .map((k) => k.t);
}

/** Each key's first title in `ordered`, by title id: where a tap on that key jumps. */
export function firstOfEach(ordered: readonly TitleSummary[], keyOf: (t: TitleSummary) => string): Map<string, string> {
  const firsts = new Map<string, string>();
  for (const t of ordered) {
    const key = keyOf(t);
    if (!firsts.has(key)) firsts.set(key, t.id);
  }
  return firsts;
}
