// SPDX-License-Identifier: LGPL-3.0-or-later
// Read a season, disc and year out of a folder name, ready for a metadata lookup.
import { parseName } from '@seikou/titles';

export default async function example(): Promise<void> {
  const parsed = parseName('[BDMV] Starfall Wanderer Season 2 Vol.3 (2021)');
  console.log(parsed.candidates, 'season', parsed.season, 'volume', parsed.volume, 'year', parsed.year);
  if (parsed.candidates[0] !== 'Starfall Wanderer' || parsed.season !== 2 || parsed.volume !== 3 || parsed.year !== 2021) throw new Error('the name was misread');

  const empty = parseName('');
  if (empty.candidates.length !== 0 || empty.season !== null) throw new Error('an empty name gave a guess');
}
