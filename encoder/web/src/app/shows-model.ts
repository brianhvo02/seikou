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
  /** The playlist the NAS lists the first such episode on, the one Check episodes opens. */
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
  /** One job per checked playlist with episodes to encode; `only` its 1-based episodes still to encode. */
  readonly jobs: BatchJob[];
}

/** The episodes a disc lists, over its playlists. */
const listed = (disc: NasSeasonDisc) => disc.playlists.flatMap((p) => p.episodes);

/** Whether the NAS lists episodes on no disc of the season (an own title, a film): every disc then needs checking. */
const listsNone = (season: NasSeason): boolean => season.discs.every((d) => listed(d).length === 0);

/** How many episodes an `--episodes` list makes. */
export const groupsOf = (spec: string): number => spec.split(',').filter((t) => t.trim() !== '').length;

/**
 * The chapter ranges of the episode list `text` with its open end closed at `chapters`, as JSON (`[[1,3],[4,6]]`), the
 * way the backend's `resolvedSpec` writes a checked playlist's list; null for a list that does not read on that many
 * chapters (ranges ascending, not overlapping, an open range last only).
 */
export function resolvedSpec(text: string, chapters: number): string | null {
  if (text.trim() === '') return null;
  const tokens = text.split(',').map((t) => t.trim());
  const out: [number, number][] = [];
  let previousEnd = 0;
  for (const [i, token] of tokens.entries()) {
    const m = /^(\d+)(?:(-)(\d*))?$/.exec(token);
    if (!m) return null;
    const from = Number(m[1]);
    if (m[2] !== undefined && m[3] === '' && i !== tokens.length - 1) return null;
    const to = m[2] === undefined ? from : m[3] === '' ? chapters : Number(m[3]);
    if (from < 1 || to < 1 || from > chapters || to > chapters || to < from || from <= previousEnd) return null;
    previousEnd = to;
    out.push([from, to]);
  }
  return JSON.stringify(out);
}

/** The key of an episode a job encodes: the disc, and the title and number it is encoded as (on whichever playlist). */
export function queuedKey(discKey: string, title: NasEncodeTitle, episode: number): string {
  return `${discKey}|${titlePart(title)}|${episode}`;
}

/**
 * The episodes of `season` that a NAS job in the app's queue (queued or running, waiting for the NAS included) already
 * encodes, as `queuedKey`s. A job is read through the disc's checked playlist it was queued with (the same episode
 * list, however it is written); one queued with another list can't be read and counts for nothing. A failed episode
 * or one the job skips is not counted.
 */
export function queuedKeys(season: NasSeason, jobs: readonly Job[]): Set<string> {
  const keys = new Set<string>();
  for (const job of jobs) {
    if (job.kind !== 'encode' || job.settings.destination !== 'nas' || (job.state !== 'queued' && job.state !== 'running')) continue;
    const disc = season.discs.find((d) => d.key === job.disc.key);
    const grouping = disc?.checkedPlaylists.find((p) => p.id === job.playlist && resolvedSpec(job.episodeSpec, p.chapters) === p.resolvedSpec);
    if (grouping === undefined) continue;
    const only = job.only === undefined ? null : new Set(job.only);
    for (const g of grouping.groups) {
      if (g.title === null || g.episode === null || (only !== null && !only.has(g.index))) continue;
      const ep = job.episodes.find((e) => e.index === g.index);
      if (ep?.skipped === true || ep?.state === 'failed') continue;
      keys.add(queuedKey(job.disc.key, g.title, g.episode));
    }
  }
  return keys;
}

/**
 * The checked group of `disc` that is episode `number` of the season's title, in any of its checked playlists (the
 * first that has it), with that playlist's id; undefined when none gives it.
 */
function groupFor(season: NasSeason, disc: NasSeasonDisc, number: number): { readonly playlistId: string; readonly group: NasCheckedGroup } | undefined {
  const title = season.title;
  if (title === null) return undefined;
  for (const p of disc.checkedPlaylists) {
    const group = p.groups.find((g) => g.title !== null && sameTitle(g.title, title) && g.episode === number);
    if (group !== undefined) return { playlistId: p.id, group };
  }
  return undefined;
}

/**
 * The one rule of a checked disc, the backend's `discChecked` too: at least one of its playlists is checked, and every
 * episode the NAS lists on it that isn't encoded is given, with the season's title and that number, by a group of one
 * of them, whichever playlist the NAS lists it on. A disc the NAS lists nothing on is checked once any playlist is.
 */
export function discChecked(season: NasSeason, disc: NasSeasonDisc): boolean {
  if (disc.checkedPlaylists.length === 0) return false;
  return listed(disc).every((e) => e.encoded || groupFor(season, disc, e.number) !== undefined);
}

/** Whether a NAS episode of `disc` is in the app's queue already. */
export function isQueued(season: NasSeason, disc: NasSeasonDisc, number: number, queued: ReadonlySet<string>): boolean {
  return disc.key !== null && season.title !== null && queued.has(queuedKey(disc.key, season.title, number));
}

/** Whether a checked group of `disc` is in the app's queue already. */
export function isGroupQueued(disc: NasSeasonDisc, g: NasCheckedGroup, queued: ReadonlySet<string>): boolean {
  return disc.key !== null && g.title !== null && g.episode !== null && queued.has(queuedKey(disc.key, g.title, g.episode));
}

/**
 * What `season` has left and the jobs that queue it, given the app's queue (`queued`, from `queuedKeys`). On a disc the
 * NAS lists episodes for, each episode neither encoded nor queued is mapped to the checked group that gives it with
 * the season's title and its number, in any checked playlist of the disc; a job is made per checked playlist that
 * holds such groups, `only` those groups. One no group gives is `unmapped`, never dropped. In a season the NAS lists
 * no episodes for, each checked disc makes a job per checked playlist with groups neither encoded nor queued, `only`
 * those. A disc with nothing left, or with no episodes in a season that lists some on its other discs (an extras
 * disc), makes no job and blocks nothing.
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
        const waiting = left.filter((g) => isGroupQueued(disc, g, queued));
        queuedCount += waiting.length;
        const only = left.filter((g) => !waiting.includes(g)).map((g) => g.index);
        toEncode += only.length;
        if (only.length > 0) jobs.push({ discKey: disc.key, playlistId: p.id, episodeSpec: p.episodeSpec, only });
      }
      continue;
    }
    // each number once, with the first playlist the NAS lists it on
    const todo = new Map<number, string>();
    for (const p of disc.playlists) for (const e of p.episodes) if (!e.encoded && !todo.has(e.number)) todo.set(e.number, p.id);
    const notQueued = [...todo.keys()].filter((n) => !isQueued(season, disc, n, queued));
    queuedCount += todo.size - notQueued.length;
    toEncode += notQueued.length;
    if (notQueued.length === 0) continue;
    if (needsCheck(season, disc) || disc.key === null) {
      uncheckedDiscs.push(disc.label);
      continue;
    }
    const byPlaylist = new Map<string, Set<number>>();
    const missing: number[] = [];
    for (const n of notQueued) {
      const found = groupFor(season, disc, n);
      if (found === undefined) missing.push(n);
      else byPlaylist.set(found.playlistId, (byPlaylist.get(found.playlistId) ?? new Set()).add(found.group.index));
    }
    for (const p of disc.checkedPlaylists) {
      const only = byPlaylist.get(p.id);
      if (only !== undefined) jobs.push({ discKey: disc.key, playlistId: p.id, episodeSpec: p.episodeSpec, only: [...only].sort((a, b) => a - b) });
    }
    if (missing.length > 0) {
      missing.sort((a, b) => a - b);
      unmapped.push({ disc: disc.label, discId: disc.discId, playlistId: todo.get(missing[0]!)!, numbers: missing });
    }
  }
  return { toEncode, known, queued: queuedCount, uncheckedDiscs, unmapped, jobs };
}

/**
 * Whether `disc` blocks the season's Queue until it is checked: none of its playlists is checked (an unavailable disc
 * never is) and it has episodes to encode, or the season lists no episodes at all, so what it holds is unknown. A disc
 * with a checked playlist that misses episodes is `unmapped` instead (`seasonState`).
 */
export function needsCheck(season: NasSeason, disc: NasSeasonDisc): boolean {
  if (disc.available && disc.key !== null && disc.checkedPlaylists.length > 0) return false;
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
 * Why `season` can't be queued now, or null when it can: the NAS isn't answering (`reachable` false), it didn't say
 * which episodes it already has (`encodedKnown` false), the season has no title to tag its encodes with, a disc this
 * app can't read, discs still to check, checked discs that miss episodes to encode, or nothing left (encoded, or
 * already in the queue).
 */
export function queueBlock(
  season: NasSeason,
  nas: { readonly reachable: boolean; readonly encodedKnown: boolean },
  queued: ReadonlySet<string> = new Set(),
): string | null {
  if (!nas.reachable) return "The NAS isn't answering: this is its last listing";
  if (!nas.encodedKnown) return "Can't read which episodes the NAS already has. Try again in a moment";
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
