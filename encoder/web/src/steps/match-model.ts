// SPDX-License-Identifier: LGPL-3.0-or-later
/** Pure helpers for step 2: which files an episode may use and which files no episode uses. */
import type { CachedRelease, CachedReleaseFile, MatchRow } from '../api-types';

/**
 * The files no row lists as a candidate: extras, unnumbered files and numbers outside the run. Any episode may
 * still take one of them. In release order.
 */
export function strayFiles(release: CachedRelease, rows: readonly MatchRow[]): CachedReleaseFile[] {
  const numbered = new Set(rows.flatMap((r) => r.candidates));
  return release.files.filter((f) => !numbered.has(f.id));
}

/** The files an episode's select offers: its own candidates (newest first, as the backend lists them), then the strays. */
export function optionsFor(release: CachedRelease, rows: readonly MatchRow[], row: MatchRow): CachedReleaseFile[] {
  const own = row.candidates.flatMap((id) => release.files.filter((f) => f.id === id));
  return [...own, ...strayFiles(release, rows)];
}

/** The strays no episode has taken: what "Not matched" lists, so a file the user used leaves the list. */
export function unusedFiles(release: CachedRelease, rows: readonly MatchRow[]): CachedReleaseFile[] {
  const used = new Set(rows.map((r) => r.fileId));
  return strayFiles(release, rows).filter((f) => !used.has(f.id));
}
