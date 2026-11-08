// SPDX-License-Identifier: LGPL-3.0-or-later
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { HelperApi } from './api';
import type { EpisodesAnswer, SessionInfo } from './api-types';
import { useEpisodeTitles } from './episode-titles';
import { canEnter, initialState, metadataDefaults, reduce, type Step } from './helper-model';
import { MetadataPanel } from './metadata/MetadataPanel';
import { useController } from './player/use-controller';
import { SaveBar } from './SaveBar';
import { useStepHistory } from './step-history';
import { STEP_NAMES, StepBar } from './StepBar';
import { LineUpStep, type LineUpStepProps } from './steps/LineUpStep';
import { MatchStep } from './steps/MatchStep';
import { ReleaseStep } from './steps/ReleaseStep';

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

/** The guidance each step shows until its own screen is in place. */
const STEP_HINTS: Readonly<Record<Step, string>> = {
  1: 'Search AniList for the show, then pick a release from SeaDex, search Anime Tosho, or add your own files.',
  2: 'Check which release file goes with each episode, and which of its tracks to keep.',
  3: "Line each episode's subtitles up with the disc's audio and check them in the player.",
};

/** Step 3 with the page's engine, which is made only once the step is first shown. */
function LineUpScreen(props: Omit<LineUpStepProps, 'controller'>) {
  const controller = useController();
  return <LineUpStep {...props} controller={controller} />;
}

/**
 * The helper page: a header with the disc's name, the step bar, Details and Save for encoding, and below it the step
 * on screen. It asks the backend for the session and the episodes on mount (a failure shows as an alert), and keeps
 * the metadata draft's defaults in step with the show, the release, the chosen tracks and AniList's episode titles.
 */
export function App({ api }: AppProps) {
  const [state, dispatch] = useReducer(reduce, initialState());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.session(), api.episodes()]).then(
      ([session, episodes]) => {
        if (!live) return;
        setLoaded({ session, episodes });
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

  // the metadata defaults follow the show, the release, the chosen tracks and AniList's episode titles; the fields
  // the user edited keep their values
  const titles = useEpisodeTitles(api, state.title?.alId ?? null);
  const { title, releases, choices } = state;
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (loaded === null) return;
    dispatch({ type: 'fillDefaults', defaults: metadataDefaults(stateRef.current, loaded.episodes, titles) });
  }, [loaded, title, releases, choices, titles]);

  const goTo = useCallback((step: Step) => dispatch({ type: 'goTo', step }), []);
  useStepHistory(state.step, (s) => canEnter(stateRef.current, s), goTo);

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
          <StepBar step={state.step} canEnter={(s) => canEnter(state, s)} onSelect={goTo} />
          <SaveBar api={api} state={state} dispatch={dispatch} session={loaded?.session ?? null} episodes={loaded?.episodes ?? null}>
            <button ref={detailsButton} type="button" className="quiet" disabled={!loaded} onClick={() => setDetailsOpen(true)}>
              Details
            </button>
          </SaveBar>
        </div>
      </header>

      <main className="content">
        {loadError !== null ? (
          <p className="error" role="alert">
            The helper could not load this disc. {loadError}
          </p>
        ) : state.step === 1 && loaded ? (
          <ReleaseStep api={api} state={state} dispatch={dispatch} />
        ) : state.step === 2 && loaded ? (
          <MatchStep api={api} state={state} dispatch={dispatch} episodes={loaded.episodes} />
        ) : state.step === 3 && loaded ? (
          <LineUpScreen api={api} state={state} dispatch={dispatch} session={loaded.session} episodes={loaded.episodes} />
        ) : (
          <section aria-labelledby="step-heading">
            <h2 id="step-heading">{STEP_NAMES[state.step]}</h2>
            <p className="muted">{STEP_HINTS[state.step]}</p>
          </section>
        )}
      </main>

      {detailsOpen && loaded && <MetadataPanel state={state} dispatch={dispatch} episodes={loaded.episodes} onClose={closeDetails} />}
    </div>
  );
}
