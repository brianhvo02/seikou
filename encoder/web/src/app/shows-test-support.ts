// SPDX-License-Identifier: LGPL-3.0-or-later
import type { NasSeason, NasSeasonDisc } from '../api-types';

// Made-up seasons for the Library by show's tests.

/** An episode the NAS lists on a disc, named after its number. */
export const ep = (number: number, encoded: boolean) => ({
  number,
  name: `Episode ${number}`,
  encoded,
});
/** The made-up disc key of disc `n`. */
export const KEY = (n: number): string => `f.${String(n).repeat(32)}`;

/** Disc `n` of a season, available and unchecked, with `over` on top. */
export function disc(n: number, over: Partial<NasSeasonDisc> = {}): NasSeasonDisc {
  return {
    key: KEY(n),
    discId: `id${n}`,
    label: `Disc ${n}`,
    available: true,
    playlists: [],
    checked: false,
    checkedPlaylists: [],
    ...over,
  };
}

/** Disc 1 all encoded (eps 1–4), disc 2 checked with 5 encoded and 6–8 to encode, disc 3 unchecked (9–12). */
export function season(over: Partial<NasSeason> = {}, disc3: Partial<NasSeasonDisc> = {}): NasSeason {
  return {
    id: 'anilist:990001#season',
    label: 'Season 2',
    number: 2,
    title: { source: 'anilist', anilistId: 990001 },
    discs: [
      disc(1, {
        playlists: [{ id: '00001', episodes: [1, 2, 3, 4].map((n) => ep(n, true)) }],
      }),
      disc(2, {
        playlists: [
          {
            id: '00002',
            episodes: [ep(5, true), ep(6, false), ep(7, false), ep(8, false)],
          },
        ],
        checked: true,
        checkedPlaylists: [
          {
            id: '00002',
            episodeSpec: '1-3,4-6,7-9,10-',
            episodes: [5, 6, 7, 8],
          },
        ],
      }),
      disc(3, {
        playlists: [{ id: '00001', episodes: [9, 10, 11, 12].map((n) => ep(n, false)) }],
        ...disc3,
      }),
    ],
    ...over,
  };
}
