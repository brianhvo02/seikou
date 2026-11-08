// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import type { Job } from '../api-types';
import type { AppApi } from './app-api';
import { createJobsStore, type EventSourceCtor } from './job-events';
import { FakeEventSource, makeEpisode, makeJob } from './job-test-support';
import { JobsProvider } from './jobs-context';
import { QueuePage } from './QueuePage';

beforeEach(() => FakeEventSource.reset());
afterEach(cleanup);

function fakeApi(over: Partial<AppApi> = {}): AppApi {
  return {
    jobs: vi.fn(async () => []),
    jobEventsUrl: () => '/e',
    cancelJob: vi.fn(async (id: string) => makeJob({ id, state: 'cancelled' })),
    retryJob: vi.fn(async (id: string) => makeJob({ id, state: 'queued' })),
    removeJob: vi.fn(async () => undefined),
    jobLog: vi.fn(async () => ['10:00:01 started', '10:00:02 episode 2 running']),
    outputUrl: (id: string, path: string) => `/api/outputs/${id}/${path}?t=tok`,
    ...over,
  } as unknown as AppApi;
}

/** Renders the page over a store that heard `jobs` from a fake stream. */
function setup(api: AppApi, jobs: Job[], jobId?: string) {
  const store = createJobsStore(api, { eventSource: FakeEventSource as unknown as EventSourceCtor });
  render(
    <JobsProvider store={store}>
      <QueuePage api={api} jobId={jobId} />
    </JobsProvider>,
  );
  act(() => FakeEventSource.made[0]!.sendJobs(jobs));
  return { store, source: FakeEventSource.made[0]! };
}

describe('QueuePage', () => {
  it('the queue page shows per-episode progress and the CLI command', async () => {
    const job = makeJob();
    const { source } = setup(fakeApi(), [job], job.id);
    act(() => source.sendProgress({ jobId: job.id, episode: 2, framesDone: 300, frames: 1000, fps: 20, etaSeconds: 37 }));
    expect(screen.getByRole('progressbar', { name: 'Episode 1' }).getAttribute('value')).toBe('100');
    expect(screen.getByRole('progressbar', { name: 'Episode 2' }).getAttribute('value')).toBe('30');
    expect(screen.getByRole('progressbar', { name: 'Episode 3' }).getAttribute('value')).toBe('0');
    expect(screen.getByText(/20\.0 fps/)).toBeTruthy();
    expect(screen.getByText(/under a minute left/)).toBeTruthy();
    expect(screen.getByText(job.cli)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/episode 2 running/)).toBeTruthy());
  });

  it('says a job is paused for a test encode', () => {
    const job = makeJob({ state: 'queued', paused: true });
    setup(fakeApi(), [job], job.id);
    expect(screen.getByText(/test encode/i)).toBeTruthy();
  });

  it('cancel and retry call the API', async () => {
    const api = fakeApi();
    const running = makeJob();
    const { source } = setup(api, [running], running.id);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.cancelJob).toHaveBeenCalledWith(running.id));
    // the answer to Cancel is shown at once, with Retry in place of Cancel
    await screen.findByRole('button', { name: 'Retry' });
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    act(() => source.sendJobs([makeJob({ state: 'failed', error: 'SvtAv1EncApp exited with 1' })]));
    expect(screen.getByText(/SvtAv1EncApp exited with 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.retryJob).toHaveBeenCalledWith(running.id));
  });

  it('removes a finished job after a confirm', async () => {
    const api = fakeApi();
    const done = makeJob({ state: 'done', episodes: [makeEpisode(1, { state: 'done', framesDone: 5, frames: 5, encoded: true, path: '/out/lantern/episode-1.mkv' })] });
    setup(api, [done], done.id);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(api.removeJob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    await waitFor(() => expect(api.removeJob).toHaveBeenCalledWith(done.id));
  });

  it('links the finished episodes files and the web package', () => {
    const done = makeJob({
      state: 'done',
      settings: { ...makeJob().settings, web: true },
      episodes: [makeEpisode(1, { state: 'done', framesDone: 5, frames: 5, encoded: true, path: '/out/lantern/episode-1.mkv' }), makeEpisode(2, { state: 'queued' })],
    });
    setup(fakeApi(), [done], done.id);
    expect(screen.getByRole('link', { name: 'episode-1.mkv' }).getAttribute('href')).toBe(`/api/outputs/${done.id}/episode-1.mkv?t=tok`);
    expect(screen.getByRole('link', { name: 'episode.json' }).getAttribute('href')).toBe(`/api/outputs/${done.id}/web/episode-1/episode.json?t=tok`);
  });

  it('lists the queue with the running job first and test jobs linking to their page', () => {
    const waiting = makeJob({ id: 'bbbbbbbbbbbbbbbb', state: 'queued', episodes: [makeEpisode(1)], disc: { key: 'f.b', label: 'WAITING_DISC', dir: '/d' } });
    const test = makeJob({ id: 'cccccccccccccccc', kind: 'test', state: 'queued', episodes: [], cli: '', disc: { key: 'f.c', label: 'TEST_DISC', dir: '/d' } });
    setup(fakeApi(), [waiting, makeJob(), test]);
    const items = screen.getAllByRole('listitem');
    expect(within(items[0]!).getByText('LANTERN_HARBOR_D1')).toBeTruthy();
    expect(within(items[1]!).getByText('WAITING_DISC')).toBeTruthy();
    expect(within(items[2]!).getByRole('link', { name: /TEST_DISC/ }).getAttribute('href')).toMatch(/^\/test\/cccccccccccccccc/);
  });

  it('says nothing is queued', () => {
    setup(fakeApi(), []);
    expect(screen.getByText(/Nothing is queued/)).toBeTruthy();
  });

  it('shows the message when the queue file cannot be read', async () => {
    const api = fakeApi({
      jobs: vi.fn(async () => {
        throw new ApiError(500, 'jobs-unreadable', 'jobs.json is damaged.');
      }),
    });
    const store = createJobsStore(api, { eventSource: FakeEventSource as unknown as EventSourceCtor });
    render(
      <JobsProvider store={store}>
        <QueuePage api={api} />
      </JobsProvider>,
    );
    expect(screen.getByText(/Reading the queue/)).toBeTruthy();
    act(() => FakeEventSource.made[0]!.fail());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('jobs.json is damaged.'));
  });

  it('says a job is not in the queue', () => {
    setup(fakeApi(), [makeJob()], 'ffffffffffffffff');
    expect(screen.getByText(/not in the queue/)).toBeTruthy();
  });

  it('switching to another job drops the previous job log at once', async () => {
    const a = makeJob({ id: 'aaaaaaaaaaaaaaaa' });
    const b = makeJob({ id: 'bbbbbbbbbbbbbbbb' });
    let release: (lines: string[]) => void = () => undefined;
    const jobLog = vi.fn((id: string) => (id === a.id ? Promise.resolve(['log of job a']) : new Promise<string[]>((r) => (release = r))));
    const api = fakeApi({ jobLog });
    const store = createJobsStore(api, { eventSource: FakeEventSource as unknown as EventSourceCtor });
    const view = (jobId: string) => (
      <JobsProvider store={store}>
        <QueuePage api={api} jobId={jobId} />
      </JobsProvider>
    );
    const { rerender } = render(view(a.id));
    act(() => FakeEventSource.made[0]!.sendJobs([a, b]));
    await screen.findByText('log of job a');
    rerender(view(b.id));
    expect(screen.queryByText('log of job a')).toBeNull();
    expect(screen.getByText('Reading the log…')).toBeTruthy();
    await act(async () => release(['log of job b']));
    expect(screen.getByText('log of job b')).toBeTruthy();
  });

  describe('the log poll', () => {
    const setVisibility = (state: 'visible' | 'hidden') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    afterEach(() => {
      vi.useRealTimers();
      setVisibility('visible');
    });

    it('stops while the tab is hidden and asks again when it is shown', async () => {
      vi.useFakeTimers();
      const api = fakeApi();
      const job = makeJob();
      setup(api, [job], job.id);
      await act(async () => undefined);
      const calls = () => (api.jobLog as ReturnType<typeof vi.fn>).mock.calls.length;
      const start = calls();
      await act(async () => void vi.advanceTimersByTime(4100));
      expect(calls()).toBe(start + 2);
      act(() => setVisibility('hidden'));
      await act(async () => void vi.advanceTimersByTime(10_000));
      expect(calls()).toBe(start + 2);
      act(() => setVisibility('visible'));
      expect(calls()).toBe(start + 3);
      await act(async () => void vi.advanceTimersByTime(2100));
      expect(calls()).toBe(start + 4);
    });
  });
});
