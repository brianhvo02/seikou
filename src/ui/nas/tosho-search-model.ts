import type { ToshoReleaseFiles, ToshoSearchResult } from '@seikou/nas/nas-api';
import { languageName } from '@seikou/engine/controller/language';

/**
 * The Anime Tosho search of the Subtitles menu, pure: the box's first words, and how releases, files and tracks are
 * labelled and noted for the place.
 */

/** The notice when a pick can't be fetched, lined up or loaded; the text set stays as it was. */
export const PICK_FAILED = "Couldn't load the subtitles from Anime Tosho.";
/** The tracks step says this while the NAS fetches and lines up a pick. */
export const LINING_UP = 'Lining up…';
/** Another playlist plays than the one the search listed for: the pick isn't lined up on it. */
export const EPISODE_CHANGED = 'This episode changed; search again.';

/** The longest track name a place keeps (server/src/playback-store.ts refuses longer). */
export const MAX_TRACK_NAME = 256;

/** The release a pick was listed from and its track's name as `toshoRelease` lists it, kept in the place. */
export interface FansubOrigin { readonly releaseId: number; readonly trackName: string }

/** One file of a release as the NAS lists it. */
export type ToshoFile = ToshoReleaseFiles['files'][number];
/** One subtitle track of a release's file. */
export type ToshoTrack = ToshoFile['tracks'][number];

/** The search box's first words: the title's display name, else the disc's name without its bracketed tags. */
export function defaultQuery(titleName: string | null, discName: string): string {
  const title = titleName?.trim() ?? '';
  if (title !== '') return title;
  const bare = discName.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return bare !== '' ? bare : discName.trim();
}

/** A release's row: its title, and a SeaDex badge when SeaDex lists it ("SeaDex best" on its best). */
export function releaseLabel(r: ToshoSearchResult): { text: string; badge: 'SeaDex best' | 'SeaDex' | null } {
  return { text: r.title, badge: r.seadex === 'best' ? 'SeaDex best' : r.seadex !== null ? 'SeaDex' : null };
}

/** A release's date (Anime Tosho's seconds), as YYYY-MM-DD in UTC. */
export function releaseDate(r: ToshoSearchResult): string {
  return new Date(r.date * 1000).toISOString().slice(0, 10);
}

const isEnglish = (language: string): boolean => {
  const l = language.trim().toLowerCase();
  return l === 'eng' || l === 'en' || l.startsWith('en-');
};

/** English first, then by language name, then by track number (a copy). */
export function sortTracks<T extends Pick<ToshoTrack, 'track' | 'language'>>(tracks: readonly T[]): T[] {
  const name = (t: T): string => languageName(t.language) || t.language;
  return [...tracks].sort((a, b) => Number(isEnglish(b.language)) - Number(isEnglish(a.language)) || name(a).localeCompare(name(b)) || a.track - b.track);
}

/**
 * A track's name as a place keeps it: the name `toshoRelease` lists (empty for an unnamed track, never the NAS's
 * language fallback), clipped to MAX_TRACK_NAME, so Up next finds the track again with `sameTrack`.
 */
export function placeTrackName(name: string): string {
  return name.slice(0, MAX_TRACK_NAME);
}

/** Whether a listed track is the one a place names (`placeTrackName` on both sides). */
export function sameTrack(t: ToshoTrack, trackName: string): boolean {
  return placeTrackName(t.name) === trackName;
}

/** "English · Full"; the language or the name alone when the other is missing. */
export function trackLabel(t: ToshoTrack): string {
  return [languageName(t.language) || t.language.trim(), t.name.trim()].filter((s) => s !== '').join(' · ');
}

/** A file's row when no file matched the episode: its episode number, else its name. */
export function fileLabel(f: ToshoFile): string {
  return f.episode !== null ? `Episode ${f.episode}` : f.name;
}
