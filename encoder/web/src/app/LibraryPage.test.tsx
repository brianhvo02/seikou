// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryAnswer, LibraryDiscInfo } from '../api-types';
import type { AppApi } from './app-api';
import { LibraryPage } from './LibraryPage';

afterEach(cleanup);

const disc = (label: string, extra: Partial<LibraryDiscInfo> = {}): LibraryDiscInfo => ({
  key: `f.${label.length.toString(16).padStart(32, '0')}`,
  label,
  relPath: `shows/${label}`,
  root: '/media/discs',
  playlistCount: 12,
  recordPlaylists: [],
  ...extra,
});

function fakeApi(answer: Partial<LibraryAnswer> = {}, overrides: Partial<AppApi> = {}): AppApi {
  return {
    library: vi.fn(async () => ({
      roots: ['/media/discs'],
      unreadableRoots: [],
      scanning: false,
      discs: [disc('LANTERN_HARBOR_D1'), disc('STARFALL_WANDERER_D2', { playlistCount: 7 }), disc('PAPER_KITE_D1')],
      ...answer,
    })),
    rescan: vi.fn(async () => undefined),
    setRoots: vi.fn(async (roots) => roots),
    playlists: vi.fn(async () => []),
    ...overrides,
  };
}

describe('LibraryPage', () => {
  it('the library lists discs and filters by text', async () => {
    render(<LibraryPage api={fakeApi()} />);
    expect(await screen.findByText('LANTERN_HARBOR_D1')).toBeTruthy();
    expect(screen.getByText('7 playlists')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /D[12]$/ })).toHaveLength(3);
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

  it('with no library folders it explains and lets the user add one', async () => {
    const setRoots = vi.fn(async (roots: readonly string[]) => roots);
    const api = fakeApi({ roots: [], discs: [] }, { setRoots });
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
    const api = fakeApi({ roots: ['/media/a', '/media/b'] });
    render(<LibraryPage api={api} />);
    await screen.findByText('LANTERN_HARBOR_D1');
    fireEvent.click(screen.getByRole('button', { name: 'Remove /media/a' }));
    await waitFor(() => expect(api.setRoots).toHaveBeenCalledWith(['/media/b']));
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    await waitFor(() => expect(api.rescan).toHaveBeenCalled());
  });
});
