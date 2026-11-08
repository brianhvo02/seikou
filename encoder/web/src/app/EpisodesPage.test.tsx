// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryAnswer, PlaylistDetail } from '../api-types';
import type { PlayerLike } from '../player/use-controller';
import type { AppApi } from './app-api';
import { EpisodesPage } from './EpisodesPage';

afterEach(cleanup);
beforeEach(() => history.replaceState(null, '', '/'));

const KEY = `f.${'c'.repeat(32)}`;

const detail = (record: PlaylistDetail['record'] = null): PlaylistDetail => ({
  id: '00800',
  durationMs: 6 * 600_000,
  chapters: [1, 2, 3, 4, 5, 6].map((index) => ({ index, startMs: (index - 1) * 600_000, lengthMs: 600_000 })),
  record,
});

function fakeApi(playlist: PlaylistDetail = detail(), discs: LibraryAnswer['discs'] | null = null): AppApi {
  const listed = discs ?? [
    { key: KEY, label: 'LANTERN_HARBOR_D1', relPath: 'LANTERN_HARBOR_D1', root: '/media/discs', playlistCount: 1, recordPlaylists: [], otherPaths: [] },
  ];
  return {
    library: vi.fn(async () => ({ roots: ['/media/discs'], savedRoots: [], runRoots: [], unreadableRoots: [], scanning: false, discs: listed })),
    rescan: vi.fn(async () => undefined),
    setRoots: vi.fn(async (r) => r),
    playlists: vi.fn(async () => []),
    playlist: vi.fn(async () => playlist),
    createSession: vi.fn(async () => '0123456789abcdef'),
    remoteDisc: vi.fn(async () => ({ kind: 'remote', base: 'http://x/', token: 't', manifest: {} }) as never),
  };
}

function fakeController() {
  const snapshot = { engineState: 'playing', timeUs: 0, error: null };
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    attachCanvas: vi.fn(),
    resize: vi.fn(),
    startAudio: vi.fn(async () => undefined),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    openRemote: vi.fn(),
    loadSubtitleFiles: vi.fn(),
    setSubtitleStart: vi.fn(),
    shiftSubtitleFile: vi.fn(),
  } as unknown as PlayerLike & { seek: ReturnType<typeof vi.fn>; openRemote: ReturnType<typeof vi.fn> };
}

async function show(api = fakeApi(), controller = fakeController()) {
  render(<EpisodesPage api={api} discKey={KEY} playlistId="00800" controller={controller} />);
  await screen.findByRole('heading', { name: 'LANTERN_HARBOR_D1' });
  await waitFor(() => expect(controller.openRemote).toHaveBeenCalled());
  return { api, controller };
}

const spec = () => (screen.getByLabelText('Episodes') as HTMLInputElement).value;
const click = (name: string | RegExp, role = 'button') => fireEvent.click(screen.getByRole(role, { name }));

describe('EpisodesPage', () => {
  it('opens the playlist at its start and names the page by disc and playlist', async () => {
    const { controller } = await show();
    expect(controller.openRemote.mock.calls[0]![4]).toMatchObject({ playlistId: '00800', timeUs: 0 });
    expect(document.title).toBe('LANTERN_HARBOR_D1 · 00800');
    expect(spec()).toBe('1-');
  });

  it('clicking a chapter seeks to its start', async () => {
    const { controller } = await show();
    click(/Chapter 3, starts at 20:00/);
    await waitFor(() => expect(controller.seek).toHaveBeenCalledWith(1_200_000_000));
  });

  it('a split after chapter 4 yields 1-4,5-', async () => {
    await show();
    click('Split after chapter 4', 'checkbox');
    expect(spec()).toBe('1-4,5-');
  });

  it('skipping chapter 4 yields 1-3,5-', async () => {
    await show();
    click('Skip chapter 4', 'checkbox');
    expect(spec()).toBe('1-3,5-');
  });

  it('typing a spec updates the episodes', async () => {
    await show();
    fireEvent.change(screen.getByLabelText('Episodes'), { target: { value: '1-2,3-6' } });
    expect(screen.getByRole('checkbox', { name: 'Split after chapter 2' })).toHaveProperty('checked', true);
    const list = screen.getByRole('list', { name: 'Episodes made' });
    expect(list.textContent).toContain('Episode 1');
    expect(list.textContent).toContain('20:00');
    expect(list.textContent).toContain('40:00');
  });

  it('an invalid spec shows an error and keeps the last good episodes for the buttons', async () => {
    const { api } = await show();
    fireEvent.change(screen.getByLabelText('Episodes'), { target: { value: '1-2,3-' } });
    fireEvent.change(screen.getByLabelText('Episodes'), { target: { value: '7' } });
    expect(screen.getByText(/Not an episode list/)).toBeTruthy();
    click('Choose subtitles');
    await waitFor(() => expect(api.createSession).toHaveBeenCalledWith(KEY, '00800', '1-2,3-'));
  });

  it('a record with another spec shows the warning', async () => {
    await show(fakeApi(detail({ episodeSpec: '1-3,4-6' })));
    expect(spec()).toBe('1-3,4-');
    expect(screen.queryByText(/won't match/)).toBeNull();
    click('Split after chapter 5', 'checkbox');
    expect(screen.getByText(/episodes 1-3,4-\./)).toBeTruthy();
    expect(screen.getByText(/won't match/)).toBeTruthy();
  });

  it('Choose subtitles creates a session and navigates to it', async () => {
    const { api } = await show();
    click('Choose subtitles');
    await waitFor(() => expect(location.pathname).toBe('/helper/0123456789abcdef'));
    expect(api.createSession).toHaveBeenCalledWith(KEY, '00800', '1-');
  });

  it('Encode without subtitles goes to the queue dialog with the spec', async () => {
    await show();
    click('Split after chapter 3', 'checkbox');
    click('Encode without subtitles');
    expect(location.pathname).toBe('/queue/new');
    const q = new URLSearchParams(location.search);
    expect([q.get('disc'), q.get('playlist'), q.get('spec'), q.get('noSubtitles')]).toEqual([KEY, '00800', '1-3,4-', '1']);
  });

  it('a failed playlist fetch shows an alert, and an unknown disc says so', async () => {
    const api = fakeApi();
    api.playlist = vi.fn(async () => {
      throw new Error('Could not read the playlist.');
    });
    render(<EpisodesPage api={api} discKey={KEY} playlistId="00800" controller={fakeController()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not read the playlist.');
    cleanup();
    render(<EpisodesPage api={fakeApi(detail(), [])} discKey={KEY} playlistId="00800" controller={fakeController()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('not in the library');
  });
});
