import { DiscError } from '@seikou/bdmv/byte-source';

/**
 * Maps picked files (relative paths as reported by the picker) to disc-relative upper-case paths,
 * rooted at the folder that contains BDMV. Accepts the disc root, the BDMV folder itself, or a
 * parent folder containing exactly one disc. `T` is what each path carries: a Blob for picked files, a manifest entry
 * for a disc served over HTTP.
 */
export function normalizeDiscPaths<T = Blob>(entries: ReadonlyArray<readonly [string, T]>): Map<string, T> {
  const roots = new Set<string>();
  for (const [path] of entries) {
    const segments = path.split('/').filter(Boolean);
    const bdmvAt = segments.findIndex((s) => s.toUpperCase() === 'BDMV');
    if (bdmvAt >= 0) roots.add(segments.slice(0, bdmvAt).join('/'));
  }
  if (roots.size === 0) throw new DiscError('not-bdmv', 'No BDMV folder was found in the selected folder.');
  if (roots.size > 1) {
    throw new DiscError('multiple-discs', 'The selected folder contains more than one disc. Pick a single disc folder.', [...roots].sort());
  }
  const [root] = [...roots];
  const prefix = root === '' ? '' : `${root}/`;
  const files = new Map<string, T>();
  const originals = new Map<string, string>();
  const collisions = new Set<string>();
  for (const [path, blob] of entries) {
    const relative = path.split('/').filter(Boolean).join('/');
    if (prefix !== '' && !relative.startsWith(prefix)) continue;
    const key = relative.slice(prefix.length).toUpperCase();
    const seen = originals.get(key);
    if (seen !== undefined && seen !== relative) collisions.add(seen).add(relative);
    originals.set(key, relative);
    files.set(key, blob);
  }
  // Disc names are case-insensitive, so two picked files differing only in case would silently shadow each other.
  if (collisions.size > 0) {
    throw new DiscError('case-collision', 'The disc folder has files whose names differ only in upper/lower case. Keep one of each and reopen it.', [...collisions].sort());
  }
  return files;
}
