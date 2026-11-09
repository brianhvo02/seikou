// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ContinueItem, EncodeShow, EncodeShowSummary } from '@seikou/nas/nas-api';
import {
  continueRoute, encodesEmptyState, episodeCountLabel, episodeMark, indexingRetryMs, ownerNotices, searchShows, showContaining, showGroups,
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
});

describe('the show grid', () => {
  const shows: EncodeShowSummary[] = [
    { id: '100', name: 'Starfall Wanderer', poster: null, episodeCount: 12 },
    { id: '200', name: 'Lantern Tide', poster: 'p', episodeCount: 1 },
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
