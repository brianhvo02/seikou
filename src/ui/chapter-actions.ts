// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * What an encoded episode's named chapters offer at the play position: Skip opening, Skip ending or Next episode,
 * pure. Chapter names come from the MKV (the encoder writes Opening, Ending and Preview); they are matched without
 * regard to case or surrounding space.
 */
import type { PlaybackState } from '@seikou/engine/protocol';
import { formatTime } from './format';

/** The action shown at the bottom right of the picture, or null for none. */
export type ChapterAction = { readonly kind: 'skip-opening' | 'skip-ending'; readonly toUs: number } | { readonly kind: 'next-episode' };

/** The button's wording for each action. */
export const CHAPTER_ACTION_LABEL: Readonly<Record<ChapterAction['kind'], string>> = {
  'skip-opening': 'Skip opening',
  'skip-ending': 'Skip ending',
  'next-episode': 'Next episode',
};

const named = (c: { readonly name?: string } | undefined, name: string): boolean => c?.name?.trim().toLowerCase() === name;

/**
 * The action at `timeUs`: during an `Opening`, skip to the next chapter's start; during an `Ending` with a chapter after
 * it, skip to that chapter; during an `Ending` with nothing after it, or during a `Preview` that comes anywhere after an
 * `Ending`, next-episode when `hasNext` (else null). Null everywhere else, and without chapters or a length.
 */
export function chapterAction(
  chapters: readonly { readonly startUs: number; readonly name?: string }[],
  timeUs: number,
  durationUs: number,
  hasNext: boolean,
): ChapterAction | null {
  if (!(durationUs > 0) || chapters.length === 0) return null;
  let at = -1;
  for (let i = 0; i < chapters.length; i++) if (chapters[i]!.startUs <= timeUs) at = i;
  if (at < 0) return null;
  const here = chapters[at]!;
  const next = chapters[at + 1];
  if (named(here, 'opening')) return next ? { kind: 'skip-opening', toUs: next.startUs } : null;
  if (named(here, 'ending')) {
    if (next) return { kind: 'skip-ending', toUs: next.startUs };
    return hasNext ? { kind: 'next-episode' } : null;
  }
  if (named(here, 'preview') && chapters.slice(0, at).some((c) => named(c, 'ending'))) return hasNext ? { kind: 'next-episode' } : null;
  return null;
}

/** Whether the Next episode countdown holds: while playback is paused, buffering or loading. */
export function countdownHeld(engineState: PlaybackState): boolean {
  return engineState === 'paused' || engineState === 'buffering' || engineState === 'loading';
}

/** A chapter list's row: "name · m:ss", with "Chapter N" for one without a name. */
export function chapterLabel(c: { readonly index: number; readonly startUs: number; readonly name?: string }): string {
  const name = c.name?.trim();
  return `${name ? name : `Chapter ${c.index + 1}`} · ${formatTime(c.startUs)}`;
}
