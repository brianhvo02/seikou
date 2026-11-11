/** Fetching a track and naming it, shared by the fansub runs and the viewers' picks. Original code. */
import type { PacedOptions } from '@seikou/titles/pacer';
import { unxz } from './archive';
import { normalizeLanguage } from './choose';
import { dialogueIntervals } from './dialogue';
import type { FetchCache } from './fetch-cache';
import { TRACK_DOWNLOAD_BYTES } from './tosho';
import type { Tosho, ToshoTrack } from './tosho';

/** A fetched track bigger than this once unpacked is skipped. */
export const MAX_TRACK_BYTES = 50 * 1024 * 1024;

/** A track's text, through the download cache; throws `TooLargeArchive` past the cap, and the client's errors. */
export async function fetchTrack(cache: FetchCache, tosho: Tosho, track: ToshoTrack, paced: PacedOptions): Promise<string> {
  const raw = await cache.get(track.url, () => tosho.download(track.url, paced, TRACK_DOWNLOAD_BYTES));
  return (await unxz(raw, MAX_TRACK_BYTES)).toString('utf8');
}

/** The one with the most dialogue: a file's tracks share its offset (a signs track has too little to go on). */
export function mostDialogue<T extends { readonly text: string }>(tracks: readonly T[]): T {
  return tracks.reduce((a, b) => (dialogueIntervals(b.text).length > dialogueIntervals(a.text).length ? b : a));
}

const languageNames = new Intl.DisplayNames('en', { type: 'language' });
/** "English" for `eng`; the code itself when it names no language. */
export function languageName(code: string): string {
  const c = normalizeLanguage(code);
  if (c === '' || c === 'und') return code || 'Unknown';
  try {
    return languageNames.of(c) ?? code;
  } catch {
    return code;
  }
}
