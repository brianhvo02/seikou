/**
 * Title text normalisation (spec §10), shared by the NAS server's matcher and the app's library search, so a title
 * matches the same way on both sides. Original code.
 */

/** Long-vowel spellings of romaji folded to the plain vowel, before `ou`, `oo` and `uu` collapse. */
const LONG_VOWELS: Readonly<Record<string, string>> = { ā: 'a', ī: 'i', ū: 'u', ē: 'e', ō: 'o', â: 'a', î: 'i', û: 'u', ê: 'e', ô: 'o' };

/**
 * NFKC, lower case, long vowels folded (`ō`→`o`, `ū`→`u`, `ou`→`o`, `oo`→`o`, `uu`→`u`, within a word), katakana folded
 * to hiragana, and punctuation, symbols and spaces removed. Romaji is not transliterated.
 *
 * The vowel folding also merges some English pairs (`Good`/`God`, `Moon`/`Mon`, `Soul`/`Sol`), so a short query can
 * find more than it should. The matcher must not treat a normalised match as proof on its own.
 */
export function normalizeTitle(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, ' ')
    .replace(/[āīūēōâîûêô]/g, (c) => LONG_VOWELS[c] ?? c)
    .replace(/ou|oo/g, 'o')
    .replace(/uu/g, 'u')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/ /g, '');
}

/**
 * NFKC and lower case, with only spaces, separators (`. , : ; _ · ・ /`, dashes) and brackets removed, and no vowel or
 * kana folding: the matcher's test for an exact fit, since `normalizeTitle`'s folding merges some different titles
 * (`Good`/`God`, `Soul`/`Sol`). Marks that tell titles apart (`' ° ! ? ☆ ★ ♪ +`) are kept, so `Glimmer'` is not
 * `Glimmer`; only typographic variants of one mark are folded to one form: `’ ‘ ′ \`` to `'`, `“ ”` to `"`, and `&`
 * (`＆` too, through NFKC) to the word `and`.
 */
export function normalizeStrict(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘′`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/&/g, ' and ')
    .replace(/[\s\p{Z}.,:;_·・/\p{Pd}\p{Ps}\p{Pe}]+/gu, '');
}

/**
 * True when the normalised query is a substring of a normalised name. A query that normalises to nothing matches no
 * name; the search UI shows the full list for a blank query itself.
 */
export function titleMatches(query: string, names: readonly string[]): boolean {
  const q = normalizeTitle(query);
  if (q === '') return false;
  return names.some((name) => normalizeTitle(name).includes(q));
}
