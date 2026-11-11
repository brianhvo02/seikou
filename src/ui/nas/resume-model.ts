import type { ContinueItem, DiscManifest, DiscPlaces, PlaceSettings, PlaybackPlace, PlaylistProgress } from '@seikou/nas/nas-api';
import { isShortPlace } from '@seikou/nas/place-rules';
import type { StartPoint } from '@seikou/engine/protocol';
import { resumeStart } from '../place-model';
import { playlistOf } from './library-model';

/**
 * Whether and how a NAS disc resumes, pure: `resumeOffer` decides from the disc's places and its playlists what the
 * pre-flight offers, `startOver` and `carriedSettings` give the start point and settings a launch uses, and the
 * Continue watching cards and progress marks are worded from the NAS's lists.
 */

/** The copy shown for a place `resumeStart` can't use: its playlist is gone or its time is past the playlist's end. */
export const DISC_CHANGED_COPY = 'This disc has changed since you stopped.';
/** A Continue watching card whose title the NAS doesn't name, and whose disc has no name either. */
export const UNTITLED_DISC = 'Untitled disc';

/**
 * `promise`'s value, or `fallback` once it fails or `ms` pass: a pre-flight never waits on a stalled request (a WebRTC
 * route, a session that doesn't come) for longer than that.
 */
export function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    const done = (v: T): void => {
      clearTimeout(timer);
      resolve(v);
    };
    promise.then(done, () => done(fallback));
  });
}

/** The disc's playlists from its manifest (every MPLS file), with the length of each one inlined there. */
export function playlistsOf(manifest: DiscManifest): { readonly id: string; readonly durationUs?: number }[] {
  const out: { id: string; durationUs?: number }[] = [];
  for (const { path } of manifest.files) {
    const m = /^BDMV\/PLAYLIST\/(\d{5})\.MPLS$/.exec(path);
    if (!m) continue;
    const mpls = playlistOf(manifest, m[1]!);
    const ticks = mpls?.playItems.reduce((sum, p) => sum + Math.max(0, p.outTime - p.inTime), 0);
    out.push(ticks !== undefined && ticks > 0 ? { id: m[1]!, durationUs: Math.round((ticks / 45_000) * 1e6) } : { id: m[1]! });
  }
  return out;
}

/**
 * What a pre-flight offers for the disc's places: the usual Play (`none`: no place, or a finished one), Resume or
 * Start from beginning (`ask`), or only Start from beginning when the place's playlist is gone from the disc or its time is at or past the playlist's end (`changed`). A
 * place near its start (isShortPlace) asks nothing: for a requested playlist (`short`), Play starts it from the
 * beginning with the place's settings (`start`; null when the disc no longer has the playlist); with none requested it
 * is passed over. With a playlist requested, its own place; else the disc's newest unfinished place that isn't short
 * (none: the disc opens as it starts).
 */
export type ResumeOffer =
  | { readonly kind: 'none' }
  | { readonly kind: 'short'; readonly place: PlaybackPlace; readonly start: StartPoint | null }
  | { readonly kind: 'ask'; readonly place: PlaybackPlace; readonly start: StartPoint }
  | { readonly kind: 'changed'; readonly place: PlaybackPlace };

/** What the pre-flight offers (see `ResumeOffer`) for `places`: the place of `playlistId` when one is requested, else the disc's newest unfinished place that is not short. `playlists` (null when not known yet, which skips the check) gives each playlist's current length; a place whose playlist the disc no longer has, or whose time is at or past that length, is `changed`. A finished place, or none found, is `none`. */
export function resumeOffer(
  places: DiscPlaces | null,
  playlistId: string | null,
  playlists: readonly { readonly id: string; readonly durationUs?: number }[] | null,
): ResumeOffer {
  if (!places) return { kind: 'none' };
  const lengthOf = (p: PlaybackPlace): number => playlists?.find((x) => x.id === p.playlistId)?.durationUs ?? p.durationUs;
  const short = (p: PlaybackPlace): boolean => isShortPlace(p.timeUs, lengthOf(p));
  const place = playlistId !== null
    ? places.places[playlistId]
    : Object.values(places.places).filter((p) => !p.finished && !short(p)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!place || place.finished) return { kind: 'none' };
  if (short(place)) return { kind: 'short', place, start: playlists && !playlists.some((x) => x.id === place.playlistId) ? null : startOver(place) };
  const start = resumeStart(place, playlists);
  return 'problem' in start ? { kind: 'changed', place } : { kind: 'ask', place, start };
}

/** Start from beginning: the place's playlist at 0, played directly with its audio, subtitle and angle (PSR 1–3). */
export function startOver(place: PlaybackPlace): StartPoint {
  const { psr1, psr2, psr3 } = place.settings;
  return { playlistId: place.playlistId, timeUs: 0, hdmv: null, playback: { psr1, psr2, psr3 } };
}

/**
 * The settings a launch with no place of its own starts with: an Up next card's (the finished
 * episode's, from the NAS's Continue watching list), else the disc's own defaults (its latest place's); null for none.
 */
export function carriedSettings(
  items: readonly ContinueItem[] | null, discId: string, playlistId: string, places: DiscPlaces | null,
): PlaceSettings | null {
  const upNext = items?.find((i) => i.kind === 'up-next' && i.discId === discId && i.playlistId === playlistId && i.settings !== null);
  return upNext?.settings ?? places?.defaults ?? null;
}

/** "1 h 05 min" or "9 min" left of a place; at least a minute while any is left. */
function timeLeft(item: Pick<ContinueItem, 'timeUs' | 'durationUs'>): string {
  const min = Math.max(1, Math.ceil(Math.max(0, item.durationUs - item.timeUs) / 60_000_000));
  return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min left` : `${min} min left`;
}

/** What a Continue watching card shows: its title, its line, and its progress (null: no bar). */
export function continueCard(item: ContinueItem, discName: string | null): { readonly title: string; readonly line: string; readonly percent: number | null } {
  const title = item.titleName ?? (discName || UNTITLED_DISC);
  const episode = item.episode !== null ? [...(item.seasonNumber !== null ? [`S${item.seasonNumber}`] : []), `Episode ${item.episode}`].join(' · ') : null;
  if (item.kind === 'up-next') return { title, line: episode ? `Up next · ${episode}` : 'Up next', percent: null };
  const left = item.durationUs > 0 ? timeLeft(item) : null;
  const parts = item.kindOfTitle === 'movie' ? ['Movie', ...(left ? [left] : [])] : [...(episode ? [episode] : []), ...(left ? [left] : [])];
  return { title, line: parts.join(' · '), percent: progressPercent(item) };
}

/** How far into a place, 0–100; null without a length, or once finished. */
export function progressPercent(p: Pick<PlaylistProgress, 'timeUs' | 'durationUs'> & { readonly finished?: boolean }): number | null {
  if (p.finished || !(p.durationUs > 0)) return null;
  return Math.min(100, Math.max(0, Math.round((p.timeUs / p.durationUs) * 100)));
}

/** An episode row's progress: its disc's place for its playlist, when unfinished. */
export function episodeProgress(
  progress: Readonly<Record<string, Readonly<Record<string, PlaylistProgress>>>> | null, discId: string, playlistId: string,
): number | null {
  const p = progress?.[discId]?.[playlistId];
  return p ? progressPercent(p) : null;
}
