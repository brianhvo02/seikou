// SPDX-License-Identifier: LGPL-3.0-or-later
import { useRef, useState, type CSSProperties } from 'react';
import type { Job, JobProgress, TestPlan, TestProfileResult } from '../api-types';
import type { AppApi } from './app-api';
import { formatLeft, overallPercent, runningEpisode, secondsLeft } from './job-model';
import { useJobs, useJobsStore } from './jobs-context';
import { useDocumentTitle } from './place';
import { Link, navigate, routeHref } from './router';
import { DRIFT_SECONDS, formatPlaylistTime, formatSize, projectedBytes, testSummary } from './test-model';

/** What the page needs: the backend client and the test job to show. */
export interface TestPageProps {
  /** The backend client. */
  readonly api: AppApi;
  /** The test job. */
  readonly jobId: string;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What one row of samples plays: the stretch's label and length, and each profile's sample with its name. */
interface RowProps {
  /** Where the stretch starts in the playlist, as the page says it. */
  readonly label: string;
  /** The stretch's length in seconds, until the first video says its own. */
  readonly seconds: number;
  /** Each profile's sample, in column order. */
  readonly samples: readonly { readonly src: string; readonly name: string }[];
}

/**
 * One stretch's samples side by side, with one Play/Pause and one position control for all of them. The first video
 * leads: its time drives the position control, every other video that drifts more than 0.1 s from it is moved back to
 * it, and its end stops the row. Only the first video is heard; every sample carries the same audio.
 */
function SampleRow({ label, seconds, samples }: RowProps) {
  const videos = useRef<(HTMLVideoElement | null)[]>([]);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(seconds);
  const all = (): HTMLVideoElement[] => videos.current.filter((v): v is HTMLVideoElement => v !== null);

  const toggle = (): void => {
    if (playing) {
      for (const v of all()) v.pause();
      setPlaying(false);
      return;
    }
    const lead = all()[0];
    // A row that played to its end starts again from its beginning.
    if (lead !== undefined && lead.ended) for (const v of all()) v.currentTime = 0;
    for (const v of all()) void v.play().catch(() => undefined);
    setPlaying(true);
  };

  const follow = (): void => {
    const [lead, ...rest] = all();
    if (lead === undefined) return;
    const t = lead.currentTime;
    setTime(t);
    for (const v of rest) if (Math.abs(v.currentTime - t) > DRIFT_SECONDS) v.currentTime = t;
  };

  const seek = (value: number): void => {
    for (const v of all()) v.currentTime = value;
    setTime(value);
  };

  const ended = (): void => {
    for (const v of all()) v.pause();
    setPlaying(false);
  };

  const metadata = (): void => {
    const d = all()[0]?.duration;
    if (d !== undefined && Number.isFinite(d) && d > 0) setDuration(d);
  };

  return (
    <div role="group" aria-label={`Sample at ${label}`} className="sample-row">
      <div className="sample-controls">
        <span className="sample-at num">{label}</span>
        <button type="button" className="quiet sample-play" aria-pressed={playing} onClick={toggle}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          className="sample-seek"
          aria-label={`Position in the sample at ${label}`}
          min={0}
          max={duration}
          step={0.1}
          value={Math.min(time, duration)}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <span className="muted num sample-clock">
          {time.toFixed(1)} / {duration.toFixed(1)} s
        </span>
      </div>
      <div className="sample-videos">
        {samples.map((s, k) => (
          <figure key={s.src} className="sample">
            <video
              ref={(el) => {
                videos.current[k] = el;
              }}
              src={s.src}
              muted={k > 0}
              playsInline
              preload="metadata"
              onTimeUpdate={k === 0 ? follow : undefined}
              onEnded={k === 0 ? ended : undefined}
              onLoadedMetadata={k === 0 ? metadata : undefined}
            />
            <figcaption className="muted">{s.name}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

/** The samples grid with each profile's settings above and its projected sizes and "Use this profile" below. */
function Results({ api, job, plan, results }: { readonly api: AppApi; readonly job: Job; readonly plan: TestPlan; readonly results: readonly TestProfileResult[] }) {
  const columns = { '--cols': plan.profiles.length } as CSSProperties;
  const streams = plan.audioStreams ?? 1;
  const use = (profileId: string): void =>
    navigate(
      routeHref(
        { kind: 'queueNew', discKey: job.disc.key, playlistId: job.playlist, spec: job.episodeSpec, noSubtitles: job.noSubtitles, profile: profileId },
        location.search,
      ),
    );
  return (
    <div className="test-grid" style={columns}>
      <div className="test-columns test-heads">
        {plan.profiles.map((p) => (
          <div key={p.id} className="test-head">
            <h2>{p.name}</h2>
            <p className="muted">{testSummary(p.settings)}</p>
          </div>
        ))}
      </div>
      {plan.stretches.map((s, i) => (
        <SampleRow
          key={s.startMs}
          label={formatPlaylistTime(s.startMs)}
          seconds={(s.endMs - s.startMs) / 1000}
          samples={plan.profiles.map((p) => ({ src: api.sampleUrl(job.id, p.id, i + 1), name: p.name }))}
        />
      ))}
      <div className="test-columns test-feet">
        {plan.profiles.map((p) => {
          const result = results.find((r) => r.id === p.id);
          return (
            <section key={p.id} className="test-foot" aria-label={`${p.name}: projected sizes`}>
              <h3>{p.name}</h3>
              {result === undefined ? (
                <p className="muted">No measurement.</p>
              ) : (
                <ul className="test-sizes" aria-label={`Projected sizes with ${p.name}`}>
                  {plan.episodeSeconds.map((seconds, e) => (
                    <li key={e}>
                      <span>Episode {e + 1}</span>
                      <span className="num">{formatSize(projectedBytes(seconds, result, streams))}</span>
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="primary" aria-label={`Use ${p.name}`} onClick={() => use(p.id)}>
                Use this profile
              </button>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** The page of one test job. */
function TestView({ api, job, live }: { readonly api: AppApi; readonly job: Job; readonly live: JobProgress | undefined }) {
  const store = useJobsStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle(`${job.disc.label} · test encode`);
  const plan = job.test;
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
  const active = job.state === 'queued' || job.state === 'running';
  const stopped = job.state === 'failed' || job.state === 'interrupted' || job.state === 'cancelled';
  const unit = runningEpisode(job);
  const percent = overallPercent(job, live);
  const left = secondsLeft(job, live);
  const count = plan?.profiles.length ?? 0;
  const stopText = job.state === 'interrupted' ? 'The app stopped while this test ran.' : job.state === 'cancelled' ? 'This test was cancelled.' : 'This test failed.';

  return (
    <main className="content wide test-page">
      <p className="crumb">
        <Link to={{ kind: 'queue' }}>Queue</Link> / {job.disc.label}
      </p>
      <h1 className="page-title">Test encode</h1>
      <p className="queue-disc">{job.disc.label}</p>
      <p className="muted">
        Playlist <span className="num">{job.playlist}</span>, episodes <span className="num">{job.episodeSpec}</span>.{' '}
        {plan !== undefined &&
          `${plan.stretches.length} ${plan.stretches.length === 1 ? 'stretch' : 'stretches'} of the first episode, encoded with ${count} ${count === 1 ? 'profile' : 'profiles'}.`}
      </p>

      {active && (
        <section className="test-progress" aria-label="Progress">
          <p>
            {job.state === 'queued'
              ? 'Waiting. A test runs before the next episode of any encode in progress.'
              : unit === null
                ? 'Starting…'
                : `Sample ${unit.index} of ${job.episodes.length}`}
            {job.state === 'running' && <span className="num">, {percent}%</span>}
            {left !== null && <span className="muted">, {formatLeft(left)}</span>}
          </p>
          <progress max={100} value={percent} aria-label="Test progress" />
          <div className="actions">
            <button type="button" className="quiet" disabled={busy} onClick={() => void act(async () => store.applyJob(await api.cancelJob(job.id)))}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {stopped && (
        <section className="test-stopped">
          <p className="error" role="alert">
            {stopText}
            {job.error !== undefined && ` ${job.error}`}
          </p>
          <div className="actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void act(async () => store.applyJob(await api.retryJob(job.id)))}>
              Retry
            </button>
            <Link to={{ kind: 'job', jobId: job.id }}>See the log</Link>
          </div>
        </section>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {job.state === 'done' && plan !== undefined && plan.results !== null && (
        <>
          <p className="muted test-note">
            Each row plays one stretch with every profile at once. Sizes are projected from the samples, with{' '}
            {plan.audioStreams ?? 1} Opus {plan.audioStreams === 1 ? 'stream' : 'streams'} per episode.
          </p>
          <Results api={api} job={job} plan={plan} results={plan.results} />
          <p className="test-log">
            <Link to={{ kind: 'job', jobId: job.id }}>See the log</Link>
          </p>
        </>
      )}
    </main>
  );
}

/**
 * The Test page: while a test encode runs, its progress (one unit per sample encode) and Cancel; when it is done, a
 * grid with a row per stretch, labelled by its time in the playlist, and a column per profile with its settings in one
 * line. One Play/Pause and one position control per row drive every video of the row in step. Below each column, the
 * projected size of each episode of the job with that profile, and "Use this profile", which opens the queue dialog for
 * the same disc, playlist and episodes with that profile chosen. A failed test shows its error, Retry and the log link.
 */
export function TestPage({ api, jobId }: TestPageProps) {
  const { jobs, progress, problem } = useJobs();
  useDocumentTitle('Test encode · Seikou encoder');
  if (jobs === null) {
    return (
      <main className="content wide">
        <h1 className="page-title">Test encode</h1>
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
  const job = jobs.find((j) => j.id === jobId && j.kind === 'test');
  if (job === undefined) {
    return (
      <main className="content wide">
        <h1 className="page-title">Test not found</h1>
        <p className="muted">That test is not in the queue. It may have been removed.</p>
        <p>
          <Link to={{ kind: 'queue' }}>Back to the queue</Link>
        </p>
      </main>
    );
  }
  return <TestView key={job.id} api={api} job={job} live={progress[job.id]} />;
}
