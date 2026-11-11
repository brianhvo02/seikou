// SPDX-License-Identifier: LGPL-3.0-or-later
// Search the way the library does: a normalised query inside a normalised name.
import { titleMatches } from '@seikou/nas';

export default async function example(): Promise<void> {
  const names = ['Starfall Wanderer', 'スターフォール'];

  const hit = titleMatches('starfall wander', names);
  const miss = titleMatches('lantern', names);
  console.log(hit, miss, titleMatches('   ', names));
  if (!hit || miss || titleMatches('   ', names)) throw new Error('the search is wrong');
}
