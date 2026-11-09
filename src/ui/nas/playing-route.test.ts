import { describe, expect, it } from 'vitest';
import type { NasRoute } from './nas-route';
import { PlayingRoute } from './playing-route';

const KEY = 'f.0123456789ABCDEF0123456789ABCDEF';

/** The history's route and what was put in its place. */
function fakeHistory(initial: NasRoute | null = { kind: 'play', discKey: KEY, playlistId: null, timeS: null, resume: false }) {
  const h = {
    current: initial,
    replaced: [] as NasRoute[],
    route: () => h.current,
    replace: (r: NasRoute | null) => {
      if (r === null) throw new Error('unexpected replace(null)');
      h.current = r;
      h.replaced.push(r);
    },
  };
  return h;
}

function make(initial?: NasRoute | null) {
  const h = fakeHistory(initial);
  let now = 0;
  const route = new PlayingRoute(h, () => now);
  return { h, route, at: (ms: number) => (now = ms) };
}

const playing = (timeUs: number, engineState = 'playing') => ({ currentPlaylistId: '00001', timeUs, engineState });
const times = (h: { replaced: NasRoute[] }) => h.replaced.map((r) => (r.kind === 'play' ? r.timeS : NaN));

describe('PlayingRoute', () => {
  it('does nothing before start or after stop', () => {
    const { h, route, at } = make();
    route.update(playing(1e6));
    expect(h.replaced).toEqual([]);
    route.start(KEY);
    route.update(playing(2e6));
    at(2500);
    route.update(playing(2.5e6, 'paused'));
    expect(h.replaced).toHaveLength(1);
    route.stop();
    at(10_000);
    route.update(playing(12e6, 'paused'));
    expect(h.replaced).toHaveLength(1);
  });

  it('replaces at most every 5 s while playing, with the time floored to whole seconds', () => {
    const { h, route, at } = make();
    route.start(KEY);
    route.update(playing(0));
    for (let ms = 500; ms < 5000; ms += 500) {
      at(ms);
      route.update(playing(ms * 1000));
    }
    expect(h.replaced).toEqual([]);
    at(5000);
    route.update(playing(5_900_000));
    expect(h.replaced).toEqual([{ kind: 'play', discKey: KEY, playlistId: '00001', timeS: 5, resume: false }]);
    at(5500);
    route.update(playing(6_400_000));
    at(10_000);
    route.update(playing(10_900_000));
    expect(times(h)).toEqual([5, 10]);
  });

  it('replaces at once on pause', () => {
    const { h, route, at } = make();
    route.start(KEY);
    route.update(playing(0));
    at(1200);
    route.update(playing(1_200_000));
    at(1300);
    route.update(playing(1_300_000, 'paused'));
    expect(times(h)).toEqual([1]);
    // still paused: no more replaces than the throttle allows
    at(1400);
    route.update(playing(1_300_000, 'paused'));
    expect(times(h)).toEqual([1]);
  });

  it('replaces at once on a 10 s jump (a seek)', () => {
    const { h, route, at } = make();
    route.start(KEY);
    route.update(playing(0));
    at(1000);
    route.update(playing(1_000_000));
    at(1500);
    route.update(playing(11_500_000));
    expect(times(h)).toEqual([11]);
  });

  it("leaves a link's time in place while its playlist starts, then writes the link's seek", () => {
    const { h, route, at } = make({ kind: 'play', discKey: KEY, playlistId: '00001', timeS: 600, resume: false });
    route.start(KEY);
    route.update(playing(0));
    expect(h.replaced).toEqual([]);
    at(300);
    route.update(playing(600_000_000));
    expect(times(h)).toEqual([600]);
  });

  it('leaves a screen Back went to alone', () => {
    const { h, route, at } = make();
    route.start(KEY);
    h.current = { kind: 'library', shelf: null, q: '' };
    at(6000);
    route.update(playing(6e6, 'paused'));
    expect(h.replaced).toEqual([]);
  });

  it('waits for a playlist before writing one', () => {
    const { h, route } = make();
    route.start(KEY);
    route.update({ currentPlaylistId: null, timeUs: 0, engineState: 'loading' });
    expect(h.replaced).toEqual([]);
  });
});

describe('PlayingRoute write floor', () => {
  it('a burst of seeks makes at most 3 replaces, the last with the final time', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const h = fakeHistory();
      const route = new PlayingRoute(h, () => Date.now());
      route.start(KEY);
      route.update(playing(0));
      for (let i = 1; i <= 20; i++) {
        vi.advanceTimersByTime(100);
        route.update(playing(i * 10e6));
      }
      vi.advanceTimersByTime(2000);
      expect(h.replaced.length).toBeLessThanOrEqual(3);
      expect(times(h).at(-1)).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an encode's play route current, never naming a disc", () => {
    const { h, route, at } = make({ kind: 'encodePlay', encodeId: '100-3', timeS: null, resume: true });
    route.startEncode('100-3');
    expect(route.discKey).toBeNull();
    expect(route.encodeId).toBe('100-3');
    route.update({ currentPlaylistId: 'mkv', timeUs: 0, engineState: 'playing' });
    at(5000);
    route.update({ currentPlaylistId: 'mkv', timeUs: 5.4e6, engineState: 'playing' });
    expect(h.replaced).toEqual([{ kind: 'encodePlay', encodeId: '100-3', timeS: 5, resume: false }]);
    route.stop();
    expect(route.encodeId).toBeNull();
    // a disc start forgets the encode
    route.startEncode('100-3');
    route.start(KEY);
    expect(route.encodeId).toBeNull();
  });

  it("writes nothing for an encode once the address bar has left its play route", () => {
    const { h, route, at } = make({ kind: 'encodes', q: '' });
    route.startEncode('100-3');
    route.update({ currentPlaylistId: 'mkv', timeUs: 0, engineState: 'playing' });
    at(6000);
    route.update({ currentPlaylistId: 'mkv', timeUs: 6e6, engineState: 'paused' });
    expect(h.replaced).toEqual([]);
  });
});
