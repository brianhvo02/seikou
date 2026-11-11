// SPDX-License-Identifier: LGPL-3.0-or-later
// Read a disc's metadata with openDisc, over a ByteSource of a folder on disk, and list its playlists.
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ByteSource } from '@seikou/bdmv';
import { openDisc } from '@seikou/engine';
// Runs in a Vite or vitest project: the package root imports Vite's `?url` and `?worker&url` modules.

/** A ByteSource over a disc folder: paths are matched without regard to case, as a disc's are. */
async function folderSource(root: string): Promise<ByteSource> {
  const files = new Map<string, { path: string; size: number }>();
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(rel);
      else files.set(rel.toUpperCase(), { path: rel, size: (await stat(join(root, rel))).size });
    }
  };
  await walk('');
  const file = (path: string): { path: string; size: number } => {
    const f = files.get(path.toUpperCase());
    if (!f) throw new Error(`no file ${path}`);
    return f;
  };
  return {
    exists: (path) => files.has(path.toUpperCase()),
    size: (path) => file(path).size,
    list: (dir) => {
      const prefix = `${dir.toUpperCase()}/`;
      return [...files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => k.slice(prefix.length)).sort();
    },
    read: async (path, offset, length) => (await readFile(join(root, file(path).path))).subarray(offset, offset + length),
  };
}

export default async function example(): Promise<void> {
  const source = await folderSource(fileURLToPath(new URL('../../../fixtures/synthetic/disc1', import.meta.url)));

  const disc = await openDisc(source);
  // the main feature comes first
  for (const p of disc.summaries) console.log(p.id, `${(p.durationUs / 1e6).toFixed(1)} s`, p.chapterCount, 'chapters', p.playable ? 'playable' : 'not playable');
  console.log('BD-J:', disc.usesBdj, 'warnings:', disc.warnings);

  if (disc.summaries[0]?.id !== '00000' || disc.summaries[0].durationUs !== 8_000_000) throw new Error('unexpected main playlist');
}
