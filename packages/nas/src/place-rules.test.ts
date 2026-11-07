import { describe, expect, it } from 'vitest';
import { isShortPlace } from './place-rules';

describe('isShortPlace', () => {
  it('is short before 5% of a playlist under 10 minutes', () => {
    expect(isShortPlace(11_999_999, 240_000_000)).toBe(true); // 5% of 4 min is 12 s
    expect(isShortPlace(12_000_000, 240_000_000)).toBe(false);
  });

  it('is short before 30 s of a longer playlist', () => {
    expect(isShortPlace(29_999_999, 1_440_000_000)).toBe(true);
    expect(isShortPlace(30_000_000, 1_440_000_000)).toBe(false);
  });

  it('is never short without a length', () => {
    expect(isShortPlace(0, 0)).toBe(false);
  });
});
