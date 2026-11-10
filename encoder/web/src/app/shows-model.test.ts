// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { NasSeason } from '../api-types';
import { checkTarget, discsPhrase, queueBlock, seasonCounts, seasonState } from './shows-model';
import { disc, ep, KEY, season } from './shows-test-support';

describe('seasonState', () => {
  it('counts what is left, names the unchecked discs, and makes a job of each checked disc with episodes to encode', () => {
    expect(seasonState(season())).toEqual({
      toEncode: 7,
      uncheckedDiscs: ['Disc 3'],
      jobs: [
        {
          discKey: KEY(2),
          playlistId: '00002',
          episodeSpec: '1-3,4-6,7-9,10-',
          only: [2, 3, 4],
        },
      ],
    });
  });

  it('makes both jobs once disc 3 is checked, mapped by episode number onto its grouping', () => {
    const s = seasonState(
      season(
        {},
        {
          checked: true,
          checkedPlaylists: [
            {
              id: '00001',
              episodeSpec: '1-2,3-4,5-6,7-',
              episodes: [9, 10, 11, 12],
            },
          ],
        },
      ),
    );
    expect(s.uncheckedDiscs).toEqual([]);
    expect(s.jobs).toEqual([
      {
        discKey: KEY(2),
        playlistId: '00002',
        episodeSpec: '1-3,4-6,7-9,10-',
        only: [2, 3, 4],
      },
      {
        discKey: KEY(3),
        playlistId: '00001',
        episodeSpec: '1-2,3-4,5-6,7-',
        only: [1, 2, 3, 4],
      },
    ]);
  });

  it('never makes a job for a disc whose every episode is encoded, checked or not', () => {
    const s = seasonState(season({ discs: [season().discs[0]!] }));
    expect(s).toEqual({ toEncode: 0, uncheckedDiscs: [], jobs: [] });
  });

  it('counts an unavailable disc with episodes to encode as unchecked', () => {
    expect(seasonState(season({}, { key: null, available: false })).uncheckedDiscs).toEqual(['Disc 3']);
  });

  it('queues the whole checked grouping of a season the NAS lists no episodes for', () => {
    const own: NasSeason = {
      id: 'own:5f0c2a1e-0000-4000-8000-000000000001#s1',
      label: 'Season 1',
      number: 1,
      title: {
        source: 'own',
        ownId: '5f0c2a1e-0000-4000-8000-000000000001',
        season: 1,
      },
      discs: [
        disc(1, {
          checked: true,
          checkedPlaylists: [{ id: '00003', episodeSpec: '1-4,5-8', episodes: [1, 2] }],
        }),
        disc(2),
      ],
    };
    expect(seasonState(own)).toEqual({
      toEncode: 2,
      uncheckedDiscs: ['Disc 2'],
      jobs: [{ discKey: KEY(1), playlistId: '00003', episodeSpec: '1-4,5-8' }],
    });
  });

  it('leaves out a disc with no episodes in a season that lists episodes on its other discs', () => {
    const s = seasonState(season({ discs: [...season().discs, disc(4, { label: 'Bonus' })] }));
    expect(s.uncheckedDiscs).toEqual(['Disc 3']);
  });
});

describe('queueBlock', () => {
  it('names the discs to check, by number when they are numbered', () => {
    expect(queueBlock(season(), true)).toBe('Check disc 3 first');
    const two = season({
      discs: [...season().discs, disc(4, { playlists: [{ id: '00001', episodes: [ep(13, false)] }] })],
    });
    expect(queueBlock(two, true)).toBe('Check discs 3 and 4 first');
    expect(discsPhrase(['Disc 2', 'Disc 3', 'Disc 5'])).toBe('discs 2, 3 and 5');
    expect(discsPhrase(['Bonus', 'Disc 3'])).toBe('Bonus and Disc 3');
  });

  it('says a disc this app cannot read must be found first', () => {
    expect(queueBlock(season({}, { key: null, available: false }), true)).toBe("Disc 3 isn't in this app's listing of the NAS yet: rescan the Library");
    const both = season({ discs: [...season().discs, disc(4, { key: null, available: false, playlists: [{ id: '00001', episodes: [ep(13, false)] }] })] });
    expect(queueBlock(both, true)).toBe("Check disc 3 first. Disc 4 isn't in this app's listing of the NAS yet: rescan the Library");
  });

  it('blocks a season the NAS has no entry for, an unreachable NAS, and a season with nothing left', () => {
    expect(queueBlock(season({ title: null }), true)).toBe("The NAS hasn't loaded this season's entry yet, so its encodes can't be named");
    expect(queueBlock(season(), false)).toBe("The NAS isn't answering: this is its last listing");
    expect(queueBlock(season({ discs: [season().discs[0]!] }), true)).toBe('Every episode is encoded');
    const done = season(
      {},
      {
        checked: true,
        checkedPlaylists: [{ id: '00001', episodeSpec: '1-', episodes: [9] }],
      },
    );
    expect(queueBlock(done, true)).toBeNull();
  });
});

describe('seasonCounts and checkTarget', () => {
  it('counts encoded and to encode episodes', () => {
    expect(seasonCounts(season())).toEqual({
      encoded: 5,
      toEncode: 7,
      episodes: 12,
    });
  });

  it('opens the first listed playlist not checked, else the disc for a disc listing none', () => {
    expect(checkTarget(season().discs[2]!)).toEqual({
      kind: 'playlist',
      playlistId: '00001',
    });
    const two = disc(5, {
      playlists: [
        { id: '00010', episodes: [ep(1, false)] },
        { id: '00011', episodes: [ep(2, false)] },
      ],
      checkedPlaylists: [{ id: '00010', episodeSpec: '1-', episodes: [1] }],
    });
    expect(checkTarget(two)).toEqual({ kind: 'playlist', playlistId: '00011' });
    expect(checkTarget(disc(6))).toEqual({ kind: 'disc' });
    expect(checkTarget(disc(7, { key: null, available: false }))).toBeNull();
  });
});
