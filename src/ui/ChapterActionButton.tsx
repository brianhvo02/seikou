// SPDX-License-Identifier: LGPL-3.0-or-later
import type { ReactElement } from 'react';
import { CHAPTER_ACTION_LABEL, type ChapterAction } from './chapter-actions';
import { NextEpisodeButton } from './NextEpisodeButton';

interface ChapterActionButtonProps {
  readonly action: ChapterAction;
  /** The person's Next episode countdown (off until the NAS has said). */
  readonly countdown: boolean;
  readonly paused: boolean;
  onSkip(toUs: number): void;
  onNext(): void;
}

/**
 * Skip opening, Skip ending or Next episode, at the bottom right of the picture above the control bar, clear of the
 * subtitles, which sit at the bottom centre.
 */
export function ChapterActionButton({ action, countdown, paused, onSkip, onNext }: ChapterActionButtonProps): ReactElement {
  if (action.kind === 'next-episode') {
    return <NextEpisodeButton countdown={countdown} seconds={10} paused={paused} onNext={onNext} onCancel={() => undefined} />;
  }
  return (
    <div className="chapter-action">
      <button type="button" className="chapter-action-button" data-testid="skip-chapter" data-kind={action.kind} onClick={() => onSkip(action.toUs)}>
        <span className="chapter-action-label">{CHAPTER_ACTION_LABEL[action.kind]}</span>
      </button>
    </div>
  );
}
