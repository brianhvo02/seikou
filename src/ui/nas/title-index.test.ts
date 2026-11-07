import { describe, expect, it } from 'vitest';
import type { TitleNames, TitleSummary } from '@seikou/nas/nas-api';
import { englishKey, firstOfEach, japaneseOrder, kanaRow, reading, romajiToKana } from './title-index';

// Every title here is made up (ruling R4).

function title(id: string, names: Partial<TitleNames>): TitleSummary {
  return { id, kind: 'series', names: { english: null, romaji: null, native: null, synonyms: [], display: null, ...names }, poster: null, year: null, seasons: 1, discs: 1, addedAt: 0, own: false };
}

const STARFALL = title('a:1', { english: 'Starfall Wanderer', romaji: 'Hoshifuri no Tabibito', native: '星降りの旅人' });
const EMBER = title('a:2', { english: 'Ember Blade', romaji: 'Hinokiri no Ken', native: '火斬りの剣' });
const KANA = title('a:3', { english: 'Paper Comet', native: 'かみのほうきぼし' });
const KATAKANA = title('a:4', { english: 'Glass Orchard', native: 'ガラスノカジュエン' });
const LATIN = title('t:1', { english: 'Lanternfall', native: 'Lanternfall' });
const NUMBERED = title('a:5', { english: '7 Seas Lantern', romaji: 'Nanatsu no Umi', native: '七つの海' });
const ROMAJI_ONLY = title('a:6', { romaji: 'Tsukikage no Minato', native: '月影の港' });

describe('englishKey', () => {
  it('is the first letter of the displayed name, upper-cased, or # for a digit or anything else', () => {
    expect(englishKey(STARFALL)).toBe('S');
    expect(englishKey(title('x', { display: 'ember tide' }))).toBe('E');
    expect(englishKey(NUMBERED)).toBe('#');
    expect(englishKey(title('x', { native: '火斬りの剣' }))).toBe('#');
    expect(englishKey(title('x', { english: 'Éclair Road' }))).toBe('E');
  });
});

describe('romajiToKana', () => {
  it('reads Hepburn romaji as hiragana', () => {
    expect(romajiToKana('Hoshifuri no Tabibito')).toBe('ほしふりのたびびと');
    expect(romajiToKana('Tsukikage no Minato')).toBe('つきかげのみなと');
    expect(romajiToKana('Kyoukai no Kanata')).toBe('きょうかいのかなた');
  });

  it('reads doubled consonants as っ, n before a consonant or at the end as ん, and long vowels with macrons', () => {
    expect(romajiToKana('Kitto')).toBe('きっと');
    expect(romajiToKana('Matcha')).toBe('まっちゃ');
    expect(romajiToKana('Shinsekai')).toBe('しんせかい');
    expect(romajiToKana("Kin'iro")).toBe('きんいろ');
    expect(romajiToKana('Ken')).toBe('けん');
    expect(romajiToKana('Tōkyō')).toBe('とうきょう');
  });

  it('is null when nothing reads', () => {
    expect(romajiToKana('!!')).toBeNull();
  });
});

describe('reading and kanaRow', () => {
  it('reads a kana native name directly, katakana as hiragana', () => {
    expect(reading(KANA)).toBe('かみのほうきぼし');
    expect(reading(KATAKANA)).toBe('がらすのかじゅえん');
    expect(kanaRow(KATAKANA)).toBe('か');
  });

  it('reads a kanji native name through its romaji', () => {
    expect(reading(STARFALL)).toBe('ほしふりのたびびと');
    expect(kanaRow(STARFALL)).toBe('は');
    expect(kanaRow(EMBER)).toBe('は');
    expect(kanaRow(ROMAJI_ONLY)).toBe('た');
    expect(kanaRow(NUMBERED)).toBe('な');
  });

  it('puts each gojūon row in its place, voiced kana with their row', () => {
    const row = (native: string) => kanaRow(title('x', { native }));
    expect(['あお', 'ごご', 'ざる', 'でんき', 'ぬの', 'ぱん', 'もり', 'ゆき', 'ろうそく', 'わたし'].map(row)).toEqual(['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ']);
  });

  it('puts a title with no reading in 他', () => {
    expect(kanaRow(LATIN)).toBe('他');
    expect(kanaRow(title('x', { english: 'Moonlit Harbor', native: '月影の港' }))).toBe('他');
  });
});

describe('japaneseOrder', () => {
  it('orders by reading in gojūon order, titles with no reading last and A–Z', () => {
    const order = japaneseOrder([LATIN, STARFALL, KANA, EMBER, ROMAJI_ONLY, title('t:0', { english: 'Ashen Gate' })]).map((t) => t.id);
    // かみの… < つきかげ… < ひのきり… < ほしふり…, then Ashen Gate and Lanternfall (他)
    expect(order).toEqual(['a:3', 'a:6', 'a:2', 'a:1', 't:0', 't:1']);
  });
});

describe('firstOfEach', () => {
  it("maps each key to its first title's id in the given order", () => {
    const firsts = firstOfEach([EMBER, STARFALL, KANA], kanaRow);
    expect([...firsts]).toEqual([['は', 'a:2'], ['か', 'a:3']]);
  });
});
