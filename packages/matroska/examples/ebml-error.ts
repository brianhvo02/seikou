// SPDX-License-Identifier: LGPL-3.0-or-later
// Catch the error the tree parser throws when an element runs past the end of its data.
import { EbmlError, parseMkv } from '@seikou/matroska';

export default async function example(): Promise<void> {
  const cut = new Uint8Array([0x42, 0x82, 0x88, 0x6d]); // a DocType that claims 8 bytes of data and has 1

  const mine = new EbmlError('element runs past the end');
  console.log('thrown as', mine.constructor.name + ':', mine.message);

  try {
    parseMkv(cut);
  } catch (error) {
    if (!(error instanceof EbmlError)) throw error;
    console.log('cut element:', error.message);
    return;
  }
  throw new Error('a cut element was parsed');
}
