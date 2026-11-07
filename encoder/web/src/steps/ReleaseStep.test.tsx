// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useReducer } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HelperApi } from '../api';
import { ApiError } from '../api';
import type { ReleaseAnswer, SeaDexAnswer, TitleHit } from '../api-types';
import { initialState, reduce } from '../helper-model';
import { ReleaseStep } from './ReleaseStep';

afterEach(cleanup);

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
    ...overrides,
  };
}

function Harness({ api }: { api: HelperApi }) {
  const [state, dispatch] = useReducer(reduce, initialState());
  return <ReleaseStep api={api} state={state} dispatch={dispatch} />;
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
    const summary = await screen.findByRole('region', { name: /Fetched release/i });
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
    await screen.findByRole('region', { name: /Fetched release/i });
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.queryByRole('button', { name: /GroupA/ })).toBeNull();
    expect(screen.queryByRole('region', { name: /Fetched release/i })).toBeNull();
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
    await screen.findByRole('region', { name: /Fetched release/i });
    const box = screen.getByRole('searchbox', { name: /show/i });
    fireEvent.change(box, { target: { value: 'lantern' } });
    fireEvent.submit(box.closest('form')!);
    fireEvent.click(await screen.findByRole('button', { name: /ランタン港/ }));
    await waitFor(() => expect(api.seadex).toHaveBeenCalled());
    expect(screen.getByRole('region', { name: /Fetched release/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('region', { name: /Fetched release/i })).toBeTruthy();
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
});
