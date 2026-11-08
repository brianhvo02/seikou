// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJobsStore, type EventSourceCtor } from './job-events';
import { FakeEventSource, makeJob } from './job-test-support';
import { JobsProvider } from './jobs-context';
import { ProgressLine } from './ProgressLine';

beforeEach(() => FakeEventSource.reset());
afterEach(cleanup);

function setup() {
  const store = createJobsStore({ jobEventsUrl: () => '/e', jobs: async () => [] }, { eventSource: FakeEventSource as unknown as EventSourceCtor });
  render(
    <JobsProvider store={store}>
      <div data-testid="slot">
        <ProgressLine />
      </div>
    </JobsProvider>,
  );
  return FakeEventSource.made[0]!;
}

describe('ProgressLine', () => {
  it('the progress line shows the running job and hides when idle', () => {
    const source = setup();
    expect(screen.getByTestId('slot').textContent).toBe('');
    act(() => source.sendJobs([makeJob()]));
    act(() => source.sendProgress({ jobId: 'aaaaaaaaaaaaaaaa', episode: 2, framesDone: 300, frames: 1000, fps: 20, etaSeconds: 37 }));
    const link = screen.getByRole('link', { name: /LANTERN_HARBOR_D1/ });
    expect(link.getAttribute('href')).toMatch(/^\/queue\/aaaaaaaaaaaaaaaa/);
    expect(link.textContent).toContain('episode 2 of 3');
    expect(link.textContent).toContain('43%');
    expect(link.textContent).toContain('min left');
    act(() => source.sendJobs([makeJob({ state: 'done' })]));
    expect(screen.getByTestId('slot').textContent).toBe('');
  });
});
