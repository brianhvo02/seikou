// SPDX-License-Identifier: LGPL-3.0-or-later
// Tell a fingerprint key from a disc id key, and refuse anything else.
import { parseDiscKey } from '@seikou/nas';

export default async function example(): Promise<void> {
  const byId = parseDiscKey('d.0123456789abcdef');
  const byContent = parseDiscKey('f.FE6728886C477A014E305CF44016C231');
  console.log(byId, byContent, parseDiscKey('nonsense'));

  if (byId?.kind !== 'disc' || byId.discId !== '0123456789abcdef') throw new Error('the disc id key was not read');
  if (byContent?.kind !== 'fingerprint' || parseDiscKey('nonsense') !== null) throw new Error('the keys were not told apart');
}
