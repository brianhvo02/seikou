// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Job, JobEpisode, JobProgress, JobState } from '../api-types';

// What the queue shows about a job, worked out from the job and its latest progress report. Pure.

/** The share (0 to 1) of an episode that is encoded; the live `progress` report, when it is for this episode, is newer than the job's. */
export function episodeFraction(episode: JobEpisode, progress?: JobProgress): number {
  if (episode.state === 'done' || episode.state === 'packaging-failed') return 1;
  const live = progress !== undefined && progress.episode === episode.index && episode.state === 'running';
  const done = live ? progress.framesDone : episode.framesDone;
  const frames = live ? progress.frames : episode.frames;
  if (frames <= 0) return 0;
  return Math.min(1, done / frames);
}

/** The episode being encoded now, or null. */
export function runningEpisode(job: Job): JobEpisode | null {
  return job.episodes.find((e) => e.state === 'running') ?? null;
}

/** The share of the whole job that is done, from 0 to 100, every episode counting the same. */
export function overallPercent(job: Job, progress?: JobProgress): number {
  if (job.episodes.length === 0) return job.state === 'done' ? 100 : 0;
  const sum = job.episodes.reduce((n, e) => n + episodeFraction(e, progress), 0);
  return Math.floor((sum / job.episodes.length) * 100);
}

/**
 * Seconds left for the job: the running episode's own estimate plus, for each episode still waiting, the time the
 * running one needs from start to finish at its speed. Null when the speed is not known yet.
 */
export function secondsLeft(job: Job, progress?: JobProgress): number | null {
  const running = runningEpisode(job);
  if (running === null || progress === undefined || progress.episode !== running.index) return null;
  if (progress.etaSeconds === null || progress.fps === null || progress.fps <= 0) return null;
  const waiting = job.episodes.filter((e) => e.state === 'queued').length;
  const frames = progress.frames > 0 ? progress.frames : running.frames;
  return progress.etaSeconds + (frames > 0 ? Math.round((waiting * frames) / progress.fps) : 0);
}

/** A time left in words: "under a minute left", "12 min left", "1 h 05 min left". */
export function formatLeft(seconds: number): string {
  if (seconds < 60) return 'under a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min left`;
}

/** What a state is called on screen. */
export function stateLabel(state: JobState, paused = false): string {
  if (state === 'queued' && paused) return 'Paused';
  switch (state) {
    case 'queued':
      return 'Waiting';
    case 'running':
      return 'Encoding';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'interrupted':
      return 'Interrupted';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** Whether a job has stopped for good (it can be removed, and retried unless it is done). */
export function isFinished(job: Job): boolean {
  return job.state === 'done' || job.state === 'failed' || job.state === 'interrupted' || job.state === 'cancelled';
}

/** The running job, or null; the queue runs one at a time. */
export function runningJob(jobs: readonly Job[] | null): Job | null {
  return jobs?.find((j) => j.state === 'running') ?? null;
}

/** The queue as the Queue page lists it: what is running or waiting in the order it runs, then the finished, newest first. */
export function orderJobs(jobs: readonly Job[]): Job[] {
  const active = jobs.filter((j) => !isFinished(j));
  const running = active.filter((j) => j.state === 'running');
  const waiting = active.filter((j) => j.state !== 'running');
  const finished = jobs.filter(isFinished).sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt));
  return [...running, ...waiting, ...finished];
}

/** The file name of a path, either separator. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter((p) => p !== '').pop() ?? path;
}

/** The speed of an encode, such as "21.4 fps". */
export function formatFps(fps: number): string {
  return `${fps.toFixed(1)} fps`;
}
