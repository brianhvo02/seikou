// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * The Encodes tab, pure: which empty state shows, the owner's notices about the encodes folder, the show grid, a Continue
 * watching card's route, a show's groups and its episodes' progress marks, and where a show whose id changed went.
 */
import type { ContinueItem, EncodeEpisode, EncodeSeason, EncodeShow, EncodeShowSummary, EncodesStatus, PlaylistProgress } from '@seikou/nas/nas-api';
import { ENCODE_PLAYLIST } from '@seikou/nas/place-key';
import { isShortPlace } from '@seikou/nas/place-rules';
import { normalizeTitle } from '@seikou/nas/title-text';
import { NasHttpError, type NasClient } from './nas-client';
import type { NasRoute } from './nas-route';
import { progressPercent } from './resume-model';

/** The help page section on setting up the encodes folder. */
export const ENCODES_HELP = '/help/nas#encodes';
/** Shown while the NAS reads the encodes folder for the first time. */
export const INDEXING_COPY = 'Indexing the encodes…';
/** The heading of an owner's empty states. */
export const NO_ENCODES_YET = 'No encodes yet';
/** The line above the owner's list of files that couldn't be filed. */
export const UNFILED_COPY = 'These MKVs carry no AniList tags, so the library can’t place them under a show.';

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

/** The wait before asking again when the NAS is still indexing (503 `indexing`, its `Retry-After`); null for any other error. */
export function indexingRetryMs(err: unknown): number | null {
  if (!(err instanceof NasHttpError) || err.status !== 503 || err.code !== 'indexing') return null;
  return Math.min(err.detail.retryAfter ?? 5, MAX_RETRY_S) * 1000;
}

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
      return { key: String(season.anilistId), kind: season.kind, heading, sub, season };
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

/**
 * A show id answered 404 (its AniList chain loaded and the show is rooted elsewhere now): the show among `shows` whose
 * seasons hold the AniList id or the episode it was reached by; null for none.
 */
export function showContaining(shows: readonly EncodeShow[], from: { readonly anilistId?: number; readonly encodeId?: string }): string | null {
  for (const show of shows) {
    for (const season of show.seasons) {
      if (from.anilistId !== undefined && season.anilistId === from.anilistId) return show.id;
      if (from.encodeId !== undefined && season.episodes.some((e) => e.id === from.encodeId)) return show.id;
    }
  }
  return null;
}

/**
 * The episode after `encodeId` in its show: the next episode number its entry has, else, for a TV season, the first
 * episode of the next season (in the show's order). Never a film, and none after a film, an other entry's last
 * episode or the last season's; null when the show doesn't hold the episode.
 */
export function nextEpisode(show: EncodeShow, encodeId: string): EncodeEpisode | null {
  const at = show.seasons.findIndex((s) => s.episodes.some((e) => e.id === encodeId));
  if (at < 0) return null;
  const season = show.seasons[at]!;
  if (season.kind === 'film') return null;
  const current = season.episodes.find((e) => e.id === encodeId)!.episode;
  const later = season.episodes.filter((e) => e.episode > current).sort((a, b) => a.episode - b.episode)[0];
  if (later) return later;
  if (season.kind !== 'season') return null;
  const nextSeason = show.seasons.slice(at + 1).find((s) => s.kind === 'season' && s.episodes.length > 0);
  return nextSeason ? ([...nextSeason.episodes].sort((a, b) => a.episode - b.episode)[0] ?? null) : null;
}

/**
 * The show holding the episodes of AniList entry `anilistId`: the show rooted at that entry when there is one,
 * else the first show of the list that holds it; null for none.
 */
export async function findEncodeShow(nas: Pick<NasClient, 'encodeShow' | 'encodeShows'>, anilistId: number): Promise<EncodeShow | null> {
  const own = await nas.encodeShow(String(anilistId));
  if (own && own.seasons.some((s) => s.anilistId === anilistId)) return own;
  const { shows } = await nas.encodeShows();
  for (const summary of shows) {
    if (summary.id === String(anilistId)) continue;
    const show = await nas.encodeShow(summary.id);
    if (show && show.seasons.some((s) => s.anilistId === anilistId)) return show;
  }
  return null;
}

/** "24 min" for an episode's length; null when unknown. */
export function durationLabel(durationMs: number): string | null {
  if (!(durationMs > 0)) return null;
  return `${Math.max(1, Math.round(durationMs / 60_000))} min`;
}
