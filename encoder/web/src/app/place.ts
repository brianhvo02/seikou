// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect } from 'react';
import type { LibraryDiscInfo } from '../api-types';

/** The last folder name of a path (the whole text when it has none). */
function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}

/**
 * Where a disc is, for the line under its name: with several library folders the folder's name comes first, and a path
 * that only repeats the disc's name is left out (so a disc that sits directly in its folder shows the folder alone).
 * Empty when there is one folder and the path is the name.
 */
export function placeText(disc: Pick<LibraryDiscInfo, 'label' | 'relPath' | 'root'>, rootCount: number): string {
  const same = disc.relPath === disc.label;
  if (rootCount <= 1) return same ? '' : disc.relPath;
  const root = folderName(disc.root);
  return same ? root : `${root} / ${disc.relPath}`;
}

/** Sets the document's title while the calling page is on screen. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
