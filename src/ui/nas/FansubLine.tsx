import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { FansubTitleState } from '@seikou/nas/nas-api';
import { forgetFansubDeletion, fansubsDeletedHere, runButtonLabel, seasonLine } from './fansub-model';
import { subtitleErrorMessage } from './subtitle-model';
import { NasHttpError, type NasClient } from './nas-client';

/** How often the line asks for the run's state while one goes. */
const POLL_MS = 3000;

interface FansubLineProps {
  readonly nas: Pick<NasClient, 'fansubTitle' | 'runFansubs' | 'undeleteFansubs'>;
  readonly titleId: string;
  readonly seasonId: string;
  /** A run finished (or a run's answer changed what is stored): the screen fetches the subtitles again. */
  readonly onChanged: () => void;
  /** Every state the line learns, for the screen's episode marks. */
  readonly onState?: (state: FansubTitleState) => void;
}

/** The owner's line above a season's episodes: which release it uses, when it was checked, and the run button. */
export function FansubLine({ nas, titleId, seasonId, onChanged, onState }: FansubLineProps): ReactElement | null {
  const [state, setState] = useState<FansubTitleState | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callbacks = useRef({ onChanged, onState });
  callbacks.current = { onChanged, onState };
  const wasRunning = useRef(false);

  const accept = useCallback((next: FansubTitleState): void => {
    setState(next);
    callbacks.current.onState?.(next);
    if (wasRunning.current && !next.running) callbacks.current.onChanged();
    wasRunning.current = next.running;
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      accept(await nas.fansubTitle(titleId));
    } catch {
      // the line stays as it was; the next poll or press tries again
    }
  }, [nas, titleId, accept]);

  useEffect(() => {
    let live = true;
    nas.fansubTitle(titleId).then((s) => live && accept(s), () => {});
    return () => {
      live = false;
    };
  }, [nas, titleId, accept]);

  const running = state?.running === true;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const run = async (bringBack: boolean): Promise<void> => {
    setAsking(false);
    setBusy(true);
    setError(null);
    try {
      if (bringBack) await nas.undeleteFansubs(titleId);
      const next = await nas.runFansubs(titleId);
      forgetFansubDeletion(titleId);
      wasRunning.current = true; // so a run that is over by its answer still tells the screen
      accept(next);
    } catch (err) {
      if (err instanceof NasHttpError && err.status === 409 && err.code === 'running') void load();
      else setError(err instanceof NasHttpError ? subtitleErrorMessage(err) : "Couldn't start the fansub run.");
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;
  const text = seasonLine(state, seasonId, Date.now()) ?? (state.nothingFound ? 'Fansubs: none found for this title' : state.lastRunAt === null ? 'Fansubs: not looked for yet' : 'Fansubs: none attached');
  const onPress = (): void => {
    if (state.lastRunAt !== null && fansubsDeletedHere(titleId)) setAsking(true);
    else void run(false);
  };
  return (
    <div className="fansub-line" data-testid="fansub-line">
      <div className="fansub-line-main">
        <span className="fansub-line-text">{text}</span>
        {/* live while a run goes: pressing it hurries a nightly run that waits for the NAS to be idle */}
        <button type="button" data-testid="fansub-run" disabled={busy} onClick={onPress}>
          {runButtonLabel(state)}
        </button>
      </div>
      {asking && (
        <div className="admin-confirm-box" role="group" aria-label="Find fansubs again">
          <p>Bring back the tracks you deleted?</p>
          <span className="admin-confirm">
            <button type="button" data-testid="fansub-undelete-yes" onClick={() => void run(true)}>Yes</button>
            <button type="button" data-testid="fansub-undelete-no" onClick={() => void run(false)}>No</button>
          </span>
        </div>
      )}
      {error !== null && <p className="owner-message" role="alert">{error}</p>}
    </div>
  );
}
