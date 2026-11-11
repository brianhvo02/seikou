// SPDX-License-Identifier: LGPL-3.0-or-later
// Read a BD-J object file and list the applications it starts.
import { readFile } from 'node:fs/promises';
import { parseBdjo } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  // #region parse
  const bytes = await readFile(new URL('../../../fixtures/synthetic/disc-bdj/BDMV/BDJO/00000.bdjo', import.meta.url));
  const bdjo = parseBdjo(new Uint8Array(bytes));
  for (const app of bdjo.apps) console.log('app', app.orgId.toString(16), app.appId.toString(16), 'control code', app.controlCode);
  // #endregion
  if (bdjo.apps.length === 0) throw new Error('the BD-J object has no applications');
}
