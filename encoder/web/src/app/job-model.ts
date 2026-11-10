// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Job, JobEpisode, JobProgress, JobState } from '../api-types';

// What the queue shows about a job, worked out from the job and its latest progress report. Pure.

/** The share (0 to 1) of an episode that is encoded; the live `progress` report, when it is for this episode, is newer than the job's. */
export function episodeFraction(episode: JobEpisode, progress?: JobProgress): number {
  if (episode.state === 'done' || episode.state === 'packaging-failed' || episode.state === 'upload-waiting') return 1;
  const live = progress !== undefined && progress.episode === episode.index && episode.state === 'running';
  const done = live ? progress.framesDone : episode.framesDone;
  const frames = live ? progress.frames : episode.frames;
  if (frames <= 0) return 0;
  return Math.min(1, done / frames);
}

/** How many of the job's episodes it encodes: those it was not queued without. */
export function encodedCount(job: Job): number {
  return job.episodes.filter((e) => e.skipped !== true).length;
}

/** The episode being encoded now, or null. */
export function runningEpisode(job: Job): JobEpisode | null {
  return job.episodes.find((e) => e.state === 'running') ?? null;
}

/** The share of the whole job that is done, from 0 to 100, every episode counting the same. */
export function overallPercent(job: Job, progress?: JobProgress): number {
  const counted = job.episodes.filter((e) => e.skipped !== true);
  if (counted.length === 0) return job.state === 'done' ? 100 : 0;
  const sum = counted.reduce((n, e) => n + episodeFraction(e, progress), 0);
  return Math.floor((sum / counted.length) * 100);
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

/** Bytes done of a total in one unit, the total's: "120 of 640 MB", "1.2 of 4.0 GB" (decimal units). */
export function formatBytesOf(done: number, total: number): string {
  if (total >= 1e9) return `${(done / 1e9).toFixed(1)} of ${(total / 1e9).toFixed(1)} GB`;
  return `${Math.round(done / 1e6)} of ${Math.round(total / 1e6)} MB`;
}

/**
 * What an episode of the open job is doing, in a line: "Fetching from the NAS · 1.2 of 4.0 GB", "Encoding",
 * "Uploading episode 2 of 6 · 45%", "Uploaded" (the NAS took it; its `encodeId` stays on the episode for a later link),
 * "Encoded · upload waits for the NAS", "Upload failed: <reason>", or the plain states.
 */
export function episodeStatus(job: Job, episode: JobEpisode): string {
  if (episode.skipped === true) return 'Already encoded';
  switch (episode.state) {
    case 'queued':
      return 'Waiting';
    case 'done':
      return episode.encodeId !== undefined ? 'Uploaded' : 'Done';
    case 'packaging-failed':
      return 'Encoded, web package failed';
    case 'upload-failed':
      return `Upload failed: ${episode.error ?? 'the NAS did not take it'}`;
    case 'upload-waiting':
      return 'Encoded · upload waits for the NAS';
    case 'failed':
      return 'Failed';
    case 'running':
      if (episode.step === 'fetching') {
        return episode.stepTotal > 0 ? `Fetching from the NAS · ${formatBytesOf(episode.stepDone, episode.stepTotal)}` : 'Fetching from the NAS';
      }
      if (episode.step === 'uploading') {
        const percent = episode.stepTotal > 0 ? Math.floor((Math.min(episode.stepDone, episode.stepTotal) / episode.stepTotal) * 100) : 0;
        return `Uploading episode ${episode.index} of ${job.episodes.length} · ${percent}%`;
      }
      return 'Encoding';
  }
}

/** The job's wait for the NAS with when it is tried again (the runner's `nasRetryMs`, 60 s), or null. */
export function waitingText(job: Job): string | null {
  return job.waiting === null ? null : `${job.waiting}. Trying again every minute.`;
}

/** Whether the job sends its episodes to the NAS rather than a folder. */
export function sendsToNas(job: Job): boolean {
  return job.settings.destination === 'nas';
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

/** Jobs just queued as re-encodes that replace an earlier encode's files, whose page has not said so yet. */
const replacesFiles = new Set<string>();

/** Remembers that the job just queued with `id` replaces an earlier encode's files, for its page to say once. */
export function noteReplacesFiles(id: string): void {
  replacesFiles.add(id);
}

/** Whether the page of job `id` still has to say that it replaces earlier files (see `takeReplacesFilesNotice`). */
export function hasReplacesFilesNotice(id: string): boolean {
  return replacesFiles.has(id);
}

/** Like `hasReplacesFilesNotice`, and forgets the note, so the notice is shown once. */
export function takeReplacesFilesNotice(id: string): boolean {
  return replacesFiles.delete(id);
}
