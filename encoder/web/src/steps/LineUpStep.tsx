// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef, useState, useSyncExternalStore, type Dispatch } from 'react';
import { ApiError, type HelperApi } from '../api';
import type { AlignAnswer, CachedRelease, EpisodesAnswer, FansubAlignment, FetchProgress, SessionInfo } from '../api-types';
import { episodeFile, type HelperAction, type HelperState, type LineUpChoice } from '../helper-model';
import { Player } from '../player/Player';
import { showAt, type PlayerLike } from '../player/use-controller';
import { AlignmentStrip } from '../strip/AlignmentStrip';
import { shiftAt } from '../strip/strip-geometry';
import {
  describeAlignment,
  episodeStatus,
  formatNudge,
  MAX_NUDGE_MS,
  allLinedUp,
  nextEpisode,
  othersToCheck,
  previousEpisode,
  NUDGE_FINE_MS,
  NUDGE_FRAME_MS,
  nudgeForKey,
  previewTiming,
  firstDialogueMs,
  sessionKey,
} from './lineup-model';

/** What step 3 needs. */
export interface LineUpStepProps {
  /** The backend client: lining up, the retimed tracks, the fonts and the disc. */
  readonly api: HelperApi;
  /** The page's state; the step reads the choices, the pooled releases their files come from, and the timings. */
  readonly state: HelperState;
  /** Applies an action to the page's state (timings, nudges, accept, skip, and Back to the Episodes step). */
  readonly dispatch: Dispatch<HelperAction>;
  /** The run: its disc key, playlist and whether lining up can run here. */
  readonly session: SessionInfo;
  /** The run's episodes in playlist time. */
  readonly episodes: EpisodesAnswer;
  /** The page's engine (`useController`), or a stand-in in tests. */
  readonly controller: PlayerLike;
}

/** Where lining an episode's file up stands: running, answered, or not possible. */
type LineUp =
  | { readonly status: 'working' }
  | { readonly status: 'done'; readonly answer: AlignAnswer }
  | { readonly status: 'tools-missing' }
  | { readonly status: 'failed'; readonly message: string };

/** How often a running line-up is asked what it fetches from the NAS. */
const FETCH_POLL_MS = 1000;

/** Bytes as megabytes for the fetch line: one decimal under 10 MB, whole above. */
function megabytes(n: number): string {
  const mb = n / 1_000_000;
  return mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
}

/** What the step says when lining up cannot run on this machine. */
const TOOLS_MESSAGE = "Lining up needs VapourSynth with BestSource, which this machine does not have. The preview uses the release's own timing.";

/** Input types that take no typed text, so the nudge keys still work while one of them has focus. */
const NOT_TYPED_INTO = new Set(['radio', 'checkbox', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image']);

/** A name the engine accepts as an ASS file: the track's name with path separators taken out. */
function trackFileName(episode: number, name: string, id: string): string {
  const base = (name.trim() || `Track ${id}`).replace(/[\\/]/g, ' ');
  return `Episode ${episode} - ${base}.ass`;
}

/** The text at `url`, or a rejection naming the HTTP status. */
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The helper answered ${res.status} for the subtitle track.`);
  return res.text();
}

/** A release's fonts as files named as the release names them. */
async function fetchFonts(api: HelperApi, release: CachedRelease): Promise<File[]> {
  return Promise.all(
    release.fonts.map(async (font) => {
      const res = await fetch(api.fontUrl(release.key, font.name));
      if (!res.ok) throw new Error(`The helper answered ${res.status} for the font ${font.name}.`);
      return new File([await res.blob()], font.name);
    }),
  );
}

/**
 * Step 3's question, asked once per session before the first line-up: line the episodes up against the disc's audio,
 * or use the release's own timing. It must be answered: Escape and a click beside it do nothing, focus starts on Line
 * up and Tab stays between the two buttons.
 */
function LineUpQuestion({ onAnswer }: { readonly onAnswer: (choice: LineUpChoice) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        return;
      }
      if (e.key !== 'Tab' || box.current === null) return;
      const buttons = [...box.current.querySelectorAll('button')];
      if (buttons.length === 0) return;
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = at === -1 ? 0 : (at + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length;
      e.preventDefault();
      buttons[next]?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="question-backdrop">
      <div ref={box} className="question" role="alertdialog" aria-modal="true" aria-labelledby="lineup-question-title" aria-describedby="lineup-question-text">
        <h2 id="lineup-question-title">Line up the subtitles against the disc's audio?</h2>
        <p id="lineup-question-text" className="muted">
          Lining up finds where the release's subtitles fall against the disc's speech, one episode at a time. It can take a while, and for a disc
          on the NAS each episode's clips are downloaded first.
        </p>
        <div className="question-actions">
          <button ref={first} type="button" className="primary" onClick={() => onAnswer('line-up')}>
            Line up
          </button>
          <button type="button" className="quiet" onClick={() => onAnswer('original')}>
            Use the release's timing
          </button>
        </div>
      </div>
    </div>
  );
}

/** The nudge as the engine can hold it: the file offset stays within ten minutes either way. */
function clampNudge(ms: number): number {
  return Math.max(-MAX_NUDGE_MS, Math.min(MAX_NUDGE_MS, ms));
}

/**
 * Step 3, one episode at a time. The first time an episode would be lined up in a helper session, a question asks
 * whether to line up against the disc's audio or use the release's own timing (`LineUpQuestion`); nothing is lined up,
 * fetched or opened until it is answered, and the answer covers the session's other episodes. With Line up, each
 * episode's track is lined up against the disc's audio as it is shown (the backend picks the track
 * with the most dialogue, and its timing applies to every track of the episode); with the release's timing, each
 * episode previews at that timing and "Line up this episode" lines up that one alone (shown once the session has
 * an answer, restored episodes included; lining an accepted episode up again leaves it to be accepted again). An
 * episode whose timing is already there (restored from the record) is not a reason to ask. After the answer, focus
 * moves to the episode's heading (Line up) or to "Line up this episode" (the release's timing). The step says what lining up found, and plays the
 * episode in Seikou's engine with the retimed track and the release's fonts. The nudge (`[` `]` by 42 ms, `{` `}` by
 * 10 ms, or the buttons) moves the subtitles live and slides the strip's lower lane. "Accept, next episode", "Use
 * original timing" and "Skip" settle the episode. Each episode uses the file and fonts of its own release
 * (`episodeFile`), so episodes from different releases line up and preview against their own. "Previous episode"
 * returns to the episode before in the list with its timing and nudge as they were, and "Back" goes to the Episodes
 * step. Without VapourSynth it neither asks nor lines up, and previews at the release's own timing.
 */
export function LineUpStep({ api, state, dispatch, session, episodes, controller }: LineUpStepProps) {
  const order = episodes.episodes.filter((e) => state.choices[e.index] !== undefined).map((e) => e.index);
  const [picked, setPicked] = useState<number | null>(() => {
    const open = order.find((n) => {
      const c = state.choices[n];
      return c !== undefined && c !== 'none' && !state.timing[n]?.accepted;
    });
    return open ?? order[0] ?? null;
  });
  const shown = picked !== null && order.includes(picked) ? picked : (order[0] ?? null);
  const [lineups, setLineups] = useState<Readonly<Record<string, LineUp>>>({});
  const [previewTracks, setPreviewTracks] = useState<Readonly<Record<number, string>>>({});
  const [loaded, setLoaded] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  /** What the running line-up (by its key) fetches from the NAS, while it fetches. */
  const [fetching, setFetching] = useState<{ readonly key: string; readonly progress: FetchProgress } | null>(null);
  /** The line-ups (by key) asked for with "Line up this episode". */
  const [requested, setRequested] = useState<ReadonlySet<string>>(() => new Set());
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  const settled = useRef(new Set<string>());
  const fonts = useRef(new Map<string, Promise<File[]>>());
  const seekedTo = useRef<number | null>(null);
  const timingNow = useRef(state.timing);
  timingNow.current = state.timing;

  const episode = episodes.episodes.find((e) => e.index === shown) ?? null;
  const choice = shown === null ? undefined : state.choices[shown];
  // the episode's file, from whichever pooled release its choice names
  const found = shown === null ? null : episodeFile(state, shown);
  const release = found?.pooled.release ?? null;
  const file = found?.file ?? null;
  const fileId = file?.id ?? null;
  const chosen = file && choice !== undefined && choice !== 'none' ? file.tracks.filter((t) => choice.trackIds.includes(t.id)) : [];
  const hasTracks = shown !== null && release !== null && file !== null && chosen.length > 0;

  const lineKey = `${shown}:${release?.key}:${fileId}`;
  const lineup: LineUp | undefined = lineups[lineKey];
  const answer = lineup?.status === 'done' ? lineup.answer : null;
  const timing = shown === null ? undefined : state.timing[shown];
  const alignment: FansubAlignment | undefined = timing?.alignment ?? answer?.alignment;
  const fetchTiming = previewTiming(alignment);
  const nudgeMs = clampNudge(timing?.nudgeMs ?? 0);
  const asked = session.toolsReady && state.lineUpChoice?.session === sessionKey(session) ? state.lineUpChoice.choice : null;
  // whether this episode's file is lined up: by the session's answer, or asked for this episode alone
  const runs = session.toolsReady && hasTracks && (asked === 'line-up' || requested.has(lineKey));
  // the question waits for an episode that would start a line-up: one with tracks, no timing yet, and none run
  const asking = session.toolsReady && hasTracks && asked === null && timing === undefined && lineup === undefined && !settled.current.has(lineKey);
  const ready = hasTracks && !asking && (!runs || (lineup !== undefined && lineup.status !== 'working'));
  const trackId = (shown !== null ? previewTracks[shown] : undefined) ?? (answer && chosen.some((t) => t.id === answer.trackId) ? answer.trackId : chosen[0]?.id);
  const loadKey = `${lineKey}:${trackId}:${JSON.stringify(fetchTiming)}`;
  const previewing = loaded === loadKey;

  // Line the episode's file up once per episode, release and file, when the session's answer is Line up or the episode
  // alone was asked for. With the session's answer a timing already there (restored, or the release's own timing chosen
  // by hand) is kept, and the answer still feeds the strip; one asked for by hand replaces it. Choosing another file
  // drops the episode's timing, so coming back to a file lined up before puts its answer back instead of asking again.
  const byHand = requested.has(lineKey);

  // The answered question's button goes away with it: focus moves to the step's heading after Line up, and to "Line up
  // this episode" after the release's timing, once the step has drawn without the question.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lineUpOneRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<LineUpChoice | null>(null);
  useEffect(() => {
    if (focusAfter.current === null || asking) return;
    const target = focusAfter.current === 'original' ? (lineUpOneRef.current ?? headingRef.current) : headingRef.current;
    focusAfter.current = null;
    target?.focus();
  });
  const answerQuestion = (choice: LineUpChoice): void => {
    focusAfter.current = choice;
    dispatch({ type: 'chooseLineUp', session: sessionKey(session), choice });
  };
  useEffect(() => {
    if (!hasTracks || !session.toolsReady || shown === null || release === null || fileId === null) return;
    if (settled.current.has(lineKey)) {
      if (answer !== null && timingNow.current[shown] === undefined) dispatch({ type: 'setTiming', episode: shown, alignment: answer.alignment });
      return;
    }
    if (asked !== 'line-up' && !byHand) return;
    const abort = new AbortController();
    setLineups((l) => ({ ...l, [lineKey]: { status: 'working' } }));
    api.align(shown, release.key, fileId, abort.signal).then(
      (found) => {
        settled.current.add(lineKey);
        setLineups((l) => ({ ...l, [lineKey]: { status: 'done', answer: found } }));
        if (byHand || timingNow.current[shown] === undefined) dispatch({ type: 'setTiming', episode: shown, alignment: found.alignment });
      },
      (e: unknown) => {
        if (abort.signal.aborted) return;
        settled.current.add(lineKey);
        const result: LineUp = e instanceof ApiError && e.code === 'tools-missing' ? { status: 'tools-missing' } : { status: 'failed', message: e instanceof Error ? e.message : String(e) };
        setLineups((l) => ({ ...l, [lineKey]: result }));
      },
    );
    return () => abort.abort();
  }, [api, dispatch, hasTracks, session.toolsReady, shown, release, fileId, lineKey, answer, asked, byHand]);

  // While a line-up runs, ask now and every second what it fetches from the NAS: a NAS disc's clips are fetched whole
  // before the audio is decoded, which can take minutes.
  const working = lineup?.status === 'working';
  useEffect(() => {
    if (!working || shown === null) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (): void => {
      api.lineUpFetch(shown, abort.signal).then(
        (progress) => {
          if (abort.signal.aborted) return;
          setFetching(progress === null ? null : { key: lineKey, progress });
          timer = setTimeout(ask, FETCH_POLL_MS);
        },
        () => {
          if (!abort.signal.aborted) timer = setTimeout(ask, FETCH_POLL_MS);
        },
      );
    };
    ask();
    return () => {
      abort.abort();
      clearTimeout(timer);
      setFetching(null);
    };
  }, [api, working, shown, lineKey]);
  const fetchingNow = working && fetching?.key === lineKey ? fetching.progress : null;

  // Load the preview track (retimed as found) with the release's fonts, place it at the episode's start, and on a new
  // episode go to its first dialogue line. Everything is sent to the engine in order, so the track lands on the disc
  // the open or seek put on screen.
  useEffect(() => {
    if (!ready || episode === null || release === null || file === null || trackId === undefined) return;
    let live = true;
    setPreviewError(null);
    const run = async () => {
      const url = api.subtitleUrl(episode.index, release.key, file.id, trackId, fetchTiming);
      let fontFiles = fonts.current.get(release.key);
      if (!fontFiles) {
        fontFiles = fetchFonts(api, release);
        fonts.current.set(release.key, fontFiles);
        fontFiles.catch(() => fonts.current.delete(release.key));
      }
      const [script, fontList] = await Promise.all([fetchText(url), fontFiles]);
      if (!live) return;
      const name = chosen.find((t) => t.id === trackId)?.name ?? '';
      const track = new File([script], trackFileName(episode.index, name, trackId), { type: 'text/plain' });
      if (seekedTo.current !== episode.index) {
        // the backend's dialogue spans are at the release's timing; the fetched script is already retimed
        const spans = answer?.dialogue ?? [];
        const first = spans.length > 0 ? spans.reduce((a, b) => (b.fromMs < a.fromMs ? b : a)) : null;
        const firstMs = first ? first.fromMs + shiftAt(fetchTiming, first.fromMs) : (firstDialogueMs(script) ?? 0);
        const atMs = Math.max(0, Math.min(episode.durationUs / 1000 - 1000, firstMs));
        seekedTo.current = episode.index;
        await showAt(controller, api, session, episode.startUs + Math.round(atMs * 1000));
        if (!live) return;
      }
      await controller.loadSubtitleFiles([track, ...fontList]);
      if (!live) return;
      controller.setSubtitleStart(0, episode.startUs);
      setLoaded(loadKey);
    };
    run().catch((e: unknown) => {
      if (!live) return;
      seekedTo.current = null;
      setPreviewError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      live = false;
    };
    // loadKey names everything the load depends on; the objects behind it are read as they are at that render
  }, [ready, loadKey]);

  // Keep the engine's file offset at the nudge. A new track arrives at offset 0, and a key press changes the nudge;
  // either way the offset is set from the difference, so a stale snapshot only sends the same value again.
  const engineFile = snapshot.subtitles?.text?.files[0];
  const engineOffsetMs = engineFile?.offsetMs;
  useEffect(() => {
    if (!previewing || engineOffsetMs === undefined) return;
    if (engineOffsetMs !== nudgeMs) controller.shiftSubtitleFile(0, nudgeMs - engineOffsetMs);
  }, [controller, previewing, engineOffsetMs, nudgeMs]);

  const nudge = (deltaMs: number) => {
    if (shown === null || !previewing) return;
    const next = clampNudge(nudgeMs + deltaMs);
    if (next !== nudgeMs) dispatch({ type: 'nudge', episode: shown, deltaMs: next - nudgeMs });
  };
  const nudgeRef = useRef(nudge);
  nudgeRef.current = nudge;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLInputElement && !NOT_TYPED_INTO.has(t.type)) return;
      if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      if (t instanceof HTMLElement && t.isContentEditable) return;
      const delta = nudgeForKey(e.key);
      if (delta === null) return;
      e.preventDefault();
      nudgeRef.current(delta);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const moveOn = (accepted: boolean) => {
    if (shown === null) return;
    const timings = accepted && timing ? { ...state.timing, [shown]: { ...timing, accepted: true } } : state.timing;
    setPicked(nextEpisode(order, shown, state.choices, timings));
  };

  const back = (
    <button type="button" className="quiet" onClick={() => dispatch({ type: 'goTo', step: 2 })}>
      Back
    </button>
  );

  if (shown === null || episode === null) {
    return (
      <section aria-labelledby="step-heading">
        <h2 id="step-heading">Line up</h2>
        <p className="muted">Choose tracks for an episode on the Episodes step first.</p>
        <div className="step-next step-actions">{back}</div>
      </section>
    );
  }

  const previous = previousEpisode(order, episode.index);

  const toolsMissing = !session.toolsReady || lineup?.status === 'tools-missing';

  return (
    <section className="lineup" aria-labelledby="step-heading">
      <nav className="lineup-episodes" aria-label="Episodes">
        <ul>
          {order.map((n) => (
            <li key={n}>
              <button type="button" aria-current={n === shown ? 'true' : undefined} onClick={() => setPicked(n)}>
                <span className="lineup-episode-name">Episode <span className="num">{n}</span></span>
                <span className="lineup-episode-status">{episodeStatus(state.choices[n], state.timing[n])}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <h2 id="step-heading" ref={headingRef} tabIndex={-1}>
        Episode <span className="num">{episode.index}</span>
      </h2>

      {!hasTracks ? (
        <p className="muted">This episode is encoded without subtitles. Choose its tracks on the Episodes step to add them back.</p>
      ) : (
        <>
          <div className="lineup-status" role="status">
            {toolsMissing ? (
              <p className="muted">{TOOLS_MESSAGE}</p>
            ) : asking ? (
              <p className="muted">Choose how to time the subtitles.</p>
            ) : lineup === undefined && !runs ? (
              <div className="lineup-own">
                <p className="lineup-result">{describeAlignment(alignment ?? { kind: 'original' })}</p>
                {asked !== null && (
                  <button ref={lineUpOneRef} type="button" className="quiet" onClick={() => setRequested((r) => new Set(r).add(lineKey))}>
                    Line up this episode
                  </button>
                )}
              </div>
            ) : lineup === undefined || lineup.status === 'working' ? (
              <p className="working">
                <span className="spinner" aria-hidden="true" />
                {fetchingNow !== null
                  ? `Fetching from the NAS (${megabytes(fetchingNow.bytesDone)} of ${megabytes(fetchingNow.bytes)} MB)`
                  : `Lining up episode ${episode.index} against the disc's audio`}
              </p>
            ) : lineup.status === 'failed' ? (
              <p className="error">Lining up failed: {lineup.message} The preview uses the release's own timing.</p>
            ) : (
              <p className="lineup-result">{describeAlignment(alignment ?? { kind: 'original' })}</p>
            )}
            {previewError !== null && <p className="error">The preview could not load the track. {previewError}</p>}
          </div>

          <Player controller={controller} episode={episode} />

          {answer !== null && (
            <AlignmentStrip
              speech={answer.speech}
              dialogue={answer.dialogue}
              alignment={fetchTiming}
              nudgeMs={nudgeMs}
              atMs={(snapshot.timeUs - episode.startUs) / 1000}
            />
          )}

          <div className="nudge" role="group" aria-label="Nudge the subtitles">
            <span className="nudge-label">Nudge</span>
            <output className="nudge-value num" aria-live="polite">
              {formatNudge(nudgeMs)}
            </output>
            <div className="nudge-buttons">
              <button type="button" className="quiet num" disabled={!previewing} aria-label={`Earlier by ${NUDGE_FRAME_MS} ms`} title="[" onClick={() => nudge(-NUDGE_FRAME_MS)}>
                &minus;{NUDGE_FRAME_MS}
              </button>
              <button type="button" className="quiet num" disabled={!previewing} aria-label={`Earlier by ${NUDGE_FINE_MS} ms`} title="{" onClick={() => nudge(-NUDGE_FINE_MS)}>
                &minus;{NUDGE_FINE_MS}
              </button>
              <button type="button" className="quiet num" disabled={!previewing} aria-label={`Later by ${NUDGE_FINE_MS} ms`} title="}" onClick={() => nudge(NUDGE_FINE_MS)}>
                +{NUDGE_FINE_MS}
              </button>
              <button type="button" className="quiet num" disabled={!previewing} aria-label={`Later by ${NUDGE_FRAME_MS} ms`} title="]" onClick={() => nudge(NUDGE_FRAME_MS)}>
                +{NUDGE_FRAME_MS}
              </button>
            </div>
            <span className="nudge-keys muted">
              Keys <kbd>[</kbd> <kbd>]</kbd> move a frame, <kbd>{'{'}</kbd> <kbd>{'}'}</kbd> 10 ms
            </span>
          </div>

          {chosen.length > 1 && (
            <fieldset className="track-switch">
              <legend>Track in the preview</legend>
              {chosen.map((t) => (
                <label key={t.id} className="check">
                  <input
                    type="radio"
                    name={`preview-track-${episode.index}`}
                    checked={t.id === trackId}
                    onChange={() => setPreviewTracks((p) => ({ ...p, [episode.index]: t.id }))}
                  />
                  {t.name}
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}

      <div className="lineup-actions">
        {back}
        <button type="button" className="quiet lineup-previous" disabled={previous === null} onClick={() => previous !== null && setPicked(previous)}>
          Previous episode
        </button>
        {hasTracks && (
          <>
            <button
              type="button"
              className="primary"
              disabled={lineup?.status === 'working'}
              onClick={() => {
                dispatch({ type: 'accept', episode: episode.index });
                moveOn(true);
              }}
            >
              {othersToCheck(order, episode.index, state.choices, state.timing) ? 'Accept, next episode' : 'Accept'}
            </button>
            <button type="button" className="quiet" disabled={fetchTiming.kind === 'original'} onClick={() => dispatch({ type: 'useOriginal', episode: episode.index })}>
              Use original timing
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => {
                dispatch({ type: 'skip', episode: episode.index });
                moveOn(false);
              }}
            >
              Skip
            </button>
          </>
        )}
      </div>
      {asking && <LineUpQuestion onAnswer={answerQuestion} />}
      {hasTracks && allLinedUp(order, state.choices, state.timing) && (
        <p className="lineup-done" role="status" aria-label="Every episode is lined up">
          Every episode is lined up. Check Details, then Save for encoding.
        </p>
      )}
    </section>
  );
}
