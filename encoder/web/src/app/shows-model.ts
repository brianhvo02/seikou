// SPDX-License-Identifier: LGPL-3.0-or-later
import { sameTitle, titlePart } from '@seikou/nas/encode-title';
import type { Job, NasCheckedGroup, NasEncodeTitle, NasSeason, NasSeasonDisc } from '../api-types';
import type { BatchJob } from './QueueDialog';

// The Library by show, as pure functions over the backend's season answer and the app's queue: what a season has left
// to encode, which of its discs still need checking, the jobs its Queue makes and why Queue can't be used yet.

/** NAS episodes to encode on a disc that none of its checked groups gives with the season's title and that number. */
export interface Unmapped {
  /** The disc's label. */
  readonly disc: string;
  readonly discId: string;
  /** The first playlist with such an episode, the one Check episodes opens. */
  readonly playlistId: string;
  readonly numbers: number[];
}

/** What a season's Queue would do now. */
export interface SeasonState {
  /** Episodes the Queue would queue now or once every disc is checked: not encoded and not in the app's queue already. */
  readonly toEncode: number;
  /** False when a disc of a season the NAS lists no episodes for isn't checked, so how many it holds isn't known. */
  readonly known: boolean;
  /** Episodes left out because a NAS job queued here already encodes them. */
  readonly queued: number;
  /** The labels of the discs with episodes to encode that are not checked (an unavailable one included), in disc order. */
  readonly uncheckedDiscs: string[];
  /** Checked discs whose groups miss NAS episodes to encode. */
  readonly unmapped: Unmapped[];
  /** One job per checked disc and playlist with episodes to encode; `only` its 1-based episodes still to encode. */
  readonly jobs: BatchJob[];
}

/** The episodes a disc lists, over its playlists. */
const listed = (disc: NasSeasonDisc) => disc.playlists.flatMap((p) => p.episodes);

/** Whether the NAS lists episodes on no disc of the season (an own title, a film): every disc then needs checking. */
const listsNone = (season: NasSeason): boolean => season.discs.every((d) => listed(d).length === 0);

/** How many episodes an `--episodes` list makes. */
export const groupsOf = (spec: string): number => spec.split(',').filter((t) => t.trim() !== '').length;

/** The key of an episode a job encodes: the disc, the playlist, and the title and number it is encoded as. */
export function queuedKey(discKey: string, playlistId: string, title: NasEncodeTitle, episode: number): string {
  return `${discKey}|${playlistId}|${titlePart(title)}|${episode}`;
}

/**
 * The episodes of `season` that a NAS job in the app's queue (queued or running, waiting for the NAS included) already
 * encodes, as `queuedKey`s. A job is read through the disc's checked grouping it was queued with (the same episode
 * list); one queued with another list can't be read and counts for nothing. A failed episode or one the job skips is
 * not counted.
 */
export function queuedKeys(season: NasSeason, jobs: readonly Job[]): Set<string> {
  const keys = new Set<string>();
  for (const job of jobs) {
    if (job.kind !== 'encode' || job.settings.destination !== 'nas' || (job.state !== 'queued' && job.state !== 'running')) continue;
    const disc = season.discs.find((d) => d.key === job.disc.key);
    const grouping = disc?.checkedPlaylists.find((p) => p.id === job.playlist && p.episodeSpec === job.episodeSpec);
    if (grouping === undefined) continue;
    const only = job.only === undefined ? null : new Set(job.only);
    for (const g of grouping.groups) {
      if (g.title === null || g.episode === null || (only !== null && !only.has(g.index))) continue;
      const ep = job.episodes.find((e) => e.index === g.index);
      if (ep?.skipped === true || ep?.state === 'failed') continue;
      keys.add(queuedKey(job.disc.key, job.playlist, g.title, g.episode));
    }
  }
  return keys;
}

/** The checked group of `disc`'s playlist that is episode `number` of the season's title, or undefined. */
function groupFor(season: NasSeason, disc: NasSeasonDisc, playlistId: string, number: number): NasCheckedGroup | undefined {
  const title = season.title;
  if (title === null) return undefined;
  return disc.checkedPlaylists.find((p) => p.id === playlistId)?.groups.find((g) => g.title !== null && sameTitle(g.title, title) && g.episode === number);
}

/** Whether a NAS episode of `disc` is in the app's queue already. */
export function isQueued(season: NasSeason, disc: NasSeasonDisc, playlistId: string, number: number, queued: ReadonlySet<string>): boolean {
  return disc.key !== null && season.title !== null && queued.has(queuedKey(disc.key, playlistId, season.title, number));
}

/** Whether a checked group of `disc` is in the app's queue already. */
export function isGroupQueued(disc: NasSeasonDisc, playlistId: string, g: NasCheckedGroup, queued: ReadonlySet<string>): boolean {
  return disc.key !== null && g.title !== null && g.episode !== null && queued.has(queuedKey(disc.key, playlistId, g.title, g.episode));
}

/**
 * What `season` has left and the jobs that queue it, given the app's queue (`queued`, from `queuedKeys`). A disc the
 * NAS lists episodes for makes a job per playlist with episodes neither encoded nor queued, `only` the 1-based
 * episodes of the playlist's checked grouping that give one of them with the season's title and its number; one no
 * group gives is `unmapped`, never dropped. In a season the NAS lists no episodes for, each checked disc makes a job
 * per checked playlist with groups neither encoded nor queued, `only` those. A disc with nothing left, or with no
 * episodes in a season that lists some on its other discs (an extras disc), makes no job and blocks nothing.
 */
export function seasonState(season: NasSeason, queued: ReadonlySet<string> = new Set()): SeasonState {
  const none = listsNone(season);
  let toEncode = 0;
  let queuedCount = 0;
  let known = true;
  const uncheckedDiscs: string[] = [];
  const unmapped: Unmapped[] = [];
  const jobs: BatchJob[] = [];
  for (const disc of season.discs) {
    if (none) {
      if (needsCheck(season, disc)) {
        uncheckedDiscs.push(disc.label);
        known = false;
        continue;
      }
      if (disc.key === null) continue;
      for (const p of disc.checkedPlaylists) {
        const left = p.groups.filter((g) => !g.encoded);
        const waiting = left.filter((g) => isGroupQueued(disc, p.id, g, queued));
        queuedCount += waiting.length;
        const only = left.filter((g) => !waiting.includes(g)).map((g) => g.index);
        toEncode += only.length;
        if (only.length > 0) jobs.push({ discKey: disc.key, playlistId: p.id, episodeSpec: p.episodeSpec, only });
      }
      continue;
    }
    const todo = disc.playlists.flatMap((p) => p.episodes.filter((e) => !e.encoded).map((e) => ({ playlistId: p.id, number: e.number })));
    const notQueued = todo.filter((e) => !isQueued(season, disc, e.playlistId, e.number, queued));
    queuedCount += todo.length - notQueued.length;
    toEncode += notQueued.length;
    if (notQueued.length === 0) continue;
    if (needsCheck(season, disc) || disc.key === null) {
      uncheckedDiscs.push(disc.label);
      continue;
    }
    const missing: number[] = [];
    let missingIn: string | null = null;
    for (const p of disc.playlists) {
      const grouping = disc.checkedPlaylists.find((c) => c.id === p.id);
      const only: number[] = [];
      for (const e of notQueued.filter((x) => x.playlistId === p.id)) {
        const g = groupFor(season, disc, p.id, e.number);
        if (g === undefined) {
          missing.push(e.number);
          missingIn ??= p.id;
        } else only.push(g.index);
      }
      if (grouping !== undefined && only.length > 0)
        jobs.push({ discKey: disc.key, playlistId: p.id, episodeSpec: grouping.episodeSpec, only: only.sort((a, b) => a - b) });
    }
    if (missing.length > 0) unmapped.push({ disc: disc.label, discId: disc.discId, playlistId: missingIn ?? '', numbers: missing.sort((a, b) => a - b) });
  }
  return { toEncode, known, queued: queuedCount, uncheckedDiscs, unmapped, jobs };
}

/**
 * Whether `disc` blocks the season's Queue until it is checked: it isn't checked (an unavailable disc never is) and
 * it has episodes to encode, or the season lists no episodes at all, so what it holds is unknown.
 */
export function needsCheck(season: NasSeason, disc: NasSeasonDisc): boolean {
  if (disc.available && disc.checked && disc.key !== null) return false;
  return listsNone(season) || listed(disc).some((e) => !e.encoded);
}

/**
 * A season's episodes: how many, how many are encoded and how many are not. Those the NAS lists, or for a season it
 * lists none for, the groups of its checked discs, `known` false while one of its discs isn't checked.
 */
export function seasonCounts(season: NasSeason): { readonly encoded: number; readonly toEncode: number; readonly episodes: number; readonly known: boolean } {
  if (listsNone(season)) {
    const groups = season.discs.flatMap((d) => (d.checked ? d.checkedPlaylists.flatMap((p) => p.groups) : []));
    const encoded = groups.filter((g) => g.encoded).length;
    return { encoded, toEncode: groups.length - encoded, episodes: groups.length, known: season.discs.every((d) => !needsCheck(season, d)) };
  }
  const all = season.discs.flatMap(listed);
  const encoded = all.filter((e) => e.encoded).length;
  return { encoded, toEncode: all.length - encoded, episodes: all.length, known: true };
}

/** Numbers as a phrase: `10`, `10 and 11`, `9, 10 and 11`. */
export function andList(items: readonly (string | number)[]): string {
  return items.length === 1 ? String(items[0]) : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** `labels` as a phrase: `discs 2 and 3` when every label is `Disc <n>`, else the labels themselves. */
export function discsPhrase(labels: readonly string[]): string {
  const numbers = labels.map((l) => /^Disc (\S+)$/i.exec(l)?.[1] ?? null);
  const numbered = numbers.every((n) => n !== null);
  const list = andList(numbered ? (numbers as string[]) : labels);
  return numbered ? `${labels.length === 1 ? 'disc' : 'discs'} ${list}` : list;
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The warning for a checked disc whose groups miss NAS episodes to encode. */
export function unmappedText(u: Unmapped): string {
  return `${u.disc}'s checked episodes don't include ${andList(u.numbers)}: check it again`;
}

/**
 * Why `season` can't be queued now, or null when it can: the NAS isn't answering (`reachable` false), the season has
 * no title to tag its encodes with, a disc this app can't read, discs still to check, checked discs that miss episodes
 * to encode, or nothing left (encoded, or already in the queue).
 */
export function queueBlock(season: NasSeason, reachable: boolean, queued: ReadonlySet<string> = new Set()): string | null {
  if (!reachable) return "The NAS isn't answering: this is its last listing";
  if (season.title === null) return "The NAS hasn't loaded this season's entry yet, so its encodes can't be named";
  const state = seasonState(season, queued);
  const unchecked = new Set(state.uncheckedDiscs);
  const missing = season.discs.filter((d) => !d.available && unchecked.has(d.label)).map((d) => d.label);
  const toCheck = state.uncheckedDiscs.filter((l) => !missing.includes(l));
  const reasons: string[] = [];
  if (toCheck.length > 0) reasons.push(`Check ${discsPhrase(toCheck)} first`);
  if (missing.length > 0)
    reasons.push(`${capital(discsPhrase(missing))} ${missing.length === 1 ? "isn't" : "aren't"} in this app's listing of the NAS yet: rescan the Library`);
  reasons.push(...state.unmapped.map(unmappedText));
  if (reasons.length > 0) return reasons.join('. ');
  if (state.jobs.length === 0) return state.queued > 0 ? 'Everything left is in the queue already' : 'Every episode is encoded';
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
