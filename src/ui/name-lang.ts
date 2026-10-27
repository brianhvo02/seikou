/** Kana, CJK ideographs and half-width katakana. */
const JAPANESE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;

/**
 * The `lang` for a name the library shows: `ja` when it has Japanese characters, so the browser draws its kanji in their
 * Japanese forms (an English page would let Android and Windows pick Chinese ones) and in a Japanese font.
 */
export function nameLang(name: string | null | undefined): 'ja' | undefined {
  return name != null && JAPANESE.test(name) ? 'ja' : undefined;
}
