import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GraphicsPlaneReader } from '../../src/bdj/graphics-plane';
import { replayPlayerBdj } from '../bdj/replay-player';

const BDJ_DISC_A = fileURLToPath(new URL('../../fixtures/local/BDJ_DISC_A', import.meta.url));

/** BDJ_DISC_A's settled main menu in libbluray (tools/bdj-trace/README.md, Planes: the same in every run). */
const MAIN_MENU = '4bc306b4';
/** As the harness's `wait still`: no flush for this long (wall time) counts as settled. */
const STILL_MS = 1000;

describe.skipIf(!existsSync(BDJ_DISC_A))('the BD-J graphics plane on a local disc', () => {
  it("BDJ_DISC_A's settled main menu matches libbluray's plane hash", async () => {
    const settled: string[] = [];
    let flushes = -1;
    let since = 0;
    const isMainMenu = (plane: GraphicsPlaneReader): boolean => {
      const n = plane.flushCount();
      const now = performance.now();
      if (n !== flushes) {
        flushes = n;
        since = now;
        return false;
      }
      if (n === 0 || now - since < STILL_MS) return false;
      since = Infinity; // one hash per settled point
      settled.push(plane.hash());
      return settled.at(-1) === MAIN_MENU;
    };
    const run = await replayPlayerBdj(BDJ_DISC_A, { until: '-', untilPlane: isMainMenu, timeoutMs: 240_000 }).catch((e: unknown) => {
      throw new Error(`${e instanceof Error ? e.message : String(e)}; settled planes: ${settled.join(', ') || 'none'}`);
    });
    console.log(`BDJ_DISC_A: settled planes ${settled.join(', ')} after ${run.untilMs.toFixed(0)} ms (${run.plane?.flushCount()} flushes)`);
    expect(settled.at(-1)).toBe(MAIN_MENU);
    expect(run.plane?.visible()).toBe(true);
  }, 300_000);
});
