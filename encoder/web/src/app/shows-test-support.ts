// SPDX-License-Identifier: LGPL-3.0-or-later
import type { NasCheckedGroup, NasCheckedPlaylist, NasEncodeTitle, NasSeason, NasSeasonDisc } from '../api-types';
import { resolvedSpec } from './shows-model';

// Made-up seasons for the Library by show's tests.

/** An episode the NAS lists on a disc, named after its number. */
export const ep = (number: number, encoded: boolean) => ({
  number,
  name: `Episode ${number}`,
  encoded,
});
/** The made-up disc key of disc `n`. */
export const KEY = (n: number): string => `f.${String(n).repeat(32)}`;

/** The season's title in these tests. */
export const TITLE: NasEncodeTitle = { source: 'anilist', anilistId: 990001 };

/** Checked groups numbered `numbers` (null for a group with no title) under `title`, encoded where `encoded` holds. */
export function groups(numbers: readonly (number | null)[], encoded: readonly number[] = [], title: NasEncodeTitle = TITLE): NasCheckedGroup[] {
  return numbers.map((n, i) => ({ index: i + 1, title: n === null ? null : title, episode: n, encoded: n !== null && encoded.includes(n) }));
}

/** A checked playlist `id` of `chapters` chapters grouped as `episodeSpec`. */
export function played(id: string, episodeSpec: string, groups: NasCheckedGroup[], chapters: number): NasCheckedPlaylist {
  return { id, episodeSpec, chapters, resolvedSpec: resolvedSpec(episodeSpec, chapters) ?? episodeSpec, groups };
}

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

/** Disc 3 checked, its four groups numbered 9 to 12. */
export const checked3: Partial<NasSeasonDisc> = { checked: true, checkedPlaylists: [played('00001', '1-2,3-4,5-6,7-', groups([9, 10, 11, 12]), 8)] };

/** Disc 1 all encoded (eps 1–4), disc 2 checked with 5 encoded and 6–8 to encode, disc 3 unchecked (9–12). */
export function season(over: Partial<NasSeason> = {}, disc3: Partial<NasSeasonDisc> = {}): NasSeason {
  return {
    id: 'anilist:990001#season',
    label: 'Season 2',
    number: 2,
    title: TITLE,
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
        checkedPlaylists: [played('00002', '1-3,4-6,7-9,10-', groups([5, 6, 7, 8], [5]), 12)],
      }),
      disc(3, {
        playlists: [{ id: '00001', episodes: [9, 10, 11, 12].map((n) => ep(n, false)) }],
        ...disc3,
      }),
    ],
    ...over,
  };
}
