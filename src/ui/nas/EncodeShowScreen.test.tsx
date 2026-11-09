// @vitest-environment jsdom
// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { EncodeShow } from '@seikou/nas/nas-api';
import { EncodeShowScreen } from './EncodeShowScreen';
import type { NasClient } from './nas-client';
import type { NasHistory } from './nas-history';

afterEach(cleanup);

const SHOW: EncodeShow = {
  id: '100', name: 'Starfall Wanderer', poster: null,
  seasons: [
    { anilistId: 100, name: 'Starfall Wanderer', kind: 'season', number: 1, episodes: [{ episode: 1, id: '100-1', title: 'The Long Night', durationMs: 1_440_000 }, { episode: 2, id: '100-2', title: null, durationMs: 1_420_000 }] },
    { anilistId: 103, name: 'Starfall Wanderer: Ember Road', kind: 'film', number: null, episodes: [{ episode: 1, id: '103-1', title: null, durationMs: 6_000_000 }] },
    { anilistId: 101, name: 'Starfall Wanderer Season 2', kind: 'season', number: 2, episodes: [{ episode: 1, id: '101-1', title: null, durationMs: 1_440_000 }] },
  ],
};

const PROGRESS = {
  '100-1': { mkv: { timeUs: 720_000_000, durationUs: 1_440_000_000, finished: false } },
  '100-2': { mkv: { timeUs: 1_420_000_000, durationUs: 1_420_000_000, finished: true } },
};

function fakeHistory(): NasHistory {
  return { push: vi.fn(), replace: vi.fn(), back: vi.fn(), route: vi.fn() } as unknown as NasHistory;
}

function fakeNas(over: Record<string, unknown> = {}): NasClient {
  return {
    encodeShow: vi.fn(async (id: string) => (id === '100' ? SHOW : null)),
    encodeShows: vi.fn(async () => ({ shows: [] })),
    titleProgress: vi.fn(async () => PROGRESS),
    artUrl: vi.fn(async () => null),
    ...over,
  } as unknown as NasClient;
}

describe('the encodes show screen', () => {
  it('the show screen lists seasons in order with progress', async () => {
    const nas = fakeNas();
    const history = fakeHistory();
    render(<EncodeShowScreen nas={nas} history={history} showId="100" />);
    const groups = await screen.findAllByTestId('encode-season');
    expect(groups.map((g) => within(g).getByRole('heading').textContent)).toEqual(['Season 1', 'Season 2', 'Starfall Wanderer: Ember Road']);
    await waitFor(() => expect(nas.titleProgress).toHaveBeenCalledWith('100', { library: 'encodes' }));

    const rows = within(groups[0]!).getAllByTestId('episode-row');
    expect(rows.map((r) => r.getAttribute('data-encode-id'))).toEqual(['100-1', '100-2']);
    expect(rows[0]!.textContent).toContain('The Long Night');
    expect(rows[0]!.textContent).toContain('24 min');
    await waitFor(() => expect(within(rows[0]!).getByTestId('episode-progress').getAttribute('aria-label')).toBe('50% watched'));
    // finished: watched, no bar, no resume
    expect(within(rows[1]!).queryByTestId('episode-progress')).toBeNull();
    expect(within(rows[1]!).getByTestId('episode-watched')).toBeTruthy();

    const resume = screen.getByTestId('episode-resume');
    expect(resume.textContent).toBe('Resume at 12:00');
    fireEvent.click(resume);
    expect(history.push).toHaveBeenCalledWith({ kind: 'encodePlay', encodeId: '100-1', timeS: 720, resume: true });
    expect(screen.getAllByTestId('episode-resume')).toHaveLength(1);

    fireEvent.click(rows[1]!);
    expect(history.push).toHaveBeenCalledWith({ kind: 'encodePlay', encodeId: '100-2', timeS: null, resume: false });
  });

  it('follows a show whose id changed to the show holding it', async () => {
    const moved: EncodeShow = { ...SHOW, id: '90', seasons: [{ anilistId: 90, name: 'Starfall Wanderer Zero', kind: 'season', number: 1, episodes: [] }, ...SHOW.seasons] };
    const nas = fakeNas({
      encodeShow: vi.fn(async (id: string) => (id === '90' ? moved : id === '300' ? { id: '300', name: 'Lantern Tide', poster: null, seasons: [] } : null)),
      encodeShows: vi.fn(async () => ({
        shows: [{ id: '300', name: 'Lantern Tide', poster: null, episodeCount: 1, anilistIds: [300] }, { id: '90', name: 'Starfall Wanderer', poster: null, episodeCount: 4, anilistIds: [90, 100, 103, 101] }],
      })),
    });
    const history = fakeHistory();
    render(<EncodeShowScreen nas={nas} history={history} showId="100" />);
    await waitFor(() => expect(history.replace).toHaveBeenCalledWith({ kind: 'encodeShow', showId: '90' }));
    // found from the list's ids: no show was fetched to look
    expect(vi.mocked(nas.encodeShow).mock.calls.map(([id]) => id).filter((id) => id !== '90')).toEqual(['100']);
  });

  it('follows a moved show on a NAS whose list has no AniList ids, by fetching its shows', async () => {
    const moved: EncodeShow = { ...SHOW, id: '90', seasons: [{ anilistId: 90, name: 'Starfall Wanderer Zero', kind: 'season', number: 1, episodes: [] }, ...SHOW.seasons] };
    const nas = fakeNas({
      encodeShow: vi.fn(async (id: string) => (id === '90' ? moved : id === '300' ? { id: '300', name: 'Lantern Tide', poster: null, seasons: [] } : null)),
      encodeShows: vi.fn(async () => ({ shows: [{ id: '300', name: 'Lantern Tide', poster: null, episodeCount: 1 }, { id: '90', name: 'Starfall Wanderer', poster: null, episodeCount: 4 }] })),
    });
    const history = fakeHistory();
    render(<EncodeShowScreen nas={nas} history={history} showId="100" />);
    await waitFor(() => expect(history.replace).toHaveBeenCalledWith({ kind: 'encodeShow', showId: '90' }));
    expect(nas.encodeShow).toHaveBeenCalledWith('300');
  });

  it('goes back to the list when no show holds it', async () => {
    const nas = fakeNas({ encodeShow: vi.fn(async () => null), encodeShows: vi.fn(async () => ({ shows: [{ id: '300', name: 'Lantern Tide', poster: null, episodeCount: 1, anilistIds: [300] }] })) });
    const history = fakeHistory();
    render(<EncodeShowScreen nas={nas} history={history} showId="100" />);
    await waitFor(() => expect(history.replace).toHaveBeenCalledWith({ kind: 'encodes', q: '' }));
  });

  it('shows not-found when the show it was sent to answers 404 too, without looking again', async () => {
    const nas = fakeNas({
      encodeShow: vi.fn(async () => null),
      encodeShows: vi.fn(async () => ({ shows: [{ id: '90', name: 'Starfall Wanderer', poster: null, episodeCount: 4, anilistIds: [90, 100] }] })),
    });
    const history = fakeHistory();
    const { rerender } = render(<EncodeShowScreen nas={nas} history={history} showId="100" />);
    await waitFor(() => expect(history.replace).toHaveBeenCalledTimes(1));
    // as if the lookup had found show 90, which then went too
    rerender(<EncodeShowScreen nas={nas} history={history} showId="90" />);
    expect(await screen.findByTestId('nas-not-found')).toBeTruthy();
    expect(nas.encodeShows).toHaveBeenCalledTimes(1);
  });

  // a NAS whose list has no AniList ids: only there does the lookup fetch shows in turn
  it('stops looking once the screen is left', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const encodeShow = vi.fn(async (id: string) => {
      if (id !== '100') await gate;
      return null;
    });
    const shows = Array.from({ length: 5 }, (_, i) => ({ id: String(200 + i), name: `Show ${i}`, poster: null, episodeCount: 1 }));
    const nas = fakeNas({ encodeShow, encodeShows: vi.fn(async () => ({ shows })) });
    const history = fakeHistory();
    const { unmount } = render(<EncodeShowScreen nas={nas} history={history} showId="100" />);
    await waitFor(() => expect(encodeShow).toHaveBeenCalledWith('200'));
    unmount();
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(encodeShow).toHaveBeenCalledTimes(2);
    expect(history.replace).not.toHaveBeenCalled();
  });
});
