import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeVideoCodecApi } from '../../tests/helpers/fake-video-decoder';
import { fixtureDiscFiles } from '../../tests/helpers/fixture-disc';
import { discEntries } from '../../tests/helpers/synthetic-disc';
import { createRing, renderQuantum, ringViews } from './audio/ring';
import { createAudioDecoderFactory } from './decode/audio-decoder';
import { Player } from './player';
import type { EngineEvent, PlaybackState } from './protocol';

const STEP_MS = 640 / 48;
const players: Player[] = [];
afterEach(async () => {
  for (const p of players.splice(0)) await p.handle({ type: 'close' });
});

/** A Player built as player-bdj.test.ts builds it, but with no BD-J provider (PlayerDeps.bdj). */
async function harness(): Promise<{ readonly player: Player; readonly events: EngineEvent[]; play(ms: number): Promise<void> }> {
  const events: EngineEvent[] = [];
  const clock = { ms: 1000 };
  const player = new Player({
    emit: (e) => events.push(e),
    videoCodecApi: fakeVideoCodecApi,
    nowMs: () => clock.ms,
    requestFrame: () => undefined,
    createAudioDecoder: createAudioDecoderFactory(() => Promise.reject(new Error('no wasm'))),
    createCompositor: () => ({ resize: () => undefined, drawVideo: () => undefined }),
    setTimer: () => () => undefined,
  });
  players.push(player);
  const ring = createRing(48_000, 2);
  const views = ringViews(ring);
  await player.handle({ type: 'attachAudio', ring });
  await player.handle({ type: 'attachCanvas', canvas: {} as OffscreenCanvas });
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  return {
    player,
    events,
    async play(ms) {
      for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
        clock.ms += STEP_MS;
        for (let q = 0; q < 5; q++) renderQuantum(views, left, right);
        player.tick();
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
}

const lastState = (events: readonly EngineEvent[]): PlaybackState | undefined => events.flatMap((e) => (e.type === 'state' ? [e.state] : [])).at(-1);
const times = (events: readonly EngineEvent[]): number[] => events.flatMap((e) => (e.type === 'time' ? [e.timeUs] : []));

describe('Player without a BD-J provider', () => {
  it('opens a BD-J disc to the picker, naming the BD-J runtime as missing, and plays a playlist picked there', async () => {
    const h = await harness();
    await h.player.handle({ type: 'open', disc: { kind: 'files', entries: discEntries(fixtureDiscFiles('disc-bdj')) } });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'titles', usesBdj: true, bdjSupported: false, bdjMissing: ['BD-J runtime'] }));
    expect(h.events).toContainEqual({
      type: 'notice',
      code: 'bdj',
      message: "This disc uses BD-J (Java) menus, which this browser can't run: it lacks BD-J runtime. Choose a playlist to play.",
    });
    expect(h.events).not.toContainEqual(expect.objectContaining({ type: 'bdjActive', active: true }));
    expect(lastState(h.events)).toBe('idle');

    await h.player.handle({ type: 'playPlaylist', playlistId: '00000' });
    await vi.waitFor(
      async () => {
        await h.play(50);
        expect(lastState(h.events)).toBe('playing');
        expect(Math.max(0, ...times(h.events))).toBeGreaterThan(0);
      },
      { timeout: 30_000, interval: 1 },
    );
  }, 60_000);
});
