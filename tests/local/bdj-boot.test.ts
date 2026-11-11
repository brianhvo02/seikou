import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { replayPlayerBdj } from '../bdj/replay-player';

const LOCAL = fileURLToPath(new URL('../../fixtures/local', import.meta.url)); // independent of the working directory

/**
 * The first two playlists each known disc's BD-J program selects, from libbluray's trace
 * (npm run bdj-trace -- <disc> --until selectPlaylistN#2): the intro, then the menu background once the intro ends.
 */
const SELECTIONS: Readonly<Record<string, readonly [number, number]>> = { BDJ_DISC_A: [833, 149], BDJ_DISC_B: [1611, 1355] };

function bdjDiscs(): string[] {
  if (!existsSync(LOCAL)) return [];
  return readdirSync(LOCAL)
    .map((name) => join(LOCAL, name))
    .filter((dir) => existsSync(join(dir, 'BDMV', 'BDJO')));
}

const discs = bdjDiscs();

describe.skipIf(discs.length === 0)('local BD-J discs', () => {
  for (const dir of discs) {
    const name = basename(dir);
    it(`${name} plays its first playlist to the end and selects the next one, in the player`, async () => {
      const { trace, firstPlaylistMs, untilMs, virtualMs } = await replayPlayerBdj(dir, { until: 'selectPlaylistN', occurrence: 2, timeoutMs: 240_000 });
      console.log(`${name}: firstPlaylistMs ${firstPlaylistMs.toFixed(0)}, untilMs ${untilMs.toFixed(0)} (virtual ${virtualMs.toFixed(0)} ms)`);
      const selections = trace.filter((e) => e.call === 'selectPlaylistN');
      expect(selections).toHaveLength(2);
      expect(selections.every((e) => e.ret === 1)).toBe(true);
      const expected = SELECTIONS[name];
      if (expected !== undefined) expect(selections.map((e) => e.args[0])).toEqual(expected);
    }, 300_000);
  }
});
