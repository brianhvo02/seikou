// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaylistSummary } from '../api-types';
import type { AppApi } from './app-api';
import { DiscPage } from './DiscPage';

afterEach(cleanup);

const KEY = `f.${'b'.repeat(32)}`;

const playlists: PlaylistSummary[] = [
  { id: '00001', durationMs: 90_000, clips: 1, chapters: 1, likelyMain: false },
  { id: '00800', durationMs: 4_350_000, clips: 3, chapters: 12, likelyMain: true },
  { id: '00002', durationMs: 1_500_000, clips: 2, chapters: 5, likelyMain: false },
];

function fakeApi(): AppApi {
  return {
    library: vi.fn(async () => ({
      roots: ['/media/discs'],
      unreadableRoots: [],
      scanning: false,
      discs: [{ key: KEY, label: 'LANTERN_HARBOR_D1', relPath: 'LANTERN_HARBOR_D1', root: '/media/discs', playlistCount: 3, recordPlaylists: ['00800'] }],
    })),
    rescan: vi.fn(async () => undefined),
    setRoots: vi.fn(async (r) => r),
    playlists: vi.fn(async () => playlists),
  };
}

describe('DiscPage', () => {
  it('the disc page lists playlists longest first and links to episodes', async () => {
    render(<DiscPage api={fakeApi()} discKey={KEY} />);
    expect(await screen.findByRole('heading', { name: 'LANTERN_HARBOR_D1' })).toBeTruthy();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByTestId('playlist-id').textContent)).toEqual(['00800', '00002', '00001']);
    expect(within(rows[0]!).getByText('1:12:30')).toBeTruthy();
    expect(within(rows[0]!).getByText('3 clips')).toBeTruthy();
    expect(within(rows[0]!).getByText('12 chapters')).toBeTruthy();
    expect(within(rows[0]!).getByText('Likely main')).toBeTruthy();
    expect(within(rows[1]!).queryByText('Likely main')).toBeNull();
    expect(within(rows[0]!).getByText('Subtitle choices saved')).toBeTruthy();
    const link = within(rows[0]!).getByRole('link', { name: 'Episodes' });
    expect(link.getAttribute('href')).toBe(`/disc/f.${'b'.repeat(32)}/00800`);
  });

  it('says so when the disc is not in the library', async () => {
    const api = fakeApi();
    api.playlists = vi.fn(async () => {
      throw new Error('disc-changed');
    });
    render(<DiscPage api={api} discKey={KEY} />);
    expect((await screen.findByRole('alert')).textContent).toContain('disc-changed');
  });
});
