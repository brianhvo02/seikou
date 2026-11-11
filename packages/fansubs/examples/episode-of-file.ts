// SPDX-License-Identifier: LGPL-3.0-or-later
// Read the episode number out of a release's file names; extras and names with no number give null.
import { episodeOfFile } from '@seikou/fansubs';

export default async function example(): Promise<void> {
  const names = ['[Group] Starfall Wanderer - 05v2 [1080p][5E12FA90].mkv', 'Starfall.Wanderer.S01E07.1080p.mkv', '[Group] Starfall Wanderer - NCOP1.mkv', 'extras/Interview.mkv'];
  const found = names.map(episodeOfFile);
  console.log(found);
  if (found.join() !== '5,7,,') throw new Error('the episodes were misread');
}
