// SPDX-License-Identifier: LGPL-3.0-or-later
// Search TMDB for series and films and read a series by id, answered from recorded responses for made-up entries.
import { createTmdb, Pacer } from '@seikou/titles';

export default async function example(): Promise<void> {
  const recorded: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/3/search/tv') {
      return json({ results: [{ id: 990101, name: 'Lantern Road', original_name: 'Lantern Road', first_air_date: '2020-10-02', genre_ids: [16], poster_path: '/lantern.jpg' }] });
    }
    if (url.pathname === '/3/tv/990101') {
      return json({
        id: 990101, name: 'Lantern Road', first_air_date: '2020-10-02', number_of_episodes: 20, episode_run_time: [24], genres: [{ id: 16 }],
        seasons: [{ season_number: 0, episode_count: 2 }, { season_number: 1, episode_count: 12 }, { season_number: 2, episode_count: 8 }],
      });
    }
    return new Response('{}', { status: 404 });
  };
  const tmdb = createTmdb(recorded, new Pacer(20, 1_000), 'made-up-key');

  const found = await tmdb.search('lantern road', { kind: 'series' });
  console.log(found.map((e) => e.id + ' ' + e.year + ' animation=' + e.animation));

  const show = await tmdb.entry('tmdb-tv:990101');
  console.log(show?.seasons); // season 0 (the specials) is left out
  if (found[0]?.poster?.large !== 'https://image.tmdb.org/t/p/w780/lantern.jpg' || show?.seasons.length !== 2) throw new Error('the entries were misread');
  if ((await tmdb.entry('tmdb-tv:1')) !== null) throw new Error('an unknown id was not null');
}
