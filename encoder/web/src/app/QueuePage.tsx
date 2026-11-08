// SPDX-License-Identifier: LGPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import type { Job, JobEpisode, JobProgress } from '../api-types';
import type { AppApi } from './app-api';
import { episodeFraction, fileNameOf, formatFps, formatLeft, isFinished, orderJobs, overallPercent, stateLabel } from './job-model';
import { useJobs, useJobsStore } from './jobs-context';
import { useDocumentTitle } from './place';
import { Link, navigate, routeHref } from './router';

/** What the page needs: the backend client, and the job to show (none shows the list). */
export interface QueuePageProps {
  /** The backend client. */
  readonly api: AppApi;
  /** The job whose page this is; leave it out for the list of every job. */
  readonly jobId?: string | undefined;
}

/** How often the log of the open, running job is asked for again, in milliseconds. */
export const LOG_POLL_MS = 2000;

/** How many log lines the page asks for. */
const LOG_LINES = 300;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const episodesText = (n: number): string => `${n} ${n === 1 ? 'episode' : 'episodes'}`;

/** The state of a job as a small mark beside its name. */
function StateMark({ job }: { readonly job: Job }) {
  return <span className={`job-state job-state-${job.state}${job.paused ? ' job-state-paused' : ''}`}>{stateLabel(job.state, job.paused)}</span>;
}

/** A job's row in the list. */
function JobRow({ job, progress }: { readonly job: Job; readonly progress: JobProgress | undefined }) {
  const test = job.kind === 'test';
  return (
    <li className="job-row">
      <Link to={test ? { kind: 'test', jobId: job.id } : { kind: 'job', jobId: job.id }} className="job-link">
        <span className="job-name">{job.disc.label}</span>
        <StateMark job={job} />
        <span className="muted job-meta">
          {test ? 'Test encode' : `Playlist ${job.playlist}, ${episodesText(job.episodes.length)}`}
          {job.state === 'running' && !test && <> , {overallPercent(job, progress)}%</>}
        </span>
      </Link>
    </li>
  );
}

/** One episode of the open job: its bar, and for the running one its speed and time left. */
function EpisodeRow({ episode, progress }: { readonly episode: JobEpisode; readonly progress: JobProgress | undefined }) {
  const percent = Math.floor(episodeFraction(episode, progress) * 100);
  const live = episode.state === 'running' && progress !== undefined && progress.episode === episode.index ? progress : undefined;
  const status =
    episode.state === 'packaging-failed'
      ? 'Encoded, web package failed'
      : episode.state === 'queued'
        ? 'Waiting'
        : episode.state === 'running'
          ? 'Encoding'
          : episode.state === 'done'
            ? 'Done'
            : 'Failed';
  return (
    <li className={`episode-row episode-${episode.state}`}>
      <div className="episode-row-head">
        <span className="episode-name">Episode {episode.index}</span>
        <span className="muted">{status}</span>
        <span className="num episode-percent">{percent}%</span>
      </div>
      <progress max={100} value={percent} aria-label={`Episode ${episode.index}`} />
      {live !== undefined && (
        <p className="muted num episode-speed">
          {live.fps !== null && formatFps(live.fps)}
          {live.fps !== null && live.etaSeconds !== null && ', '}
          {live.etaSeconds !== null && formatLeft(live.etaSeconds)}
        </p>
      )}
      {episode.error !== undefined && <p className="error">{episode.error}</p>}
    </li>
  );
}

/** The log tail of a job, a scrolling box that stays at its newest line unless the reader scrolled up. */
function LogBox({ api, job }: { readonly api: AppApi; readonly job: Job }) {
  const [lines, setLines] = useState<readonly string[] | null>(null);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const running = job.state === 'running';

  useEffect(() => {
    let live = true;
    const load = (): void => {
      api.jobLog(job.id, LOG_LINES).then(
        (next) => {
          if (live) setLines(next);
        },
        () => undefined,
      );
    };
    load();
    const timer = running ? setInterval(load, LOG_POLL_MS) : undefined;
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, job.id, job.state, running]);

  useEffect(() => {
    const el = box.current;
    if (el !== null && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = (): void => {
    const el = box.current;
    if (el !== null) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <pre className="job-log" ref={box} tabIndex={0} aria-label="Log" onScroll={onScroll}>
      {lines === null ? 'Reading the log…' : lines.length === 0 ? 'Nothing logged yet.' : lines.join('\n')}
    </pre>
  );
}

/** The command that does what the job does, with a button that copies it. */
function CliBox({ cli }: { readonly cli: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = (): void => {
    navigator.clipboard.writeText(cli).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <section aria-labelledby="job-cli-heading" className="job-section">
      <h2 id="job-cli-heading">Command</h2>
      <p className="muted">Run this in a terminal to do the same encode without the app.</p>
      <pre className="job-cli">
        <code>{cli}</code>
      </pre>
      <div className="actions">
        <button type="button" className="quiet" aria-label="Copy command" onClick={copy}>
          Copy
        </button>
        <span role="status" className={copied === false ? 'error' : 'muted'}>
          {copied === true ? 'Copied' : copied === false ? 'The browser would not copy it. Select the command and copy it.' : ''}
        </span>
      </div>
    </section>
  );
}

/** The files a job wrote: each finished episode's MKV, and its web package's `episode.json` when the web package is on. */
function OutputFiles({ api, job }: { readonly api: AppApi; readonly job: Job }) {
  const files = job.episodes.filter((e) => (e.state === 'done' || e.state === 'packaging-failed') && e.path !== undefined);
  if (files.length === 0) return null;
  return (
    <section aria-labelledby="job-files-heading" className="job-section">
      <h2 id="job-files-heading">Files</h2>
      <ul className="job-files">
        {files.map((e) => {
          const name = fileNameOf(e.path!);
          const base = name.replace(/\.mkv$/i, '');
          return (
            <li key={e.index}>
              <a href={api.outputUrl(job.id, name)}>{name}</a>
              {job.settings.web && e.state === 'done' && (
                <a href={api.outputUrl(job.id, `web/${base}/episode.json`)} title={`The web package of episode ${e.index}`}>
                  episode.json
                </a>
              )}
            </li>
          );
        })}
      </ul>
      <p className="muted job-out">
        In <span className="num">{job.outDir}</span>
      </p>
    </section>
  );
}

/** The page of one job. */
function JobView({ api, job }: { readonly api: AppApi; readonly job: Job }) {
  const { progress } = useJobs();
  const store = useJobsStore();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle(`${job.disc.label} · encode`);
  const test = job.kind === 'test';
  const live = progress[job.id];
  const active = job.state === 'queued' || job.state === 'running';

  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="content wide job-page">
      <p className="crumb">
        <Link to={{ kind: 'queue' }}>Queue</Link> / {job.disc.label}
      </p>
      <div className="page-head job-head">
        <h1 className="page-title disc-title">{job.disc.label}</h1>
        <StateMark job={job} />
      </div>
      <p className="muted">
        {test ? 'Test encode' : <>Playlist <span className="num">{job.playlist}</span>, {episodesText(job.episodes.length)} (<span className="num">{job.episodeSpec}</span>)</>}
        {job.noSubtitles && !test && ', without subtitles'}
      </p>

      {job.paused && (
        <p className="warn" role="status">
          Paused while a test encode runs. This job carries on when the test is done.
        </p>
      )}
      {job.error !== undefined && (
        <p className="error" role="alert">
          {job.error}
        </p>
      )}

      <div className="actions job-actions">
        {active && (
          <button type="button" className="quiet" disabled={busy} onClick={() => void act(async () => store.applyJob(await api.cancelJob(job.id)))}>
            Cancel
          </button>
        )}
        {(job.state === 'failed' || job.state === 'interrupted' || job.state === 'cancelled') && (
          <button type="button" className="primary" disabled={busy} onClick={() => void act(async () => store.applyJob(await api.retryJob(job.id)))}>
            Retry
          </button>
        )}
        {isFinished(job) &&
          (confirming ? (
            <>
              <span className="muted">Remove this job from the queue? Its files stay.</span>
              <button
                type="button"
                className="quiet danger"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api.removeJob(job.id);
                    store.dropJob(job.id);
                    navigate(routeHref({ kind: 'queue' }, location.search));
                  })
                }
              >
                Yes, remove
              </button>
              <button type="button" className="quiet" disabled={busy} onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="quiet" disabled={busy} onClick={() => setConfirming(true)}>
              Remove
            </button>
          ))}
      </div>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {test ? (
        <p>
          <Link to={{ kind: 'test', jobId: job.id }}>See the test results</Link>
        </p>
      ) : (
        <section aria-labelledby="job-episodes-heading" className="job-section">
          <h2 id="job-episodes-heading">Episodes</h2>
          <ol className="episode-rows">
            {job.episodes.map((e) => (
              <EpisodeRow key={e.index} episode={e} progress={live} />
            ))}
          </ol>
        </section>
      )}

      <OutputFiles api={api} job={job} />

      <section aria-labelledby="job-log-heading" className="job-section">
        <h2 id="job-log-heading">Log</h2>
        <LogBox api={api} job={job} />
      </section>

      {job.cli !== '' && <CliBox cli={job.cli} />}
    </main>
  );
}

/**
 * The Queue page. Without `jobId` it lists the jobs: the running one first, then those waiting in the order they run,
 * then the finished, newest first. With a `jobId` it shows that job: a bar for each episode (the running one with its
 * speed and time left), a note when a test encode has paused it, the log's last lines (asked for every 2 seconds while
 * the job runs), the equivalent command with a Copy button, Cancel, Retry and Remove, and links to the files it wrote.
 * A test job's row leads to its results page.
 */
export function QueuePage({ api, jobId }: QueuePageProps) {
  const { jobs, progress, problem } = useJobs();
  useDocumentTitle(jobId === undefined ? 'Queue · Seikou encoder' : 'Encode · Seikou encoder');
  const job = jobId === undefined ? undefined : jobs?.find((j) => j.id === jobId);

  if (jobs === null) {
    return (
      <main className="content wide">
        <h1 className="page-title">Queue</h1>
        {problem !== null ? (
          <p className="error" role="alert">
            {problem}
          </p>
        ) : (
          <p className="muted">Reading the queue…</p>
        )}
      </main>
    );
  }
  if (jobId !== undefined) {
    if (job === undefined) {
      return (
        <main className="content wide">
          <h1 className="page-title">Job not found</h1>
          <p className="muted">That job is not in the queue. It may have been removed.</p>
          <p>
            <Link to={{ kind: 'queue' }}>Back to the queue</Link>
          </p>
        </main>
      );
    }
    return <JobView api={api} job={job} />;
  }
  const ordered = orderJobs(jobs);
  return (
    <main className="content wide queue-page">
      <h1 className="page-title">Queue</h1>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {ordered.length === 0 ? (
        <p className="muted">
          Nothing is queued. Choose a playlist's episodes in the <Link to={{ kind: 'library' }}>library</Link> and queue an encode.
        </p>
      ) : (
        <ul className="job-list">
          {ordered.map((j) => (
            <JobRow key={j.id} job={j} progress={progress[j.id]} />
          ))}
        </ul>
      )}
    </main>
  );
}
