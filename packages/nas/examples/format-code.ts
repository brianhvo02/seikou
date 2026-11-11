// SPDX-License-Identifier: LGPL-3.0-or-later
// Show a pairing code in groups of four.
import { formatCode } from '@seikou/nas';

export default async function example(): Promise<void> {
  const shown = formatCode('K7QM4XP2R9TD');
  console.log(shown);
  if (shown !== 'K7QM-4XP2-R9TD') throw new Error('the code is not grouped');
}
