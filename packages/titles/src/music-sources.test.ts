import { describe, expect, it } from 'vitest';
import { chooseRelease } from './music-sources';
import type { ReleaseCandidate } from './music-sources';

const c = (item: string, o: Partial<ReleaseCandidate<string>> = {}): ReleaseCandidate<string> => ({ item, bluray: false, japan: false, date: '2020', artistKey: 'a', ...o });

describe('chooseRelease', () => {
  it('is null with no candidates', () => expect(chooseRelease([])).toBeNull());
  it('keeps the first of a tie', () => {
    expect(chooseRelease([c('first', { bluray: true, japan: true }), c('second', { bluray: true, japan: true })])).toBe('first');
  });
  it('sorts an unknown date after a known one', () => {
    expect(chooseRelease([c('unknown', { date: null }), c('known', { date: '2023-05' })])).toBe('known');
  });
  it('does not count a null artist as a disagreement', () => {
    expect(chooseRelease([c('x', { artistKey: null, date: '2019' }), c('y', { artistKey: 'a' })])).toBe('x');
  });
  it('misses when artists disagree', () => {
    expect(chooseRelease([c('x', { artistKey: 'a' }), c('y', { artistKey: 'b' })])).toBeNull();
  });
  it('prefers Blu-ray not Japan over Japan without Blu-ray', () => {
    expect(chooseRelease([c('jp', { japan: true }), c('bd', { bluray: true })])).toBe('bd');
  });
});
