// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useReducer } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HelperApi } from '../api';
import type { CachedTrack, EpisodesAnswer, ReleaseAnswer, TitleHit } from '../api-types';
import { initialState, reduce, type HelperAction } from '../helper-model';
import { fileValue } from './match-model';
import { MatchStep } from './MatchStep';

afterEach(cleanup);

const hit: TitleHit = { alId: 900101, title: 'Lantern Harbor', nativeTitle: null, year: 2021, format: 'TV', episodes: 3, poster: null };
const track = (id: string, path: string, kind: CachedTrack['kind'], name: string): CachedTrack => ({ id, name, language: 'eng', path, kind, dialogueLines: 10 });
const answer: ReleaseAnswer = {
  key: 'tosho-11',
  source: 'tosho',
  label: 'GroupA release',
  group: 'GroupA',
  files: [
    { id: 'f1', name: 'Lantern Harbor - 01.mkv', tracks: [track('2', 'a/1/2.ass', 'full', 'Full dialogue'), track('3', 'a/1/3.ass', 'signs', 'Signs and songs')] },
    { id: 'f2', name: 'Lantern Harbor - 02.mkv', tracks: [track('2', 'a/2/2.ass', 'full', 'Full dialogue')] },
    { id: 'f9', name: 'Lantern Harbor - Special.mkv', tracks: [track('2', 'a/9/2.ass', 'full', 'Full dialogue')] },
  ],
  fonts: [],
  match: {
    rows: [
      { episode: 1, fileId: 'f1', candidates: ['f1'] },
      { episode: 2, fileId: 'f2', candidates: ['f2'] },
      { episode: 3, fileId: null, candidates: [] },
    ],
    unmatched: [{ id: 'f9', name: 'Lantern Harbor - Special.mkv', tracks: [track('2', 'a/9/2.ass', 'full', 'Full dialogue')] }],
  },
};

function fakeApi(titles: Record<number, string>): HelperApi {
  const notCalled = () => Promise.reject(new Error('not expected'));
  return {
    session: notCalled,
    episodes: notCalled,
    searchTitles: notCalled,
    episodeTitles: vi.fn(async () => titles),
    seadex: notCalled,
    searchTosho: notCalled,
    fetchRelease: notCalled,
    upload: notCalled,
    release: notCalled,
    align: notCalled,
    subtitleUrl: () => '',
    fontUrl: () => '',
    record: notCalled,
    saveRecord: notCalled,
    remoteDisc: notCalled,
  };
}

const episodes: EpisodesAnswer = {
  episodes: [1, 2, 3].map((index) => ({ index, startUs: index * 1_000_000, durationUs: 1_000_000, chapters: [{ startUs: index * 1_000_000 }] })),
  audio: [],
  pgCount: 0,
};

/** A second release whose file ids repeat the first's, with its own episode 3 file. */
const other: ReleaseAnswer = {
  key: 'own-7',
  source: 'local',
  label: 'Own files',
  group: 'Me',
  files: [
    { id: 'f1', name: 'Own - 01.mkv', tracks: [track('5', 'b/1/5.srt', 'full', 'Plain text')] },
    { id: 'f3', name: 'Own - 03.mkv', tracks: [track('6', 'b/3/6.ass', 'full', 'Own dialogue')] },
  ],
  fonts: [],
  match: {
    rows: [
      { episode: 1, fileId: 'f1', candidates: ['f1'] },
      { episode: 2, fileId: null, candidates: [] },
      { episode: 3, fileId: 'f3', candidates: ['f3'] },
    ],
    unmatched: [],
  },
};

function Harness({ api, offset = 0, extra = [], pool = [answer], after = [] }: { api: HelperApi; offset?: number; extra?: ReleaseAnswer[]; pool?: ReleaseAnswer[]; after?: HelperAction[] }) {
  const [state, dispatch] = useReducer(reduce, initialState(), (s) => {
    let next = reduce(reduce(s, { type: 'setTitle', title: hit }), { type: 'setOffset', offset });
    for (const r of [...pool, ...extra]) next = reduce(next, { type: 'addRelease', release: r, from: r.source });
    for (const a of after) next = reduce(next, a);
    return next;
  });
  return <MatchStep api={api} state={state} dispatch={dispatch} episodes={episodes} />;
}

const rowOf = (n: number) => screen.getByRole('group', { name: new RegExp(`^Episode ${n}\\b`) });

describe('MatchStep', () => {
  it('rows show AniList titles', async () => {
    const api = fakeApi({ 1: 'The Harbor Wakes', 2: 'Lamps' });
    render(<Harness api={api} />);
    expect(await screen.findByText('The Harbor Wakes')).toBeTruthy();
    expect(screen.getByText('Lamps')).toBeTruthy();
    expect(api.episodeTitles).toHaveBeenCalledWith(900101);
    // AniList has nothing for episode 3
    expect(within(rowOf(3)).getByText('Episode 3')).toBeTruthy();
  });

  it('with an episode offset, rows show the release numbers and their AniList titles', async () => {
    const api = fakeApi({ 1: 'The Harbor Wakes', 13: 'Tide Line', 14: 'Lamps Again' });
    render(<Harness api={api} offset={12} />);
    expect(await screen.findByText('Tide Line')).toBeTruthy();
    expect(within(rowOf(13)).getByText('Tide Line')).toBeTruthy();
    expect(within(rowOf(14)).getByText('Lamps Again')).toBeTruthy();
    expect(screen.queryByText('The Harbor Wakes')).toBeNull();
    expect(within(rowOf(15)).getByRole('combobox', { name: 'Release file for Episode 15' })).toBeTruthy();
  });

  it('ticks full and signs by default', () => {
    render(<Harness api={fakeApi({})} />);
    const boxes = [
      within(rowOf(1)).getByRole('checkbox', { name: /Full dialogue/ }),
      within(rowOf(1)).getByRole('checkbox', { name: /Signs and songs/ }),
    ] as HTMLInputElement[];
    expect(boxes.every((b) => b.checked)).toBe(true);
  });

  it('unticking a track keeps the rest', () => {
    render(<Harness api={fakeApi({})} />);
    fireEvent.click(within(rowOf(1)).getByRole('checkbox', { name: /Signs and songs/ }));
    expect((within(rowOf(1)).getByRole('checkbox', { name: /Signs and songs/ }) as HTMLInputElement).checked).toBe(false);
    expect((within(rowOf(1)).getByRole('checkbox', { name: /Full dialogue/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('choosing an unmatched file for an episode moves it out of Not matched', async () => {
    render(<Harness api={fakeApi({})} />);
    const list = screen.getByRole('list', { name: 'Not matched' });
    expect(within(list).getByText('Lantern Harbor - Special.mkv')).toBeTruthy();
    fireEvent.change(within(rowOf(3)).getByRole('combobox'), { target: { value: fileValue('tosho-11', 'f9') } });
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Not matched' })).toBeNull());
    expect(within(rowOf(3)).getAllByRole('checkbox', { name: /Full dialogue/ })).toHaveLength(1);
  });

  it("No subtitles disables the row's tracks", () => {
    render(<Harness api={fakeApi({})} />);
    const none = within(rowOf(1)).getByRole('checkbox', { name: 'No subtitles' }) as HTMLInputElement;
    fireEvent.click(none);
    expect(none.checked).toBe(true);
    for (const b of [within(rowOf(1)).getByRole('checkbox', { name: /Full dialogue/ }), within(rowOf(1)).getByRole('checkbox', { name: /Signs and songs/ })]) {
      expect((b as HTMLInputElement).disabled).toBe(true);
    }
    // unticking brings the file's tracks back
    fireEvent.click(none);
    expect((within(rowOf(1)).getByRole('checkbox', { name: /Full dialogue/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('rows offer files from every pooled release, grouped', () => {
    render(<Harness api={fakeApi({})} extra={[other]} />);
    const select = within(rowOf(3)).getByRole('combobox');
    const groups = Array.from(select.querySelectorAll('optgroup'));
    expect(groups.map((g) => g.label)).toEqual(['GroupA release', 'Own files']);
    expect(Array.from(groups[0]!.querySelectorAll('option')).map((o) => o.textContent)).toEqual(['Lantern Harbor - Special.mkv']);
    expect(Array.from(groups[1]!.querySelectorAll('option')).map((o) => o.textContent)).toEqual(['Own - 03.mkv']);
    expect((select.querySelector('option') as HTMLOptionElement).textContent).toBe('No file');
  });

  it('lists every episode with an empty pool', () => {
    render(<Harness api={fakeApi({})} pool={[]} />);
    expect(rowOf(1)).toBeTruthy();
    expect(rowOf(3)).toBeTruthy();
    expect(within(rowOf(2)).getByText('No release file for this episode.')).toBeTruthy();
  });

  it("choosing another release's file swaps the tracks", () => {
    render(<Harness api={fakeApi({})} extra={[other]} />);
    fireEvent.change(within(rowOf(3)).getByRole('combobox'), { target: { value: fileValue('own-7', 'f3') } });
    expect(within(rowOf(3)).getByRole('checkbox', { name: /Own dialogue/ })).toBeTruthy();
    fireEvent.change(within(rowOf(1)).getByRole('combobox'), { target: { value: fileValue('own-7', 'f1') } });
    expect(within(rowOf(1)).queryByRole('checkbox', { name: /Signs and songs/ })).toBeNull();
    expect(within(rowOf(1)).getByRole('checkbox', { name: /Plain text/ })).toBeTruthy();
  });

  it('same file id in two releases picks the right one', () => {
    render(<Harness api={fakeApi({})} extra={[other]} />);
    const select = within(rowOf(1)).getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe(fileValue('tosho-11', 'f1'));
    fireEvent.change(select, { target: { value: fileValue('own-7', 'f1') } });
    expect(select.value).toBe(fileValue('own-7', 'f1'));
    expect(select.selectedOptions[0]!.textContent).toBe('Own - 01.mkv');
  });

  it('a restored choice that is no candidate still shows selected', () => {
    render(<Harness api={fakeApi({})} extra={[other]} after={[{ type: 'chooseFile', episode: 2, releaseKey: 'own-7', fileId: 'f3' }]} />);
    const select = within(rowOf(2)).getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe(fileValue('own-7', 'f3'));
  });

  it('Back goes to step 1', () => {
    const dispatch = vi.fn();
    const state = reduce(initialState(), { type: 'goTo', step: 2 });
    render(<MatchStep api={fakeApi({})} state={state} dispatch={dispatch} episodes={episodes} />);
    const back = screen.getByRole('button', { name: 'Back' });
    const next = screen.getByRole('button', { name: 'Next' });
    expect(back.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(back);
    expect(dispatch).toHaveBeenCalledWith({ type: 'goTo', step: 1 });
  });
});
