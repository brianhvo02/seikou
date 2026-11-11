// SPDX-License-Identifier: LGPL-3.0-or-later
// Find the episode after the one just watched: the next in its season, else the next season's first.
import { buildEncodeCatalogue, nextInShow, type Entry } from '@seikou/titles';

const entry = (n: number, name: string, relation: { type: string; to: number }): Entry => ({
  source: 'anilist', id: 'anilist:' + n, kind: 'series', format: 'TV', names: { english: name, romaji: null, native: null, synonyms: [] },
  animation: true, year: 2020 + (n % 10), episodes: 2, runtimeMin: 24, seasons: [],
  relations: [{ type: relation.type, id: 'anilist:' + relation.to, format: 'TV', startDate: null }], poster: null, banner: null,
});

export default async function example(): Promise<void> {
  const anilist = new Map([
    [990001, entry(990001, 'Lantern Road', { type: 'SEQUEL', to: 990002 })],
    [990002, entry(990002, 'Lantern Road Again', { type: 'PREQUEL', to: 990001 })],
  ]);
  const encodes = [[990001, 1], [990001, 2], [990002, 1]].map(([anilistId, episode]) => ({
    id: anilistId + '-' + episode, title: { source: 'anilist' as const, anilistId: anilistId! }, episode: episode!, episodeTitle: null, durationMs: 24 * 60_000,
  }));
  const show = buildEncodeCatalogue(encodes, anilist).shows[0]!;

  const second = nextInShow(show, '990001-1');
  const nextSeason = nextInShow(show, '990001-2');
  const last = nextInShow(show, '990002-1');
  console.log(second?.id, nextSeason?.id, last);
  if (second?.id !== '990001-2' || nextSeason?.id !== '990002-1' || last !== null) throw new Error('the next episode is wrong');
  if (nextInShow(show, 'nothing-9') !== null) throw new Error('an unknown episode has a next one');
}
