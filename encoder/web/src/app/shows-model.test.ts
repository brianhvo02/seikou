// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Job, NasSeason, NasSeasonDisc } from '../api-types';
import { makeJob } from './job-test-support';
import { checkTarget, discChecked, discsPhrase, groupsOf, queueBlock, queuedKeys, resolvedSpec, seasonCounts, seasonState } from './shows-model';
import { checked3, disc, ep, groups, KEY, played, season } from './shows-test-support';

const OWN = { source: 'own', ownId: '5f0c2a1e-0000-4000-8000-000000000001', season: 1 } as const;
/** A NAS that answers, its encodes list read now. */
const LIVE = { reachable: true, encodedKnown: true } as const;

/** An own title's season the NAS lists no episodes for: disc 1 checked (episode 1 encoded, 2 not), disc 2 as `disc2`. */
function ownSeason(disc2: Parameters<typeof disc>[1] = {}): NasSeason {
  return {
    id: `own:${OWN.ownId}#s1`,
    label: 'Season 1',
    number: 1,
    title: OWN,
    discs: [disc(1, { checked: true, checkedPlaylists: [played('00003', '1-4,5-8', groups([1, 2], [1], OWN), 8)] }), disc(2, disc2)],
  };
}

/** A NAS job of the app's queue. */
function nasJob(over: Partial<Job>): Job {
  const base = makeJob(over);
  return { ...base, settings: { ...base.settings, destination: 'nas' } };
}

/**
 * Disc 3 as the NAS lists it: episodes 9 to 12 each on its own playlist (00001 to 00004, one chapter each), 9 encoded,
 * with `checkedPlaylists` checked here.
 */
function perEpisode(checkedPlaylists: NasSeasonDisc['checkedPlaylists']): Partial<NasSeasonDisc> {
  const playlists = [9, 10, 11, 12].map((n, i) => ({ id: `0000${i + 1}`, episodes: [ep(n, n === 9)] }));
  return { playlists, checkedPlaylists };
}
/** The play-all playlist 00010 of disc 3: eight chapters as episodes 9 to 12, 9 encoded. */
const playAll = played('00010', '1-2,3-4,5-6,7-', groups([9, 10, 11, 12], [9]), 8);

/** `over` with `checked` set by the one rule, as the backend sets it. */
function ruled(s: NasSeason): NasSeason {
  return { ...s, discs: s.discs.map((d) => ({ ...d, checked: d.available && discChecked(s, d) })) };
}

describe('resolvedSpec', () => {
  it('closes the open end, so one list written two ways is the same list', () => {
    expect(resolvedSpec('1-3,4-', 6)).toBe('[[1,3],[4,6]]');
    expect(resolvedSpec('1-3,4-6', 6)).toBe(resolvedSpec('1-3,4-', 6));
    expect(resolvedSpec('1,2-', 4)).toBe('[[1,1],[2,4]]');
  });

  it('answers null for a list that does not read on that many chapters', () => {
    expect(resolvedSpec('1-3,4-7', 6)).toBeNull();
    expect(resolvedSpec('3-1', 6)).toBeNull();
    expect(resolvedSpec('1-,3', 6)).toBeNull();
    expect(resolvedSpec('1-3,2-4', 6)).toBeNull();
    expect(resolvedSpec('', 6)).toBeNull();
    expect(resolvedSpec('x', 6)).toBeNull();
  });
});

describe('discChecked', () => {
  it('holds as the backend sets it on the test seasons', () => {
    for (const s of [season(), season({}, checked3), ownSeason()]) for (const d of s.discs) expect(discChecked(s, d)).toBe(d.checked);
  });

  it('holds when a checked play-all playlist gives the episodes the NAS lists on their own playlists', () => {
    const s = season({}, perEpisode([playAll]));
    expect(discChecked(s, s.discs[2]!)).toBe(true);
  });

  it('needs every episode to encode in some checked group, and at least one checked playlist', () => {
    const missing11 = season({}, perEpisode([played('00010', '1-2,3-4,5-', groups([9, 10, 12], [9]), 8)]));
    expect(discChecked(missing11, missing11.discs[2]!)).toBe(false);
    // an encoded episode need not be given
    const no9 = season({}, perEpisode([played('00010', '1-2,3-4,5-', groups([10, 11, 12]), 8)]));
    expect(discChecked(no9, no9.discs[2]!)).toBe(true);
    expect(discChecked(season(), disc(4))).toBe(false);
    expect(discChecked(ownSeason(), disc(5, { checkedPlaylists: [played('00001', '1-', groups([3], [], OWN), 2)] }))).toBe(true);
  });
});

describe('seasonState', () => {
  it('counts what is left, names the unchecked discs, and makes a job of each checked disc with episodes to encode', () => {
    expect(seasonState(season())).toEqual({
      toEncode: 7,
      known: true,
      queued: 0,
      uncheckedDiscs: ['Disc 3'],
      unmapped: [],
      jobs: [{ discKey: KEY(2), playlistId: '00002', episodeSpec: '1-3,4-6,7-9,10-', only: [2, 3, 4] }],
    });
  });

  it('makes both jobs once disc 3 is checked, mapped by title and episode number onto its grouping', () => {
    const s = seasonState(season({}, checked3));
    expect(s.uncheckedDiscs).toEqual([]);
    expect(s.jobs).toEqual([
      { discKey: KEY(2), playlistId: '00002', episodeSpec: '1-3,4-6,7-9,10-', only: [2, 3, 4] },
      { discKey: KEY(3), playlistId: '00001', episodeSpec: '1-2,3-4,5-6,7-', only: [1, 2, 3, 4] },
    ]);
  });

  it('never drops an episode to encode that no checked group gives: it is unmapped', () => {
    const short = season({}, { checked: false, checkedPlaylists: [played('00001', '1-2,3-', groups([9, 12]), 8)] });
    const s = seasonState(short);
    expect(s.uncheckedDiscs).toEqual([]);
    expect(s.unmapped).toEqual([{ disc: 'Disc 3', discId: 'id3', playlistId: '00001', numbers: [10, 11] }]);
    expect(s.jobs[1]).toEqual({ discKey: KEY(3), playlistId: '00001', episodeSpec: '1-2,3-', only: [1, 2] });
  });

  it('matches a group by the season title as well as the number', () => {
    const other = { source: 'anilist', anilistId: 990099 } as const;
    const s = seasonState(season({}, { checkedPlaylists: [played('00001', '1-2,3-4,5-6,7-', groups([9, 10, 11, 12], [], other), 8)] }));
    expect(s.unmapped).toEqual([{ disc: 'Disc 3', discId: 'id3', playlistId: '00001', numbers: [9, 10, 11, 12] }]);
    expect(s.jobs).toHaveLength(1);
  });

  it('queues the play-all playlist for episodes the NAS lists on their own playlists', () => {
    const s = seasonState(ruled(season({}, perEpisode([playAll]))));
    expect(s.uncheckedDiscs).toEqual([]);
    expect(s.unmapped).toEqual([]);
    expect(s.jobs).toEqual([
      { discKey: KEY(2), playlistId: '00002', episodeSpec: '1-3,4-6,7-9,10-', only: [2, 3, 4] },
      { discKey: KEY(3), playlistId: '00010', episodeSpec: '1-2,3-4,5-6,7-', only: [2, 3, 4] },
    ]);
  });

  it('makes a job of each checked per-episode playlist, and one only for an episode two playlists give', () => {
    const one = (id: string, n: number) => played(id, '1-', groups([n]), 1);
    const s = seasonState(ruled(season({}, perEpisode([one('00002', 10), one('00003', 11), one('00004', 12), played('00010', '1-6,7-', groups([null, 12]), 8)]))));
    expect(s.unmapped).toEqual([]);
    expect(s.jobs.slice(1)).toEqual([
      { discKey: KEY(3), playlistId: '00002', episodeSpec: '1-', only: [1] },
      { discKey: KEY(3), playlistId: '00003', episodeSpec: '1-', only: [1] },
      { discKey: KEY(3), playlistId: '00004', episodeSpec: '1-', only: [1] },
    ]);
    const two = seasonState(ruled(season({}, perEpisode([one('00002', 10), one('00003', 11)]))));
    expect(two.jobs.slice(1).map((j) => j.playlistId)).toEqual(['00002', '00003']);
    expect(two.unmapped).toEqual([{ disc: 'Disc 3', discId: 'id3', playlistId: '00004', numbers: [12] }]);
  });

  it('never makes a job for a disc whose every episode is encoded, checked or not', () => {
    expect(seasonState(season({ discs: [season().discs[0]!] }))).toMatchObject({ toEncode: 0, uncheckedDiscs: [], jobs: [] });
  });

  it('counts an unavailable disc with episodes to encode as unchecked', () => {
    expect(seasonState(season({}, { key: null, available: false })).uncheckedDiscs).toEqual(['Disc 3']);
  });

  it('queues only the groups not encoded of a season the NAS lists no episodes for, and knows no count while a disc is unchecked', () => {
    expect(seasonState(ownSeason())).toMatchObject({
      toEncode: 1,
      known: false,
      uncheckedDiscs: ['Disc 2'],
      jobs: [{ discKey: KEY(1), playlistId: '00003', episodeSpec: '1-4,5-8', only: [2] }],
    });
    const all = ownSeason({ checked: true, checkedPlaylists: [played('00001', '1-', groups([3], [3], OWN), 2)] });
    expect(seasonState(all)).toMatchObject({ toEncode: 1, known: true, uncheckedDiscs: [], jobs: [{ discKey: KEY(1), playlistId: '00003', only: [2] }] });
  });

  it('leaves out a disc with no episodes in a season that lists episodes on its other discs', () => {
    expect(seasonState(season({ discs: [...season().discs, disc(4, { label: 'Bonus' })] })).uncheckedDiscs).toEqual(['Disc 3']);
  });

  it('leaves out what a NAS job in the queue already encodes, and makes no job of a disc all queued', () => {
    const s3 = season({}, checked3);
    const queued = queuedKeys(s3, [
      nasJob({ disc: { key: KEY(3), label: 'D3', dir: '/x' }, playlist: '00001', episodeSpec: '1-2,3-4,5-6,7-', state: 'queued' }),
      nasJob({ disc: { key: KEY(2), label: 'D2', dir: '/x' }, playlist: '00002', episodeSpec: '1-3,4-6,7-9,10-', only: [2], state: 'running' }),
      // a finished job, a folder job and a job with another grouping count for nothing
      nasJob({ disc: { key: KEY(2), label: 'D2', dir: '/x' }, playlist: '00002', episodeSpec: '1-3,4-6,7-9,10-', state: 'done' }),
      { ...makeJob({ disc: { key: KEY(2), label: 'D2', dir: '/x' }, playlist: '00002', episodeSpec: '1-3,4-6,7-9,10-' }) },
      nasJob({ disc: { key: KEY(2), label: 'D2', dir: '/x' }, playlist: '00002', episodeSpec: '1-6,7-', state: 'queued' }),
    ]);
    const s = seasonState(s3, queued);
    expect(s.queued).toBe(5);
    expect(s.toEncode).toBe(2);
    expect(s.jobs).toEqual([{ discKey: KEY(2), playlistId: '00002', episodeSpec: '1-3,4-6,7-9,10-', only: [3, 4] }]);
  });

  it('reads a queued job whose episode list is written another way as the same list', () => {
    const s = season({}, { checked: true, checkedPlaylists: [played('00001', '1-3,4-', groups([9, 10]), 6)], playlists: [{ id: '00001', episodes: [ep(9, false), ep(10, false)] }] });
    const queued = queuedKeys(s, [nasJob({ disc: { key: KEY(3), label: 'D3', dir: '/x' }, playlist: '00001', episodeSpec: '1-3,4-6', state: 'queued' })]);
    expect(seasonState(s, queued).queued).toBe(2);
    const other = queuedKeys(s, [nasJob({ disc: { key: KEY(3), label: 'D3', dir: '/x' }, playlist: '00001', episodeSpec: '1-2,3-6', state: 'queued' })]);
    expect(seasonState(s, other).queued).toBe(0);
  });

  it('counts an episode queued on the play-all playlist as queued, wherever the NAS lists it', () => {
    const s = ruled(season({}, perEpisode([playAll])));
    const queued = queuedKeys(s, [nasJob({ disc: { key: KEY(3), label: 'D3', dir: '/x' }, playlist: '00010', episodeSpec: '1-2,3-4,5-6,7-8', only: [2, 3], state: 'queued' })]);
    expect(seasonState(s, queued)).toMatchObject({ queued: 2, jobs: [expect.anything(), { playlistId: '00010', only: [4] }] });
  });
});

describe('queueBlock', () => {
  it('names the discs to check, by number when they are numbered', () => {
    expect(queueBlock(season(), LIVE)).toBe('Check disc 3 first');
    const two = season({ discs: [...season().discs, disc(4, { playlists: [{ id: '00001', episodes: [ep(13, false)] }] })] });
    expect(queueBlock(two, LIVE)).toBe('Check discs 3 and 4 first');
    expect(discsPhrase(['Disc 2', 'Disc 3', 'Disc 5'])).toBe('discs 2, 3 and 5');
    expect(discsPhrase(['Bonus', 'Disc 3'])).toBe('Bonus and Disc 3');
  });

  it('says a disc this app cannot read must be found first', () => {
    expect(queueBlock(season({}, { key: null, available: false }), LIVE)).toBe("Disc 3 isn't in this app's listing of the NAS yet: rescan the Library");
    const both = season({ discs: [...season().discs, disc(4, { key: null, available: false, playlists: [{ id: '00001', episodes: [ep(13, false)] }] })] });
    expect(queueBlock(both, LIVE)).toBe("Check disc 3 first. Disc 4 isn't in this app's listing of the NAS yet: rescan the Library");
  });

  it('blocks a checked disc whose groups miss episodes to encode', () => {
    const short = season({}, { checkedPlaylists: [played('00001', '1-2,3-', groups([9, 12]), 8)] });
    expect(queueBlock(short, LIVE)).toBe("Disc 3's checked episodes don't include 10 and 11: check it again");
  });

  it('blocks a season the NAS has no entry for, an unreachable NAS, and a season with nothing left', () => {
    expect(queueBlock(season({ title: null }), LIVE)).toBe("The NAS hasn't loaded this season's entry yet, so its encodes can't be named");
    expect(queueBlock(season(), { reachable: false, encodedKnown: false })).toBe("The NAS isn't answering: this is its last listing");
    expect(queueBlock(season({ discs: [season().discs[0]!] }), LIVE)).toBe('Every episode is encoded');
    expect(queueBlock(season({}, checked3), LIVE)).toBeNull();
    const s3 = season({ discs: [season().discs[0]!, season({}, checked3).discs[2]!] });
    const queued = queuedKeys(s3, [nasJob({ disc: { key: KEY(3), label: 'D3', dir: '/x' }, playlist: '00001', episodeSpec: '1-2,3-4,5-6,7-', state: 'queued' })]);
    expect(queueBlock(s3, LIVE, queued)).toBe('Everything left is in the queue already');
  });

  it('blocks while the NAS has not said which episodes it holds', () => {
    expect(queueBlock(season({}, checked3), { reachable: true, encodedKnown: false })).toBe("Can't read which episodes the NAS already has. Try again in a moment");
  });
});

describe('seasonCounts, groupsOf and checkTarget', () => {
  it('counts the NAS episodes, or the checked groups of a season with no list, saying when that count is not known', () => {
    expect(seasonCounts(season())).toEqual({ encoded: 5, toEncode: 7, episodes: 12, known: true });
    expect(seasonCounts(ownSeason())).toEqual({ encoded: 1, toEncode: 1, episodes: 2, known: false });
    expect(groupsOf('1-3,4-6,7-')).toBe(3);
  });

  it('opens the first listed playlist not checked, else the disc for a disc listing none', () => {
    expect(checkTarget(season().discs[2]!)).toEqual({ kind: 'playlist', playlistId: '00001' });
    const two = disc(5, {
      playlists: [
        { id: '00010', episodes: [ep(1, false)] },
        { id: '00011', episodes: [ep(2, false)] },
      ],
      checkedPlaylists: [played('00010', '1-', groups([1]), 1)],
    });
    expect(checkTarget(two)).toEqual({ kind: 'playlist', playlistId: '00011' });
    expect(checkTarget(disc(6))).toEqual({ kind: 'disc' });
    expect(checkTarget(disc(7, { key: null, available: false }))).toBeNull();
  });
});
