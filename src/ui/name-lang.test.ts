import { describe, expect, it } from 'vitest';
import { nameLang } from './name-lang';

describe('nameLang', () => {
  it('marks a name with kana or kanji as Japanese', () => {
    expect(nameLang('星降りの旅人')).toBe('ja');
    expect(nameLang('Starfall Wanderer (星降りの旅人)')).toBe('ja');
    expect(nameLang('ｽﾀｰﾌｫｰﾙ')).toBe('ja');
    expect(nameLang('月影')).toBe('ja');
  });

  it('leaves a Latin name, or none, to the page', () => {
    expect(nameLang('Starfall Wanderer')).toBeUndefined();
    expect(nameLang('Pokémon')).toBeUndefined();
    expect(nameLang('')).toBeUndefined();
    expect(nameLang(null)).toBeUndefined();
    expect(nameLang(undefined)).toBeUndefined();
  });
});
