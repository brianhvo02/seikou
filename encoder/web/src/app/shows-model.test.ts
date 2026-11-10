// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Job, NasSeason } from '../api-types';
import { makeJob } from './job-test-support';
import { checkTarget, discsPhrase, groupsOf, queueBlock, queuedKeys, seasonCounts, seasonState } from './shows-model';
import { checked3, disc, ep, groups, KEY, season } from './shows-test-support';

const OWN = { source: 'own', ownId: '5f0c2a1e-0000-4000-8000-000000000001', season: 1 } as const;

/** An own title's season the NAS lists no episodes for: disc 1 checked (episode 1 encoded, 2 not), disc 2 as `disc2`. */
function ownSeason(disc2: Parameters<typeof disc>[1] = {}): NasSeason {
  return {
    id: `own:${OWN.ownId}#s1`,
    label: 'Season 1',
    number: 1,
    title: OWN,
    discs: [disc(1, { checked: true, checkedPlaylists: [{ id: '00003', episodeSpec: '1-4,5-8', groups: groups([1, 2], [1], OWN) }] }), disc(2, disc2)],
  };
}

/** A NAS job of the app's queue. */
function nasJob(over: Partial<Job>): Job {
  const base = makeJob(over);
  return { ...base, settings: { ...base.settings, destination: 'nas' } };
}

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
    const short = season({}, { checked: true, checkedPlaylists: [{ id: '00001', episodeSpec: '1-2,3-', groups: groups([9, 12]) }] });
    const s = seasonState(short);
    expect(s.unmapped).toEqual([{ disc: 'Disc 3', discId: 'id3', playlistId: '00001', numbers: [10, 11] }]);
    expect(s.jobs[1]).toEqual({ discKey: KEY(3), playlistId: '00001', episodeSpec: '1-2,3-', only: [1, 2] });
  });

  it('matches a group by the season title as well as the number', () => {
    const other = { source: 'anilist', anilistId: 990099 } as const;
    const s = seasonState(season({}, { checked: true, checkedPlaylists: [{ id: '00001', episodeSpec: '1-2,3-4,5-6,7-', groups: groups([9, 10, 11, 12], [], other) }] }));
    expect(s.unmapped).toEqual([{ disc: 'Disc 3', discId: 'id3', playlistId: '00001', numbers: [9, 10, 11, 12] }]);
    expect(s.jobs).toHaveLength(1);
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
    const all = ownSeason({ checked: true, checkedPlaylists: [{ id: '00001', episodeSpec: '1-', groups: groups([3], [3], OWN) }] });
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
});

describe('queueBlock', () => {
  it('names the discs to check, by number when they are numbered', () => {
    expect(queueBlock(season(), true)).toBe('Check disc 3 first');
    const two = season({ discs: [...season().discs, disc(4, { playlists: [{ id: '00001', episodes: [ep(13, false)] }] })] });
    expect(queueBlock(two, true)).toBe('Check discs 3 and 4 first');
    expect(discsPhrase(['Disc 2', 'Disc 3', 'Disc 5'])).toBe('discs 2, 3 and 5');
    expect(discsPhrase(['Bonus', 'Disc 3'])).toBe('Bonus and Disc 3');
  });

  it('says a disc this app cannot read must be found first', () => {
    expect(queueBlock(season({}, { key: null, available: false }), true)).toBe("Disc 3 isn't in this app's listing of the NAS yet: rescan the Library");
    const both = season({ discs: [...season().discs, disc(4, { key: null, available: false, playlists: [{ id: '00001', episodes: [ep(13, false)] }] })] });
    expect(queueBlock(both, true)).toBe("Check disc 3 first. Disc 4 isn't in this app's listing of the NAS yet: rescan the Library");
  });

  it('blocks a checked disc whose groups miss episodes to encode', () => {
    const short = season({}, { checked: true, checkedPlaylists: [{ id: '00001', episodeSpec: '1-2,3-', groups: groups([9, 12]) }] });
    expect(queueBlock(short, true)).toBe("Disc 3's checked episodes don't include 10 and 11: check it again");
  });

  it('blocks a season the NAS has no entry for, an unreachable NAS, and a season with nothing left', () => {
    expect(queueBlock(season({ title: null }), true)).toBe("The NAS hasn't loaded this season's entry yet, so its encodes can't be named");
    expect(queueBlock(season(), false)).toBe("The NAS isn't answering: this is its last listing");
    expect(queueBlock(season({ discs: [season().discs[0]!] }), true)).toBe('Every episode is encoded');
    expect(queueBlock(season({}, checked3), true)).toBeNull();
    const s3 = season({ discs: [season().discs[0]!, season({}, checked3).discs[2]!] });
    const queued = queuedKeys(s3, [nasJob({ disc: { key: KEY(3), label: 'D3', dir: '/x' }, playlist: '00001', episodeSpec: '1-2,3-4,5-6,7-', state: 'queued' })]);
    expect(queueBlock(s3, true, queued)).toBe('Everything left is in the queue already');
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
      checkedPlaylists: [{ id: '00010', episodeSpec: '1-', groups: groups([1]) }],
    });
    expect(checkTarget(two)).toEqual({ kind: 'playlist', playlistId: '00011' });
    expect(checkTarget(disc(6))).toEqual({ kind: 'disc' });
    expect(checkTarget(disc(7, { key: null, available: false }))).toBeNull();
  });
});
