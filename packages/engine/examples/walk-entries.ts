// SPDX-License-Identifier: LGPL-3.0-or-later
// Turn a dropped disc folder into the [path, File] pairs PlayerController.open takes.
import { walkEntries, type DirEntryLike, type EntryLike, type FileEntryLike } from '@seikou/engine';

// What a drop's `item.webkitGetAsEntry()` hands a page, made up here for a folder `disc1/BDMV/index.bdmv`.
const file = (name: string): FileEntryLike => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(new File([new Uint8Array(4)], name)) });
const dir = (name: string, children: EntryLike[]): DirEntryLike => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let done = false; // a reader hands out its entries in batches, then an empty one
    return { readEntries: (ok) => ok(done ? [] : ((done = true), children)) };
  },
});

export default async function example(): Promise<void> {
  const dropped = [dir('disc1', [dir('BDMV', [file('index.bdmv'), dir('PLAYLIST', [file('00000.mpls')])])])];

  // In a drop handler: const entries = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry()).filter(Boolean)
  const pairs = await walkEntries(dropped, 4);
  for (const [path, f] of pairs) console.log(path, f.size, 'bytes');
  // controller.open(pairs) would open the disc; the engine finds the folder that holds BDMV.

  const paths = pairs.map(([path]) => path);
  if (paths.join() !== 'disc1/BDMV/index.bdmv,disc1/BDMV/PLAYLIST/00000.mpls') throw new Error(`unexpected paths ${paths.join()}`);
  if ((await walkEntries(dropped, 1)).length !== 1) throw new Error('maxDepth 1 should stop above PLAYLIST');
}
