import { describe, expect, it } from 'vitest';
import { autoPlace, episodeStarts, MIN_EPISODE_US, sortByName, TextSet } from './text-set';

const MIN = 60_000_000;
const file = (name: string) => ({ name, format: 'ass' as const, cues: 1, renderer: name });

describe('episodeStarts', () => {
  it('keeps play items of at least five minutes', () => {
    expect(episodeStarts([{ startUs: 0, durationUs: 30_000_000 }, { startUs: 30_000_000, durationUs: 24 * MIN }, { startUs: 30_000_000 + 24 * MIN, durationUs: 24 * MIN }])).toEqual([30_000_000, 30_000_000 + 24 * MIN]);
  });
  it('uses every item when none is that long', () => {
    expect(episodeStarts([{ startUs: 0, durationUs: 2_000_000 }, { startUs: 2_000_000, durationUs: 2_000_000 }])).toEqual([0, 2_000_000]);
    expect(MIN_EPISODE_US).toBe(5 * MIN);
  });
});

describe('sortByName', () => {
  it('orders numbers numerically', () => {
    expect(sortByName([file('ep10.ass'), file('ep2.ass'), file('ep1.ass')]).map((f) => f.name)).toEqual(['ep1.ass', 'ep2.ass', 'ep10.ass']);
  });
});

describe('autoPlace', () => {
  it('places file n at start n when the counts match', () => {
    expect(autoPlace(2, [0, 24 * MIN])).toEqual({ placements: [{ startUs: 0, offsetMs: 0 }, { startUs: 24 * MIN, offsetMs: 0 }], placed: true });
  });
  it('places only the first file at 0 otherwise', () => {
    expect(autoPlace(3, [0, 24 * MIN])).toEqual({ placements: [{ startUs: 0, offsetMs: 0 }, { startUs: null, offsetMs: 0 }, { startUs: null, offsetMs: 0 }], placed: false });
  });
  it('treats one file as placed at the playlist start', () => {
    expect(autoPlace(1, [0, 24 * MIN]).placed).toBe(true);
    expect(autoPlace(1, [0, 24 * MIN]).placements).toEqual([{ startUs: 0, offsetMs: 0 }]);
  });
});

describe('TextSet', () => {
  const set = () => { const s = new TextSet([file('ep1'), file('ep2')]); s.usePlaylist('00000', [0, 24 * MIN]); return s; };
  it('shows each file in its window, with local time from its start', () => {
    const s = set();
    expect(s.at(MIN)).toEqual({ file: 0, renderer: 'ep1', localUs: MIN });
    expect(s.at(25 * MIN)).toEqual({ file: 1, renderer: 'ep2', localUs: MIN });
  });
  it('hides a file past the next start even if its events run longer', () => {
    expect(set().at(24 * MIN)!.file).toBe(1);
  });
  it('applies each file its own offset', () => {
    const s = set();
    s.setOffset(1, 500);
    expect(s.at(25 * MIN)!.localUs).toBe(MIN - 500_000);
    expect(s.at(MIN)!.localUs).toBe(MIN);
  });
  it('clamps offsets to ten minutes', () => {
    const s = set();
    s.setOffset(0, 10 ** 9);
    expect(s.placements()[0]!.offsetMs).toBe(600_000);
  });
  it('unplaces a file whose start is taken by another', () => {
    const s = set();
    s.setStart(1, 0);
    expect(s.placements().map((p) => p.startUs)).toEqual([null, 0]);
    expect(s.at(25 * MIN)!.file).toBe(1);
  });
  it('shows nothing before the first placed start', () => {
    const s = set();
    s.setStart(0, null);
    expect(s.at(MIN)).toBeNull();
    expect(s.nextBoundary(MIN)).toBe(24 * MIN);
    expect(s.nextBoundary(25 * MIN)).toBeNull();
  });
  it('remembers placements per playlist', () => {
    const s = set();
    s.setStart(1, 20 * MIN);
    expect(s.usePlaylist('00001', [0]).placed).toBe(false);
    s.usePlaylist('00000', [0, 24 * MIN]);
    expect(s.placements()[1]!.startUs).toBe(20 * MIN);
  });
});
