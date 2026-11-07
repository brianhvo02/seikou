import { describe, expect, it } from 'vitest';
import { NAME_CORPUS } from './corpus';
import { parseName } from './parse-name';

describe('parseName', () => {
  for (const { text, expected } of NAME_CORPUS) {
    it(text, () => {
      const parsed = parseName(text);
      for (const [key, value] of Object.entries(expected)) expect(parsed[key as keyof typeof parsed], key).toEqual(value);
    });
  }

  it('returns empty structure for an empty name', () => {
    expect(parseName('')).toEqual({ candidates: [], season: null, volume: null, disc: null, box: null, year: null, episodes: null, bonus: false, music: false });
  });
});
