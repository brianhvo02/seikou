// SPDX-License-Identifier: LGPL-3.0-or-later
/** Pure helpers of the line-up step: the words for a timing, time formats, and where an episode's preview starts. */
import type { FansubAlignment } from '../api-types';
import type { EpisodeChoice, EpisodeTiming } from '../helper-model';

/** A nudge step of the bracket keys and the coarse buttons: about one frame at 24 fps. */
export const NUDGE_FRAME_MS = 42;
/** A nudge step of the braced keys (`{`, `}`) and the fine buttons. */
export const NUDGE_FINE_MS = 10;
/** The engine keeps a subtitle file's offset within this many milliseconds either way; the nudge stays inside it. */
export const MAX_NUDGE_MS = 600_000;

/** The nudge the keys stand for: `]` and `[` a frame either way, `}` and `{` 10 ms; null for any other key. */
export function nudgeForKey(key: string): number | null {
  switch (key) {
    case ']':
      return NUDGE_FRAME_MS;
    case '[':
      return -NUDGE_FRAME_MS;
    case '}':
      return NUDGE_FINE_MS;
    case '{':
      return -NUDGE_FINE_MS;
    default:
      return null;
  }
}

/** `+1.20 s` or `−0.84 s` (a true minus sign): seconds with two decimals, signed. */
export function formatShift(ms: number): string {
  const text = `${(Math.abs(ms) / 1000).toFixed(2)} s`;
  return ms < 0 ? `−${text}` : `+${text}`;
}

/** `+0.032 s`: the nudge, to the millisecond, signed; `0.000 s` when there is none. */
export function formatNudge(ms: number): string {
  const text = `${(Math.abs(ms) / 1000).toFixed(3)} s`;
  return ms === 0 ? text : ms < 0 ? `−${text}` : `+${text}`;
}

/** `m:ss`, or `h:mm:ss` from an hour on, for a time in milliseconds (rounded down to the second). */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * The timing in words: `Shifted +1.20 s, confident`, `Split at 12:04: +1.20 s, then +0.84 s`, `Could not line up: too
 * little dialogue` or `…: not confident`, and the release's own timing. Lining up answers an offset or a split only
 * when it is sure of it, which is why those always read as confident.
 */
export function describeAlignment(alignment: FansubAlignment): string {
  switch (alignment.kind) {
    case 'offset':
      return `Shifted ${formatShift(alignment.offsetMs)}, confident`;
    case 'split': {
      const parts = [...alignment.parts].sort((a, b) => a.fromMs - b.fromMs);
      const at = parts.find((p) => p.fromMs > 0)?.fromMs ?? 0;
      return `Split at ${clock(at)}: ${parts.map((p) => formatShift(p.offsetMs)).join(', then ')}`;
    }
    case 'none':
      return `Could not line up: ${alignment.reason === 'no-speech' ? 'too little dialogue' : 'not confident'}`;
    case 'original':
      return "Using the release's own timing";
  }
}

/**
 * The timing the preview's track is fetched with: what lining up found when it moves the track (offset or split),
 * else the release's own timing. The nudge is never part of it; the engine applies that as the file's offset.
 */
export function previewTiming(alignment: FansubAlignment | undefined): FansubAlignment {
  return alignment && (alignment.kind === 'offset' || alignment.kind === 'split') ? alignment : { kind: 'original' };
}

/**
 * The start of the earliest `Dialogue:` event of an ASS script, in milliseconds, or null when it has none. For a
 * preview without lining up, which has no dialogue spans from the backend to start at.
 */
export function firstDialogueMs(script: string): number | null {
  let first: number | null = null;
  for (const m of script.matchAll(/^Dialogue:\s*[^,]*,\s*(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,2})/gm)) {
    const ms = ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) * 10;
    if (first === null || ms < first) first = ms;
  }
  return first;
}

/** How an episode stands, as its line in the episode list says it. */
export function episodeStatus(choice: EpisodeChoice | undefined, timing: EpisodeTiming | undefined): string {
  if (choice === 'none') return 'No subtitles';
  if (timing?.accepted) return 'Accepted';
  return 'To check';
}

/** Whether an episode has tracks to line up: a choice of at least one track, not "no subtitles". */
function hasTracks(choice: EpisodeChoice | undefined): boolean {
  return choice !== undefined && choice !== 'none' && choice.trackIds.length > 0;
}

/** Whether any episode in `order` other than `from` still has tracks waiting to be accepted. */
export function othersToCheck(
  order: readonly number[],
  from: number,
  choices: Readonly<Record<number, EpisodeChoice>>,
  timing: Readonly<Record<number, EpisodeTiming>>,
): boolean {
  return order.some((n) => n !== from && hasTracks(choices[n]) && !timing[n]?.accepted);
}

/** Whether every episode in `order` that has tracks is accepted: nothing is left to line up. */
export function allLinedUp(
  order: readonly number[],
  choices: Readonly<Record<number, EpisodeChoice>>,
  timing: Readonly<Record<number, EpisodeTiming>>,
): boolean {
  return order.every((n) => !hasTracks(choices[n]) || timing[n]?.accepted === true);
}

/**
 * The episode to show after `from` is accepted or skipped: the next one in `order` that has tracks and is not
 * accepted yet, looking past the end back to the start; `from` itself when there is none.
 */
export function nextEpisode(
  order: readonly number[],
  from: number,
  choices: Readonly<Record<number, EpisodeChoice>>,
  timing: Readonly<Record<number, EpisodeTiming>>,
): number {
  const at = order.indexOf(from);
  for (let i = 1; i < order.length; i++) {
    const n = order[(at + i) % order.length]!;
    const choice = choices[n];
    if (choice !== undefined && choice !== 'none' && choice.trackIds.length > 0 && !timing[n]?.accepted) return n;
  }
  return from;
}
