// SPDX-License-Identifier: LGPL-3.0-or-later
/** Pure helpers for step 2: naming a file of the pool in a select, and which files no episode uses. */
import type { CachedRelease, CachedReleaseFile, MatchRow } from '../api-types';
import type { HelperState, PooledRelease } from '../helper-model';

/**
 * The files no row lists as a candidate: extras, unnumbered files and numbers outside the run. Any episode may
 * still take one of them. In release order.
 */
export function strayFiles(release: CachedRelease, rows: readonly MatchRow[]): CachedReleaseFile[] {
  const numbered = new Set(rows.flatMap((r) => r.candidates));
  return release.files.filter((f) => !numbered.has(f.id));
}

/**
 * The value a select option carries for a file of the pool. File ids repeat between releases, so the value holds the
 * release's key and the file's id together; `parseFileValue` reads it back.
 */
export function fileValue(releaseKey: string, fileId: string): string {
  return JSON.stringify([releaseKey, fileId]);
}

/** The release key and file id a `fileValue` holds, or null for any other text (such as the empty "No file" value). */
export function parseFileValue(value: string): { readonly releaseKey: string; readonly fileId: string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return { releaseKey: parsed[0], fileId: parsed[1] };
    }
  } catch {
    // not a file value
  }
  return null;
}

/**
 * Per pooled release, in pool order, its strays that no episode has taken: what "Not matched" lists, so a file the
 * user used leaves the list. Releases with nothing to list are left out.
 */
export function unusedFiles(state: Pick<HelperState, 'releases' | 'choices'>): { readonly pooled: PooledRelease; readonly files: CachedReleaseFile[] }[] {
  const used = new Set(Object.values(state.choices).flatMap((c) => (c === 'none' ? [] : [fileValue(c.releaseKey, c.fileId)])));
  return state.releases
    .map((pooled) => ({ pooled, files: strayFiles(pooled.release, pooled.release.match.rows).filter((f) => !used.has(fileValue(pooled.release.key, f.id))) }))
    .filter((r) => r.files.length > 0);
}
