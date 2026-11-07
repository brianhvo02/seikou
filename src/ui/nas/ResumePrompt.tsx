import type { ReactElement } from 'react';
import type { PlaybackPlace } from '@seikou/nas/nas-api';
import { promptLines } from '../place-model';
import { DISC_CHANGED_COPY } from './resume-model';

interface ResumePromptProps {
  readonly place: PlaybackPlace;
  /** The place no longer fits the disc: only Start from beginning, with the reason. */
  readonly changed: boolean;
  /** From a Continue watching card: Resume is the one way on, without the question. */
  readonly resumeOnly: boolean;
  readonly disabled: boolean;
  readonly nowMs: number;
  readonly onResume: () => void;
  readonly onStartOver: () => void;
}

/** Spec 2026-10-20 mockup 2: where the place stopped, on which device and when, with what, then Resume or Start from beginning. */
export function ResumePrompt({ place, changed, resumeOnly, disabled, nowMs, onResume, onStartOver }: ResumePromptProps): ReactElement {
  const lines = promptLines(place, nowMs);
  return (
    <div className="resume-prompt" data-testid="resume-prompt" role="group" aria-label={lines.heading}>
      {changed ? (
        <p className="resume-changed" data-testid="resume-changed">
          {DISC_CHANGED_COPY}
        </p>
      ) : (
        <>
          {!resumeOnly && <h4 className="resume-heading">{lines.heading}</h4>}
          <p className="resume-line">{lines.line}</p>
          {lines.details && <p className="resume-details title-muted">{lines.details}</p>}
        </>
      )}
      <div className="resume-actions">
        {!changed && (
          <button type="button" className="resume-primary" data-testid="resume-at" disabled={disabled} onClick={onResume}>
            {lines.resumeLabel}
          </button>
        )}
        {(changed || !resumeOnly) && (
          <button type="button" data-testid="resume-start-over" disabled={disabled} onClick={onStartOver}>
            Start from beginning
          </button>
        )}
      </div>
    </div>
  );
}
