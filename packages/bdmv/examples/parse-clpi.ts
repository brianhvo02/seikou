// SPDX-License-Identifier: LGPL-3.0-or-later
// Read a clip's information file: its streams and where decoding can start.
import { readFile } from 'node:fs/promises';
import { parseClpi } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  // #region parse
  const bytes = await readFile(new URL('../../../fixtures/synthetic/disc1/BDMV/CLIPINF/00001.clpi', import.meta.url));
  const clip = parseClpi(new Uint8Array(bytes));
  for (const stream of clip.programs[0]!.streams) console.log('PID', stream.pid, 'coding type', stream.codingType);
  console.log('key frames:', clip.epMaps[0]!.entries.length, 'source packets:', clip.numSourcePackets);
  // #endregion
  if (clip.epMaps[0]!.entries.length === 0) throw new Error('the clip has no entry points');
}
