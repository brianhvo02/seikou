// SPDX-License-Identifier: LGPL-3.0-or-later
// Read an encode id back into its title and episode.
import { parseEncodeId } from '@seikou/nas';

export default async function example(): Promise<void> {
  const parsed = parseEncodeId('tv990002s2-5');
  console.log(parsed, parseEncodeId('tv990002s2-0'));

  if (parsed?.episode !== 5 || parsed.title.source !== 'tmdb-tv') throw new Error('the id was not read');
  if (parseEncodeId('tv990002s2-0') !== null) throw new Error('episode 0 is not an episode');
}
