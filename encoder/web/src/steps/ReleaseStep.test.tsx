// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useReducer } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HelperApi } from '../api';
import { ApiError } from '../api';
import type { EpisodesAnswer, ReleaseAnswer, SeaDexAnswer, TitleHit } from '../api-types';
import { initialState, reduce } from '../helper-model';
import { MatchStep } from './MatchStep';
import { ReleaseStep } from './ReleaseStep';

afterEach(cleanup);

/** The text of the elements `el`'s `aria-describedby` names, joined by spaces. */
function description(el: HTMLElement): string {
  const ids = el.getAttribute('aria-describedby')?.split(/\s+/).filter((id) => id !== '') ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

const hit: TitleHit = { alId: 900101, title: 'Lantern Harbor', nativeTitle: 'ランタン港', year: 2021, format: 'TV', episodes: 12, poster: null };
const seadexAnswer: SeaDexAnswer = {
  notes: 'GroupA is best.',
  comparison: '',
  url: 'https://releases.example/900101',
  releases: [
    { group: 'GroupA', tracker: 'Nyaa', isBest: true, dualAudio: true, tags: ['Dual Audio'], toshoId: 11, unavailable: null },
    { group: 'GroupB', tracker: 'Nyaa', isBest: false, dualAudio: false, tags: [], toshoId: 12, unavailable: null },
    { group: 'GroupP', tracker: 'PrivateTracker', isBest: false, dualAudio: false, tags: [], toshoId: null, unavailable: 'private-tracker' },
  ],
};
const track = (id: string, path: string) => ({ id, name: 'Full', language: 'eng', path, kind: 'full' as const, dialogueLines: 10 });
const answer: ReleaseAnswer = {
  key: 'tosho-11',
  source: 'tosho',
  label: 'GroupA release',
  group: 'GroupA',
  files: [
    { id: 'f1', name: 'Lantern Harbor - 01.mkv', tracks: [track('2', 'a/1/2.ass'), track('3', 'a/1/3.ass')] },
    { id: 'f2', name: 'Lantern Harbor - 02.mkv', tracks: [track('2', 'a/2/2.ass')] },
  ],
  fonts: [{ name: 'Font.ttf', path: 'a/f/Font.ttf' }],
  match: {
    rows: [
      { episode: 1, fileId: 'f1', candidates: ['f1'] },
      { episode: 2, fileId: 'f2', candidates: ['f2'] },
    ],
    unmatched: [],
  },
};

const answerB: ReleaseAnswer = {
  ...answer,
  key: 'tosho-12',
  label: 'GroupB release',
  group: 'GroupB',
  files: [{ id: 'g1', name: 'Lantern Harbor - 01.mkv', tracks: [track('2', 'b/1/2.ass')] }],
  fonts: [],
  match: { rows: [{ episode: 1, fileId: 'g1', candidates: ['g1'] }, { episode: 2, fileId: null, candidates: [] }], unmatched: [] },
};

/** An API whose fetches answer by Anime Tosho id: 11 is GroupA's release, 12 is GroupB's. */
function poolApi(overrides: Partial<HelperApi> = {}): HelperApi {
  return fakeApi({
    fetchRelease: vi.fn(async (id: number) => (id === 11 ? answer : answerB)),
    release: vi.fn(async (key: string) => (key === 'tosho-11' ? answer : answerB)),
    ...overrides,
  });
}

async function pickBoth(api: HelperApi) {
  await searchAndPick(api);
  fireEvent.click(await screen.findByRole('button', { name: /^GroupA/ }));
  await waitFor(() => expect(screen.getAllByRole('listitem').some((li) => /GroupA release/.test(li.textContent ?? ''))).toBe(true));
  fireEvent.click(await screen.findByRole('button', { name: /^GroupB/ }));
  await screen.findByText('GroupB release');
}

function fakeApi(overrides: Partial<HelperApi> = {}): HelperApi {
  const notCalled = () => Promise.reject(new Error('not expected'));
  return {
    session: notCalled,
    episodes: notCalled,
    searchTitles: vi.fn(async () => [hit]),
    episodeTitles: notCalled,
    seadex: vi.fn(async () => seadexAnswer),
    searchTosho: vi.fn(async () => []),
    fetchRelease: vi.fn(async () => answer),
    upload: vi.fn(async () => answer),
    release: vi.fn(async () => answer),
    align: notCalled,
    subtitleUrl: () => '',
    fontUrl: () => '',
    record: notCalled,
    saveRecord: notCalled,
    episodeInfo: vi.fn(async () => null),
    saveEpisodeInfo: notCalled,
    remoteDisc: notCalled,
    ...overrides,
  };
}

function Harness({ api }: { api: HelperApi }) {
  const [state, dispatch] = useReducer(reduce, initialState());
  return <ReleaseStep api={api} state={state} dispatch={dispatch} />;
}

const twoEpisodes: EpisodesAnswer = {
  episodes: [1, 2].map((index) => ({ index, startUs: index * 1_000_000, durationUs: 1_000_000, chapters: [{ startUs: index * 1_000_000 }] })),
  audio: [],
  pgCount: 0,
};

/** Step 1, then step 2 once the state moves there. */
function StepsHarness({ api }: { api: HelperApi }) {
  const [state, dispatch] = useReducer(reduce, initialState());
  return state.step === 1 ? <ReleaseStep api={api} state={state} dispatch={dispatch} /> : <MatchStep api={api} state={state} dispatch={dispatch} episodes={twoEpisodes} />;
}

async function searchAndPick(api: HelperApi) {
  render(<Harness api={api} />);
  const box = screen.getByRole('searchbox', { name: /show/i });
  fireEvent.change(box, { target: { value: 'lantern' } });
  fireEvent.submit(box.closest('form')!);
  fireEvent.click(await screen.findByRole('button', { name: /Lantern Harbor/ }));
}

describe('ReleaseStep', () => {
  it('searches AniList only when submitted', async () => {
    const api = fakeApi();
    render(<Harness api={api} />);
    const box = screen.getByRole('searchbox', { name: /show/i });
    fireEvent.change(box, { target: { value: 'lantern' } });
    expect(api.searchTitles).not.toHaveBeenCalled();
    fireEvent.submit(box.closest('form')!);
    await screen.findByRole('button', { name: /Lantern Harbor/ });
    expect(api.searchTitles).toHaveBeenCalledTimes(1);
    expect(api.searchTitles).toHaveBeenCalledWith('lantern');
  });

  it('asks SeaDex only after a show is picked, with its id', async () => {
    const api = fakeApi();
    render(<Harness api={api} />);
    expect(api.seadex).not.toHaveBeenCalled();
    expect(screen.getByText(/search for the show first/i)).toBeTruthy();
    const box = screen.getByRole('searchbox', { name: /show/i });
    fireEvent.change(box, { target: { value: 'lantern' } });
    fireEvent.submit(box.closest('form')!);
    const result = await screen.findByRole('button', { name: /Lantern Harbor/ });
    expect(api.seadex).not.toHaveBeenCalled();
    fireEvent.click(result);
    await waitFor(() => expect(api.seadex).toHaveBeenCalledWith(900101));
    expect(api.seadex).toHaveBeenCalledTimes(1);
  });

  it('lets the Anime Tosho search and own files work before a show is picked', () => {
    render(<Harness api={fakeApi()} />);
    expect(screen.getByRole('searchbox', { name: /Anime Tosho/i })).toBeTruthy();
    const input = screen.getByLabelText(/Add your own files/i) as HTMLInputElement;
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe('.ass,.ssa,.srt,.ttf,.otf,.ttc,.woff,.woff2');
  });

  it('lists SeaDex releases with the private one disabled', async () => {
    await searchAndPick(fakeApi());
    const a = await screen.findByRole('button', { name: /GroupA/ });
    expect((a as HTMLButtonElement).disabled).toBe(false);
    expect(a.textContent).toMatch(/Best/);
    expect(a.textContent).toMatch(/Dual Audio/);
    const p = screen.getByRole('button', { name: /GroupP/ }) as HTMLButtonElement;
    expect(p.disabled).toBe(true);
    expect(p.textContent).toMatch(/Private tracker/);
    const link = screen.getByRole('link', { name: /Open on SeaDex/ });
    expect(link.getAttribute('href')).toBe('https://releases.example/900101');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(screen.getByText('GroupA is best.')).toBeTruthy();
  });

  it('picking GroupA fetches and shows the summary', async () => {
    const api = fakeApi();
    await searchAndPick(api);
    fireEvent.click(await screen.findByRole('button', { name: /GroupA/ }));
    const summary = await screen.findByRole('region', { name: /Releases in use/i });
    expect(api.fetchRelease).toHaveBeenCalledWith(11, 0);
    expect(summary.textContent).toMatch(/2 episodes/);
    expect(summary.textContent).toMatch(/3 tracks/);
    expect(summary.textContent).toMatch(/eng/);
    expect(summary.textContent).toMatch(/1 font/);
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('changing the show clears the SeaDex list and the release', async () => {
    await searchAndPick(fakeApi());
    fireEvent.click(await screen.findByRole('button', { name: /GroupA/ }));
    await screen.findByRole('region', { name: /Releases in use/i });
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.queryByRole('button', { name: /GroupA/ })).toBeNull();
    expect(screen.queryByRole('region', { name: /Releases in use/i })).toBeNull();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('searchbox', { name: /show/i })).toBeTruthy();
  });

  it.each([
    ['local', async () => fireEvent.change(screen.getByLabelText(/Add your own files/i), { target: { files: [new File(['x'], 'a.ass')] } })],
    [
      'tosho',
      async () => {
        const box = screen.getByRole('searchbox', { name: /Anime Tosho/i });
        fireEvent.change(box, { target: { value: 'lantern' } });
        fireEvent.submit(box.closest('form')!);
        fireEvent.click(await screen.findByRole('button', { name: /Lantern Harbor \[GroupT\]/ }));
      },
    ],
  ])('keeps a %s release when the show is picked and changed', async (_name, addRelease) => {
    const api = fakeApi({ searchTosho: vi.fn(async () => [{ toshoId: 21, title: 'Lantern Harbor [GroupT]', date: 1700000000 }]) });
    render(<Harness api={api} />);
    await addRelease();
    await screen.findByRole('region', { name: /Releases in use/i });
    const box = screen.getByRole('searchbox', { name: /show/i });
    fireEvent.change(box, { target: { value: 'lantern' } });
    fireEvent.submit(box.closest('form')!);
    fireEvent.click(await screen.findByRole('button', { name: /ランタン港/ }));
    await waitFor(() => expect(api.seadex).toHaveBeenCalled());
    expect(screen.getByRole('region', { name: /Releases in use/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('region', { name: /Releases in use/i })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the newest AniList results when an earlier search answers late', async () => {
    let releaseFirst: (hits: TitleHit[]) => void = () => {};
    const first = new Promise<TitleHit[]>((r) => (releaseFirst = r));
    const searchTitles = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce([{ ...hit, alId: 2, title: 'Newer Show' }]);
    render(<Harness api={fakeApi({ searchTitles })} />);
    const box = screen.getByRole('searchbox', { name: /show/i });
    fireEvent.change(box, { target: { value: 'old' } });
    fireEvent.submit(box.closest('form')!);
    fireEvent.change(box, { target: { value: 'new' } });
    fireEvent.submit(box.closest('form')!);
    await screen.findByRole('button', { name: /Newer Show/ });
    releaseFirst([hit]);
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: /Lantern Harbor/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Newer Show/ })).toBeTruthy();
  });

  it('a 503 shows the retry message beside the release list', async () => {
    const api = fakeApi({ seadex: vi.fn(async () => Promise.reject(new ApiError(503, 'source-unavailable', 'x', { source: 'SeaDex' }))) });
    await searchAndPick(api);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/not answering/i);
    expect(alert.textContent).toMatch(/try again/i);
  });

  it('picking two releases lists both in use', async () => {
    await pickBoth(poolApi());
    const region = screen.getByRole('region', { name: /Releases in use/i });
    const items = region.querySelectorAll('li.release-in-use');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toMatch(/GroupA release/);
    expect(items[0]!.textContent).toMatch(/GroupA, SeaDex/);
    expect(items[0]!.textContent).toMatch(/2 episodes, 3 tracks/);
    expect(items[1]!.textContent).toMatch(/GroupB release/);
    expect(items[1]!.textContent).toMatch(/1 episode, 1 track/);
  });

  it('Remove drops a release and its episodes', async () => {
    await pickBoth(poolApi());
    fireEvent.click(screen.getByRole('button', { name: 'Remove GroupA release' }));
    const region = screen.getByRole('region', { name: /Releases in use/i });
    expect(region.querySelectorAll('li.release-in-use')).toHaveLength(1);
    expect(region.textContent).not.toMatch(/GroupA release/);
    // GroupB numbers only episode 1, so one episode has a file
    expect(region.textContent).toMatch(/1 episode, 1 track/);
    fireEvent.click(screen.getByRole('button', { name: 'Remove GroupB release' }));
    expect(screen.queryByRole('region', { name: /Releases in use/i })).toBeNull();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an already pooled release shows as added and picking it again fetches it again', async () => {
    const api = poolApi();
    await searchAndPick(api);
    fireEvent.click(await screen.findByRole('button', { name: /^GroupA/ }));
    await screen.findByRole('region', { name: /Releases in use/i });
    const row = screen.getByRole('button', { name: /^GroupA/ });
    expect(row.textContent).toMatch(/Added/);
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /^GroupB/ }).textContent).not.toMatch(/Added/);
    fireEvent.click(row);
    await waitFor(() => expect(api.fetchRelease).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('region', { name: /Releases in use/i }).querySelectorAll('li.release-in-use')).toHaveLength(1);
  });

  it('changing the offset fetches every pooled release again', async () => {
    const api = poolApi();
    await pickBoth(api);
    const box = screen.getByRole('spinbutton');
    fireEvent.change(box, { target: { value: '2' } });
    fireEvent.blur(box);
    await waitFor(() => expect(api.release).toHaveBeenCalledTimes(2));
    expect(api.release).toHaveBeenCalledWith('tosho-11', 2);
    expect(api.release).toHaveBeenCalledWith('tosho-12', 2);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failed refetch keeps that release, re-adds the others and names it beside the offset', async () => {
    const shifted: ReleaseAnswer = { ...answer, match: { rows: [{ episode: 1, fileId: 'f2', candidates: ['f2'] }, { episode: 2, fileId: null, candidates: [] }], unmatched: [] } };
    const api = poolApi({ release: vi.fn(async (key: string) => (key === 'tosho-11' ? shifted : Promise.reject(new Error('gone')))) });
    await pickBoth(api);
    const box = screen.getByRole('spinbutton');
    fireEvent.change(box, { target: { value: '1' } });
    fireEvent.blur(box);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/GroupB release/);
    expect(alert.textContent).not.toMatch(/GroupA release/);
    // GroupA was re-added at the new offset (one episode with one track), GroupB stays pooled
    const items = screen.getByRole('region', { name: /Releases in use/i }).querySelectorAll('li.release-in-use');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toMatch(/1 episode, 1 track/);
  });

  it('a pick that was fetched at an offset the user has since changed is fetched again at the new one', async () => {
    let resolveFirst: (a: ReleaseAnswer) => void = () => {};
    const fetchRelease = vi.fn().mockImplementationOnce(() => new Promise<ReleaseAnswer>((r) => (resolveFirst = r))).mockResolvedValue(answer);
    const api = poolApi({ fetchRelease });
    await searchAndPick(api);
    fireEvent.click(await screen.findByRole('button', { name: /^GroupA/ }));
    const box = screen.getByRole('spinbutton');
    fireEvent.change(box, { target: { value: '3' } });
    fireEvent.blur(box);
    resolveFirst(answer);
    await screen.findByRole('region', { name: /Releases in use/i });
    expect(fetchRelease).toHaveBeenLastCalledWith(11, 3);
  });

  it('keeps Next off until a release is pooled', async () => {
    await searchAndPick(poolApi());
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a pooled release that matches no episode can still move on, with a hint', async () => {
    const api = poolApi({ fetchRelease: vi.fn(async () => ({ ...answer, match: { rows: [{ episode: 1, fileId: null, candidates: [] }], unmatched: [] } })) });
    await searchAndPick(api);
    fireEvent.click(await screen.findByRole('button', { name: /^GroupA/ }));
    await screen.findByRole('region', { name: /Releases in use/i });
    const next = screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    expect(description(next)).toBe('No file matched an episode; pick them on the Episodes step.');
  });

  it('own files with no episode number: step 1 can move on and step 2 lists them', async () => {
    const own: ReleaseAnswer = {
      key: 'own-1',
      source: 'local',
      label: 'Your files',
      group: '',
      files: [
        { id: 'o1', name: 'harbor-opening.ass', tracks: [track('1', 'o/1/1.ass')] },
        { id: 'o2', name: 'harbor-finale.ass', tracks: [track('1', 'o/2/1.ass')] },
      ],
      fonts: [],
      match: { rows: [{ episode: 1, fileId: null, candidates: [] }, { episode: 2, fileId: null, candidates: [] }], unmatched: [] },
    };
    const api = fakeApi({ upload: vi.fn(async () => own) });
    render(<StepsHarness api={api} />);
    const input = screen.getByLabelText('Add your own files');
    fireEvent.change(input, { target: { files: [new File(['x'], 'harbor-opening.ass'), new File(['y'], 'harbor-finale.ass')] } });
    await screen.findByRole('region', { name: /Releases in use/i });
    const next = screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    const unmatched = await screen.findByRole('region', { name: 'Not matched' });
    expect(within(unmatched).getByText('harbor-opening.ass')).toBeTruthy();
    expect(within(unmatched).getByText('harbor-finale.ass')).toBeTruthy();
  });
});
