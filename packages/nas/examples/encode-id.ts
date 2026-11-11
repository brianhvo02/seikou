// SPDX-License-Identifier: LGPL-3.0-or-later
// The id the NAS routes and the player use for one encoded episode.
import { encodeId } from '@seikou/nas';

export default async function example(): Promise<void> {
  const id = encodeId({ source: 'tmdb-tv', tmdbId: 990002, season: 2 }, 5);
  const anilist = encodeId({ source: 'anilist', anilistId: 990001 }, 3);
  console.log(id, anilist);
  if (id !== 'tv990002s2-5' || anilist !== '990001-3') throw new Error('unexpected encode ids');
}
