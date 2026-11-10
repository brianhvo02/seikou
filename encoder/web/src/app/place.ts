// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect } from 'react';
import type { LibraryDiscInfo } from '../api-types';

/** The last folder name of a path (the whole text when it has none). */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}

/**
 * Where a disc is, for the line under its name: with several library folders the folder's name comes first, and a path
 * that only repeats the disc's name is left out (so a disc that sits directly in its folder shows the folder alone).
 * Empty when there is one folder and the path is the name.
 */
export function placeText(disc: Pick<LibraryDiscInfo, 'label' | 'relPath' | 'root' | 'source'>, rootCount: number): string {
  if (disc.source === 'nas') return `On the NAS at ${disc.relPath}`;
  const same = disc.relPath === disc.label;
  if (rootCount <= 1) return same ? '' : disc.relPath;
  const root = folderName(disc.root);
  return same ? root : `${root} / ${disc.relPath}`;
}

/** The `root` of a disc on the NAS. */
export const NAS_ROOT = 'NAS';

/**
 * Where another copy of a disc is, as the line "Also at ..." shows it: the path under its library folder, led by the
 * folder's name when there are several folders, or by "the NAS" for a copy there.
 */
export function otherPlaceText(other: { readonly relPath: string; readonly root: string }, rootCount: number): string {
  if (other.root === NAS_ROOT) return `the NAS, ${other.relPath}`;
  return rootCount <= 1 ? other.relPath : `${folderName(other.root)} / ${other.relPath}`;
}

/** Sets the document's title while the calling page is on screen. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/** How often a page that waits for the library scan asks again, in milliseconds. */
export const SCAN_POLL_MS = 1000;
