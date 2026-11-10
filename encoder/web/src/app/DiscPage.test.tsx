// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryAnswer, PlaylistSummary } from '../api-types';
import { ApiError } from '../api';
import type { AppApi } from './app-api';
import { DiscPage } from './DiscPage';
import { UNUSED_ANILIST_API, UNUSED_JOB_API, UNUSED_NAS_API } from './job-test-support';

afterEach(cleanup);

const KEY = `f.${'b'.repeat(32)}`;

const playlists: PlaylistSummary[] = [
  { id: '00001', durationMs: 90_000, clips: 1, chapters: 1, likelyMain: false },
  { id: '00800', durationMs: 4_350_000, clips: 3, chapters: 12, likelyMain: true },
  { id: '00002', durationMs: 1_500_000, clips: 2, chapters: 5, likelyMain: false },
];

const library = (discs: LibraryAnswer['discs']): LibraryAnswer => ({
  roots: ['/media/discs'],
  savedRoots: ['/media/discs'],
  runRoots: [],
  unreadableRoots: [],
  scanning: false,
  discs,
});

const listed: LibraryAnswer['discs'] = [
  { key: KEY, label: 'LANTERN_HARBOR_D1', relPath: 'LANTERN_HARBOR_D1', root: '/media/discs', playlistCount: 3, recordPlaylists: ['00800'], otherPaths: [] },
];

function fakeApi(discs: LibraryAnswer['discs'] = listed): AppApi {
  return {
    library: vi.fn(async () => library(discs)),
    rescan: vi.fn(async () => undefined),
    setRoots: vi.fn(async (r) => r),
    playlists: vi.fn(async () => playlists),
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
  };
}

describe('DiscPage', () => {
  it('the disc page lists playlists longest first and links to episodes', async () => {
    render(<DiscPage api={fakeApi()} discKey={KEY} />);
    expect(await screen.findByRole('heading', { name: 'LANTERN_HARBOR_D1' })).toBeTruthy();
    expect(document.title).toBe('LANTERN_HARBOR_D1');
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

  it('names other copies of the disc with the folder name and the full path as a title', async () => {
    const copy = { ...listed[0]!, otherPaths: [{ relPath: 'LANTERN_COPY', root: '/media/old' }] };
    const api = fakeApi([copy]);
    vi.mocked(api.library).mockResolvedValue({ ...library([copy]), roots: ['/media/discs', '/media/old'] });
    render(<DiscPage api={api} discKey={KEY} />);
    const note = await screen.findByText('Also at old / LANTERN_COPY');
    expect(note.getAttribute('title')).toBe('/media/old');
  });

  it('says so when the disc is not in the library, and links back to it', async () => {
    render(<DiscPage api={fakeApi([])} discKey={KEY} />);
    expect((await screen.findByRole('alert')).textContent).toContain('not in the library');
    expect(screen.getByRole('link', { name: 'Back to the library' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Disc' })).toBeNull();
  });

  it('says the same when the backend does not know the disc', async () => {
    const api = fakeApi();
    api.playlists = vi.fn(async () => {
      throw new ApiError(404, 'disc-changed', 'The disc changed.');
    });
    render(<DiscPage api={api} discKey={KEY} />);
    expect((await screen.findByRole('alert')).textContent).toContain('not in the library');
  });

  it('shows the error when the playlists cannot be read', async () => {
    const api = fakeApi();
    api.playlists = vi.fn(async () => {
      throw new Error('the app is not answering');
    });
    render(<DiscPage api={api} discKey={KEY} />);
    expect((await screen.findByRole('alert')).textContent).toContain('the app is not answering');
  });

  it('says the library is being scanned, not that the disc is missing, until the scan ends', async () => {
    const api = fakeApi();
    let scanning = true;
    setTimeout(() => (scanning = false), 300);
    api.library = vi.fn(async () => ({ ...library(scanning ? [] : listed), scanning }));
    api.playlists = vi.fn(async () => {
      if (scanning) throw new ApiError(404, 'disc-changed', 'The helper serves no disc with that key.');
      return playlists;
    });
    render(<DiscPage api={api} discKey={KEY} />);
    expect(await screen.findByText('Scanning the library…')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'LANTERN_HARBOR_D1' }, { timeout: 3000 })).toBeTruthy();
  });

  it('says the disc is not in the library once the scan is over', async () => {
    const api = fakeApi([]);
    api.playlists = vi.fn(async () => {
      throw new ApiError(404, 'disc-changed', 'The helper serves no disc with that key.');
    });
    render(<DiscPage api={api} discKey={KEY} />);
    expect((await screen.findByRole('alert')).textContent).toContain('not in the library');
  });

  it('lands on not-in-library when the scan ends without the disc after a poll began', async () => {
    const api = fakeApi([]);
    let scanning = true;
    setTimeout(() => (scanning = false), 300);
    api.library = vi.fn(async () => ({ ...library([]), scanning }));
    api.playlists = vi.fn(async () => {
      throw new ApiError(404, 'disc-changed', 'The helper serves no disc with that key.');
    });
    render(<DiscPage api={api} discKey={KEY} />);
    expect(await screen.findByText('Scanning the library…')).toBeTruthy();
    expect((await screen.findByRole('alert', {}, { timeout: 3000 })).textContent).toContain('not in the library');
    expect(screen.queryByText('Scanning the library…')).toBeNull();
  });
});
