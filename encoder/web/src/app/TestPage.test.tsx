// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, TestPlan } from '../api-types';
import type { AppApi } from './app-api';
import { createJobsStore, type EventSourceCtor } from './job-events';
import { DEFAULT_TEST_SETTINGS, FakeEventSource, makeEpisode, makeJob } from './job-test-support';
import { JobsProvider } from './jobs-context';
import { TestPage } from './TestPage';
import { formatSize, projectedBytes } from './test-model';

const played: HTMLMediaElement[] = [];
const paused: HTMLMediaElement[] = [];

beforeEach(() => {
  FakeEventSource.reset();
  played.length = 0;
  paused.length = 0;
  // jsdom has no media playback: record the calls, and keep currentTime as a plain value.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    played.push(this);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    paused.push(this);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

const plan: TestPlan = {
  profiles: [
    { id: 'default', name: 'Default', settings: DEFAULT_TEST_SETTINGS },
    { id: 'ab12', name: 'Small files', settings: { ...DEFAULT_TEST_SETTINGS, crf: 32, preset: 6 } },
  ],
  stretches: [
    { startMs: 4500, endMs: 14_500 },
    { startMs: 22_250, endMs: 32_250 },
    { startMs: 40_000, endMs: 50_000 },
    { startMs: 57_750, endMs: 67_750 },
    { startMs: 75_500, endMs: 85_500 },
  ],
  episodeSeconds: [1440, 1500],
  audioStreams: 2,
  results: [
    { id: 'default', videoBytesPerSecond: 250_000, audioBytesPerSecond: 20_000 },
    { id: 'ab12', videoBytesPerSecond: 100_000, audioBytesPerSecond: 20_000 },
  ],
};

function testJob(over: Partial<Job> = {}): Job {
  return makeJob({
    id: 'cccccccccccccccc',
    kind: 'test',
    playlist: '00001',
    episodeSpec: '1-3,4-6',
    state: 'done',
    cli: '',
    outDir: '/data/tests/cccccccccccccccc',
    episodes: Array.from({ length: 10 }, (_, i) => makeEpisode(i + 1, { state: 'done', framesDone: 240, frames: 240, encoded: true })),
    test: plan,
    ...over,
  });
}

function fakeApi(over: Partial<AppApi> = {}): AppApi {
  return {
    jobs: vi.fn(async () => []),
    jobEventsUrl: () => '/e',
    jobLog: vi.fn(async () => []),
    cancelJob: vi.fn(async (id: string) => testJob({ id, state: 'cancelled' })),
    retryJob: vi.fn(async (id: string) => testJob({ id, state: 'queued' })),
    sampleUrl: (jobId: string, profileId: string, n: number) => `/api/tests/${jobId}/${profileId}/${n}.webm?t=tok`,
    ...over,
  } as unknown as AppApi;
}

function setup(api: AppApi, jobs: Job[], jobId = 'cccccccccccccccc') {
  const store = createJobsStore(api, { eventSource: FakeEventSource as unknown as EventSourceCtor });
  render(
    <JobsProvider store={store}>
      <TestPage api={api} jobId={jobId} />
    </JobsProvider>,
  );
  act(() => FakeEventSource.made[0]!.sendJobs(jobs));
  return FakeEventSource.made[0]!;
}

describe('TestPage', () => {
  it('shows the grid: a row per stretch, a column per profile, and the projected sizes', () => {
    setup(fakeApi(), [testJob()]);
    const rows = screen.getAllByRole('group', { name: /^Sample at/ });
    expect(rows).toHaveLength(5);
    expect(rows[0]!.getAttribute('aria-label')).toBe('Sample at 0:04');
    const videos = rows[1]!.querySelectorAll('video');
    expect([...videos].map((v) => v.getAttribute('src'))).toEqual(['/api/tests/cccccccccccccccc/default/2.webm?t=tok', '/api/tests/cccccccccccccccc/ab12/2.webm?t=tok']);
    expect(screen.getAllByText('Small files').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/CRF 32, preset 6/).length).toBeGreaterThan(0);
    // Default: (250 000 + 2 × 20 000) × 1440 s = 417.6 MB.
    const sizes = screen.getByRole('list', { name: 'Projected sizes with Default' });
    expect(within(sizes).getByText('418 MB')).toBeTruthy();
    expect(within(sizes).getAllByRole('listitem')).toHaveLength(2);
  });

  it("a row's videos play in step", () => {
    setup(fakeApi(), [testJob()]);
    const rows = screen.getAllByRole('group', { name: /^Sample at/ });
    const [a, b] = [...rows[0]!.querySelectorAll('video')] as HTMLVideoElement[];
    const others = [...rows[1]!.querySelectorAll('video')];
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Play' }));
    expect(played).toEqual([a, b]);
    expect(played.some((v) => others.includes(v as HTMLVideoElement))).toBe(false);
    expect(within(rows[0]!).getByRole('button', { name: 'Pause' })).toBeTruthy();
    // The second video drifts by more than 0.1 s and is brought back to the first.
    a!.currentTime = 3;
    b!.currentTime = 3.5;
    fireEvent(a!, new Event('timeupdate'));
    expect(b!.currentTime).toBe(3);
    // A small drift is left alone.
    b!.currentTime = 3.05;
    fireEvent(a!, new Event('timeupdate'));
    expect(b!.currentTime).toBe(3.05);
    // One seek control moves every video of the row.
    fireEvent.change(within(rows[0]!).getByRole('slider', { name: /Position/ }), { target: { value: '6.5' } });
    expect(a!.currentTime).toBe(6.5);
    expect(b!.currentTime).toBe(6.5);
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Pause' }));
    expect(paused).toEqual(expect.arrayContaining([a, b]));
  });

  it('Use this profile opens the queue dialog with it', () => {
    setup(fakeApi(), [testJob()]);
    fireEvent.click(screen.getByRole('button', { name: 'Use Small files' }));
    expect(location.pathname).toBe('/queue/new');
    const q = new URLSearchParams(location.search);
    expect(q.get('disc')).toBe(testJob().disc.key);
    expect(q.get('playlist')).toBe('00001');
    expect(q.get('spec')).toBe('1-3,4-6');
    expect(q.get('profile')).toBe('ab12');
  });

  it('shows progress while the test runs', () => {
    const running = testJob({
      state: 'running',
      test: { ...plan, results: null, audioStreams: null },
      episodes: Array.from({ length: 10 }, (_, i) => makeEpisode(i + 1, i < 3 ? { state: 'done', encoded: true, framesDone: 240, frames: 240 } : i === 3 ? { state: 'running', framesDone: 120, frames: 240 } : {})),
    });
    const source = setup(fakeApi(), [running]);
    act(() => source.sendProgress({ jobId: running.id, episode: 4, framesDone: 180, frames: 240, fps: 30, etaSeconds: 2 }));
    expect(screen.getByText(/Sample 4 of 10/)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Test progress' }).getAttribute('value')).toBe('37');
    expect(screen.queryAllByRole('group', { name: /^Sample at/ })).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('a failed test shows its error and the log link', () => {
    setup(fakeApi(), [testJob({ state: 'failed', error: 'SvtAv1EncApp stopped with code 1', test: { ...plan, results: null } })]);
    expect(screen.getByRole('alert').textContent).toContain('SvtAv1EncApp stopped with code 1');
    expect(screen.getByRole('link', { name: 'See the log' }).getAttribute('href')).toMatch(/^\/queue\/cccccccccccccccc/);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('says when the job is not in the queue', () => {
    setup(fakeApi(), [], 'dddddddddddddddd');
    expect(screen.getByText(/not in the queue/)).toBeTruthy();
  });
});

describe('test-model', () => {
  it('projects audio once per audio stream and formats sizes', () => {
    expect(projectedBytes(100, { videoBytesPerSecond: 1000, audioBytesPerSecond: 100 }, 3)).toBe(130_000);
    expect(formatSize(417_600_000)).toBe('418 MB');
    expect(formatSize(9_460_000)).toBe('9.5 MB');
    expect(formatSize(1_234_000_000)).toBe('1.23 GB');
  });
});
