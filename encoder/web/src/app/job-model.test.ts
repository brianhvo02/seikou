// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { encodedCount, episodeFraction, episodeStatus, formatBytesOf, overallPercent, secondsLeft, waitingText } from './job-model';
import { DEFAULT_TEST_SETTINGS, makeEpisode, makeJob } from './job-test-support';

const nasJob = (episodes = 6) =>
  makeJob({
    settings: { ...DEFAULT_TEST_SETTINGS, destination: 'nas' },
    episodes: Array.from({ length: episodes }, (_, i) => makeEpisode(i + 1)),
  });

describe('episodeStatus', () => {
  it('says how much of a fetch from the NAS is done', () => {
    const ep = makeEpisode(1, { state: 'running', step: 'fetching', stepDone: 1.2e9, stepTotal: 4e9 });
    expect(episodeStatus(nasJob(), ep)).toBe('Fetching from the NAS · 1.2 of 4.0 GB');
  });

  it('a fetch whose size is not known yet says only that it fetches', () => {
    const ep = makeEpisode(1, { state: 'running', step: 'fetching', stepDone: 0, stepTotal: 0 });
    expect(episodeStatus(nasJob(), ep)).toBe('Fetching from the NAS');
  });

  it('says encoding while the episode encodes, as before', () => {
    expect(episodeStatus(nasJob(), makeEpisode(2, { state: 'running', step: 'encoding' }))).toBe('Encoding');
    expect(episodeStatus(makeJob(), makeEpisode(2, { state: 'running', step: null }))).toBe('Encoding');
  });

  it('says which episode uploads and how far', () => {
    const ep = makeEpisode(2, { state: 'running', step: 'uploading', stepDone: 450, stepTotal: 1000 });
    expect(episodeStatus(nasJob(6), ep)).toBe('Uploading episode 2 of 6 · 45%');
  });

  it('an episode the NAS took is Uploaded', () => {
    const ep = makeEpisode(2, { state: 'done', encoded: true, encodeId: '990001-2' });
    expect(episodeStatus(nasJob(), ep)).toBe('Uploaded');
  });

  it('a failed upload gives its reason', () => {
    const ep = makeEpisode(2, { state: 'upload-failed', encoded: true, error: 'The NAS has no room.' });
    expect(episodeStatus(nasJob(), ep)).toBe('Upload failed: The NAS has no room.');
    expect(episodeStatus(nasJob(), makeEpisode(2, { state: 'upload-failed' }))).toBe('Upload failed: the NAS did not take it');
  });

  it('an encoded episode whose upload waits for the NAS says so, and counts as encoded', () => {
    const ep = makeEpisode(1, { state: 'upload-waiting', encoded: true, frames: 1000, framesDone: 1000 });
    expect(episodeStatus(nasJob(), ep)).toBe('Encoded · upload waits for the NAS');
    expect(episodeFraction(makeEpisode(1, { state: 'upload-waiting', encoded: true }))).toBe(1);
  });

  it('keeps the other states as the page said them', () => {
    const job = makeJob();
    expect(episodeStatus(job, makeEpisode(1, { state: 'queued' }))).toBe('Waiting');
    expect(episodeStatus(job, makeEpisode(1, { state: 'done' }))).toBe('Done');
    expect(episodeStatus(job, makeEpisode(1, { state: 'failed' }))).toBe('Failed');
    expect(episodeStatus(job, makeEpisode(1, { state: 'packaging-failed' }))).toBe('Encoded, web package failed');
  });
});

describe('waitingText', () => {
  it('says the job waits for the NAS and when it tries again', () => {
    expect(waitingText(makeJob({ waiting: 'Waiting for the NAS' }))).toBe('Waiting for the NAS. Trying again every minute.');
  });

  it('is null for a job that waits for nothing', () => {
    expect(waitingText(makeJob())).toBeNull();
  });
});

describe('formatBytesOf', () => {
  it('uses megabytes below a gigabyte', () => {
    expect(formatBytesOf(120e6, 640e6)).toBe('120 of 640 MB');
    expect(formatBytesOf(1.2e9, 4e9)).toBe('1.2 of 4.0 GB');
  });
});

describe('a job queued for only some of its episodes', () => {
  const skipped = (index: number) => makeEpisode(index, { state: 'done', skipped: true });
  const job = makeJob({
    only: [2, 3],
    episodes: [skipped(1), makeEpisode(2, { state: 'running', framesDone: 500, frames: 1000 }), makeEpisode(3)],
  });

  it('calls the skipped episode already encoded', () => {
    expect(episodeStatus(job, job.episodes[0]!)).toBe('Already encoded');
    expect(episodeStatus(job, job.episodes[1]!)).toBe('Encoding');
  });

  it('leaves it out of the count and the percentage', () => {
    expect(encodedCount(job)).toBe(2);
    // one of two counted episodes is half done: 25%, not (1 + 0.5) / 3
    expect(overallPercent(job)).toBe(25);
  });

  it('leaves it out of the time left', () => {
    const progress = { jobId: job.id, episode: 2, framesDone: 500, frames: 1000, fps: 10, etaSeconds: 50 };
    // 50 s for the running episode plus one waiting episode of 1000 frames at 10 fps
    expect(secondsLeft(job, progress)).toBe(150);
  });
});
