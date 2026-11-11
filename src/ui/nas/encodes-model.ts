// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The Encodes tab, pure: which empty state shows, the owner's notices about the encodes folder, the show grid, a Continue
 * watching card's route, a show's groups and its episodes' progress marks, and where a show whose id changed went.
 */
import type { ContinueItem, EncodeEpisode, EncodeSeason, EncodeShow, EncodeShowSummary, EncodesStatus, PlaylistProgress } from '@seikou/nas/nas-api';
import { ENCODE_PLAYLIST } from '@seikou/nas/place-key';
import { isShortPlace } from '@seikou/nas/place-rules';
import { normalizeTitle } from '@seikou/nas/title-text';
import { showIdOfTitle, titlePart, type EncodeTitle } from '@seikou/nas/encode-title';
import { NasHttpError, type NasClient } from './nas-client';
import type { NasRoute } from './nas-route';
import { progressPercent } from './resume-model';
import { nextInShow } from '@seikou/titles/encode-next';

/** The help page section on setting up the encodes folder. */
export const ENCODES_HELP = '/help/nas#encodes';
/** Shown while the NAS reads the encodes folder for the first time. */
export const INDEXING_COPY = 'Indexing the encodes…';
/** The heading of an owner's empty states. */
export const NO_ENCODES_YET = 'No encodes yet';
/** The line above the owner's list of files that couldn't be filed. */
export const UNFILED_COPY = 'These MKVs carry no title tags (an AniList, TMDB or own title), so the library can’t place them under a show.';

/** What the Encodes tab says when it has no shows: `unconfigured` (an owner on a NAS with no encodes folder, with a help link), `owner-none` (an owner, folder empty) or `guest` (everyone else). */
export type EncodesEmpty =
  /** An owner, and the NAS has no encodes folder. */
  | { readonly kind: 'unconfigured'; readonly title: string; readonly text: string; readonly help: string }
  /** An owner, with the folder and nothing in it yet. */
  | { readonly kind: 'owner-none'; readonly title: string; readonly text: string }
  /** Everyone else. */
  | { readonly kind: 'guest'; readonly title: string; readonly text: string };

/** The empty state for a library of `showCount` shows; null once there is one. */
export function encodesEmptyState(status: EncodesStatus | null, owner: boolean, showCount: number): EncodesEmpty | null {
  if (showCount > 0) return null;
  if (!owner) return { kind: 'guest', title: 'The library is currently empty.', text: 'Encoded episodes appear here once the owner adds them.' };
  if (status?.configured !== true) return { kind: 'unconfigured', title: NO_ENCODES_YET, text: 'Set ENCODES_MOUNT on the NAS to hold encodes', help: ENCODES_HELP };
  return { kind: 'owner-none', title: NO_ENCODES_YET, text: 'Encode an episode in Seikou encoder to add it here.' };
}

/** What an owner is told about the encodes folder: missing, empty while episodes are still listed, or the scan's error. */
export function ownerNotices(status: EncodesStatus | null, owner: boolean): string[] {
  if (!owner || !status) return [];
  const out: string[] = [];
  if (status.rootMissing) out.push("The encodes folder isn't there. Check that the drive is mounted.");
  if (status.rootEmpty) out.push('The encodes folder is empty, but the library still lists earlier episodes.');
  if (status.scanError) out.push(status.scanError);
  return out;
}

/** A Retry-After longer than this is waited out for this long only. */
const MAX_RETRY_S = 60;
/** A Retry-After shorter than this (0, say) is waited out for this long, so a client never asks in a tight loop. */
const MIN_RETRY_S = 1;

/** The wait before asking again when the NAS is still indexing (503 `indexing`, its `Retry-After`); null for any other error. */
export function indexingRetryMs(err: unknown): number | null {
  if (!(err instanceof NasHttpError) || err.status !== 503 || err.code !== 'indexing') return null;
  return Math.max(MIN_RETRY_S, Math.min(err.detail.retryAfter ?? 5, MAX_RETRY_S)) * 1000;
}

/**
 * Asks `ask` until the NAS answers something other than 503 `indexing`, waiting `indexingRetryMs` between tries
 * (`onIndexing` on each such answer). `result` settles with that answer; once `cancel` is called nothing more is asked
 * and `result` never settles.
 */
export function untilIndexed<T>(ask: () => Promise<T>, onIndexing?: () => void): { readonly result: Promise<T>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const result = new Promise<T>((resolve, reject) => {
    const once = (): void => {
      ask().then(
        (v) => {
          if (!cancelled) resolve(v);
        },
        (err: unknown) => {
          if (cancelled) return;
          const wait = indexingRetryMs(err);
          if (wait === null) return reject(err);
          onIndexing?.();
          timer = setTimeout(once, wait);
        },
      );
    };
    once();
  });
  return {
    result,
    cancel: () => {
      cancelled = true;
      clearTimeout(timer);
    },
  };
}

/** `1 episode` or `N episodes`. */
export function episodeCountLabel(n: number): string {
  return n === 1 ? '1 episode' : `${n} episodes`;
}

/** The shows whose name holds the search, in the list's order (by name). */
export function searchShows(shows: readonly EncodeShowSummary[], query: string): readonly EncodeShowSummary[] {
  const q = normalizeTitle(query).trim();
  if (q === '') return shows;
  return shows.filter((s) => normalizeTitle(s.name).includes(q));
}

/** Where a Continue watching card leads: a place resumes at once, an Up next episode starts from its beginning. */
export function continueRoute(item: ContinueItem): Extract<NasRoute, { kind: 'encodePlay' }> | null {
  if (!item.encodeId) return null;
  return item.kind === 'resume'
    ? { kind: 'encodePlay', encodeId: item.encodeId, timeS: Math.floor(item.timeUs / 1e6), resume: true }
    : { kind: 'encodePlay', encodeId: item.encodeId, timeS: null, resume: false };
}

/** One group of a show's screen: a season, a film, or another entry. */
export interface ShowGroup {
  /** The row's title part (`titlePart`): unique within a show, whatever the source. */
  readonly key: string;
  readonly kind: EncodeSeason['kind'];
  readonly heading: string;
  /** Under the heading: a season's own name when it says more than the show's name or "Season N", 'Film' for a film; else null. */
  readonly sub: string | null;
  readonly season: EncodeSeason;
}

const KIND_ORDER: Record<EncodeSeason['kind'], number> = { season: 0, film: 1, other: 2 };

/** A show's groups: its seasons in the order given, then its films, then the others. */
export function showGroups(show: EncodeShow): ShowGroup[] {
  return show.seasons
    .map((season, i) => ({ season, i }))
    .sort((a, b) => KIND_ORDER[a.season.kind] - KIND_ORDER[b.season.kind] || a.i - b.i)
    .map(({ season }) => {
      const numbered = season.kind === 'season' && season.number !== null;
      const heading = numbered ? `Season ${season.number}` : season.name;
      const sub = season.kind === 'film' ? 'Film' : numbered && season.name !== show.name && season.name !== heading ? season.name : null;
      // a row from a NAS before titles beyond AniList has only its AniList id, which is its title part too
      const title = season.title as EncodeTitle | undefined;
      return { key: title ? titlePart(title) : String(season.anilistId), kind: season.kind, heading, sub, season };
    });
}

/** Show progress as the NAS gives it: by encode id, then the encode's one playlist. */
export type EncodeProgress = Readonly<Record<string, Readonly<Record<string, PlaylistProgress>>>>;

/** An episode's mark: its progress bar (null once finished), whether it is finished, and where Resume starts (null: none to offer). */
export interface EpisodeMark {
  readonly percent: number | null;
  readonly finished: boolean;
  readonly resumeUs: number | null;
}

/** The mark of an episode with a place; null without one. */
export function episodeMark(progress: EncodeProgress | null, encodeId: string): EpisodeMark | null {
  const p = progress?.[encodeId]?.[ENCODE_PLAYLIST];
  if (!p) return null;
  if (p.finished) return { percent: null, finished: true, resumeUs: null };
  return { percent: progressPercent(p), finished: false, resumeUs: isShortPlace(p.timeUs, p.durationUs) ? null : p.timeUs };
}

/** Whether a show's row holds the encodes of `title` (a row from a NAS before titles beyond AniList has only its AniList id). */
function rowHolds(season: EncodeSeason, title: EncodeTitle): boolean {
  // a NAS from before the row titles leaves them out (the wire type says they are there)
  const rowTitle = season.title as EncodeTitle | undefined;
  if (rowTitle) return titlePart(rowTitle) === titlePart(title);
  return title.source === 'anilist' && season.anilistId === title.anilistId;
}

/**
 * A show id answered 404 (its AniList chain loaded and the show is rooted elsewhere now): the show among `shows` whose
 * seasons hold the title (or AniList id) or the episode it was reached by; null for none.
 */
export function showContaining(
  shows: readonly EncodeShow[],
  from: { readonly anilistId?: number; readonly title?: EncodeTitle; readonly encodeId?: string },
): string | null {
  for (const show of shows) {
    for (const season of show.seasons) {
      if (from.anilistId !== undefined && rowHolds(season, { source: 'anilist', anilistId: from.anilistId })) return show.id;
      if (from.title !== undefined && rowHolds(season, from.title)) return show.id;
      if (from.encodeId !== undefined && season.episodes.some((e) => e.id === from.encodeId)) return show.id;
    }
  }
  return null;
}

/**
 * The show of the list that holds `title`, by the title parts the list names for each show (`titles`), or by its
 * AniList ids (`anilistIds`) on a NAS from before the title parts, which lists AniList titles only: the show's id, null
 * for none, undefined when the list names neither (a NAS from before both).
 */
export function listedShowOf(shows: readonly EncodeShowSummary[], title: EncodeTitle): string | null | undefined {
  const part = titlePart(title);
  // a NAS from before them leaves the fields out (the wire type says they are there)
  const parts = (s: EncodeShowSummary): readonly string[] | undefined => s.titles as readonly string[] | undefined;
  const ids = (s: EncodeShowSummary): readonly number[] | undefined => s.anilistIds as readonly number[] | undefined;
  if (shows.some((s) => parts(s) !== undefined)) return shows.find((s) => parts(s)?.includes(part))?.id ?? null;
  if (shows.some((s) => ids(s) !== undefined)) {
    if (title.source !== 'anilist') return null;
    return shows.find((s) => ids(s)?.includes(title.anilistId))?.id ?? null;
  }
  return undefined;
}

/** The id a show rooted at `title` has: an AniList entry's own id (the root's guess), else `showIdOfTitle`'s. */
function rootShowId(title: EncodeTitle): string {
  return showIdOfTitle(title) ?? titlePart(title);
}

/** The episode after `encodeId` in its show, by the rule the NAS's Up next uses too (`nextInShow`). */
export function nextEpisode(show: EncodeShow, encodeId: string): EncodeEpisode | null {
  return nextInShow(show, encodeId);
}

/**
 * The show holding the encodes of `title` (an AniList entry, a TMDB season or film, an own title): the show list names
 * each show's titles (`listedShowOf`), so only that show is fetched. A list naming neither (a NAS from before them) is
 * walked instead: the show rooted at the title, then each show in turn until one holds it. Null for none.
 */
export async function findEncodeShow(nas: Pick<NasClient, 'encodeShow' | 'encodeShows'>, title: EncodeTitle): Promise<EncodeShow | null> {
  const holds = (show: EncodeShow | null): show is EncodeShow => show !== null && show.seasons.some((s) => rowHolds(s, title));
  const { shows } = await nas.encodeShows();
  const listed = listedShowOf(shows, title);
  if (listed !== undefined) {
    if (listed === null) return null;
    const show = await nas.encodeShow(listed);
    return holds(show) ? show : null;
  }
  const root = rootShowId(title);
  const own = await nas.encodeShow(root);
  if (holds(own)) return own;
  for (const summary of shows) {
    if (summary.id === root) continue;
    const show = await nas.encodeShow(summary.id);
    if (holds(show)) return show;
  }
  return null;
}

/** "24 min" for an episode's length; null when unknown. */
export function durationLabel(durationMs: number): string | null {
  if (!(durationMs > 0)) return null;
  return `${Math.max(1, Math.round(durationMs / 60_000))} min`;
}
