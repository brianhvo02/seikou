// SPDX-License-Identifier: LGPL-3.0-or-later
// Pick a movie's main file: the largest one that is not an extra.
import { mainFile, type ToshoFile } from '@seikou/fansubs';

export default async function example(): Promise<void> {
  const file = (id: number, name: string, size: number): ToshoFile => ({ id, name, size, tracks: [] });
  const main = mainFile([file(1, 'Glass Orchard (2022) NCOP.mkv', 900_000_000), file(2, 'Glass Orchard (2022).mkv', 4_000_000_000), file(3, 'Glass Orchard (2022) Trailer PV.mkv', 50_000_000)]);
  console.log(main?.name);
  if (main?.id !== 2 || mainFile([]) !== null) throw new Error('the main file is wrong');
}
