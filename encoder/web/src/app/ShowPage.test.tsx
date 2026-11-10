// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render as rtlRender, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, LibraryAnswer, NasSeason, NasShowAnswer } from '../api-types';
import type { AppApi } from './app-api';
import type { JobsStore } from './job-events';
import { JobsProvider } from './jobs-context';
import { makeJob, UNUSED_ANILIST_API, UNUSED_JOB_API, UNUSED_NAS_API } from './job-test-support';
import { SeasonPage, SeasonQueue, ShowPage } from './ShowPage';
import { checked3, disc, groups, KEY, season } from './shows-test-support';

afterEach(cleanup);

/** Renders `ui` under a queue holding `jobs`. */
function render(ui: ReactElement, jobs: readonly Job[] = []) {
  const snapshot = { jobs, progress: {}, problem: null };
  const store: JobsStore = { subscribe: () => () => {}, getSnapshot: () => snapshot, applyJob: () => {}, dropJob: () => {} };
  return rtlRender(<JobsProvider store={store}>{ui}</JobsProvider>);
}
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
    expect(queueButton().getAttribute('aria-describedby')).toBe(screen.getByText('Check disc 3 first').id);
  });

  it('warns about a checked disc that misses episodes to encode, offers Check episodes again and blocks Queue', async () => {
    const short = season({}, { checked: true, checkedPlaylists: [{ id: '00001', episodeSpec: '1-2,3-', groups: groups([9, 12]) }] });
    render(<SeasonPage api={fakeApi(answer([short]))} titleId={TITLE} seasonId="anilist:990001#season" />);
    await screen.findByRole('heading', { name: 'Season 2' });
    const disc3 = screen.getByRole('region', { name: 'Disc 3' });
    expect(within(disc3).getByText("Disc 3's checked episodes don't include 10 and 11: check it again.")).toBeTruthy();
    expect(within(disc3).getByRole('link', { name: 'Check episodes' })).toBeTruthy();
    expect(within(disc3).queryByText('Checked')).toBeNull();
    expect(queueButton().disabled).toBe(true);
  });

  it('marks what a NAS job in the queue already encodes as Queued and leaves it out', async () => {
    const job = makeJob({ disc: { key: KEY(3), label: 'D3', dir: '/x' }, playlist: '00001', episodeSpec: '1-2,3-4,5-6,7-', state: 'queued' });
    const nasJob: Job = { ...job, settings: { ...job.settings, destination: 'nas' } };
    render(<SeasonPage api={fakeApi(answer([season({}, checked3)]))} titleId={TITLE} seasonId="anilist:990001#season" />, [nasJob]);
    await screen.findByRole('heading', { name: 'Season 2' });
    expect(within(screen.getByRole('region', { name: 'Disc 3' })).getAllByText('Queued')).toHaveLength(4);
    expect(queueButton().textContent).toBe('Queue 3 episodes to the NAS');
  });

  it('claims no count while a disc of a season with no episode list is unchecked, and lists checked groups', async () => {
    const own = { source: 'own', ownId: '5f0c2a1e-0000-4000-8000-000000000001', season: 1 } as const;
    const s: NasSeason = {
      id: `own:${own.ownId}#s1`,
      label: 'Season 1',
      number: 1,
      title: own,
      discs: [disc(1, { checked: true, checkedPlaylists: [{ id: '00003', episodeSpec: '1-4,5-', groups: groups([1, 2], [1], own) }] }), disc(2)],
    };
    render(<SeasonPage api={fakeApi(answer([s]))} titleId={TITLE} seasonId={s.id} />);
    await screen.findByRole('heading', { name: 'Season 1' });
    const button = screen.getByRole('button', { name: 'Queue to the NAS' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByText(/\d+ to encode/)).toBeNull();
    const disc1 = screen.getByRole('region', { name: 'Disc 1' });
    expect(within(disc1).getByText('Encoded')).toBeTruthy();
    expect(within(disc1).getByText('To encode')).toBeTruthy();
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

  it('leaves out of the batch what a NAS job in the queue already encodes', async () => {
    const job = makeJob({ disc: { key: KEY(3), label: 'D3', dir: '/x' }, playlist: '00001', episodeSpec: '1-2,3-4,5-6,7-', only: [1, 2], state: 'running' });
    render(<SeasonQueue api={fakeApi(answer([season({}, checked3)]))} titleId={TITLE} seasonId="anilist:990001#season" />, [
      { ...job, settings: { ...job.settings, destination: 'nas' } },
    ]);
    const items = within(await screen.findByRole('list', { name: 'Encodes to queue' })).getAllByRole('listitem');
    expect(items[1]!.textContent).toContain('Episodes 3 and 4');
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
