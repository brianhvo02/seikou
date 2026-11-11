// SPDX-License-Identifier: LGPL-3.0-or-later
// The error every metadata and music client throws when its source cannot answer.
import { createAniList, Pacer, SourceUnavailable } from '@seikou/titles';

export default async function example(): Promise<void> {
  const mine = new SourceUnavailable('the source is down');
  console.log(mine.name, mine.message);

  const down: typeof fetch = async () => {
    throw new TypeError('offline');
  };
  try {
    await createAniList(down, new Pacer(30, 60_000)).search('Starfall Wanderer');
  } catch (error) {
    if (!(error instanceof SourceUnavailable)) throw error;
    console.log('search failed:', error.message);
    return;
  }
  throw new Error('a network error did not throw');
}
