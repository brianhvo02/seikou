// SPDX-License-Identifier: LGPL-3.0-or-later
// The key an encoded episode keeps its resume place under.
import { encodePlaceKey, parsePlaceKey } from '@seikou/nas';

export default async function example(): Promise<void> {
  const key = encodePlaceKey({ source: 'tmdb-tv', tmdbId: 990002, season: 2 }, 5);
  console.log(key);
  if (key !== 'e.tv990002s2.5' || parsePlaceKey(key)?.kind !== 'encode') throw new Error('unexpected place key');
}
