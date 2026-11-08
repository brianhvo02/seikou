// SPDX-License-Identifier: LGPL-3.0-or-later
import type { MkvChapter } from '@seikou/matroska';

// WebVTT (W3C WebVTT: The Web Video Text Tracks Format): the file starts with the line `WEBVTT`,
// then cues separated by blank lines. A cue is an optional identifier line, a timing line
// `hh:mm:ss.ttt --> hh:mm:ss.ttt`, then its text. A chapters track (kind="chapters") has one cue
// per chapter whose text is the chapter's title. In cue text `&`, `<` and `>` are written as
// character references, and a cue's text must not hold a blank line (which ends the cue)
// or `-->`; escaping `>` and joining lines covers both.

function timestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const pad = (n: number, w: number): string => String(n).padStart(w, '0');
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor(total / 60_000) % 60;
  const s = Math.floor(total / 1000) % 60;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(total % 1000, 3)}`;
}

function cueText(title: string): string {
  return title
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The WebVTT chapters file for `chapters` (sorted by start) of an episode that lasts `durationMs`:
 * one cue per chapter, numbered from 1, from its start to the next chapter's start, the last one to
 * `durationMs`. Times are rounded to whole milliseconds. Chapters that start at or after
 * `durationMs` are left out, since a cue must end after it starts. Without chapters the file is just
 * the `WEBVTT` line.
 */
export function toVtt(chapters: readonly MkvChapter[], durationMs: number): string {
  const lines = ['WEBVTT'];
  const kept = chapters.filter((c) => Number(c.startNs) / 1e6 < durationMs);
  kept.forEach((c, i) => {
    const start = Number(c.startNs) / 1e6;
    const next = kept[i + 1];
    const end = next === undefined ? durationMs : Number(next.startNs) / 1e6;
    lines.push('', String(i + 1), `${timestamp(start)} --> ${timestamp(end)}`, cueText(c.title));
  });
  return `${lines.join('\n')}\n`;
}
