// SPDX-License-Identifier: LGPL-3.0-or-later
import { formatLeft, overallPercent, runningEpisode, runningJob, secondsLeft } from './job-model';
import { useJobs } from './jobs-context';
import { Link } from './router';

/**
 * The line under the app bar that says what is encoding: the disc's name, "episode n of m", the share done and the time
 * left, as one link to the job's page. A test encode shows its disc, "test encode", "sample n of m" and the share done.
 * It renders nothing while no job is running, so the slot it sits in stays empty. It reads the app's shared queue, so every page shows the same line.
 */
export function ProgressLine() {
  const { jobs, progress } = useJobs();
  const job = runningJob(jobs);
  if (job === null) return null;
  const live = progress[job.id];
  if (job.kind === 'test') {
    const unit = runningEpisode(job);
    const done = overallPercent(job, live);
    return (
      <Link to={{ kind: 'test', jobId: job.id }} className="progress-line">
        <strong className="progress-disc">{job.disc.label}</strong>
        <span className="muted">test encode</span>
        {unit !== null && <span>{`sample ${unit.index} of ${job.episodes.length}`}</span>}
        <span className="num">{done}%</span>
        <span className="progress-meter" aria-hidden="true">
          <span style={{ width: `${done}%` }} />
        </span>
      </Link>
    );
  }
  const percent = overallPercent(job, live);
  const episode = runningEpisode(job);
  const left = secondsLeft(job, live);
  return (
    <Link to={{ kind: 'job', jobId: job.id }} className="progress-line">
      <strong className="progress-disc">{job.disc.label}</strong>
      <span>
        {episode === null ? 'starting' : `episode ${episode.index} of ${job.episodes.length}`}
      </span>
      <span className="num">{percent}%</span>
      {left !== null && <span className="muted num">{formatLeft(left)}</span>}
      <span className="progress-meter" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
    </Link>
  );
}
