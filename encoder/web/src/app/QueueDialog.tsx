// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import type { ChapterInfo, EncodeDestination, EpisodeInfo, NasStatus, Profile } from '../api-types';
import { noteReplacesFiles } from './job-model';
import { MAX_TEST_PROFILES, testSummary } from './test-model';
import type { AppApi } from './app-api';
import { formatLength } from './DiscPage';
import { episodeRows, episodesPhrase, missingTitles, sharedTitles, suggestedTitles } from './episode-info-model';
import { episodeLengths, episodesOf, fromSpec } from './grouping';
import { useDocumentTitle } from './place';
import { Link, navigate, routeHref } from './router';
import { profileSummary, STARTING_SETTINGS } from './SettingsPage';

/** What the dialog needs: the backend client and what the route named. */
export interface SingleQueueProps {
  /** The backend client. */
  readonly api: AppApi;
  /** No batch: this dialog queues the one encode its route named. */
  readonly batch?: undefined;
  /** The library disc. */
  readonly discKey: string;
  /** Five-digit name of the playlist. */
  readonly playlistId: string;
  /** The episode list, as `--episodes` takes it. */
  readonly spec: string;
  /** Whether the "Encode without subtitles" box starts ticked. */
  readonly noSubtitles: boolean;
  /** The profile to start with, by id; the first profile when left out or unknown. */
  readonly profile?: string | undefined;
}

/** One job of a batch: a disc's playlist and episode list, and the 1-based episodes of it still to encode. */
export interface BatchJob {
  readonly discKey: string;
  readonly playlistId: string;
  readonly episodeSpec: string;
  readonly only: readonly number[];
}

/** A batch: the jobs a season's Queue made, queued in order with one profile to the NAS's Encodes library. */
export interface BatchQueueProps {
  readonly api: AppApi;
  readonly batch: readonly BatchJob[];
  /** The profile to start with, by id; the first profile when left out or unknown. */
  readonly profile?: string | undefined;
}

/** What the dialog takes: the one encode its route named, or a batch. */
export type QueueDialogProps = SingleQueueProps | BatchQueueProps;

interface Loaded {
  readonly label: string | null;
  readonly chapters: readonly ChapterInfo[];
  readonly profiles: readonly Profile[];
  /** False when the backend could not suggest an output folder. */
  readonly folderSuggested: boolean;
  /** The pairing with the NAS; null when the app could not say. */
  readonly nas: NasStatus | null;
  /** The saved episode info (null when none is saved), or `unreadable` when it could not be read. */
  readonly info: EpisodeInfo | null | 'unreadable';
  /** The show of the saved subtitle record, which the Episodes page suggests for every episode. */
  readonly recordShow: { readonly id: number } | null;
}

/** What a NAS encode lacks before it can be queued, or what the backend said it lacks. */
interface NasNeeds {
  /** Episodes with no AniList entry. */
  readonly missing: readonly number[];
  /** Episodes whose entry is only a suggestion the Episodes page has not saved. */
  readonly suggested: readonly number[];
  /** Groups of episodes that share one AniList episode. */
  readonly shared: readonly (readonly number[])[];
}

const NO_NEEDS: NasNeeds = { missing: [], suggested: [], shared: [] };

const hasNeeds = (n: NasNeeds): boolean => n.missing.length > 0 || n.suggested.length > 0 || n.shared.length > 0;

const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []);

/** The lines that say what a NAS encode lacks: "Episode 2 has no AniList entry" and the like. */
function needLines(n: NasNeeds): string[] {
  const has = (list: readonly number[]): string => (list.length === 1 ? 'has' : 'have');
  return [
    ...(n.missing.length > 0 ? [`${episodesPhrase(n.missing)} ${has(n.missing)} no AniList entry`] : []),
    ...(n.suggested.length > 0 ? [`${episodesPhrase(n.suggested)} ${has(n.suggested)} a suggested AniList entry. Confirm on the Episodes page.`] : []),
    ...n.shared.filter((g) => g.length > 0).map((g) => `${episodesPhrase(g)} ${g.length === 1 ? 'shares' : 'are'} the same AniList episode. The NAS keeps one file for each.`),
  ];
}

/** The profile list used when the profiles cannot be read: the built-in Default alone. */
const FALLBACK_PROFILES: readonly Profile[] = [{ id: 'default', name: 'Default', builtIn: true, settings: STARTING_SETTINGS }];

/** A 409 that says the saved subtitle choices are for another episode list. */
interface Mismatch {
  readonly recordSpec: string;
  readonly spec: string;
}

/** The codes of refusals about the output folder, which are shown beside the folder. */
const FOLDER_ERRORS: ReadonlySet<string> = new Set(['output-not-absolute', 'output-not-allowed', 'output-in-use']);

const text = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);

/**
 * The page that queues an encode: the disc, playlist and episode list the route named, a settings profile (with its
 * settings in one line), where the episodes go (a folder on this Mac, the profile's choice by default, or the paired NAS's
 * Encodes library, offered only when paired), the output folder for a folder (the backend's default, editable) and
 * "Encode without subtitles". To the NAS, Queue waits until every episode has a saved AniList entry, no two share one,
 * and the NAS keeps encodes, saying what is missing with a link to the Episodes page; the backend's 409
 * `nas-needs-title` and `nas-duplicate-episodes` are shown the same way. Queue
 * encode makes the job and goes to its page (which says once when the job re-encodes into an earlier encode's files). A
 * refusal about the folder (another encode's folder among them) shows beside the folder, any other as an alert;
 * when the saved subtitle choices are for another episode list the alert says both lists and offers to encode without
 * subtitles or to open the helper for this list.
 */
function SingleQueueDialog({ api, discKey, playlistId, spec, noSubtitles: startNoSubtitles, profile: startProfile }: SingleQueueProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState('default');
  const [outDir, setOutDir] = useState('');
  const [noSubtitles, setNoSubtitles] = useState(startNoSubtitles);
  const [busy, setBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [alertText, setAlertText] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);
  const [testIds, setTestIds] = useState<readonly string[]>([]);
  const [testError, setTestError] = useState<string | null>(null);
  const [destination, setDestination] = useState<EncodeDestination>('folder');
  /** What the backend said a NAS encode lacks, from its last refusal. */
  const [refusedNeeds, setRefusedNeeds] = useState<NasNeeds | null>(null);
  useDocumentTitle(loaded?.label ? `${loaded.label} · queue an encode` : 'Queue an encode · Seikou encoder');

  useEffect(() => {
    let live = true;
    // The folder suggestion and the profiles are only conveniences: when one fails the dialog still works.
    Promise.all([
      api.library(),
      api.playlist(discKey, playlistId),
      api.profiles().then(
        (p) => (p.length > 0 ? p : FALLBACK_PROFILES),
        () => FALLBACK_PROFILES,
      ),
      api.jobDefaults(discKey, playlistId).then(
        (d) => d.outDir as string | null,
        () => null,
      ),
      api.nas().then(
        (n): NasStatus | null => n,
        () => null,
      ),
      api.episodeInfo(discKey, playlistId).then(
        (i): EpisodeInfo | null | 'unreadable' => i,
        () => 'unreadable' as const,
      ),
    ]).then(
      ([library, playlist, profiles, suggested, nas, info]) => {
        if (!live) return;
        setLoaded({
          label: library.discs.find((d) => d.key === discKey)?.label ?? null,
          chapters: playlist.chapters,
          profiles,
          folderSuggested: suggested !== null,
          nas,
          info,
          recordShow: playlist.record?.anilist ?? null,
        });
        const first = profiles.find((p) => p.id === startProfile) ?? profiles[0];
        setProfileId(first?.id ?? 'default');
        setDestination(first?.settings.destination === 'nas' && nas?.paired === true ? 'nas' : 'folder');
        setTestIds(first === undefined ? [] : [first.id]);
        setOutDir(suggested ?? '');
      },
      (e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [api, discKey, playlistId, startProfile]);

  if (loadError !== null) {
    return (
      <main className="content wide">
        <p className="error" role="alert">
          {loadError}
        </p>
        <p>
          <Link to={{ kind: 'episodes', discKey, playlistId }}>Back to the episodes</Link>
        </p>
      </main>
    );
  }
  if (loaded === null) {
    return (
      <main className="content wide">
        <p className="muted">Reading the disc…</p>
      </main>
    );
  }

  const profile = loaded.profiles.find((p) => p.id === profileId) ?? loaded.profiles[0];
  const grouping = fromSpec(spec, loaded.chapters.length);
  const episodes = grouping === null ? [] : episodesOf(grouping, loaded.chapters.length);
  const lengths = episodeLengths(episodes, loaded.chapters.map((c) => c.lengthMs));
  const label = loaded.label ?? 'This disc';
  const paired = loaded.nas?.paired === true ? loaded.nas : null;
  const toNas = destination === 'nas' && paired !== null;
  const rows = loaded.info === 'unreadable' ? null : episodeRows(episodes.map((e, i) => ({ index: i + 1, first: e.from })), loaded.info, loaded.recordShow);
  const needs: NasNeeds = rows === null ? NO_NEEDS : { missing: missingTitles(rows), suggested: suggestedTitles(rows), shared: sharedTitles(rows) };
  const encodesOff = paired?.encodes === 'not-configured';
  const nasBlocked = toNas && (hasNeeds(needs) || encodesOff);

  const choose = (next: string): void => {
    setProfileId(next);
    const picked = loaded.profiles.find((p) => p.id === next);
    if (picked !== undefined) setDestination(picked.settings.destination === 'nas' && paired !== null ? 'nas' : 'folder');
  };

  const submit = async (without: boolean): Promise<void> => {
    if (profile === undefined) return;
    setBusy(true);
    setFolderError(null);
    setAlertText(null);
    setMismatch(null);
    setRefusedNeeds(null);
    const settings = toNas ? { ...profile.settings, web: false, destination: 'nas' as const } : { ...profile.settings, destination: 'folder' as const };
    try {
      const job = await api.createJob({ discKey, playlistId, episodeSpec: spec, settings, outDir: toNas ? '' : outDir.trim(), noSubtitles: without });
      if (job.warning === 'replaces-files') noteReplacesFiles(job.id);
      navigate(routeHref({ kind: 'job', jobId: job.id }, location.search));
    } catch (e) {
      setBusy(false);
      if (!(e instanceof ApiError)) return setAlertText(e instanceof Error ? e.message : String(e));
      if (e.code === 'record-mismatch') return setMismatch({ recordSpec: text(e.details.recordEpisodeSpec, '?'), spec: text(e.details.episodeSpec, spec) });
      if (FOLDER_ERRORS.has(e.code)) return setFolderError(e.message);
      if (e.code === 'nas-needs-title') return setRefusedNeeds({ ...NO_NEEDS, missing: numbers(e.details.episodes) });
      if (e.code === 'nas-duplicate-episodes') return setRefusedNeeds({ ...NO_NEEDS, shared: [numbers(e.details.episodes)] });
      setAlertText(e.message);
    }
  };

  const openHelper = (): void => {
    setBusy(true);
    api.createSession(discKey, playlistId, spec).then(
      (id) => navigate(routeHref({ kind: 'helper', sessionId: id }, location.search)),
      (e: unknown) => {
        setBusy(false);
        setAlertText(e instanceof Error ? e.message : String(e));
      },
    );
  };

  const toggleTest = (id: string): void =>
    setTestIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids.length < MAX_TEST_PROFILES ? [...ids, id] : ids));

  const runTest = async (): Promise<void> => {
    const chosen = loaded.profiles.filter((p) => testIds.includes(p.id));
    if (chosen.length === 0) return;
    setBusy(true);
    setTestError(null);
    try {
      const job = await api.createTest({
        discKey,
        playlistId,
        episodeSpec: spec,
        profiles: chosen.map((p) => ({ id: p.id, name: p.name, settings: p.settings })),
        noSubtitles,
      });
      navigate(routeHref({ kind: 'test', jobId: job.id }, location.search));
    } catch (e) {
      setBusy(false);
      setTestError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    void submit(noSubtitles);
  };

  return (
    <main className="content wide queue-dialog">
      <p className="crumb">
        <Link to={{ kind: 'library' }}>Library</Link> / <Link to={{ kind: 'disc', discKey }}>{label}</Link> /{' '}
        <Link to={{ kind: 'episodes', discKey, playlistId }}>Episodes</Link>
      </p>
      <h1 className="page-title disc-title">Queue an encode</h1>
      <p className="queue-disc">{label}</p>
      <p className="muted">
        Playlist <span className="num">{playlistId}</span>, {episodes.length} {episodes.length === 1 ? 'episode' : 'episodes'} (
        <span className="num">{spec}</span>)
      </p>
      {episodes.length > 0 && (
        <ol className="episode-summary" aria-label="Episodes to encode">
          {episodes.map((ep, i) => (
            <li key={ep.from}>
              <span className="episode-name">Episode {i + 1}</span>
              <span className="num">{formatLength(lengths[i] ?? 0)}</span>
              <span className="muted">{ep.from === ep.to ? `chapter ${ep.from}` : `chapters ${ep.from} to ${ep.to}`}</span>
            </li>
          ))}
        </ol>
      )}

      <form className="queue-form" onSubmit={onSubmit}>
        <div className="field">
          <label className="field-label" htmlFor="queue-profile">
            Settings profile
          </label>
          <select id="queue-profile" value={profileId} disabled={busy} onChange={(e) => choose(e.target.value)}>
            {loaded.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {profile !== undefined && <span className="hint">{profileSummary(profile.settings)}</span>}
        </div>

        <fieldset className="field queue-test" aria-labelledby="queue-test-legend">
          <legend className="field-label" id="queue-test-legend">
            Run a test encode first
          </legend>
          <span className="hint">
            Encodes five short stretches of the first episode with each ticked profile (up to {MAX_TEST_PROFILES}), so you can watch them side by side
            and compare the size each would make.
          </span>
          <div className="queue-test-profiles">
            {loaded.profiles.map((p) => {
              const ticked = testIds.includes(p.id);
              return (
                <div key={p.id} className="queue-test-profile">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={ticked}
                      disabled={busy || (!ticked && testIds.length >= MAX_TEST_PROFILES)}
                      aria-describedby={`queue-test-${p.id}`}
                      onChange={() => toggleTest(p.id)}
                    />
                    <span>{p.name}</span>
                  </label>
                  <span className="hint" id={`queue-test-${p.id}`}>
                    {testSummary(p.settings)}
                  </span>
                </div>
              );
            })}
          </div>
          {testError !== null && (
            <span className="error field-error" role="alert">
              {testError}
            </span>
          )}
          <div className="actions">
            <button type="button" className="quiet" disabled={busy || testIds.length === 0} onClick={() => void runTest()}>
              Run test encode
            </button>
          </div>
        </fieldset>

        <fieldset className="field queue-destination" aria-labelledby="queue-destination-legend">
          <legend className="field-label" id="queue-destination-legend">
            Where the episodes go
          </legend>
          <label className="check">
            <input type="radio" name="queue-destination" checked={!toNas} disabled={busy} onChange={() => setDestination('folder')} />
            <span>A folder on this Mac</span>
          </label>
          <label className="check">
            <input
              type="radio"
              name="queue-destination"
              checked={toNas}
              disabled={busy || paired === null}
              aria-describedby="queue-nas-hint"
              onChange={() => setDestination('nas')}
            />
            <span>The NAS (Encodes library)</span>
          </label>
          <span className="hint queue-destination-hint" id="queue-nas-hint">
            {paired === null ? (
              <>
                Pair with your NAS in <Link to={{ kind: 'settings' }}>Settings</Link>
              </>
            ) : (
              <>
                Each episode is uploaded to <span className="num">{paired.host}</span> as {paired.personName} once it is encoded, then removed from this
                Mac. No web package is made.
              </>
            )}
          </span>
        </fieldset>

        {toNas ? (
          <>
            {!paired.reachable && <p className="warn">The NAS isn't answering right now. The encode is queued anyway and waits for it.</p>}
            {nasBlocked && (
              <div className="queue-needs">
                <p>Before this can go to the NAS:</p>
                <ul>
                  {encodesOff && <li>The NAS has no encodes folder: ENCODES_MOUNT isn't set in its .env. Set it and restart the NAS.</li>}
                  {needLines(needs).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {hasNeeds(needs) && (
                  <p>
                    <Link to={{ kind: 'episodes', discKey, playlistId }}>Choose them on the Episodes page</Link>
                  </p>
                )}
              </div>
            )}
            {loaded.info === 'unreadable' && <p className="warn">Couldn't read the episodes' AniList choices. Queueing checks them.</p>}
          </>
        ) : (
          <div className="field">
            <label className="field-label" htmlFor="queue-out">
              Output folder
            </label>
            <input
              id="queue-out"
              type="text"
              className="num"
              value={outDir}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              aria-invalid={folderError !== null}
              aria-describedby={folderError !== null ? 'queue-out-error' : 'queue-out-hint'}
              onChange={(e) => setOutDir(e.target.value)}
            />
            {folderError !== null ? (
              <span className="error field-error" id="queue-out-error" role="alert">
                {folderError}
              </span>
            ) : (
              <span className="hint" id="queue-out-hint">
                {loaded.folderSuggested
                  ? 'A full path. The episodes are written here, and the folder is made if it is missing.'
                  : "Couldn't suggest a folder; type a full path. The folder is made if it is missing."}
              </span>
            )}
          </div>
        )}

        <div className="field">
          <label className="check">
            <input type="checkbox" checked={noSubtitles} disabled={busy} onChange={(e) => setNoSubtitles(e.target.checked)} />
            <span>Encode without subtitles</span>
          </label>
          <span className="hint">Leave out the subtitle choices saved for this playlist. The disc's own picture subtitles follow the profile.</span>
        </div>

        {mismatch !== null && (
          <div className="queue-mismatch" role="alert">
            <p>
              The saved subtitle choices are for episodes <span className="num">{mismatch.recordSpec}</span>, and this encode is for{' '}
              <span className="num">{mismatch.spec}</span>.
            </p>
            <div className="actions">
              <button type="button" className="quiet" disabled={busy} onClick={() => void submit(true)}>
                Encode without subtitles
              </button>
              <button type="button" className="quiet" disabled={busy} onClick={openHelper}>
                Open the helper
              </button>
            </div>
          </div>
        )}
        {refusedNeeds !== null && (
          <div className="queue-needs" role="alert">
            <ul>
              {needLines(refusedNeeds).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p>
              <Link to={{ kind: 'episodes', discKey, playlistId }}>Fix them on the Episodes page</Link>
            </p>
          </div>
        )}
        {alertText !== null && (
          <p className="error" role="alert">
            {alertText}
          </p>
        )}

        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy || profile === undefined || episodes.length === 0 || nasBlocked}>
            {busy ? 'Queueing…' : 'Queue encode'}
          </button>
          <Link to={{ kind: 'episodes', discKey, playlistId }} className="quiet-link">
            Back to the episodes
          </Link>
        </div>
      </form>
    </main>
  );
}

/** What a batch shows of one of its jobs. */
type BatchResult = { readonly state: 'queued' } | { readonly state: 'refused'; readonly message: string };

/**
 * Queues a batch of jobs, one per disc, with one settings profile and the NAS's Encodes library as the destination.
 * The jobs go in order; a refusal is shown beside the disc it belongs to and the rest are still queued. What was
 * refused can be tried again once its cause is fixed.
 */
function BatchQueueDialog({ api, batch, profile: startProfile }: BatchQueueProps) {
  const [loaded, setLoaded] = useState<{ profiles: readonly Profile[]; labels: ReadonlyMap<string, string>; nas: NasStatus | null } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState('default');
  const [results, setResults] = useState<ReadonlyMap<number, BatchResult>>(new Map());
  const [busy, setBusy] = useState(false);
  useDocumentTitle('Queue encodes · Seikou encoder');

  useEffect(() => {
    let live = true;
    Promise.all([
      api.library(),
      api.profiles().then(
        (p) => (p.length > 0 ? p : FALLBACK_PROFILES),
        () => FALLBACK_PROFILES,
      ),
      api.nas().then(
        (n): NasStatus | null => n,
        () => null,
      ),
    ]).then(
      ([library, profiles, nas]) => {
        if (!live) return;
        setLoaded({ profiles, labels: new Map(library.discs.map((d) => [d.key, d.label])), nas });
        setProfileId((profiles.find((p) => p.id === startProfile) ?? profiles[0])?.id ?? 'default');
      },
      (e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [api, startProfile]);

  if (loadError !== null) {
    return (
      <main className="content wide">
        <p className="error" role="alert">
          {loadError}
        </p>
        <p>
          <Link to={{ kind: 'library' }}>Back to the library</Link>
        </p>
      </main>
    );
  }
  if (loaded === null) {
    return (
      <main className="content wide">
        <p className="muted">Reading the discs…</p>
      </main>
    );
  }

  const profile = loaded.profiles.find((p) => p.id === profileId) ?? loaded.profiles[0];
  const paired = loaded.nas?.paired === true ? loaded.nas : null;
  const encodesOff = paired?.encodes === 'not-configured';
  const labelOf = (job: BatchJob): string => loaded.labels.get(job.discKey) ?? 'A disc';
  const waiting = batch.flatMap((_, i) => (results.get(i)?.state === 'queued' ? [] : [i]));
  const refused = batch.filter((_, i) => results.get(i)?.state === 'refused').length;

  const run = async (): Promise<void> => {
    if (profile === undefined || paired === null) return;
    setBusy(true);
    const settings = { ...profile.settings, web: false, destination: 'nas' as const };
    const next = new Map(results);
    for (const i of waiting) {
      const job = batch[i]!;
      try {
        await api.createJob({ discKey: job.discKey, playlistId: job.playlistId, episodeSpec: job.episodeSpec, only: job.only, settings, outDir: '', noSubtitles: false });
        next.set(i, { state: 'queued' });
      } catch (e) {
        next.set(i, { state: 'refused', message: e instanceof Error ? e.message : String(e) });
      }
      setResults(new Map(next));
    }
    setBusy(false);
    if (batch.every((_, i) => next.get(i)?.state === 'queued')) navigate(routeHref({ kind: 'queue' }, location.search));
  };

  const count = waiting.length;
  return (
    <main className="content wide queue-dialog">
      <p className="crumb">
        <Link to={{ kind: 'library' }}>Library</Link>
      </p>
      <h1 className="page-title disc-title">Queue {batch.length === 1 ? 'an encode' : `${batch.length} encodes`}</h1>
      <p className="muted">Each goes to the NAS's Encodes library with the same settings, one after another.</p>
      <ol className="episode-summary" aria-label="Encodes to queue">
        {batch.map((job, i) => {
          const result = results.get(i);
          return (
            <li key={`${job.discKey}:${job.playlistId}`} className={result?.state === 'refused' ? 'queue-batch-refused' : undefined}>
              <span className="episode-name">{labelOf(job)}</span>
              <span className="num">{episodesPhrase(job.only)}</span>
              {result === undefined && <span className="muted">Not queued yet</span>}
              {result?.state === 'queued' && <span className="muted">Queued</span>}
              {result?.state === 'refused' && (
                <span className="error" role="alert">
                  {labelOf(job)} was refused: {result.message}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <form
        className="queue-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="queue-profile">
            Settings profile
          </label>
          <select id="queue-profile" value={profileId} disabled={busy} onChange={(e) => setProfileId(e.target.value)}>
            {loaded.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {profile !== undefined && <span className="hint">{profileSummary(profile.settings)}</span>}
        </div>
        {paired === null && (
          <p className="warn">
            Pair with your NAS in <Link to={{ kind: 'settings' }}>Settings</Link> first.
          </p>
        )}
        {encodesOff && <p className="warn">The NAS has no encodes folder: ENCODES_MOUNT isn't set in its .env.</p>}
        {paired !== null && !paired.reachable && <p className="warn">The NAS isn't answering right now. The encodes are queued anyway and wait for it.</p>}
        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy || profile === undefined || paired === null || encodesOff || count === 0}>
            {busy ? 'Queueing…' : refused > 0 ? `Queue the ${count} left` : `Queue ${count === 1 ? 'encode' : `${count} encodes`}`}
          </button>
          <Link to={{ kind: 'library' }} className="quiet-link">
            Back to the library
          </Link>
        </div>
      </form>
    </main>
  );
}

/**
 * The page that queues encodes: one the route named (`SingleQueueDialog`), or with `batch` the jobs a season's Queue
 * made (`BatchQueueDialog`).
 */
export function QueueDialog(props: QueueDialogProps) {
  return props.batch !== undefined ? <BatchQueueDialog api={props.api} batch={props.batch} profile={props.profile} /> : <SingleQueueDialog {...props} />;
}
