// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef, useState, type ReactElement } from 'react';

/** How often the countdown steps. */
const TICK_MS = 100;

interface NextEpisodeButtonProps {
  /** The person's "Next episode countdown" setting: the button drains and then starts the next episode by itself. */
  readonly countdown: boolean;
  readonly seconds: 10;
  /** The countdown holds while this is true: playback paused, buffering or loading (countdownHeld). */
  readonly held?: boolean;
  onNext(): void;
  onCancel(): void;
  /** Seconds as words instead of a draining fill; read from `prefers-reduced-motion` when absent. */
  readonly reducedMotion?: boolean;
}

/** Whether the viewer asked for less motion; false where it can't be read. */
function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * "Next episode" at the end of an encoded episode. With the countdown on, its fill drains over `seconds` (holding
 * while `held`) and `onNext` runs when it is empty; Cancel beside it stops the countdown and leaves the button. With reduced
 * motion the seconds left are counted in the label instead. Without the countdown it is a plain button.
 */
export function NextEpisodeButton({ countdown, seconds, held = false, onNext, onCancel, reducedMotion }: NextEpisodeButtonProps): ReactElement {
  const totalMs = seconds * 1000;
  const [leftMs, setLeftMs] = useState(totalMs);
  const [cancelled, setCancelled] = useState(false);
  const [done, setDone] = useState(false);
  const [motionless] = useState(() => reducedMotion ?? prefersReducedMotion());
  const next = useRef(onNext);
  next.current = onNext;
  const running = countdown && !cancelled && !done;

  useEffect(() => {
    if (!running || held) return;
    const id = window.setInterval(() => setLeftMs((ms) => Math.max(0, ms - TICK_MS)), TICK_MS);
    return () => window.clearInterval(id);
  }, [running, held]);

  useEffect(() => {
    if (!running || leftMs > 0) return;
    setDone(true);
    next.current();
  }, [running, leftMs]);

  const go = (): void => {
    setDone(true);
    onNext();
  };
  const cancel = (): void => {
    setCancelled(true);
    onCancel();
  };
  const left = Math.ceil(leftMs / 1000);
  return (
    <div className="chapter-action next-episode" data-testid="next-episode-action">
      <button type="button" className="chapter-action-button" data-testid="next-episode" onClick={go} aria-label={running ? `Next episode in ${left} seconds` : undefined}>
        {running && !motionless && <span className="next-episode-fill" data-testid="next-episode-fill" aria-hidden="true" style={{ transform: `scaleX(${leftMs / totalMs})` }} />}
        <span className="chapter-action-label">{running && motionless ? `Next episode in ${left}` : 'Next episode'}</span>
      </button>
      {running && (
        <button type="button" className="chapter-action-cancel" aria-label="Cancel next episode countdown" onClick={cancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
