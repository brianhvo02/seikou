// SPDX-License-Identifier: LGPL-3.0-or-later
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { HelperApi } from './api';
import type { EpisodesAnswer, SessionInfo } from './api-types';
import { canEnter, initialState, reduce, toRecord, type HelperAction, type HelperState, type Step } from './helper-model';
import { defaultMetadata } from './metadata/metadata-model';
import { STEP_NAMES, StepBar } from './StepBar';

/** What the page needs: the backend client, made by the entry point from the run's token. */
export interface AppProps {
  /** The backend client. */
  readonly api: HelperApi;
}

/** What the page has learned about the run, once both first requests have answered. */
interface Loaded {
  readonly session: SessionInfo;
  readonly episodes: EpisodesAnswer;
}

/** The number of episodes an episode spec names: one per comma-separated range. */
function episodeCount(spec: string): number {
  return spec.split(',').filter((t) => t.trim() !== '').length;
}

/** The state the page starts from once the run is known: nothing picked, the metadata at its defaults. */
function startingState(episodes: EpisodesAnswer): HelperState {
  const metadata = defaultMetadata({
    show: null,
    episodes: episodes.episodes.map((e) => ({ index: e.index, title: null, chapterCount: e.chapters.length })),
    audio: episodes.audio,
    tracks: {},
  });
  return { ...initialState(), metadata };
}

/** The guidance each step shows until its own screen is in place. */
const STEP_HINTS: Readonly<Record<Step, string>> = {
  1: 'Search AniList for the show, then pick a release from SeaDex, search Anime Tosho, or add your own files.',
  2: 'Check which release file goes with each episode, and which of its tracks to keep.',
  3: "Line each episode's subtitles up with the disc's audio and check them in the player.",
};

/** The Details sheet: names and languages written into each episode's file. */
function DetailsPanel({ state, onClose }: { state: HelperState; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const episodes = Object.values(state.metadata.episodes).sort((a, b) => a.index - b.index);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className="sheet" role="dialog" aria-modal="true" aria-labelledby="details-heading" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <h2 id="details-heading">Details</h2>
          <button ref={closeRef} type="button" className="quiet" aria-label="Close details" onClick={onClose}>
            Close
          </button>
        </header>
        <p className="muted">The titles, track names and languages written into each episode's file.</p>
        <ol className="episode-titles">
          {episodes.map((e) => (
            <li key={e.index} className="num">
              {e.title}
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}

/**
 * The helper page: a header with the disc's name, the step bar, Details and Save for encoding, and below it the step
 * on screen. It asks the backend for the session and the episodes on mount; a failure shows as an alert.
 */
export function App({ api }: AppProps) {
  const [state, dispatch] = useReducer(reduce, initialState());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const detailsButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.session(), api.episodes()]).then(
      ([session, episodes]) => {
        if (!live) return;
        setLoaded({ session, episodes });
        dispatch({ type: 'load', state: startingState(episodes) });
      },
      (e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  const closeDetails = useCallback(() => {
    setDetailsOpen(false);
    detailsButton.current?.focus();
  }, []);

  const save = async () => {
    if (!loaded) return;
    setSaving(true);
    try {
      const stored = await api.saveRecord(toRecord(state, loaded.session, loaded.episodes));
      dispatch({ type: 'saved' } satisfies HelperAction);
      const time = new Date(stored.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      setSaveStatus({ ok: true, text: `Saved at ${time}` });
    } catch (e) {
      setSaveStatus({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const session = loaded?.session;
  const count = session ? episodeCount(session.episodeSpec) : 0;

  return (
    <div className="page">
      <header className="top">
        <div className="disc">
          <h1>{session ? session.label : 'Subtitle helper'}</h1>
          {session && (
            <p className="muted">
              {count} {count === 1 ? 'episode' : 'episodes'} from playlist <span className="num">{session.playlistId}</span>
            </p>
          )}
        </div>
        <div className="bar">
          <StepBar step={state.step} canEnter={(s) => canEnter(state, s)} onSelect={(s) => dispatch({ type: 'goTo', step: s })} />
          <div className="actions">
            <button ref={detailsButton} type="button" className="quiet" disabled={!loaded} onClick={() => setDetailsOpen(true)}>
              Details
            </button>
            <button type="button" className="primary" disabled={!loaded || saving} onClick={() => void save()}>
              Save for encoding
            </button>
          </div>
        </div>
        {saveStatus && (
          <p className={saveStatus.ok ? 'save-status muted' : 'save-status error'} role="status">
            {saveStatus.text}
          </p>
        )}
      </header>

      <main className="content">
        {loadError !== null ? (
          <p className="error" role="alert">
            The helper could not load this disc. {loadError}
          </p>
        ) : (
          <section aria-labelledby="step-heading">
            <h2 id="step-heading">{STEP_NAMES[state.step]}</h2>
            <p className="muted">{STEP_HINTS[state.step]}</p>
          </section>
        )}
      </main>

      {detailsOpen && <DetailsPanel state={state} onClose={closeDetails} />}
    </div>
  );
}
