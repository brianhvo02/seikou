// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OwnTitle, TitleSummary } from '@seikou/nas/nas-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import type { TitleHit } from '../api-types';
import type { AppApi } from './app-api';
import type { EpisodeRow } from './episode-info-model';
import { EpisodeTitlePicker, type EpisodeTitlePickerProps } from './EpisodeTitlePicker';

afterEach(cleanup);

const summary = (id: string, display: string, over: Partial<TitleSummary> = {}): TitleSummary => ({
  id,
  kind: 'series',
  names: { english: display, romaji: null, native: null, synonyms: [], display: null },
  poster: null,
  year: 2020,
  seasons: 2,
  discs: 0,
  addedAt: 0,
  own: false,
  ...over,
});

const LOOKUPS: Record<string, TitleSummary[]> = {
  anilist: [summary('anilist:990102', 'Lantern Harbour')],
  tmdb: [summary('tmdb-tv:990101', 'Lantern Harbour'), summary('tmdb-movie:990103', 'Lantern Harbour: The Film', { kind: 'movie', seasons: 0 })],
  own: [summary('own:0b7a1f4e-3c52-4d0a-9a55-2f6e8c1d7b90', 'Lantern Notes', { own: true, names: { english: null, romaji: null, native: null, synonyms: [], display: 'Lantern Notes' } })],
};

const emptyRow: EpisodeRow = { index: 2, firstChapter: 4, title: null, prefilled: false };

function setup(over: { api?: Partial<AppApi>; props?: Partial<EpisodeTitlePickerProps> } = {}) {
  const api = {
    searchAniList: vi.fn(async (): Promise<TitleHit[]> => []),
    lookupTitles: vi.fn(async (_q: string, source: string) => LOOKUPS[source] ?? []),
    createOwnTitle: vi.fn(async (t: { kind: 'series' | 'movie'; name: string; seasons: number | null }): Promise<OwnTitle> => ({ id: 'own:11111111-2222-3333-4444-555555555555', ...t })),
    ...over.api,
  } as unknown as AppApi;
  const onPick = vi.fn();
  const onPickTitle = vi.fn();
  const onNumber = vi.fn();
  render(<EpisodeTitlePicker api={api} row={emptyRow} show={null} sequel={null} disabled={false} nasPaired onPick={onPick} onPickTitle={onPickTitle} onNumber={onNumber} {...over.props} />);
  return { api: api as unknown as Record<'searchAniList' | 'lookupTitles' | 'createOwnTitle', ReturnType<typeof vi.fn>>, onPick, onPickTitle, onNumber };
}

async function search(text = 'lantern') {
  fireEvent.click(screen.getByRole('button', { name: 'Choose the AniList entry of episode 2' }));
  fireEvent.change(screen.getByLabelText('Search for episode 2'), { target: { value: text } });
  fireEvent.submit(screen.getByRole('search'));
  await screen.findByText('Lantern Notes');
}

describe('EpisodeTitlePicker paired with a NAS', () => {
  it('lists AniList, then TMDB, then the own titles of one search', async () => {
    const { api } = setup();
    await search();
    expect(api.lookupTitles.mock.calls.map((c) => c[1]).sort()).toEqual(['anilist', 'own', 'tmdb']);
    expect(api.searchAniList).not.toHaveBeenCalled();
    const names = screen.getAllByRole('button', { name: /Lantern/ }).map((b) => b.textContent);
    expect(names).toEqual([
      expect.stringContaining('AniList'),
      expect.stringContaining('TMDB'),
      expect.stringContaining('TMDB'),
      expect.stringContaining('Yours'),
    ]);
  });

  it('picks an AniList result as an AniList entry', async () => {
    const { onPick } = setup();
    await search();
    fireEvent.click(screen.getAllByRole('button', { name: /Lantern Harbour/ })[0]!);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ alId: 990102, title: 'Lantern Harbour' }));
  });

  it('asks the season of a TMDB series, and will not finish without one', async () => {
    const { onPickTitle } = setup();
    await search();
    fireEvent.click(screen.getAllByRole('button', { name: /Lantern Harbour/ })[1]!);
    const field = screen.getByLabelText('Season of Lantern Harbour') as HTMLInputElement;
    expect(field.value).toBe('1');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this season' }));
    expect(onPickTitle).not.toHaveBeenCalled();
    expect(screen.getByText('Use a whole number from 1.')).toBeTruthy();
    fireEvent.change(field, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this season' }));
    expect(onPickTitle).toHaveBeenCalledWith({ source: 'tmdb-tv', tmdbId: 990101, season: 2 }, 'Lantern Harbour');
  });

  it('prefills the season from the NAS match', async () => {
    setup({ props: { seasonHint: 2 } });
    await search();
    fireEvent.click(screen.getAllByRole('button', { name: /Lantern Harbour/ })[1]!);
    expect((screen.getByLabelText('Season of Lantern Harbour') as HTMLInputElement).value).toBe('2');
  });

  it('picks a TMDB film and an own series without or with a season', async () => {
    const { onPickTitle } = setup();
    await search();
    fireEvent.click(screen.getByRole('button', { name: /The Film/ }));
    expect(onPickTitle).toHaveBeenLastCalledWith({ source: 'tmdb-movie', tmdbId: 990103 }, 'Lantern Harbour: The Film');
    fireEvent.click(screen.getByRole('button', { name: 'Choose the AniList entry of episode 2' }));
    fireEvent.change(screen.getByLabelText('Search for episode 2'), { target: { value: 'lantern' } });
    fireEvent.submit(screen.getByRole('search'));
    fireEvent.click(await screen.findByRole('button', { name: /Lantern Notes/ }));
    fireEvent.change(screen.getByLabelText('Season of Lantern Notes'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this season' }));
    expect(onPickTitle).toHaveBeenLastCalledWith({ source: 'own', ownId: '0b7a1f4e-3c52-4d0a-9a55-2f6e8c1d7b90', season: 3 }, 'Lantern Notes');
  });

  it('keeps the results that came when one source did not answer, and says so', async () => {
    setup({
      api: {
        lookupTitles: vi.fn(async (_q: string, source: string) => {
          if (source === 'tmdb') throw new ApiError(503, 'source-unreachable', 'The NAS could not reach TMDB.');
          return LOOKUPS[source] ?? [];
        }),
      },
    });
    await search();
    expect(screen.getByRole('alert').textContent).toContain('TMDB did not answer');
    expect(screen.getAllByRole('button', { name: /Lantern/ })).toHaveLength(2);
  });

  it('Add by hand creates an own title on the NAS and picks it', async () => {
    const { api, onPickTitle } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Choose the AniList entry of episode 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add by hand' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add and use' }));
    expect(api.createOwnTitle).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Harbour Notes' } });
    fireEvent.change(screen.getByLabelText('Season'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add and use' }));
    await waitFor(() => expect(onPickTitle).toHaveBeenCalled());
    expect(api.createOwnTitle).toHaveBeenCalledWith({ kind: 'series', name: 'Harbour Notes', seasons: 2 });
    expect(onPickTitle).toHaveBeenCalledWith({ source: 'own', ownId: '11111111-2222-3333-4444-555555555555', season: 2 }, 'Harbour Notes');
  });

  it('Add by hand makes a film with no season', async () => {
    const { api, onPickTitle } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Choose the AniList entry of episode 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add by hand' }));
    fireEvent.click(screen.getByLabelText('Film'));
    expect(screen.queryByLabelText('Season')).toBeNull();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Harbour Film' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add and use' }));
    await waitFor(() => expect(onPickTitle).toHaveBeenCalled());
    expect(api.createOwnTitle).toHaveBeenCalledWith({ kind: 'movie', name: 'Harbour Film', seasons: null });
    expect(onPickTitle).toHaveBeenCalledWith({ source: 'own', ownId: '11111111-2222-3333-4444-555555555555', season: null }, 'Harbour Film');
  });

  it('says why an own title could not be made and picks nothing', async () => {
    const { onPickTitle } = setup({ api: { createOwnTitle: vi.fn(async () => Promise.reject(new ApiError(502, 'unreachable', 'nas.example is not answering.'))) } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose the AniList entry of episode 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add by hand' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Harbour Notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add and use' }));
    expect((await screen.findByRole('alert')).textContent).toContain('not answering');
    expect(onPickTitle).not.toHaveBeenCalled();
  });
});

describe('EpisodeTitlePicker not paired', () => {
  it('searches AniList only and offers no hand entry', async () => {
    const { api } = setup({
      props: { nasPaired: false },
      api: { searchAniList: vi.fn(async (): Promise<TitleHit[]> => [{ alId: 990011, title: 'Lantern Harbor Season 2', nativeTitle: null, year: 2024, format: 'TV', episodes: 12, poster: null }]) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Choose the AniList entry of episode 2' }));
    expect(screen.queryByRole('button', { name: 'Add by hand' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Search AniList for episode 2'), { target: { value: 'lantern' } });
    fireEvent.submit(screen.getByRole('search'));
    expect(await screen.findByRole('button', { name: /Lantern Harbor Season 2/ })).toBeTruthy();
    expect(api.searchAniList).toHaveBeenCalledWith('lantern');
    expect(api.lookupTitles).not.toHaveBeenCalled();
  });
});

describe('EpisodeTitlePicker showing a title of another source', () => {
  it('names a TMDB season by its show name and season', () => {
    setup({
      props: {
        row: { index: 2, firstChapter: 4, title: { title: { source: 'tmdb-tv', tmdbId: 990101, season: 2 }, episode: 3, name: null, showName: 'Lantern Harbour' }, prefilled: false },
      },
    });
    expect(screen.getByText('Lantern Harbour, season 2')).toBeTruthy();
    expect((screen.getByLabelText('AniList episode number of episode 2') as HTMLInputElement).value).toBe('3');
  });
});
