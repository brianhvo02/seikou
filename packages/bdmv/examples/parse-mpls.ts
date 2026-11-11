// SPDX-License-Identifier: LGPL-3.0-or-later
// Parse a playlist file and list its play items.
import { readFile } from 'node:fs/promises';
import { parseMpls } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  // #region parse
  const bytes = await readFile(new URL('../../../fixtures/synthetic/disc1/BDMV/PLAYLIST/00000.mpls', import.meta.url));
  const playlist = parseMpls(new Uint8Array(bytes));
  for (const item of playlist.playItems) console.log(item.clipId, item.inTime, item.outTime);
  // #endregion
  if (playlist.playItems.length === 0) throw new Error('the playlist has no play items');
}
