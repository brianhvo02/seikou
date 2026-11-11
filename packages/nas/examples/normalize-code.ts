// SPDX-License-Identifier: LGPL-3.0-or-later
// Read a pairing code as someone types it: any case, dashes, and O or I mistaken for 0 or 1.
import { normalizeCode } from '@seikou/nas';

export default async function example(): Promise<void> {
  const typed = normalizeCode('k7qm-4xp2 r9td');
  const mistaken = normalizeCode('o0il-1111-1111');
  console.log(typed, mistaken, normalizeCode('K7QM'));

  if (typed !== 'K7QM4XP2R9TD' || mistaken !== '001111111111') throw new Error('the code was misread');
  if (normalizeCode('K7QM') !== null) throw new Error('a short code was accepted');
}
