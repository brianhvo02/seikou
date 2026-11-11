// SPDX-License-Identifier: LGPL-3.0-or-later
// Group encoded episodes into shows: two sequel seasons of a made-up series become one show.
import { buildEncodeCatalogue, type Entry } from '@seikou/titles';

const entry = (n: number, name: string, prequel: number | null, sequel: number | null, year: number): Entry => ({
  source: 'anilist', id: 'anilist:' + n, kind: 'series', format: 'TV', names: { english: name, romaji: null, native: null, synonyms: [] },
  animation: true, year, episodes: 12, runtimeMin: 24, seasons: [],
  relations: [
    ...(prequel ? [{ type: 'PREQUEL', id: 'anilist:' + prequel, format: 'TV', startDate: null }] : []),
    ...(sequel ? [{ type: 'SEQUEL', id: 'anilist:' + sequel, format: 'TV', startDate: null }] : []),
  ],
  poster: null, banner: null,
});

export default async function example(): Promise<void> {
  const encode = (anilistId: number, episode: number): Parameters<typeof buildEncodeCatalogue>[0][number] => ({
    id: anilistId + '-' + episode, title: { source: 'anilist', anilistId }, episode, episodeTitle: 'Episode ' + episode, durationMs: 24 * 60_000,
  });
  const anilist = new Map([
    [990001, entry(990001, 'Lantern Road', null, 990002, 2020)],
    [990002, entry(990002, 'Lantern Road Again', 990001, null, 2021)],
  ]);

  const catalogue = buildEncodeCatalogue([encode(990002, 1), encode(990001, 2), encode(990001, 1)], anilist);
  const show = catalogue.shows[0]!;
  console.log(catalogue.shows.length, show.name, show.seasons.map((s) => 'season ' + s.number + ': ' + s.episodes.map((e) => e.episode)));
  if (catalogue.shows.length !== 1 || show.name !== 'Lantern Road' || show.seasons.length !== 2 || show.seasons[0]!.episodes.length !== 2) throw new Error('the encodes were not grouped');
  if (catalogue.show(show.id) !== show || catalogue.show('nobody') !== null) throw new Error('the show is not found by id');
}
