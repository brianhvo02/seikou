// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import type { Job, JobProgress } from '../api-types';
import { createJobsStore, subscribeJobs, type EventSourceCtor } from './job-events';
import { FakeEventSource, makeJob } from './job-test-support';

const ctor = FakeEventSource as unknown as EventSourceCtor;
const api = (jobs: () => Promise<Job[]> = async () => []) => ({ jobEventsUrl: () => '/api/jobs/events?t=tok', jobs });

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
});
afterEach(() => vi.useRealTimers());

describe('subscribeJobs', () => {
  it('opens the stream with the token and passes events on', () => {
    const jobs: (readonly Job[])[] = [];
    const progress: JobProgress[] = [];
    subscribeJobs(api(), (j) => jobs.push(j), (p) => progress.push(p), { eventSource: ctor });
    const [source] = FakeEventSource.made;
    expect(source!.url).toBe('/api/jobs/events?t=tok');
    source!.sendJobs([makeJob()]);
    source!.sendProgress({ jobId: 'aaaaaaaaaaaaaaaa', episode: 2, framesDone: 300, frames: 1000, fps: 20, etaSeconds: 35 });
    expect(jobs).toHaveLength(1);
    expect(progress[0]?.framesDone).toBe(300);
  });

  it('job events reconnect after an error', () => {
    subscribeJobs(api(), () => undefined, () => undefined, { eventSource: ctor });
    expect(FakeEventSource.made).toHaveLength(1);
    FakeEventSource.made[0]!.fail();
    expect(FakeEventSource.made[0]!.closed).toBe(true);
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.made).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.made).toHaveLength(2);
    // the wait doubles while connections keep failing
    FakeEventSource.made[1]!.fail();
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.made).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.made).toHaveLength(3);
    FakeEventSource.made[2]!.fail();
    vi.advanceTimersByTime(4000);
    expect(FakeEventSource.made).toHaveLength(4);
    // a connection that opens starts the wait over
    FakeEventSource.made[3]!.open();
    FakeEventSource.made[3]!.fail();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.made).toHaveLength(5);
  });

  it('never waits longer than 30 seconds', () => {
    subscribeJobs(api(), () => undefined, () => undefined, { eventSource: ctor });
    for (let i = 0; i < 8; i++) {
      FakeEventSource.made[i]!.fail();
      vi.advanceTimersByTime(30_000);
    }
    expect(FakeEventSource.made).toHaveLength(9);
    const last = FakeEventSource.made[8]!;
    last.fail();
    vi.advanceTimersByTime(29_999);
    expect(FakeEventSource.made).toHaveLength(9);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.made).toHaveLength(10);
  });

  it('stops for good when unsubscribed', () => {
    const stop = subscribeJobs(api(), () => undefined, () => undefined, { eventSource: ctor });
    FakeEventSource.made[0]!.fail();
    stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.made).toHaveLength(1);
    expect(FakeEventSource.made[0]!.closed).toBe(true);
  });

  it('does not report a problem after it has stopped', async () => {
    const problems: (string | null)[] = [];
    let answer: () => void = () => undefined;
    const slow = api(() => new Promise<Job[]>((r) => (answer = () => r([]))));
    const stop = subscribeJobs(slow, () => undefined, () => undefined, { eventSource: ctor, onProblem: (m) => problems.push(m) });
    FakeEventSource.made[0]!.fail();
    stop();
    answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(problems).toEqual([]);
  });

  it('says why a failing stream fails when the queue file is damaged', async () => {
    const problems: (string | null)[] = [];
    const broken = api(async () => {
      throw new ApiError(500, 'jobs-unreadable', 'jobs.json cannot be read.');
    });
    subscribeJobs(broken, () => undefined, () => undefined, { eventSource: ctor, onProblem: (m) => problems.push(m) });
    FakeEventSource.made[0]!.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(problems).toEqual(['jobs.json cannot be read.']);
  });
});

describe('the jobs store', () => {
  it('keeps the queue and the latest progress of a job, and drops progress of jobs no longer running', () => {
    const store = createJobsStore(api(), { eventSource: ctor });
    const seen: number[] = [];
    const off = store.subscribe(() => seen.push(1));
    const source = FakeEventSource.made[0]!;
    expect(store.getSnapshot().jobs).toBeNull();
    source.sendJobs([makeJob()]);
    source.sendProgress({ jobId: 'aaaaaaaaaaaaaaaa', episode: 2, framesDone: 300, frames: 1000, fps: 20, etaSeconds: 35 });
    expect(store.getSnapshot().jobs).toHaveLength(1);
    expect(store.getSnapshot().progress.aaaaaaaaaaaaaaaa?.framesDone).toBe(300);
    source.sendJobs([makeJob({ state: 'done' })]);
    expect(store.getSnapshot().progress.aaaaaaaaaaaaaaaa).toBeUndefined();
    off();
    expect(source.closed).toBe(true);
  });

  it('shares one stream between every subscriber', () => {
    const store = createJobsStore(api(), { eventSource: ctor });
    const a = store.subscribe(() => undefined);
    const b = store.subscribe(() => undefined);
    expect(FakeEventSource.made).toHaveLength(1);
    a();
    expect(FakeEventSource.made[0]!.closed).toBe(false);
    b();
    expect(FakeEventSource.made[0]!.closed).toBe(true);
  });
});
