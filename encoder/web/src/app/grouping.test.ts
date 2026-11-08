// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { episodeLengths, episodesOf, fromSpec, toSpec } from './grouping';

const set = (...n: number[]): Set<number> => new Set(n);

describe('grouping', () => {
  it('round-trips four-chapter episodes with an open last one', () => {
    const spec = '1-4,5-8,9-12,13-16,17-';
    const g = fromSpec(spec, 20)!;
    expect(g.splits).toEqual(set(4, 8, 12, 16));
    expect(g.skipped.size).toBe(0);
    expect(toSpec(episodesOf(g, 20), 20)).toBe(spec);
  });

  it('turns a skipped chapter between episodes into a gap', () => {
    const g = fromSpec('1-3,5-8', 8)!;
    expect(g.skipped).toEqual(set(4));
    expect(g.splits.size).toBe(0);
    expect(episodesOf(g, 8)).toEqual([{ from: 1, to: 3 }, { from: 5, to: 8 }]);
    expect(toSpec(episodesOf(g, 8), 8)).toBe('1-3,5-');
    expect(fromSpec('1-3,5-', 8)).toEqual(g);
  });

  it('handles a single-chapter episode and skipped tails', () => {
    const g = fromSpec('2', 5)!;
    expect(g.skipped).toEqual(set(1, 3, 4, 5));
    expect(toSpec(episodesOf(g, 5), 5)).toBe('2');
    expect(toSpec([{ from: 5, to: 5 }], 5)).toBe('5-');
  });

  it('cuts at splits and skips', () => {
    expect(episodesOf({ splits: set(2), skipped: set(4) }, 6)).toEqual([
      { from: 1, to: 2 }, { from: 3, to: 3 }, { from: 5, to: 6 },
    ]);
    expect(episodesOf({ splits: set(), skipped: set() }, 3)).toEqual([{ from: 1, to: 3 }]);
    expect(toSpec([], 3)).toBe('');
  });

  it('gives back canonical groupings unchanged', () => {
    const g = { splits: set(2, 6), skipped: set(4, 8) };
    expect(fromSpec(toSpec(episodesOf(g, 9), 9), 9)).toEqual(g);
  });

  it('rejects what the encoder rejects', () => {
    for (const bad of ['', '3-2', '1-3,3-4', '1-3,2', '4,2', '1-,3', '0-2', '1-9', '9', 'a', '1--2', '1-2,']) {
      expect(fromSpec(bad, 8), bad).toBeNull();
    }
  });

  it('sums chapter lengths', () => {
    const ms = [100, 200, 300, 400];
    expect(episodeLengths([{ from: 1, to: 2 }, { from: 4, to: 4 }], ms)).toEqual([300, 400]);
  });
});
