// SPDX-License-Identifier: LGPL-3.0-or-later
// Fold a title to the form the library compares: no case, punctuation, spaces or long-vowel marks.
import { normalizeTitle } from '@seikou/nas';

export default async function example(): Promise<void> {
  const a = normalizeTitle('Tōkyō Starfall Wanderer!');
  const b = normalizeTitle('tokyo starfall wanderer');
  console.log(a);
  if (a !== 'tokyostarfallwanderer' || a !== b) throw new Error('the titles did not fold to one form');
}
