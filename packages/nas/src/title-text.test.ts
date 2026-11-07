import { describe, expect, it } from 'vitest';
import { normalizeStrict, normalizeTitle, titleMatches } from './title-text';

describe('normalizeTitle', () => {
  it('does not transliterate romaji', () => {
    expect(normalizeTitle('Starfall Wanderer') === normalizeTitle('sutāfōru wandarā')).toBe(false);
  });

  it('lower-cases and removes spaces and punctuation', () => {
    expect(normalizeTitle('Hoshifuri no Tabibito')).toBe('hoshifurinotabibito');
    expect(normalizeTitle("Starfall: Wanderer's End!")).toBe('starfallwanderersend');
  });

  it('folds long vowels', () => {
    expect(normalizeTitle('Tōkyō Kūsō')).toBe(normalizeTitle('Tokyo Kuso'));
    expect(normalizeTitle('Toukyou Kuusou')).toBe(normalizeTitle('Tokyo Kuso'));
    expect(normalizeTitle('Ookami')).toBe('okami');
  });

  it('folds katakana to hiragana', () => {
    expect(normalizeTitle('ヴェルミナ')).toBe(normalizeTitle('ゔぇるみな'));
    expect(normalizeTitle('ﾎｼﾌﾘ')).toBe(normalizeTitle('ほしふり'));
  });

  it('applies NFKC to full-width text', () => {
    expect(normalizeTitle('Ｓｔａｒｆａｌｌ　２')).toBe('starfall2');
  });
});

describe('titleMatches', () => {
  it('matches a normalised substring of any name', () => {
    expect(titleMatches('starfall', ['Starfall Wanderer'])).toBe(true);
    expect(titleMatches('星降り', ['星降りの旅人'])).toBe(true);
    expect(titleMatches('ホシフリ', ['Starfall Wanderer', 'ほしふりのたびびと'])).toBe(true);
    expect(titleMatches('wanderer end', ["Starfall Wanderer: End"])).toBe(true);
  });

  it('is false when no name contains the query', () => {
    expect(titleMatches('moonrise', ['Starfall Wanderer', '星降りの旅人'])).toBe(false);
    expect(titleMatches('starfall', [])).toBe(false);
  });

  it('is false for a query that normalises to nothing', () => {
    expect(titleMatches('', ['Starfall Wanderer'])).toBe(false);
    expect(titleMatches(' !! ', ['Starfall Wanderer'])).toBe(false);
  });
});

describe('normalizeStrict', () => {
  it('applies NFKC, lower-cases and removes spaces and punctuation', () => {
    expect(normalizeStrict('Ｓｔａｒｆａｌｌ: Wanderer · End')).toBe('starfallwandererend');
    expect(normalizeStrict('[Star-fall] (Wan/der_er); 1.2, 3')).toBe('starfallwanderer123');
  });

  it("keeps title-significant marks: ' ’ ′ ° ! ? ☆ ★ ♪ ＋ +", () => {
    expect(normalizeStrict("Glimmer'")).not.toBe(normalizeStrict('Glimmer'));
    expect(normalizeStrict("Wanderer's End!")).toBe("wanderer'send!");
    for (const mark of ['°', '!', '?', '☆', '★', '♪', '+']) expect(normalizeStrict(`Spark${mark}`)).toBe(`spark${mark}`);
    expect(normalizeStrict('Spark＋')).toBe('spark+');
    for (const mark of ['’', '‘', '′', '`']) expect(normalizeStrict(`Spark${mark}`)).not.toBe(normalizeStrict('Spark'));
  });

  it('folds typographic variants of a mark to one form (M2)', () => {
    for (const mark of ['’', '‘', '′', '`', '＇']) expect(normalizeStrict(`Wanderer${mark}s End`)).toBe("wanderer'send");
    expect(normalizeStrict('“Harbor” Line')).toBe(normalizeStrict('"Harbor" Line'));
    expect(normalizeStrict('Fin & Feather')).toBe(normalizeStrict('Fin and Feather'));
    expect(normalizeStrict('Fin ＆ Feather')).toBe('finandfeather');
    expect(normalizeStrict('Ｇｌａｓｓ Ｏｒｃｈａｒｄ')).toBe(normalizeStrict('Glass Orchard'));
    // other marks stay distinct (T5p)
    expect(normalizeStrict('Spark!')).not.toBe(normalizeStrict('Spark?'));
    expect(normalizeStrict('Spark☆')).not.toBe(normalizeStrict('Spark♪'));
  });

  it('does not fold long vowels', () => {
    expect(normalizeStrict('Good Hunter')).not.toBe(normalizeStrict('God Hunter'));
    expect(normalizeStrict('Sōsō')).toBe('sōsō');
    expect(normalizeStrict('Toukyou')).toBe('toukyou');
  });

  it('does not fold katakana to hiragana', () => {
    expect(normalizeStrict('ヴェルミナ')).not.toBe(normalizeStrict('ゔぇるみな'));
  });
});
