// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import type { ContinueItem, EncodeShow, EncodeShowSummary } from '@seikou/nas/nas-api';
import {
  continueRoute, encodesEmptyState, episodeCountLabel, episodeMark, findEncodeShow, indexingRetryMs, nextEpisode, ownerNotices, searchShows, showContaining, showGroups, untilIndexed,
} from './encodes-model';
import { NasHttpError } from './nas-client';

const SHOW: EncodeShow = {
  id: '100', name: 'Starfall Wanderer', poster: null,
  seasons: [
    { anilistId: 100, name: 'Starfall Wanderer', kind: 'season', number: 1, episodes: [{ episode: 1, id: '100-1', title: 'The Long Night', durationMs: 1_440_000 }, { episode: 2, id: '100-2', title: null, durationMs: 1_420_000 }] },
    { anilistId: 103, name: 'Starfall Wanderer: Ember Road', kind: 'film', number: null, episodes: [{ episode: 1, id: '103-1', title: null, durationMs: 6_000_000 }] },
    { anilistId: 104, name: 'Starfall Wanderer Picture Drama', kind: 'other', number: null, episodes: [{ episode: 1, id: '104-1', title: null, durationMs: 300_000 }] },
    { anilistId: 101, name: 'Starfall Wanderer Season 2', kind: 'season', number: 2, episodes: [{ episode: 1, id: '101-1', title: null, durationMs: 1_440_000 }] },
  ],
};

describe('the encodes empty states', () => {
  it('asks an owner without ENCODES_DIR to set ENCODES_MOUNT, with the help link', () => {
    const e = encodesEmptyState({ configured: false, count: 0 }, true, 0);
    expect(e).toMatchObject({ kind: 'unconfigured', help: '/help/nas#encodes' });
    expect(e?.text).toBe('Set ENCODES_MOUNT on the NAS to hold encodes');
  });

  it('tells an owner with the folder and nothing in it to encode an episode', () => {
    expect(encodesEmptyState({ configured: true, count: 0 }, true, 0)).toMatchObject({ kind: 'owner-none', text: 'Encode an episode in Seikou encoder to add it here.' });
  });

  it('tells everyone else the library is empty, configured or not', () => {
    for (const configured of [true, false]) {
      expect(encodesEmptyState({ configured, count: 0 }, false, 0)).toEqual({
        kind: 'guest', title: 'The library is currently empty.', text: 'Encoded episodes appear here once the owner adds them.',
      });
    }
  });

  it('has no empty state once a show is listed', () => {
    expect(encodesEmptyState({ configured: true, count: 3 }, true, 1)).toBeNull();
    expect(encodesEmptyState({ configured: true, count: 3 }, false, 1)).toBeNull();
  });
});

describe('the owner notices', () => {
  it('names a missing or empty folder and a scan error, for owners only', () => {
    const status = { configured: true, count: 2, rootMissing: true, scanError: 'EACCES: permission denied' };
    expect(ownerNotices(status, true)).toEqual(["The encodes folder isn't there. Check that the drive is mounted.", 'EACCES: permission denied']);
    expect(ownerNotices({ configured: true, count: 2, rootEmpty: true }, true)).toEqual(['The encodes folder is empty, but the library still lists earlier episodes.']);
    expect(ownerNotices(status, false)).toEqual([]);
    expect(ownerNotices(null, true)).toEqual([]);
  });
});

describe('indexing', () => {
  it('retries a 503 indexing after its Retry-After, and nothing else', () => {
    expect(indexingRetryMs(new NasHttpError(503, 'indexing', { retryAfter: 3 }))).toBe(3000);
    expect(indexingRetryMs(new NasHttpError(503, 'indexing'))).toBe(5000);
    expect(indexingRetryMs(new NasHttpError(503, 'busy', { retryAfter: 3 }))).toBeNull();
    expect(indexingRetryMs(new NasHttpError(404, null))).toBeNull();
    expect(indexingRetryMs(new Error('x'))).toBeNull();
  });

  it('waits at most 60 s, whatever Retry-After says', () => {
    expect(indexingRetryMs(new NasHttpError(503, 'indexing', { retryAfter: 3600 }))).toBe(60_000);
  });

  it('waits at least 1 s, even for a Retry-After of 0', () => {
    expect(indexingRetryMs(new NasHttpError(503, 'indexing', { retryAfter: 0 }))).toBe(1000);
  });

  it('untilIndexed asks again after each indexing answer, and stops when cancelled', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const ask = vi.fn(async () => {
        n++;
        if (n < 3) throw new NasHttpError(503, 'indexing', { retryAfter: 2 });
        return 'done';
      });
      const waiting = vi.fn();
      const run = untilIndexed(ask, waiting);
      await vi.advanceTimersByTimeAsync(0);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(waiting).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(ask).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(run.result).resolves.toBe('done');
      // another error ends it at once
      const failing = untilIndexed(async () => {
        throw new NasHttpError(404, null);
      });
      await expect(failing.result).rejects.toThrow('404');
      // cancelled while waiting: nothing more is asked
      const again = vi.fn(async () => {
        throw new NasHttpError(503, 'indexing', { retryAfter: 1 });
      });
      const stopped = untilIndexed(again);
      await vi.advanceTimersByTimeAsync(0);
      stopped.cancel();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(again).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the show grid', () => {
  const shows: EncodeShowSummary[] = [
    { id: '100', name: 'Starfall Wanderer', poster: null, episodeCount: 12, anilistIds: [100] },
    { id: '200', name: 'Lantern Tide', poster: 'p', episodeCount: 1, anilistIds: [200] },
  ];
  it('counts episodes', () => {
    expect(episodeCountLabel(1)).toBe('1 episode');
    expect(episodeCountLabel(12)).toBe('12 episodes');
  });
  it('filters by name, keeping the order', () => {
    expect(searchShows(shows, '').map((s) => s.id)).toEqual(['100', '200']);
    expect(searchShows(shows, '  lantern ').map((s) => s.id)).toEqual(['200']);
    expect(searchShows(shows, 'zzz')).toEqual([]);
  });
});

describe('continue watching cards', () => {
  const card = (over: Partial<ContinueItem>): ContinueItem => ({
    kind: 'resume', discKey: '', discId: '', playlistId: 'mkv', encodeId: '100-2', timeUs: 754_900_000, durationUs: 1_420_000_000,
    titleId: '100', titleName: 'Starfall Wanderer', poster: null, seasonId: null, seasonNumber: 1, episode: 2, kindOfTitle: 'series',
    updatedAt: 1, deviceName: 'Mac', settings: null, ...over,
  });
  it('resumes a place and starts an Up next episode from its beginning', () => {
    expect(continueRoute(card({}))).toEqual({ kind: 'encodePlay', encodeId: '100-2', timeS: 754, resume: true });
    expect(continueRoute(card({ kind: 'up-next', encodeId: '100-3', timeUs: 0 }))).toEqual({ kind: 'encodePlay', encodeId: '100-3', timeS: null, resume: false });
  });
  it('opens nothing for a card without an encode', () => {
    expect(continueRoute(card({ encodeId: undefined }))).toBeNull();
  });
});

describe('the show screen', () => {
  it('lists seasons in the order given, then films, then the others', () => {
    const groups = showGroups(SHOW);
    expect(groups.map((g) => g.heading)).toEqual(['Season 1', 'Season 2', 'Starfall Wanderer: Ember Road', 'Starfall Wanderer Picture Drama']);
    expect(groups.map((g) => g.kind)).toEqual(['season', 'season', 'film', 'other']);
    // a season's own name shows under its heading when it isn't the show's
    expect(groups[0]!.sub).toBeNull();
    expect(groups[1]!.sub).toBe('Starfall Wanderer Season 2');
    expect(groups[2]!.sub).toBe('Film');
  });

  it('does not repeat a season named "Season N" under its heading', () => {
    const show: EncodeShow = { ...SHOW, seasons: [{ ...SHOW.seasons[3]!, name: 'Season 2' }] };
    expect(showGroups(show)[0]).toMatchObject({ heading: 'Season 2', sub: null });
  });

  it('names a season without a number by its entry', () => {
    const show: EncodeShow = { ...SHOW, seasons: [{ ...SHOW.seasons[0]!, number: null, name: 'Starfall Wanderer Zero' }] };
    expect(showGroups(show)[0]).toMatchObject({ heading: 'Starfall Wanderer Zero', sub: null });
  });

  it('marks progress: a bar and a resume time while unfinished, watched once finished', () => {
    const progress = {
      '100-1': { mkv: { timeUs: 720_000_000, durationUs: 1_440_000_000, finished: false } },
      '100-2': { mkv: { timeUs: 1_420_000_000, durationUs: 1_420_000_000, finished: true } },
      '101-1': { mkv: { timeUs: 10_000_000, durationUs: 1_440_000_000, finished: false } },
    };
    expect(episodeMark(progress, '100-1')).toEqual({ percent: 50, finished: false, resumeUs: 720_000_000 });
    expect(episodeMark(progress, '100-2')).toEqual({ percent: null, finished: true, resumeUs: null });
    // a place near the start shows its bar but offers no resume (isShortPlace)
    expect(episodeMark(progress, '101-1')).toEqual({ percent: 1, finished: false, resumeUs: null });
    expect(episodeMark(progress, '103-1')).toBeNull();
    expect(episodeMark(null, '100-1')).toBeNull();
  });
});

describe('a show whose id changed', () => {
  const other: EncodeShow = { id: '300', name: 'Lantern Tide', poster: null, seasons: [{ anilistId: 300, name: 'Lantern Tide', kind: 'season', number: 1, episodes: [{ episode: 1, id: '300-1', title: null, durationMs: 1 }] }] };
  it('is found again by an AniList id among its seasons', () => {
    expect(showContaining([other, SHOW], { anilistId: 101 })).toBe('100');
  });
  it('is found again by an episode', () => {
    expect(showContaining([other, SHOW], { encodeId: '103-1' })).toBe('100');
  });
  it('is not found when no show holds it', () => {
    expect(showContaining([other, SHOW], { anilistId: 999 })).toBeNull();
    expect(showContaining([], { anilistId: 100 })).toBeNull();
  });
});

describe('the next episode', () => {
  it('is the next number in the season, then the first episode of the next season, never a film', () => {
    expect(nextEpisode(SHOW, '100-1')?.id).toBe('100-2');
    expect(nextEpisode(SHOW, '100-2')?.id).toBe('101-1');
  });

  it("is none at the show's last episode, after a film or an other entry's last", () => {
    expect(nextEpisode(SHOW, '101-1')).toBeNull();
    expect(nextEpisode(SHOW, '103-1')).toBeNull();
    expect(nextEpisode(SHOW, '104-1')).toBeNull();
    expect(nextEpisode(SHOW, '999-1')).toBeNull();
  });

  it('goes on within an other row, as the NAS\'s Up next does', () => {
    const ova = { anilistId: 105, name: 'Starfall Wanderer OVA', kind: 'other' as const, number: null, episodes: [{ episode: 1, id: '105-1', title: null, durationMs: 1 }, { episode: 2, id: '105-2', title: null, durationMs: 1 }] };
    const show: EncodeShow = { ...SHOW, seasons: [...SHOW.seasons, ova] };
    expect(nextEpisode(show, '105-1')?.id).toBe('105-2');
    expect(nextEpisode(show, '105-2')).toBeNull();
  });

  it('goes by episode number, past a missing one', () => {
    const s1 = SHOW.seasons[0]!;
    const show: EncodeShow = { ...SHOW, seasons: [{ ...s1, episodes: [s1.episodes[1]!, { episode: 4, id: '100-4', title: null, durationMs: 1 }, s1.episodes[0]!] }] };
    expect(nextEpisode(show, '100-1')?.id).toBe('100-2');
    expect(nextEpisode(show, '100-2')?.id).toBe('100-4');
    expect(nextEpisode(show, '100-4')).toBeNull();
  });

  it("finds the show holding an episode from the list's AniList ids, fetching only that show", async () => {
    const other: EncodeShow = { id: '300', name: 'Lantern Tide', poster: null, seasons: [] };
    const asked: string[] = [];
    let listed = [
      { id: '300', name: 'Lantern Tide', poster: null, episodeCount: 1, anilistIds: [300] },
      { id: '100', name: 'Starfall Wanderer', poster: null, episodeCount: 5, anilistIds: [100, 103, 104, 101] },
    ];
    const nas = {
      encodeShow: async (id: string) => {
        asked.push(id);
        return id === '100' ? SHOW : id === '300' ? other : null;
      },
      encodeShows: async () => ({ shows: listed }),
    };
    expect((await findEncodeShow(nas, 101))?.id).toBe('100');
    expect(asked).toEqual(['100']);
    asked.length = 0;
    expect((await findEncodeShow(nas, 100))?.id).toBe('100');
    expect(asked).toEqual(['100']);
    asked.length = 0;
    expect(await findEncodeShow(nas, 999)).toBeNull();
    expect(asked).toEqual([]);

    // a NAS from before the ids: the show rooted at the entry, else each show in turn
    listed = listed.map(({ anilistIds: _ids, ...s }) => s) as typeof listed;
    asked.length = 0;
    expect((await findEncodeShow(nas, 100))?.id).toBe('100');
    expect(asked).toEqual(['100']);
    asked.length = 0;
    expect((await findEncodeShow(nas, 101))?.id).toBe('100');
    expect(asked).toEqual(['101', '300', '100']);
    asked.length = 0;
    expect(await findEncodeShow(nas, 999)).toBeNull();
    expect(asked).toEqual(['999', '300', '100']);
  });
});
