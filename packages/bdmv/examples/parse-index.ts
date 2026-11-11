// SPDX-License-Identifier: LGPL-3.0-or-later
// Read index.bdmv and list what First Play and the titles start.
import { readFile } from 'node:fs/promises';
import { parseIndex } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  // #region parse
  const bytes = await readFile(new URL('../../../fixtures/synthetic/disc1/BDMV/index.bdmv', import.meta.url));
  const index = parseIndex(new Uint8Array(bytes));
  console.log('First Play:', index.firstPlay.kind, 'titles:', index.titles.length);
  // #endregion
  if (index.titles.length === 0) throw new Error('index.bdmv lists no titles');
}
