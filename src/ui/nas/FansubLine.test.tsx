// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FansubTitleState } from '@seikou/nas/nas-api';
import type { NasClient } from './nas-client';
import { FansubLine } from './FansubLine';
import { rememberFansubDeletion } from './fansub-model';
import { NasHttpError } from './nas-client';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const state = (over: Partial<FansubTitleState>): FansubTitleState => ({ titleId: 't1', lastRunAt: null, running: false, nothingFound: false, seasons: {}, episodes: {}, ...over });
const asNas = (o: object): NasClient => o as unknown as NasClient;

describe('FansubLine', () => {
  it('polls every 3 s while a run goes, then tells the screen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const answers = [state({ running: true }), state({ running: true }), state({ lastRunAt: 5 })];
    const fansubTitle = vi.fn(async () => answers.shift() ?? answers[0] ?? state({ lastRunAt: 5 }));
    const onChanged = vi.fn();
    render(<FansubLine nas={asNas({ fansubTitle })} titleId="t1" seasonId="s1" onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByTestId('fansub-line').textContent).toBeTruthy());
    expect(onChanged).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(fansubTitle.mock.calls.length).toBe(3);
  });

  it('asks to bring back deleted tracks only after a deletion here, and brings them back on Yes', async () => {
    const calls: string[] = [];
    const nas = asNas({
      fansubTitle: async () => state({ lastRunAt: 5 }),
      undeleteFansubs: async () => { calls.push('undelete'); },
      runFansubs: async () => { calls.push('run'); return state({ lastRunAt: 6 }); },
    });
    const { unmount } = render(<FansubLine nas={nas} titleId="t9" seasonId="s1" onChanged={() => {}} />);
    fireEvent.click(await screen.findByTestId('fansub-run'));
    await waitFor(() => expect(calls).toEqual(['run']));
    expect(screen.queryByText('Bring back the tracks you deleted?')).toBeNull();
    unmount();

    rememberFansubDeletion('t9');
    render(<FansubLine nas={nas} titleId="t9" seasonId="s1" onChanged={() => {}} />);
    fireEvent.click(await screen.findByTestId('fansub-run'));
    expect(await screen.findByText('Bring back the tracks you deleted?')).toBeTruthy();
    expect(calls).toEqual(['run']);
    fireEvent.click(screen.getByTestId('fansub-undelete-yes'));
    await waitFor(() => expect(calls).toEqual(['run', 'undelete', 'run']));
  });

  it('keeps the button live while a run goes, so a nightly run waiting for idle can be hurried', async () => {
    const runFansubs = vi.fn(async () => state({ running: true }));
    render(<FansubLine nas={asNas({ fansubTitle: async () => state({ running: true }), runFansubs })} titleId="t1" seasonId="s1" onChanged={() => {}} />);
    const button = (await screen.findByTestId('fansub-run')) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(runFansubs).toHaveBeenCalledWith('t1'));
  });

  it('says so when a 409 shows a run is already going', async () => {
    const err = new NasHttpError(409, 'running');
    const fansubTitle = vi.fn(async () => state({ lastRunAt: 5 }));
    render(<FansubLine nas={asNas({ fansubTitle, runFansubs: async () => { throw err; } })} titleId="t1" seasonId="s1" onChanged={() => {}} />);
    fireEvent.click(await screen.findByTestId('fansub-run'));
    await waitFor(() => expect(fansubTitle.mock.calls.length).toBeGreaterThan(1));
  });
});
