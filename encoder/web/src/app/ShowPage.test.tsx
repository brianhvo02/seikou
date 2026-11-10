// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryAnswer, NasSeason, NasShowAnswer } from '../api-types';
import type { AppApi } from './app-api';
import { UNUSED_ANILIST_API, UNUSED_JOB_API, UNUSED_NAS_API } from './job-test-support';
import { SeasonPage, SeasonQueue, ShowPage } from './ShowPage';
import { KEY, season } from './shows-test-support';

afterEach(cleanup);
beforeEach(() => history.replaceState(null, '', '/?t=tok'));

const TITLE = 'anilist:990001';

function answer(seasons: NasSeason[], over: Partial<NasShowAnswer> = {}): NasShowAnswer {
  return {
    title: {
      titleId: TITLE,
      name: 'Starfall Wanderer',
      poster: null,
      kind: 'series',
    },
    seasons,
    reachable: true,
    stale: false,
    ...over,
  };
}

const library: LibraryAnswer = {
  roots: [],
  savedRoots: [],
  runRoots: [],
  unreadableRoots: [],
  scanning: false,
  nas: { paired: true, scanning: false, reachable: true },
  discs: [2, 3].map((n) => ({
    key: KEY(n),
    label: `STARFALL_D${n}`,
    relPath: `starfall/D${n}`,
    root: 'NAS',
    source: 'nas' as const,
    playlistCount: 3,
    recordPlaylists: [],
    otherPaths: [],
  })),
};

function fakeApi(show: NasShowAnswer): AppApi {
  return {
    library: vi.fn(async () => library),
    rescan: vi.fn(),
    setRoots: vi.fn(),
    playlists: vi.fn(),
    playlist: vi.fn(),
    createSession: vi.fn(),
    episodeInfo: vi.fn(),
    saveEpisodeInfo: vi.fn(),
    profiles: vi.fn(async () => []),
    createProfile: vi.fn(),
    updateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    remoteDisc: vi.fn(),
    ...UNUSED_JOB_API,
    ...UNUSED_ANILIST_API,
    ...UNUSED_NAS_API,
    nas: vi.fn(async () => ({
      paired: true as const,
      host: 'nas.example',
      personName: 'Owner',
      reachable: true,
      encodes: 'ready' as const,
    })),
    nasShow: vi.fn(async () => show),
  } as AppApi;
}

const checked3 = {
  checked: true,
  checkedPlaylists: [{ id: '00001', episodeSpec: '1-2,3-4,5-6,7-', episodes: [9, 10, 11, 12] }],
};
const queueButton = (): HTMLButtonElement => screen.getByRole('button', { name: /^Queue \d+ episodes? to the NAS$/ });

describe('SeasonPage', () => {
  it('lists the season disc by disc with Encoded and To encode, and blocks Queue until disc 3 is checked', async () => {
    render(<SeasonPage api={fakeApi(answer([season()]))} titleId={TITLE} seasonId="anilist:990001#season" />);
    expect(await screen.findByRole('heading', { name: 'Season 2' })).toBeTruthy();
    const disc2 = screen.getByRole('region', { name: 'Disc 2' });
    expect(within(disc2).getByText('Checked')).toBeTruthy();
    expect(within(disc2).getAllByText('To encode')).toHaveLength(3);
    expect(within(disc2).getAllByText('Encoded')).toHaveLength(1);
    const disc3 = screen.getByRole('region', { name: 'Disc 3' });
    const check = within(disc3).getByRole('link', { name: 'Check episodes' });
    expect(new URL(check.getAttribute('href')!, 'http://x').pathname).toBe(`/disc/${KEY(3)}/00001`);
    expect(new URL(check.getAttribute('href')!, 'http://x').searchParams.get('season')).toBe('anilist:990001#season');
    expect(queueButton().disabled).toBe(true);
    expect(queueButton().textContent).toBe('Queue 7 episodes to the NAS');
    expect(screen.getByText('Check disc 3 first')).toBeTruthy();
  });

  it('enables Queue once every disc is checked, and opens the batch queue', async () => {
    render(<SeasonPage api={fakeApi(answer([season({}, checked3)]))} titleId={TITLE} seasonId="anilist:990001#season" />);
    await screen.findByRole('heading', { name: 'Season 2' });
    expect(queueButton().disabled).toBe(false);
    fireEvent.click(queueButton());
    expect(location.pathname).toBe(`/shows/${encodeURIComponent(TITLE)}/${encodeURIComponent('anilist:990001#season')}/queue`);
    expect(new URLSearchParams(location.search).get('t')).toBe('tok');
  });

  it('keeps Queue disabled with the reason while the NAS is not answering', async () => {
    render(<SeasonPage api={fakeApi(answer([season()], { reachable: false, stale: true }))} titleId={TITLE} seasonId="anilist:990001#season" />);
    await screen.findByRole('heading', { name: 'Season 2' });
    expect(queueButton().disabled).toBe(true);
    expect(screen.getByText("The NAS isn't answering: this is its last listing")).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Check episodes' })).toBeNull();
  });
});

describe('SeasonQueue', () => {
  it('opens the batch dialog with both jobs', async () => {
    render(<SeasonQueue api={fakeApi(answer([season({}, checked3)]))} titleId={TITLE} seasonId="anilist:990001#season" />);
    const list = await screen.findByRole('list', { name: 'Encodes to queue' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([expect.stringContaining('STARFALL_D2'), expect.stringContaining('STARFALL_D3')]);
    expect(items[0]!.textContent).toContain('Episodes 2, 3 and 4');
    expect(items[1]!.textContent).toContain('Episodes 1, 2, 3 and 4');
  });

  it('refuses to queue a season that is not ready, saying why', async () => {
    render(<SeasonQueue api={fakeApi(answer([season()]))} titleId={TITLE} seasonId="anilist:990001#season" />);
    expect(await screen.findByText('Check disc 3 first')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Encodes to queue' })).toBeNull();
  });
});

describe('ShowPage', () => {
  it('lists the seasons and films, each leading to its page', async () => {
    const film: NasSeason = {
      id: 'anilist:990002#discs',
      label: 'Starfall Wanderer: The Film',
      number: null,
      title: { source: 'anilist', anilistId: 990002 },
      discs: [],
    };
    render(<ShowPage api={fakeApi(answer([season(), film]))} titleId={TITLE} />);
    expect(await screen.findByRole('heading', { name: 'Starfall Wanderer' })).toBeTruthy();
    const s2 = screen.getByRole('link', { name: /Season 2/ });
    expect(s2.textContent).toContain('5 of 12 encoded');
    expect(new URL(s2.getAttribute('href')!, 'http://x').pathname).toBe(`/shows/${encodeURIComponent(TITLE)}/${encodeURIComponent('anilist:990001#season')}`);
    expect(screen.getByRole('link', { name: /The Film/ })).toBeTruthy();
  });
});
