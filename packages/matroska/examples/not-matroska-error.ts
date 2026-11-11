// SPDX-License-Identifier: LGPL-3.0-or-later
// Tell a file that is not Matroska at all from a broken Matroska file.
import { MkvReadError, NotMatroskaError, readMatroska, type RangeReader } from '@seikou/matroska';

export default async function example(): Promise<void> {
  const text = new TextEncoder().encode('This is a text file, not a Matroska one.');
  const reader: RangeReader = { size: text.length, read: async (offset, length) => text.subarray(offset, offset + length) };

  const mine = new NotMatroskaError('no EBML header');
  console.log(mine.message, '- also an MkvReadError:', mine instanceof MkvReadError);

  try {
    await readMatroska(reader);
  } catch (error) {
    if (!(error instanceof NotMatroskaError) || !(error instanceof MkvReadError)) throw error;
    console.log('refused:', error.message);
    return;
  }
  throw new Error('a text file was read as Matroska');
}
