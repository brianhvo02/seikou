import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ShownStill } from '../../src/bdj/background';
import type { CompositorLike } from '@seikou/engine/render/compositor';
import { replayPlayerBdj } from './replay-player';

const DISC = new URL('../../fixtures/synthetic/disc-bdj-background', import.meta.url);
/** The still BackgroundXlet packs into its jar and shows (tests/bdj/xlets/src/bdjweb/background). */
const STILL = new Uint8Array(readFileSync(fileURLToPath(new URL('./xlets/src/bdjweb/background/bg.png', import.meta.url))));

describe('BD-J background stills (disc-bdj-background)', () => {
  it("draws the xlet's displayImage still under the video, and clears it when BD-J stops", async () => {
    const calls: string[] = [];
    let shown: ShownStill | null = null;
    const stills: ShownStill[] = [];
    let framesOverStill = 0;
    const compositor: CompositorLike = {
      resize: () => undefined,
      drawVideo: (frame) => {
        calls.push(`drawVideo:${frame ? 'frame' : 'none'}`);
        if (frame && shown) framesOverStill++;
      },
      setBackground: (still) => {
        shown = still;
        if (still) stills.push(still);
        calls.push(still ? 'setBackground:still' : 'setBackground:null');
      },
      drawBdj: () => undefined,
      clearBdj: () => void calls.push('clearBdj'),
    };
    const decoded: Uint8Array[] = [];
    const bitmap = { width: 64, height: 36, closed: false, close: () => void (bitmap.closed = true) };
    const run = await replayPlayerBdj(DISC, {
      until: '-',
      timeoutMs: 120_000,
      compositor,
      decodeImage: async (bytes) => {
        decoded.push(bytes);
        return bitmap as unknown as ImageBitmap;
      },
      // a few video frames drawn over the still
      untilPlane: () => framesOverStill >= 3,
    });

    // the bytes the xlet's HBackgroundImage("bg.png") names, read from the jar's mount
    expect(decoded).toEqual([STILL]);
    // displayImage is not in libbluray's trace; the xlet goes on to play its playlist over the still
    expect(run.trace.filter((e) => e.call === 'selectPlaylistN').map((e) => e.args[0])).toEqual([0]);
    expect(run.events.some((e) => e.type === 'notice' && e.code === 'bdj-failed')).toBe(false);
    // the left half of the screen, as the xlet's HScreenRectangle(0, 0, 0.5, 1)
    expect(stills).toEqual([{ image: bitmap, rect: { x: 0, y: 0, width: 0.5, height: 1 } }]);
    const first = calls.indexOf('setBackground:still');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(calls.slice(first + 1)).toContain('drawVideo:frame');
    // the player's close stopped BD-J (stopBdj): the still is dropped, closed, and the picture redrawn without it
    const last = calls.lastIndexOf('setBackground:null');
    expect(last).toBeGreaterThan(first);
    expect(calls.slice(last + 1, last + 3)).toEqual(['clearBdj', 'drawVideo:frame']);
    expect(shown).toBeNull();
    expect(bitmap.closed).toBe(true);
  }, 180_000);
});
