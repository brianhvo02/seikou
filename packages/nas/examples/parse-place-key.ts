// SPDX-License-Identifier: LGPL-3.0-or-later
// Read a place key of either library: a disc or an encoded episode.
import { parsePlaceKey } from '@seikou/nas';

export default async function example(): Promise<void> {
  const disc = parsePlaceKey('d.0123456789abcdef');
  const encode = parsePlaceKey('e.tv990002s2.5');
  console.log(disc?.kind, encode?.kind, parsePlaceKey('nonsense'));

  if (disc?.kind !== 'disc' || encode?.kind !== 'encode' || encode.episode !== 5) throw new Error('the place keys were not read');
  if (encode.title.source !== 'tmdb-tv' || parsePlaceKey('nonsense') !== null) throw new Error('the title was not read');
}
