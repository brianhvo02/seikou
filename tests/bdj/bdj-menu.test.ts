import { describe, expect, it } from 'vitest';
import type { ShownStill } from '../../src/bdj/background';
import { createGraphicsPlane, planeHash } from '../../src/bdj/graphics-plane';
import type { CompositorLike } from '@seikou/engine/render/compositor';
import type { replayPlayerBdj } from './replay-player';
import { replaySettled } from './settled';

const DISC = new URL('../../fixtures/synthetic/disc-bdj-menu', import.meta.url);

/** Replays tests/bdj/scripts/disc-bdj-menu.<script>.keys and compares it with its libbluray golden (settled.ts). */
const replayMenu = (script: string, extra: Pick<Parameters<typeof replayPlayerBdj>[1], 'compositor' | 'decodeImage'> = {}) =>
  replaySettled(DISC, new URL(`./golden/disc-bdj-menu.${script}.jsonl`, import.meta.url), new URL(`./scripts/disc-bdj-menu.${script}.keys`, import.meta.url), extra);

describe('BD-J menu disc against libbluray (disc-bdj-menu)', () => {
  it('arrows move the focus and Enter on Play starts playlist 00000, with the planes libbluray draws', async () => {
    // the menu's background still (HStillImageBackgroundConfiguration.displayImage, not in libbluray's plane: it leaves
    // displayImage unimplemented) goes to the compositor under the video
    const stills: ShownStill[] = [];
    const compositor: CompositorLike = {
      resize: () => undefined,
      drawVideo: () => undefined,
      setBackground: (still) => void (still && stills.push(still)),
      drawBdj: () => undefined,
      clearBdj: () => undefined,
    };
    const bitmap = { width: 64, height: 36, close: () => undefined } as unknown as ImageBitmap;
    const { run, golden: g } = await replayMenu('arrows', { compositor, decodeImage: async () => bitmap });
    expect(stills).toEqual([{ image: bitmap, rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }]);
    // three settled menus (Play, Chapters, Extras focused), each with the logo and text in the disc's CFF font and in
    // the fallback font; Enter then plays 00000 behind an emptied plane
    expect(new Set(g.steps.flatMap((s) => (s.hash ? [s.hash] : []))).size).toBe(3);
    expect(run.trace.filter((e) => e.call === 'selectPlaylistN').map((e) => e.args[0])).toEqual([1, -1, 0]); // Enter stops and closes 00001 first
    expect(g.endHash).toBe(planeHash(createGraphicsPlane()));
    console.log(`disc-bdj-menu arrows: ${run.flushes.length} flushes (${run.flushes.join(' ')}), ${run.untilMs.toFixed(0)} ms`);
  }, 180_000);

  it('a click on the MouseListener button changes it, a click on empty plane changes nothing', async () => {
    const { run } = await replayMenu('mouse');
    console.log(`disc-bdj-menu mouse: ${run.flushes.length} flushes (${run.flushes.join(' ')}), ${run.untilMs.toFixed(0)} ms`);
  }, 180_000);
});
