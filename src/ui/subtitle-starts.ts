/** The subtitle menu's start picker: where a file of the set can start, and how a start is labelled. */
import type { Chapter } from '@seikou/engine/nav/timeline';

/** One place a subtitle file can start: its menu label and the playlist time in microseconds, or null for not placed. */
export interface StartChoice { readonly label: string; readonly startUs: number | null }

/** H:MM:SS */
export function hms(us: number): string {
  const total = Math.max(0, Math.floor(us / 1e6));
  return `${Math.floor(total / 3600)}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** The start picker's options: each episode start, each chapter, the current position (rounded down to a second) and Not placed. */
export function startChoices(episodeStarts: readonly number[], chapters: readonly Chapter[], nowUs: number): StartChoice[] {
  const now = Math.floor(nowUs / 1e6) * 1e6;
  return [
    ...episodeStarts.map((startUs, i) => ({ label: `Episode ${i + 1} · ${hms(startUs)}`, startUs })),
    ...chapters.map((c, i) => ({ label: `Chapter ${i + 1} · ${hms(c.startUs)}`, startUs: c.startUs })),
    { label: `Current position · ${hms(now)}`, startUs: now },
    { label: 'Not placed', startUs: null },
  ];
}

/** The label of a start time: the time with its episode or chapter number when it equals one, else the time; `Not placed` for null. */
export function startLabel(startUs: number | null, episodeStarts: readonly number[], chapters: readonly Chapter[]): string {
  if (startUs === null) return 'Not placed';
  const ep = episodeStarts.indexOf(startUs);
  if (ep >= 0) return `${hms(startUs)} · Episode ${ep + 1}`;
  const ch = chapters.findIndex((c) => c.startUs === startUs);
  if (ch >= 0) return `${hms(startUs)} · Chapter ${ch + 1}`;
  return hms(startUs);
}
