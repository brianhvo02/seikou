// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ChapterInfo } from '../api-types';
import { formatLength } from './DiscPage';
import type { EpisodeRange, Grouping } from './grouping';

/** What the list needs: the chapters, how they are grouped, and what a click or a toggle does. */
export interface ChapterListProps {
  /** The playlist's chapters in order. */
  readonly chapters: readonly ChapterInfo[];
  /** The grouping on screen: its splits and skipped chapters are the toggles' states. */
  readonly grouping: Grouping;
  /** The episodes the grouping makes; each is marked on its first chapter. */
  readonly episodes: readonly EpisodeRange[];
  /** The chapter (1-based) the player is in, marked in the list; null when none is. */
  readonly currentIndex: number | null;
  /** A chapter was clicked: show the playlist from its start. */
  readonly onSeek: (chapter: ChapterInfo) => void;
  /** The "split after" toggle of chapter `n` (1-based) was changed. */
  readonly onToggleSplit: (n: number) => void;
  /** The "skip" toggle of chapter `n` (1-based) was changed. */
  readonly onToggleSkip: (n: number) => void;
}

/**
 * The playlist's chapters, one row each: the chapter's number, start and length (a button that shows the playlist from
 * there), a toggle that cuts the episode after it (not on the last chapter) and one that leaves it out of every
 * episode. The first chapter of each episode carries the episode's number, and the row of the chapter being played is marked.
 */
export function ChapterList({ chapters, grouping, episodes, currentIndex, onSeek, onToggleSplit, onToggleSkip }: ChapterListProps) {
  const episodeStartingAt = new Map(episodes.map((e, i) => [e.from, i + 1]));
  return (
    <ol className="chapter-list" aria-label="Chapters">
      {chapters.map((c, i) => {
        const skipped = grouping.skipped.has(c.index);
        const last = i === chapters.length - 1;
        const starts = episodeStartingAt.get(c.index);
        return (
          <li
            key={c.index}
            className={`chapter${skipped ? ' chapter-skipped' : ''}${c.index === currentIndex ? ' chapter-current' : ''}`}
            aria-current={c.index === currentIndex ? 'true' : undefined}
          >
            <button
              type="button"
              className="chapter-seek"
              aria-label={`Chapter ${c.index}, starts at ${formatLength(c.startMs)}`}
              onClick={() => onSeek(c)}
            >
              <span className="chapter-number num">{c.index}</span>
              <span className="chapter-start num">{formatLength(c.startMs)}</span>
              <span className="chapter-length num muted">{formatLength(c.lengthMs)}</span>
            </button>
            <span className="chapter-mark mark">{starts !== undefined ? `Episode ${starts}` : ''}</span>
            <label className="chapter-toggle">
              <input type="checkbox" checked={skipped} aria-label={`Skip chapter ${c.index}`} onChange={() => onToggleSkip(c.index)} />
              <span>Skip</span>
            </label>
            {last ? (
              <span className="chapter-toggle" aria-hidden="true" />
            ) : (
              <label className="chapter-toggle">
                <input
                  type="checkbox"
                  checked={grouping.splits.has(c.index)}
                  aria-label={`Split after chapter ${c.index}`}
                  onChange={() => onToggleSplit(c.index)}
                />
                <span>Split after</span>
              </label>
            )}
          </li>
        );
      })}
    </ol>
  );
}
