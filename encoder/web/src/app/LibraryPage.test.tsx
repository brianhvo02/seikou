// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryAnswer, LibraryDiscInfo } from '../api-types';
import type { AppApi } from './app-api';
import { LibraryPage } from './LibraryPage';
import { UNUSED_JOB_API } from './job-test-support';

afterEach(cleanup);

const disc = (label: string, extra: Partial<LibraryDiscInfo> = {}): LibraryDiscInfo => ({
  key: `f.${label.length.toString(16).padStart(32, '0')}`,
  label,
  relPath: `shows/${label}`,
  root: '/media/discs',
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
    profiles: vi.fn(async () => []),
    createProfile: vi.fn(),
    updateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    ...UNUSED_JOB_API,
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
});
