// SPDX-License-Identifier: LGPL-3.0-or-later
// Read MovieObject.bdmv and count each movie object's HDMV commands.
import { readFile } from 'node:fs/promises';
import { parseMovieObjects } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  // #region parse
  const bytes = await readFile(new URL('../../../fixtures/synthetic/disc-menu/BDMV/MovieObject.bdmv', import.meta.url));
  const movieObjects = parseMovieObjects(new Uint8Array(bytes));
  movieObjects.objects.forEach((object, id) => console.log('object', id, object.cmds.length, 'commands'));
  // #endregion
  if (movieObjects.objects.length === 0) throw new Error('no movie objects');
}
