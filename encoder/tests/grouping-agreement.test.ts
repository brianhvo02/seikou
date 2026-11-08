// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { episodesOf, fromSpec } from '../web/src/app/grouping';
import { EpisodeSpecError, parseEpisodeSpec } from '../src/plan/episodes';

// The page re-implements the episode text rules so it need not import the planner; this keeps the two in step.
describe('the page grouping model and parseEpisodeSpec', () => {
  it('agrees with parseEpisodeSpec on every case', () => {
    const cases = ['1-4,5-8', '1-3,5-8', '2', '8', '1-', '3-5,7-', '1-4,6', ' 1-2 , 4 ', '3-2', '1-3,3-4', '1-,3', '9', '0', '', '1-2,', 'x'];
    for (const c of cases) {
      let valid = true;
      let expected: { from: number; to: number }[] = [];
      try {
        expected = parseEpisodeSpec(c, 8).map((s) => ({ from: s.from, to: s.to ?? 8 }));
      } catch (e) {
        if (!(e instanceof EpisodeSpecError)) throw e;
        valid = false;
      }
      const g = fromSpec(c, 8);
      expect(g !== null, c).toBe(valid);
      if (g) expect(episodesOf(g, 8), c).toEqual(expected);
    }
  });
});
