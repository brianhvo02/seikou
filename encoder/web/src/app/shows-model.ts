// SPDX-License-Identifier: LGPL-3.0-or-later
import type { NasSeason, NasSeasonDisc } from '../api-types';
import type { BatchJob } from './QueueDialog';

// The Library by show, as pure functions over the backend's season answer: what a season has left to encode, which of
// its discs still need checking, the jobs its Queue makes and why Queue can't be used yet.

/** What a season's Queue would do now. */
export interface SeasonState {
  /** Episodes still to encode: the NAS's episodes not in the Encodes library, plus the groups of checked discs it lists none for. */
  readonly toEncode: number;
  /** The labels of the discs with episodes to encode that are not checked (an unavailable one included), in disc order. */
  readonly uncheckedDiscs: string[];
  /** One job per checked disc and playlist with episodes to encode; `only` left out queues the whole checked grouping. */
  readonly jobs: BatchJob[];
}

/** The episodes a disc lists, over its playlists. */
const listed = (disc: NasSeasonDisc) => disc.playlists.flatMap((p) => p.episodes);

/** Whether the NAS lists episodes on no disc of the season (an own title, a film): every disc then needs checking. */
const listsNone = (season: NasSeason): boolean => season.discs.every((d) => listed(d).length === 0);

/** How many episodes an `--episodes` list makes. */
const groupsOf = (spec: string): number => spec.split(',').filter((t) => t.trim() !== '').length;

/**
 * What `season` has left and the jobs that queue it. A disc the NAS lists episodes for makes a job per playlist with
 * episodes not encoded, `only` the 1-based episodes of the playlist's checked grouping whose number is one of them (a
 * number the grouping doesn't give is not queued). In a season the NAS lists no episodes for, each checked disc
 * queues every checked playlist whole. A disc with nothing left, or with no episodes in a season that lists some on
 * its other discs (an extras disc), makes no job and blocks nothing.
 */
export function seasonState(season: NasSeason): SeasonState {
  const none = listsNone(season);
  let toEncode = 0;
  const uncheckedDiscs: string[] = [];
  const jobs: BatchJob[] = [];
  for (const disc of season.discs) {
    if (needsCheck(season, disc)) {
      uncheckedDiscs.push(disc.label);
      toEncode += listed(disc).filter((e) => !e.encoded).length;
      continue;
    }
    if (none) {
      if (disc.key === null) continue;
      for (const p of disc.checkedPlaylists) {
        toEncode += groupsOf(p.episodeSpec);
        jobs.push({
          discKey: disc.key,
          playlistId: p.id,
          episodeSpec: p.episodeSpec,
        });
      }
      continue;
    }
    const left = listed(disc).filter((e) => !e.encoded).length;
    toEncode += left;
    if (left === 0 || disc.key === null) continue;
    for (const p of disc.playlists) {
      const todo = new Set(p.episodes.filter((e) => !e.encoded).map((e) => e.number));
      if (todo.size === 0) continue;
      const grouping = disc.checkedPlaylists.find((c) => c.id === p.id);
      if (grouping === undefined) continue;
      const only = grouping.episodes.flatMap((n, i) => (n !== null && todo.has(n) ? [i + 1] : []));
      if (only.length > 0)
        jobs.push({
          discKey: disc.key,
          playlistId: p.id,
          episodeSpec: grouping.episodeSpec,
          only,
        });
    }
  }
  return { toEncode, uncheckedDiscs, jobs };
}

/**
 * Whether `disc` blocks the season's Queue until it is checked: it isn't checked (an unavailable disc never is) and
 * it has episodes to encode, or the season lists no episodes at all, so what it holds is unknown.
 */
export function needsCheck(season: NasSeason, disc: NasSeasonDisc): boolean {
  if (disc.available && disc.checked && disc.key !== null) return false;
  return listsNone(season) || listed(disc).some((e) => !e.encoded);
}

/** A season's episodes the NAS lists: how many, how many are encoded and how many are not. */
export function seasonCounts(season: NasSeason): {
  readonly encoded: number;
  readonly toEncode: number;
  readonly episodes: number;
} {
  const all = season.discs.flatMap(listed);
  const encoded = all.filter((e) => e.encoded).length;
  return { encoded, toEncode: all.length - encoded, episodes: all.length };
}

/** `labels` as a phrase: `discs 2 and 3` when every label is `Disc <n>`, else the labels themselves. */
export function discsPhrase(labels: readonly string[]): string {
  const numbers = labels.map((l) => /^Disc (\S+)$/i.exec(l)?.[1] ?? null);
  const numbered = numbers.every((n) => n !== null);
  const items = numbered ? (numbers as string[]) : [...labels];
  const list = items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  return numbered ? `${items.length === 1 ? 'disc' : 'discs'} ${list}` : list;
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Why `season` can't be queued now, or null when it can: the NAS isn't answering (`reachable` false), the season has
 * no title to tag its encodes with, nothing is left, a disc this app can't read, or discs still to check.
 */
export function queueBlock(season: NasSeason, reachable: boolean): string | null {
  if (!reachable) return "The NAS isn't answering: this is its last listing";
  if (season.title === null) return "The NAS hasn't loaded this season's entry yet, so its encodes can't be named";
  const state = seasonState(season);
  const unchecked = new Set(state.uncheckedDiscs);
  const missing = season.discs.filter((d) => !d.available && unchecked.has(d.label)).map((d) => d.label);
  const toCheck = state.uncheckedDiscs.filter((l) => !missing.includes(l));
  const reasons: string[] = [];
  if (toCheck.length > 0) reasons.push(`Check ${discsPhrase(toCheck)} first`);
  if (missing.length > 0) reasons.push(`${capital(discsPhrase(missing))} ${missing.length === 1 ? "isn't" : "aren't"} in this app's listing of the NAS yet: rescan the Library`);
  if (reasons.length > 0) return reasons.join('. ');
  if (state.jobs.length === 0) return 'Every episode is encoded';
  return null;
}

/**
 * What a disc's Check episodes opens: the first playlist the NAS lists episodes on that isn't checked (else its first
 * playlist with episodes), the disc page to pick a playlist when the NAS lists none, or null for a disc this app
 * can't open.
 */
export function checkTarget(disc: NasSeasonDisc): { readonly kind: 'playlist'; readonly playlistId: string } | { readonly kind: 'disc' } | null {
  if (!disc.available || disc.key === null) return null;
  const withEpisodes = disc.playlists.filter((p) => p.episodes.length > 0);
  if (withEpisodes.length === 0) return { kind: 'disc' };
  const open = withEpisodes.find((p) => !disc.checkedPlaylists.some((c) => c.id === p.id)) ?? withEpisodes[0]!;
  return { kind: 'playlist', playlistId: open.id };
}
