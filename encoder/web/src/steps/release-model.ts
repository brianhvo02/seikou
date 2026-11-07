// SPDX-License-Identifier: LGPL-3.0-or-later
/** Pure helpers for step 1: what a fetched release holds, and the sentences the step shows for it and for errors. */
import { ApiError } from '../api';
import type { CachedRelease, MatchRow } from '../api-types';

/** What a fetched release holds, counted over the files the run's episodes use. */
export interface ReleaseSummary {
  /** Disc episodes that have a release file. */
  readonly episodes: number;
  /** Subtitle tracks in those files. */
  readonly tracks: number;
  /** The tracks' languages as the release names them, each once, sorted. */
  readonly languages: string[];
  /** Font files the release carries. */
  readonly fonts: number;
  /** Release files that no episode uses (extras, unnumbered files, numbers outside the run). */
  readonly unmatched: number;
}

/** The summary of `release` as matched by `rows`; a file two episodes share is counted once. */
export function releaseSummary(release: CachedRelease, rows: readonly MatchRow[]): ReleaseSummary {
  const used = new Set(rows.flatMap((r) => (r.fileId === null ? [] : [r.fileId])));
  const files = release.files.filter((f) => used.has(f.id));
  const languages = [...new Set(files.flatMap((f) => f.tracks.map((t) => t.language)))].sort();
  return {
    episodes: rows.filter((r) => r.fileId !== null).length,
    tracks: files.reduce((n, f) => n + f.tracks.length, 0),
    languages,
    fonts: release.fonts.length,
    unmatched: release.files.length - files.length,
  };
}

/**
 * The sentence to show beside the control whose request failed with `e`. A source that is down says so and asks the
 * user to try again; anything else shows the backend's own message.
 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError && e.code === 'source-unavailable') {
    const source = typeof e.details.source === 'string' ? e.details.source : 'The service';
    return `${source} is not answering. Try again in a moment.`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** `n` followed by `word`, with an `s` unless `n` is 1. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
