/**
 * Music release folder names: reads the date, artist and title out of names such as
 * `[2021.06.02] Artist - Title [CD][FLAC+CUE+LOG+BK+BDMV][CAT-0001]`, and spots concert words. Original code.
 *
 * Bracketed groups are rip and edition tags and are dropped whole. A parenthesised year is a date and `(Single)` marks
 * a single; both leave the title. Other parentheses stay in the title. A release that is an ISO file named directly
 * loses its `.iso`.
 */

export interface ParsedMusicName {
  readonly date: string | null; // YYYY, YYYY-MM or YYYY-MM-DD
  readonly artist: string | null; // null when the name has no ` - ` separator
  readonly title: string;
  readonly single: boolean;
}

const LEADING_DATE = /^\s*\[(\d{4})(?:[.-](\d{2})(?:[.-](\d{2}))?)?\]/;
const PAREN_YEAR = /\(\s*(\d{4})\s*\)/;
const PAREN_SINGLE = /\(\s*single\s*\)/i;
const SEPARATOR = /\s+[-–—]\s+/;
const ISO_SUFFIX = /\.iso$/i;

function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Splits a music release folder name into date, artist and title. */
export function parseMusicFolder(name: string): ParsedMusicName {
  let rest = name.trim().replace(ISO_SUFFIX, '');
  let date: string | null = null;
  const lead = LEADING_DATE.exec(rest);
  if (lead) {
    date = [lead[1], lead[2], lead[3]].filter((p): p is string => p !== undefined).join('-');
    rest = rest.slice(lead[0].length);
  }
  rest = rest.replace(/\[[^\]]*\]/g, ' ');
  const year = PAREN_YEAR.exec(rest);
  if (year) {
    date ??= year[1] ?? null;
    rest = rest.replace(PAREN_YEAR, ' ');
  }
  const single = PAREN_SINGLE.test(rest);
  if (single) rest = rest.replace(PAREN_SINGLE, ' ');
  rest = tidy(rest);
  const sep = SEPARATOR.exec(rest);
  if (sep) {
    const artist = tidy(rest.slice(0, sep.index));
    const title = tidy(rest.slice(sep.index + sep[0].length));
    if (artist && title) return { date, artist, title, single };
  }
  return { date, artist: null, title: rest, single };
}

const LATIN_CONCERT = /\b(?:live|tour|concert)\b/i;
const JAPANESE_CONCERT = ['ライブ', 'ツアー', '公演', 'コンサート'];

/** True when the text names a concert: Latin words as whole words, Japanese ones anywhere. */
export function hasConcertWord(text: string): boolean {
  return LATIN_CONCERT.test(text) || JAPANESE_CONCERT.some((w) => text.includes(w));
}
