// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import type { ChapterInfo, Profile } from '../api-types';
import type { AppApi } from './app-api';
import { formatLength } from './DiscPage';
import { episodeLengths, episodesOf, fromSpec } from './grouping';
import { useDocumentTitle } from './place';
import { Link, navigate, routeHref } from './router';
import { profileSummary } from './SettingsPage';

/** What the dialog needs: the backend client and what the route named. */
export interface QueueDialogProps {
  /** The backend client. */
  readonly api: AppApi;
  /** The library disc. */
  readonly discKey: string;
  /** Five-digit name of the playlist. */
  readonly playlistId: string;
  /** The episode list, as `--episodes` takes it. */
  readonly spec: string;
  /** Whether the "Encode without subtitles" box starts ticked. */
  readonly noSubtitles: boolean;
}

interface Loaded {
  readonly label: string | null;
  readonly chapters: readonly ChapterInfo[];
  readonly profiles: readonly Profile[];
}

/** A 409 that says the saved subtitle choices are for another episode list. */
interface Mismatch {
  readonly recordSpec: string;
  readonly spec: string;
}

/** The codes of refusals about the output folder, which are shown beside the folder. */
const FOLDER_ERRORS: ReadonlySet<string> = new Set(['output-not-absolute', 'output-not-allowed']);

const text = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);

/**
 * The page that queues an encode: the disc, playlist and episode list the route named, a settings profile (with its
 * settings in one line), the output folder (the backend's default, editable) and "Encode without subtitles". Queue
 * encode makes the job and goes to its page. A refusal about the folder shows beside the folder, any other as an alert;
 * when the saved subtitle choices are for another episode list the alert says both lists and offers to encode without
 * subtitles or to open the helper for this list.
 */
export function QueueDialog({ api, discKey, playlistId, spec, noSubtitles: startNoSubtitles }: QueueDialogProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState('default');
  const [outDir, setOutDir] = useState('');
  const [noSubtitles, setNoSubtitles] = useState(startNoSubtitles);
  const [busy, setBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [alertText, setAlertText] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);
  useDocumentTitle(loaded?.label ? `${loaded.label} · queue an encode` : 'Queue an encode · Seikou encoder');

  useEffect(() => {
    let live = true;
    Promise.all([api.library(), api.playlist(discKey, playlistId), api.profiles(), api.jobDefaults(discKey, playlistId)]).then(
      ([library, playlist, profiles, defaults]) => {
        if (!live) return;
        setLoaded({ label: library.discs.find((d) => d.key === discKey)?.label ?? null, chapters: playlist.chapters, profiles });
        setProfileId(profiles[0]?.id ?? 'default');
        setOutDir(defaults.outDir);
      },
      (e: unknown) => {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [api, discKey, playlistId]);

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

  const submit = async (without: boolean): Promise<void> => {
    if (profile === undefined) return;
    setBusy(true);
    setFolderError(null);
    setAlertText(null);
    setMismatch(null);
    try {
      const job = await api.createJob({ discKey, playlistId, episodeSpec: spec, settings: profile.settings, outDir: outDir.trim(), noSubtitles: without });
      navigate(routeHref({ kind: 'job', jobId: job.id }, location.search));
    } catch (e) {
      setBusy(false);
      if (!(e instanceof ApiError)) return setAlertText(e instanceof Error ? e.message : String(e));
      if (e.code === 'record-mismatch') return setMismatch({ recordSpec: text(e.details.recordEpisodeSpec, '?'), spec: text(e.details.episodeSpec, spec) });
      if (FOLDER_ERRORS.has(e.code)) return setFolderError(e.message);
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
          <select id="queue-profile" value={profileId} disabled={busy} onChange={(e) => setProfileId(e.target.value)}>
            {loaded.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {profile !== undefined && <span className="hint">{profileSummary(profile.settings)}</span>}
        </div>

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
              A full path. The episodes are written here, and the folder is made if it is missing.
            </span>
          )}
        </div>

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
        {alertText !== null && (
          <p className="error" role="alert">
            {alertText}
          </p>
        )}

        <div className="form-actions">
          <button type="submit" className="primary" disabled={busy || profile === undefined || episodes.length === 0}>
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
