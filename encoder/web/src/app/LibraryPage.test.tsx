// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryAnswer, LibraryDiscInfo, NasShowsAnswer } from '../api-types';
import type { AppApi } from './app-api';
import { LibraryPage } from './LibraryPage';
import { UNUSED_ANILIST_API, UNUSED_JOB_API, UNUSED_NAS_API } from './job-test-support';

afterEach(cleanup);

const disc = (label: string, extra: Partial<LibraryDiscInfo> = {}): LibraryDiscInfo => ({
  key: `f.${label.length.toString(16).padStart(32, '0')}`,
  label,
  relPath: `shows/${label}`,
  root: '/media/discs',
  source: 'local',
  playlistCount: 12,
  recordPlaylists: [],
  otherPaths: [],
  ...extra,
});

function answer(extra: Partial<LibraryAnswer> = {}): LibraryAnswer {
  return {
    roots: ['/media/discs'],
    savedRoots: ['/media/discs'],
    runRoots: [],
    unreadableRoots: [],
    scanning: false,
    nas: { paired: false, scanning: false, reachable: null },
    discs: [disc('LANTERN_HARBOR_D1'), disc('STARFALL_WANDERER_D2', { playlistCount: 7 }), disc('PAPER_KITE_D1')],
    ...extra,
  };
}

function fakeApi(extra: Partial<LibraryAnswer> = {}, overrides: Partial<AppApi> = {}): AppApi {
  return {
    library: vi.fn(async () => answer(extra)),
    rescan: vi.fn(async () => undefined),
    setRoots: vi.fn(async (roots) => roots),
    playlists: vi.fn(async () => []),
    playlist: vi.fn(async () => {
      throw new Error('not used');
    }),
    createSession: vi.fn(async () => ''),
    episodeInfo: vi.fn(async () => null),
    saveEpisodeInfo: vi.fn(),
    profiles: vi.fn(async () => []),
    createProfile: vi.fn(),
    updateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    ...UNUSED_JOB_API,
    ...UNUSED_ANILIST_API,
    ...UNUSED_NAS_API,
    remoteDisc: vi.fn(async () => {
      throw new Error('not used');
    }),
    ...overrides,
  };
}

describe('LibraryPage', () => {
  it('the library lists discs and filters by text', async () => {
    render(<LibraryPage api={fakeApi()} />);
    expect(await screen.findByText('LANTERN_HARBOR_D1')).toBeTruthy();
    expect(screen.getByText('7 playlists')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /D[12]/ })).toHaveLength(3);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter discs' }), { target: { value: 'starfall' } });
    expect(screen.queryByText('LANTERN_HARBOR_D1')).toBeNull();
    expect(screen.getByText('STARFALL_WANDERER_D2')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter discs' }), { target: { value: 'nothing here' } });
    expect(screen.getByText(/No disc matches/)).toBeTruthy();
  });

  it('a disc with a saved record is marked', async () => {
    const api = fakeApi({ discs: [disc('LANTERN_HARBOR_D1', { recordPlaylists: ['00800'] }), disc('PAPER_KITE_D1')] });
    render(<LibraryPage api={api} />);
    await screen.findByText('LANTERN_HARBOR_D1');
    expect(screen.getAllByText('Subtitle choices saved')).toHaveLength(1);
  });

  it('names the other folders that hold a copy of a disc', async () => {
    const api = fakeApi({
      discs: [disc('LANTERN_HARBOR_D1', { otherPaths: [{ relPath: 'backup/LANTERN_COPY', root: '/media/old' }] })],
    });
    render(<LibraryPage api={api} />);
    const note = await screen.findByText('Also at backup/LANTERN_COPY');
    expect(note.getAttribute('title')).toBe('/media/old');
  });

  it('with several roots the note names the other copy folder, and the filter searches other copies', async () => {
    const api = fakeApi({
      roots: ['/media/one', '/media/old'],
      savedRoots: ['/media/one', '/media/old'],
      discs: [
        disc('LANTERN_HARBOR_D1', { root: '/media/one', otherPaths: [{ relPath: 'LANTERN_COPY', root: '/media/old' }] }),
        disc('PAPER_KITE_D1'),
      ],
    });
    render(<LibraryPage api={api} />);
    const note = await screen.findByText('Also at old / LANTERN_COPY');
    expect(note.getAttribute('title')).toBe('/media/old');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter discs' }), { target: { value: 'lantern_copy' } });
    expect(screen.getByText('LANTERN_HARBOR_D1')).toBeTruthy();
    expect(screen.queryByText('PAPER_KITE_D1')).toBeNull();
  });

  it('with several roots the path line starts with the root, and does not repeat the name', async () => {
    const api = fakeApi({
      roots: ['/media/one', '/media/two'],
      savedRoots: ['/media/one', '/media/two'],
      discs: [
        disc('PAPER_KITE_D1', { root: '/media/one', relPath: 'PAPER_KITE_D1' }),
        disc('LANTERN_HARBOR_D1', { root: '/media/two', relPath: 'shows/LANTERN_HARBOR_D1' }),
      ],
    });
    render(<LibraryPage api={api} />);
    await screen.findByText('LANTERN_HARBOR_D1');
    expect(screen.getByText('one')).toBeTruthy();
    expect(screen.getByText('two / shows/LANTERN_HARBOR_D1')).toBeTruthy();
  });

  it('sets the document title', async () => {
    render(<LibraryPage api={fakeApi()} />);
    await screen.findByText('LANTERN_HARBOR_D1');
    expect(document.title).toBe('Seikou encoder');
  });

  it('with no library folders it explains and lets the user add one', async () => {
    const setRoots = vi.fn(async (roots: readonly string[]) => roots);
    const api = fakeApi({ roots: [], savedRoots: [], discs: [] }, { setRoots });
    render(<LibraryPage api={api} />);
    expect(await screen.findByText('No library folders are set')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '/media/discs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    await waitFor(() => expect(setRoots).toHaveBeenCalledWith(['/media/discs']));
  });

  it('shows a folder that cannot be read and keeps the discs listed', async () => {
    render(<LibraryPage api={fakeApi({ unreadableRoots: ['/media/discs'] })} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('/media/discs');
    expect(screen.getByText('LANTERN_HARBOR_D1')).toBeTruthy();
  });

  it('removes a folder and starts a rescan on request', async () => {
    const api = fakeApi({ roots: ['/media/a', '/media/b'], savedRoots: ['/media/a', '/media/b'] });
    render(<LibraryPage api={api} />);
    await screen.findByText('LANTERN_HARBOR_D1');
    fireEvent.click(screen.getByRole('button', { name: 'Remove /media/a' }));
    await waitFor(() => expect(api.setRoots).toHaveBeenCalledWith(['/media/b']));
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    await waitFor(() => expect(api.rescan).toHaveBeenCalled());
  });

  it('a folder from the command line has no Remove, and adding a folder saves only the saved ones', async () => {
    const api = fakeApi({ roots: ['/media/saved', '/media/run'], savedRoots: ['/media/saved'], runRoots: ['/media/run'] });
    render(<LibraryPage api={api} />);
    await screen.findByText('LANTERN_HARBOR_D1');
    expect(screen.queryByRole('button', { name: 'Remove /media/run' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove /media/saved' })).toBeTruthy();
    expect(screen.getByText(/command line, this run only/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Folder path'), { target: { value: '/media/new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    await waitFor(() => expect(api.setRoots).toHaveBeenCalledWith(['/media/saved', '/media/new']));
  });

  it('keeps polling while a scan runs when one poll fails, and shows the error', async () => {
    let calls = 0;
    const library = vi.fn(async () => {
      calls++;
      if (calls === 2) throw new Error('the app is not answering');
      return answer({ scanning: calls < 4 });
    });
    render(<LibraryPage api={fakeApi({}, { library })} pollMs={10} />);
    await screen.findByRole('button', { name: 'Scanning…' });
    await screen.findByRole('alert');
    await screen.findByRole('button', { name: 'Rescan' });
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists the NAS discs with a NAS mark and their NAS path, and a copy on the NAS as another place', async () => {
    const api = fakeApi({
      nas: { paired: true, scanning: false, reachable: true },
      discs: [
        disc('LANTERN_HARBOR_D1', { otherPaths: [{ relPath: 'anime/LANTERN_HARBOR_D1', root: 'NAS' }] }),
        disc('STARFALL_WANDERER_D2', { source: 'nas', root: 'NAS', relPath: 'anime/STARFALL_WANDERER_D2' }),
      ],
    });
    render(<LibraryPage api={api} view="folder" />);
    await screen.findByText('STARFALL_WANDERER_D2');
    expect(screen.getAllByText('NAS')).toHaveLength(1);
    expect(screen.getByText('On the NAS at anime/STARFALL_WANDERER_D2')).toBeTruthy();
    expect(screen.getByText('Also at the NAS, anime/LANTERN_HARBOR_D1')).toBeTruthy();
    expect(screen.queryByText(/can't be reached/)).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter discs' }), { target: { value: 'nas' } });
    expect(screen.getByText('STARFALL_WANDERER_D2')).toBeTruthy();
  });

  it('says when the NAS cannot be reached, and lists its discs with no library folder set', async () => {
    const api = fakeApi({
      roots: [],
      savedRoots: [],
      nas: { paired: true, scanning: false, reachable: false },
      discs: [disc('STARFALL_WANDERER_D2', { source: 'nas', root: 'NAS', relPath: 'anime/STARFALL_WANDERER_D2' })],
    });
    render(<LibraryPage api={api} view="folder" />);
    expect(await screen.findByText("The NAS can't be reached; its discs are from the last listing.")).toBeTruthy();
    expect(screen.getByRole('link', { name: /STARFALL_WANDERER_D2/ })).toBeTruthy();
    expect(screen.queryByText('No library folders are set')).toBeNull();
  });

  describe('while paired', () => {
    const paired = { nas: { paired: true, scanning: false, reachable: true } };
    const nasDisc = disc('STARFALL_WANDERER_D2', { source: 'nas', root: 'NAS', relPath: 'anime/STARFALL_WANDERER_D2' });
    const shows: NasShowsAnswer = {
      shows: [
        { titleId: 'anilist:990001', name: 'Starfall Wanderer', poster: null, kind: 'series', seasons: 2, films: 1, discs: 6, encoded: 14, toEncode: 12 },
        { titleId: 'tmdb-tv:990111', name: 'Harbour of Small Lights', poster: null, kind: 'series', seasons: 1, films: 0, discs: 2, encoded: 12, toEncode: 0 },
      ],
      unsorted: [{ key: `f.${'e'.repeat(32)}`, label: 'UNTITLED_BD', relPath: 'incoming/UNTITLED_BD' }],
      reachable: true,
      stale: false,
      encodedKnown: true,
    };

    it('opens By show: each show with its seasons, discs and what is encoded, then the unsorted discs', async () => {
      const nasShows = vi.fn(async () => shows);
      render(<LibraryPage api={fakeApi({ ...paired, discs: [disc('LANTERN_HARBOR_D1'), nasDisc] }, { nasShows })} />);
      const starfall = await screen.findByRole('link', { name: /Starfall Wanderer/ });
      expect(starfall.textContent).toContain('2 seasons, 1 film or extra, 6 discs');
      expect(starfall.textContent).toContain('14 of 26 encoded');
      expect(new URL(starfall.getAttribute('href')!, 'http://x').pathname).toBe(`/shows/${encodeURIComponent('anilist:990001')}`);
      expect(screen.getByRole('link', { name: /Harbour of Small Lights/ }).textContent).toContain('All 12 encoded');
      expect(screen.getByRole('link', { name: /UNTITLED_BD/ })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'By show' }).getAttribute('aria-current')).toBe('page');
      expect(screen.queryByText('LANTERN_HARBOR_D1')).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Library folders' })).toBeNull();
      fireEvent.change(screen.getByRole('searchbox', { name: 'Filter shows' }), { target: { value: 'harbour' } });
      expect(screen.queryByRole('link', { name: /Starfall Wanderer/ })).toBeNull();
    });

    it('marks the shows as the last listing while the NAS is not answering', async () => {
      const nasShows = vi.fn(async () => ({ ...shows, reachable: false, stale: true }));
      render(<LibraryPage api={fakeApi(paired, { nasShows })} />);
      expect(await screen.findByText("The NAS can't be reached. These are its shows from the last listing.")).toBeTruthy();
    });

    it('keeps a filter per view', async () => {
      const nasShows = vi.fn(async () => shows);
      const api = fakeApi({ ...paired, discs: [disc('LANTERN_HARBOR_D1'), nasDisc] }, { nasShows });
      const { rerender } = render(<LibraryPage api={api} view="shows" />);
      fireEvent.change(await screen.findByRole('searchbox', { name: 'Filter shows' }), { target: { value: 'harbour' } });
      rerender(<LibraryPage api={api} view="mac" />);
      expect((screen.getByRole('searchbox', { name: 'Filter discs' }) as HTMLInputElement).value).toBe('');
      expect(screen.getByText('LANTERN_HARBOR_D1')).toBeTruthy();
      rerender(<LibraryPage api={api} view="shows" />);
      expect((screen.getByRole('searchbox', { name: 'Filter shows' }) as HTMLInputElement).value).toBe('harbour');
    });

    it('lists the discs on this Mac, with the folders, under This Mac', async () => {
      render(<LibraryPage api={fakeApi({ ...paired, discs: [disc('LANTERN_HARBOR_D1'), nasDisc] })} view="mac" />);
      expect(await screen.findByText('LANTERN_HARBOR_D1')).toBeTruthy();
      expect(screen.queryByText('STARFALL_WANDERER_D2')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Library folders' })).toBeTruthy();
    });
  });
});
