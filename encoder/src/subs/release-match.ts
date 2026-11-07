// SPDX-License-Identifier: LGPL-3.0-or-later
/** Which file of a fansub release belongs to which episode of a disc, and what a subtitle track is for. */
import { episodeOfFile, fileVersion, isExtraFile } from '@seikou/fansubs/episode-files';

/** What a subtitle track holds: the whole dialogue, or only signs, songs and forced lines. */
export type TrackKind = 'full' | 'signs';

/** Labels a track from its name: `signs` when it mentions signs, songs, "S&S" or forced, else `full`. */
export function trackKind(name: string): TrackKind {
  return /sign|song|s&s|forced/i.test(name) ? 'signs' : 'full';
}

/** A release file as the matcher sees it; ids are strings so local uploads and downloaded files share the type. */
export interface ReleaseFileInfo {
  /** Stable identifier of the file within its release. */
  readonly id: string;
  /** The file's name, which carries the episode number and version. */
  readonly name: string;
  /** The file's subtitle tracks. */
  readonly tracks: readonly { readonly id: string; readonly name: string; readonly language: string }[];
}

/** One disc episode's match. */
export interface MatchRow {
  /** The disc's episode number. */
  readonly episode: number;
  /** The chosen file's id (the newest version), or null when no file fits. */
  readonly fileId: string | null;
  /** Every file id for this episode, newest version first. */
  readonly candidates: readonly string[];
}

/**
 * Matches a release's files to a disc's episodes. A file's number is read from its name and
 * maps to disc episode `number - episodeOffset` (the offset is how many episodes the
 * release numbered before this disc's first). Extras, files without a number and numbers
 * outside `episodeNumbers` go to `unmatched`. Rows follow `episodeNumbers` order; among
 * several files for one episode the highest version leads, ties keep input order.
 */
export function matchRelease(
  files: readonly ReleaseFileInfo[],
  episodeNumbers: readonly number[],
  episodeOffset: number,
): { rows: MatchRow[]; unmatched: ReleaseFileInfo[] } {
  const wanted = new Set(episodeNumbers);
  const byEpisode = new Map<number, ReleaseFileInfo[]>();
  const unmatched: ReleaseFileInfo[] = [];
  for (const f of files) {
    const n = isExtraFile(f.name) ? null : episodeOfFile(f.name);
    const episode = n === null ? null : n - episodeOffset;
    if (episode === null || !wanted.has(episode)) {
      unmatched.push(f);
      continue;
    }
    const list = byEpisode.get(episode) ?? [];
    list.push(f);
    byEpisode.set(episode, list);
  }
  const rows = episodeNumbers.map((episode): MatchRow => {
    const list = [...(byEpisode.get(episode) ?? [])].sort((a, b) => fileVersion(b.name) - fileVersion(a.name));
    const candidates = list.map((f) => f.id);
    return { episode, fileId: candidates[0] ?? null, candidates };
  });
  return { rows, unmatched };
}
