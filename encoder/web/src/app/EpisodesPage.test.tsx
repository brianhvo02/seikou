// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import type { AniListEntry, CheckAnswer, EpisodeInfo, NasPrefill, LibraryAnswer, PlaylistDetail, TitleHit } from '../api-types';
import type { TitleSummary } from '@seikou/nas/nas-api';
import type { PlayerLike } from '../player/use-controller';
import type { AppApi } from './app-api';
import { EpisodesPage } from './EpisodesPage';
import { UNUSED_ANILIST_API, UNUSED_JOB_API, UNUSED_NAS_API } from './job-test-support';

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
    { key: KEY, label: 'LANTERN_HARBOR_D1', relPath: 'LANTERN_HARBOR_D1', root: '/media/discs', source: 'local' as const, playlistCount: 1, recordPlaylists: [], otherPaths: [] },
  ];
  return {
    library: vi.fn(async () => ({ roots: ['/media/discs'], savedRoots: [], runRoots: [], unreadableRoots: [], scanning: false, discs: listed, nas: { paired: false, scanning: false, reachable: null } })),
    rescan: vi.fn(async () => undefined),
    setRoots: vi.fn(async (r) => r),
    playlists: vi.fn(async () => []),
    playlist: vi.fn(async () => playlist),
    createSession: vi.fn(async () => '0123456789abcdef'),
    episodeInfo: vi.fn(async () => null),
    saveEpisodeInfo: vi.fn(),
    profiles: vi.fn(async () => []),
    createProfile: vi.fn(),
    updateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    ...UNUSED_JOB_API,
    ...UNUSED_ANILIST_API,
    ...UNUSED_NAS_API,
    remoteDisc: vi.fn(async () => ({ kind: 'remote', base: 'http://x/', token: 't', manifest: {} }) as never),
  };
}

function fakeController() {
  let snapshot = { engineState: 'playing', timeUs: 0, error: null };
  const listeners = new Set<() => void>();
  return {
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => snapshot,
    setTime: (timeUs: number) => {
      snapshot = { ...snapshot, timeUs };
      for (const l of listeners) l();
    },
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
  } as unknown as PlayerLike & { seek: ReturnType<typeof vi.fn>; openRemote: ReturnType<typeof vi.fn>; setTime: (timeUs: number) => void };
}

async function show(api = fakeApi(), controller = fakeController(), from?: { titleId: string; seasonId: string }) {
  render(<EpisodesPage api={api} discKey={KEY} playlistId="00800" controller={controller} from={from} />);
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
    await show(fakeApi(detail({ episodeSpec: '1-3,4-6', anilist: null })));
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

  it('Queue encode goes to the queue dialog without the no-subtitles flag', async () => {
    await show();
    click('Queue encode');
    expect(location.pathname).toBe('/queue/new');
    const q = new URLSearchParams(location.search);
    expect([q.get('disc'), q.get('playlist'), q.get('spec'), q.get('noSubtitles')]).toEqual([KEY, '00800', '1-', null]);
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

  it('marks the chapter being played and follows playback', async () => {
    const { controller } = await show();
    const current = () => screen.getAllByRole('listitem').filter((li) => li.getAttribute('aria-current') === 'true').map((li) => li.textContent);
    expect(current()).toHaveLength(1);
    expect(current()[0]).toContain('0:00');
    act(() => controller.setTime(1_250_000_000));
    expect(current()).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Chapter 3,/ }).closest('li')!.getAttribute('aria-current')).toBe('true');
    act(() => controller.setTime(3_599_000_000));
    expect(screen.getByRole('button', { name: /Chapter 6,/ }).closest('li')!.getAttribute('aria-current')).toBe('true');
  });

  it('a playlist with no chapters says there is nothing to group', async () => {
    const empty: PlaylistDetail = { id: '00800', durationMs: 60_000, chapters: [], record: null };
    await show(fakeApi(empty));
    expect(screen.getByText(/no chapters to group/)).toBeTruthy();
    expect(screen.queryByText(/Untick Skip/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Choose subtitles' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the library is being scanned until the scan ends, then opens the page', async () => {
    const api = fakeApi();
    const listed = (await api.library()).discs;
    let calls = 0;
    api.library = vi.fn(async () => ({ roots: [], savedRoots: [], runRoots: [], unreadableRoots: [], scanning: calls === 0, discs: calls++ === 0 ? [] : listed, nas: { paired: false, scanning: false, reachable: null } }));
    render(<EpisodesPage api={api} discKey={KEY} playlistId="00800" controller={fakeController()} />);
    expect(await screen.findByText('Scanning the library…')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'LANTERN_HARBOR_D1' }, { timeout: 3000 })).toBeTruthy();
  });

  it('lands on not-in-library when the scan ends without the disc after a poll began', async () => {
    const api = fakeApi(detail(), []);
    let scanning = true;
    setTimeout(() => (scanning = false), 300);
    api.library = vi.fn(async () => ({ roots: [], savedRoots: [], runRoots: [], unreadableRoots: [], scanning, discs: [], nas: { paired: false, scanning: false, reachable: null } }));
    api.playlist = vi.fn(async () => {
      throw new ApiError(404, 'disc-changed', 'The helper serves no disc with that key.');
    });
    render(<EpisodesPage api={api} discKey={KEY} playlistId="00800" controller={fakeController()} />);
    expect(await screen.findByText('Scanning the library…')).toBeTruthy();
    expect((await screen.findByRole('alert', {}, { timeout: 3000 })).textContent).toContain('not in the library');
    expect(screen.queryByText('Scanning the library…')).toBeNull();
  });

  it('says the disc is not in the library when the scan is already over', async () => {
    const api = fakeApi(detail(), []);
    api.playlist = vi.fn(async () => {
      throw new ApiError(404, 'disc-changed', 'The helper serves no disc with that key.');
    });
    render(<EpisodesPage api={api} discKey={KEY} playlistId="00800" controller={fakeController()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('not in the library');
  });
});

const hit = (alId: number, title: string): TitleHit => ({ alId, title, nativeTitle: null, year: 2024, format: 'TV', episodes: 12, poster: null });

/** A fake whose episode info saves answer like the backend, and whose AniList knows two made-up seasons. */
function infoApi(record: PlaylistDetail['record'] = null) {
  const api = fakeApi(detail(record));
  const saveEpisodeInfo = vi.fn(async (_k: string, _p: string, info: Omit<EpisodeInfo, 'savedAt'>): Promise<EpisodeInfo> => ({ ...info, savedAt: '2026-11-09T10:00:00.000Z' }));
  api.saveEpisodeInfo = saveEpisodeInfo;
  api.searchAniList = vi.fn(async () => [hit(990011, 'Lantern Harbor Season 2')]);
  api.aniListEntry = vi.fn(
    async (id: number): Promise<AniListEntry> => ({
      ...hit(id, id === 990010 ? 'Lantern Harbor' : 'Lantern Harbor Season 2'),
      sequel: id === 990010 ? hit(990011, 'Lantern Harbor Season 2') : null,
    }),
  );
  api.aniListEpisodes = vi.fn(async (id: number): Promise<Record<number, string>> => (id === 990011 ? { 1: 'Cold Water' } : {}));
  return { api, saveEpisodeInfo };
}

const RECORD = { episodeSpec: '1-2,3-4,5-6', anilist: { id: 990010, title: 'Lantern Harbor' } };

describe('EpisodesPage chapter names and AniList', () => {
  const ready = async (label: string) => waitFor(() => expect((screen.getByLabelText(label) as HTMLSelectElement).disabled).toBe(false));

  it('saves a chapter name picked from the list', async () => {
    const { api, saveEpisodeInfo } = infoApi();
    await show(api);
    await ready('Name of chapter 1');
    fireEvent.change(screen.getByLabelText('Name of chapter 1'), { target: { value: 'Opening' } });
    await waitFor(() => expect(saveEpisodeInfo).toHaveBeenCalledTimes(1));
    expect(saveEpisodeInfo.mock.calls[0]![2]).toEqual({ chapterNames: { '1': 'Opening' }, titles: {} });
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('saves a custom name typed after picking Custom, once typing stops', async () => {
    const { api, saveEpisodeInfo } = infoApi();
    await show(api);
    await ready('Name of chapter 2');
    const select = screen.getByLabelText('Name of chapter 2') as HTMLSelectElement;
    const custom = [...select.options].find((o) => o.text === 'Custom…')!;
    fireEvent.change(select, { target: { value: custom.value } });
    expect(saveEpisodeInfo).not.toHaveBeenCalled();
    const field = screen.getByLabelText('Custom name for chapter 2');
    fireEvent.change(field, { target: { value: 'Cold' } });
    fireEvent.change(field, { target: { value: 'Cold open' } });
    await waitFor(() => expect(saveEpisodeInfo).toHaveBeenCalled());
    expect(saveEpisodeInfo).toHaveBeenCalledTimes(1);
    expect(saveEpisodeInfo.mock.calls[0]![2].chapterNames).toEqual({ '2': 'Cold open' });
  });

  it('prefills from the record show without saving until something changes', async () => {
    const { api, saveEpisodeInfo } = infoApi(RECORD);
    await show(api);
    const list = screen.getByRole('list', { name: 'Episodes made' });
    await waitFor(() => expect(list.textContent).toContain('Lantern Harbor'));
    expect(screen.getAllByText('Suggested')).toHaveLength(3);
    expect((screen.getByLabelText('AniList episode number of episode 3') as HTMLInputElement).value).toBe('3');
    await new Promise((r) => setTimeout(r, 700));
    expect(saveEpisodeInfo).not.toHaveBeenCalled();
  });

  it('Change, search and pick saves the choice and renumbers the episodes after it', async () => {
    const { api, saveEpisodeInfo } = infoApi(RECORD);
    await show(api);
    const change = screen.getByRole('button', { name: 'Change the AniList entry of episode 2' }) as HTMLButtonElement;
    await waitFor(() => expect(change.disabled).toBe(false));
    fireEvent.click(change);
    fireEvent.change(screen.getByLabelText('Search AniList for episode 2'), { target: { value: 'lantern' } });
    fireEvent.submit(screen.getByRole('search'));
    fireEvent.click(await screen.findByRole('button', { name: /^Lantern Harbor Season 2/ }));
    expect(api.searchAniList).toHaveBeenCalledWith('lantern');
    await waitFor(() =>
      expect(saveEpisodeInfo.mock.lastCall?.[2].titles).toEqual({
        '1': { title: { source: 'anilist', anilistId: 990010 }, episode: 1, name: null },
        '3': { title: { source: 'anilist', anilistId: 990011 }, episode: 1, name: 'Cold Water' },
        '5': { title: { source: 'anilist', anilistId: 990011 }, episode: 2, name: null },
      }),
    );
    expect(screen.queryByText('Suggested')).toBeNull();
    expect(screen.getByText('Cold Water')).toBeTruthy();
  });

  it('paired with a NAS, picking a TMDB season saves the title with the show name and renumbers the rest', async () => {
    const { api, saveEpisodeInfo } = infoApi(RECORD);
    api.library = vi.fn(async () => ({ roots: [], savedRoots: [], runRoots: [], unreadableRoots: [], scanning: false, discs: [{ key: KEY, label: 'LANTERN_HARBOR_D1', relPath: 'LANTERN_HARBOR_D1', root: '/media/discs', source: 'local' as const, playlistCount: 1, recordPlaylists: [], otherPaths: [] }], nas: { paired: true, scanning: false, reachable: true } }));
    api.lookupTitles = vi.fn(async (_q: string, source: string): Promise<TitleSummary[]> =>
      source === 'tmdb' ? [{ id: 'tmdb-tv:990101', kind: 'series' as const, names: { english: 'Lantern Harbour', romaji: null, native: null, synonyms: [], display: null }, poster: null, year: 2019, seasons: 2, discs: 0, addedAt: 0, own: false }] : [],
    );
    await show(api);
    const change = screen.getByRole('button', { name: 'Change the AniList entry of episode 2' }) as HTMLButtonElement;
    await waitFor(() => expect(change.disabled).toBe(false));
    fireEvent.click(change);
    fireEvent.change(screen.getByLabelText('Search for episode 2'), { target: { value: 'lantern' } });
    fireEvent.submit(screen.getByRole('search'));
    fireEvent.click(await screen.findByRole('button', { name: /^TMDB\s*Lantern Harbour/ }));
    fireEvent.change(screen.getByLabelText('Season of Lantern Harbour'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this season' }));
    const tv = { source: 'tmdb-tv', tmdbId: 990101, season: 2 };
    await waitFor(() =>
      expect(saveEpisodeInfo.mock.lastCall?.[2].titles).toEqual({
        '1': { title: { source: 'anilist', anilistId: 990010 }, episode: 1, name: null },
        '3': { title: tv, episode: 1, name: null, showName: 'Lantern Harbour' },
        '5': { title: tv, episode: 2, name: null, showName: 'Lantern Harbour' },
      }),
    );
    // renumbering a TMDB row keeps its title and show name
    const field = screen.getByLabelText('AniList episode number of episode 2') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '4' } });
    fireEvent.blur(field);
    await waitFor(() => expect(saveEpisodeInfo.mock.lastCall?.[2].titles['3']).toEqual({ title: tv, episode: 4, name: null, showName: 'Lantern Harbour' }));
    expect(saveEpisodeInfo.mock.lastCall?.[2].titles['5']).toEqual({ title: tv, episode: 5, name: null, showName: 'Lantern Harbour' });
  });

  it('offers the next season first in Change', async () => {
    const { api, saveEpisodeInfo } = infoApi(RECORD);
    await show(api);
    const change = screen.getByRole('button', { name: 'Change the AniList entry of episode 3' }) as HTMLButtonElement;
    await waitFor(() => expect(change.disabled).toBe(false));
    fireEvent.click(change);
    fireEvent.click(await screen.findByRole('button', { name: /^Next season/ }));
    await waitFor(() => expect(saveEpisodeInfo.mock.lastCall?.[2].titles['5']).toEqual({ title: { source: 'anilist', anilistId: 990011 }, episode: 1, name: 'Cold Water' }));
    expect(api.searchAniList).not.toHaveBeenCalled();
  });

  it('a new episode number renumbers the episodes after it in the same entry', async () => {
    const { api, saveEpisodeInfo } = infoApi(RECORD);
    await show(api);
    const field = screen.getByLabelText('AniList episode number of episode 2') as HTMLInputElement;
    await waitFor(() => expect(field.disabled).toBe(false));
    fireEvent.change(field, { target: { value: '7' } });
    fireEvent.blur(field);
    await waitFor(() => expect(saveEpisodeInfo).toHaveBeenCalled());
    const anilist = saveEpisodeInfo.mock.lastCall![2].titles;
    expect([anilist['1']?.episode, anilist['3']?.episode, anilist['5']?.episode]).toEqual([1, 7, 8]);
  });

  it('a failed save keeps the edit, says why and offers Retry', async () => {
    const { api, saveEpisodeInfo } = infoApi();
    saveEpisodeInfo.mockRejectedValueOnce(new Error('The disk is full.'));
    await show(api);
    await ready('Name of chapter 1');
    fireEvent.change(screen.getByLabelText('Name of chapter 1'), { target: { value: 'Ending' } });
    expect(await screen.findByText('Not saved: The disk is full.')).toBeTruthy();
    expect((screen.getByLabelText('Name of chapter 1') as HTMLSelectElement).value).toBe('Ending');
    click('Retry');
    await waitFor(() => expect(saveEpisodeInfo).toHaveBeenCalledTimes(2));
    expect(saveEpisodeInfo.mock.calls[1]![2].chapterNames).toEqual({ '1': 'Ending' });
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('shows saved names and choices, and keeps choices of chapters that start no episode now', async () => {
    const { api, saveEpisodeInfo } = infoApi();
    const saved: EpisodeInfo = {
      chapterNames: { '3': 'Cold open' },
      titles: { '1': { title: { source: 'anilist', anilistId: 990010 }, episode: 4, name: 'Low Tide' }, '4': { title: { source: 'anilist', anilistId: 990010 }, episode: 5, name: null } },
      savedAt: '2026-11-08T10:00:00.000Z',
    };
    api.episodeInfo = vi.fn(async () => saved);
    await show(api);
    expect(await screen.findByDisplayValue('Cold open')).toBeTruthy();
    expect(screen.getByText('Low Tide')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name of chapter 1'), { target: { value: 'Avant' } });
    await waitFor(() => expect(saveEpisodeInfo).toHaveBeenCalled());
    expect(saveEpisodeInfo.mock.calls[0]![2]).toEqual({ chapterNames: { '1': 'Avant', '3': 'Cold open' }, titles: saved.titles });
  });
});

describe('EpisodesPage NAS prefill and Mark checked', () => {
  const nasApi = (prefill: NasPrefill, record: PlaylistDetail['record'] = null) => {
    const { api, saveEpisodeInfo } = infoApi(record);
    api.library = vi.fn(async () => ({ roots: [], savedRoots: [], runRoots: [], unreadableRoots: [], scanning: false, discs: [{ key: KEY, label: 'LANTERN_HARBOR_D1', relPath: 'LANTERN_HARBOR_D1', root: '/media/discs', source: 'nas' as const, playlistCount: 1, recordPlaylists: [], otherPaths: [] }], nas: { paired: true, scanning: false, reachable: true } }));
    const nasPrefill = vi.fn(async () => prefill);
    api.nasPrefill = nasPrefill;
    const answer = (nasChoice: CheckAnswer['nasChoice'], message?: string): CheckAnswer => ({ info: { chapterNames: {}, titles: {}, savedAt: '' }, nasChoice, ...(message === undefined ? {} : { message }) });
    const checkPlaylist = vi.fn(async (): Promise<CheckAnswer> => answer('saved'));
    api.checkPlaylist = checkPlaylist;
    return { api, saveEpisodeInfo, nasPrefill, checkPlaylist, answer };
  };
  const THREE: NasPrefill = {
    episodes: [5, 6, 7].map((number) => ({ number, name: `Part ${number}` })),
    title: { source: 'anilist', anilistId: 990010 },
    episodeSpec: '1-2,3-4,5-6',
  };

  it('applies the NAS grouping and numbers the titles from the NAS, as suggestions that save nothing', async () => {
    const { api, saveEpisodeInfo, nasPrefill } = nasApi(THREE);
    await show(api);
    await waitFor(() => expect(spec()).toBe('1-2,3-4,5-'));
    expect(nasPrefill).toHaveBeenCalledWith(KEY, '00800');
    await waitFor(() => expect((screen.getByLabelText('AniList episode number of episode 3') as HTMLInputElement).value).toBe('7'));
    expect((screen.getByLabelText('AniList episode number of episode 1') as HTMLInputElement).value).toBe('5');
    expect(screen.getAllByText('Suggested')).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 700));
    expect(saveEpisodeInfo).not.toHaveBeenCalled();
  });

  it('asks for nothing and suggests nothing when titles are already saved', async () => {
    const { api, nasPrefill } = nasApi(THREE);
    api.episodeInfo = vi.fn(async () => ({ chapterNames: {}, titles: { '1': { title: { source: 'anilist' as const, anilistId: 990020 }, episode: 9, name: null } }, savedAt: '2026-11-09T10:00:00.000Z' }));
    await show(api);
    await waitFor(() => expect((screen.getByLabelText('AniList episode number of episode 1') as HTMLInputElement).value).toBe('9'));
    await new Promise((r) => setTimeout(r, 100));
    expect(nasPrefill).not.toHaveBeenCalled();
    expect(spec()).toBe('1-');
    expect(screen.queryAllByText('Suggested')).toHaveLength(0);
  });

  it('keeps the saved record\'s grouping over the NAS\'s', async () => {
    const { api, nasPrefill } = nasApi(THREE, { episodeSpec: '1-3,4-6', anilist: null });
    await show(api);
    await waitFor(() => expect(nasPrefill).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(spec()).toBe('1-3,4-');
  });

  it('Mark checked saves the suggestions, checks the grouping and says where the NAS filed the disc', async () => {
    const { api, saveEpisodeInfo, checkPlaylist } = nasApi(THREE);
    await show(api);
    await waitFor(() => expect(spec()).toBe('1-2,3-4,5-'));
    const button = screen.getByRole('button', { name: 'Mark checked' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(checkPlaylist).toHaveBeenCalledWith(KEY, '00800', '1-2,3-4,5-'));
    expect(saveEpisodeInfo.mock.lastCall?.[2].titles).toEqual({
      '1': { title: { source: 'anilist', anilistId: 990010 }, episode: 5, name: 'Part 5' },
      '3': { title: { source: 'anilist', anilistId: 990010 }, episode: 6, name: 'Part 6' },
      '5': { title: { source: 'anilist', anilistId: 990010 }, episode: 7, name: 'Part 7' },
    });
    expect(await screen.findByText('Checked. The NAS now files this disc under Lantern Harbor.')).toBeTruthy();
  });

  it('opened from a season, leads back to it once checked', async () => {
    const { api } = nasApi(THREE);
    const from = { titleId: 'anilist:990010', seasonId: 'anilist:990010#season' };
    await show(api, fakeController(), from);
    const seasonPath = `/shows/${encodeURIComponent(from.titleId)}/${encodeURIComponent(from.seasonId)}`;
    const backs = (): string[] => screen.queryAllByRole('link', { name: 'Back to the season' }).map((l) => new URL(l.getAttribute('href')!, 'http://x').pathname);
    expect(backs()).toEqual([seasonPath]);
    await waitFor(() => expect(spec()).toBe('1-2,3-4,5-'));
    const button = screen.getByRole('button', { name: 'Mark checked' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText('Checked. The NAS now files this disc under Lantern Harbor.');
    expect(backs()).toEqual([seasonPath, seasonPath]);
  });

  it('says so when the episodes span two shows, and when the NAS refuses', async () => {
    const { api, checkPlaylist, answer } = nasApi(THREE);
    await show(api);
    await waitFor(() => expect(spec()).toBe('1-2,3-4,5-'));
    const button = screen.getByRole('button', { name: 'Mark checked' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    checkPlaylist.mockResolvedValueOnce(answer('mixed'));
    fireEvent.click(button);
    expect(await screen.findByText('Checked. The episodes span two shows, so the NAS was left as it is.')).toBeTruthy();
    checkPlaylist.mockResolvedValueOnce(answer('failed', 'unknown title'));
    fireEvent.click(screen.getByRole('button', { name: 'Mark checked' }));
    expect(await screen.findByText('Checked. The NAS refused the change: unknown title')).toBeTruthy();
  });

  it('keeps Mark checked off while an episode has no title', async () => {
    const { api } = nasApi({ episodes: [], title: null, episodeSpec: null });
    await show(api);
    await waitFor(() => expect((screen.getByLabelText('Episodes') as HTMLInputElement).value).toBe('1-'));
    expect((screen.getByRole('button', { name: 'Mark checked' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the checked line is out of date once the titles change', async () => {
    const { api, checkPlaylist } = nasApi(THREE);
    await show(api);
    await waitFor(() => expect(spec()).toBe('1-2,3-4,5-'));
    const button = screen.getByRole('button', { name: 'Mark checked' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText('Checked. The NAS now files this disc under Lantern Harbor.');
    expect(checkPlaylist).toHaveBeenCalled();
    const field = screen.getByLabelText('AniList episode number of episode 1') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '9' } });
    fireEvent.blur(field);
    expect(await screen.findByText('Changed since it was checked.')).toBeTruthy();
  });

  it('keeps Mark checked off, with the reason, while the grouping differs from the saved subtitles\'', async () => {
    const { api, checkPlaylist } = nasApi(THREE, { episodeSpec: '1-3,4-6', anilist: null });
    await show(api);
    await waitFor(() => expect(spec()).toBe('1-3,4-'));
    fireEvent.change(screen.getByLabelText('Episodes'), { target: { value: '1-2,3-6' } });
    expect(screen.getByText('The saved subtitles were made for episodes grouped as 1-3,4-. Group them that way, or line up the subtitles again.', { selector: '#check-result' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Mark checked' }) as HTMLButtonElement).disabled).toBe(true);
    expect(checkPlaylist).not.toHaveBeenCalled();
  });
});
