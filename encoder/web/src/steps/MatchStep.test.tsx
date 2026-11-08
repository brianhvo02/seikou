// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useReducer } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HelperApi } from '../api';
import type { CachedTrack, ReleaseAnswer, TitleHit } from '../api-types';
import { initialState, reduce } from '../helper-model';
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

function Harness({ api, offset = 0 }: { api: HelperApi; offset?: number }) {
  const [state, dispatch] = useReducer(reduce, initialState(), (s) => {
    const withTitle = reduce(reduce(s, { type: 'setTitle', title: hit }), { type: 'setOffset', offset });
    return reduce(withTitle, { type: 'addRelease', release: answer, from: 'tosho' });
  });
  return <MatchStep api={api} state={state} dispatch={dispatch} />;
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
});
