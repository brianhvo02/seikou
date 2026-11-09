// @vitest-environment jsdom
// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ContinueItem, EncodeShowList, EncodesStatus } from '@seikou/nas/nas-api';
import { EncodesLibrary } from './EncodesLibrary';
import { NasHttpError, type NasClient } from './nas-client';
import type { NasHistory } from './nas-history';

afterEach(cleanup);

const LIST: EncodeShowList = {
  shows: [
    { id: '100', name: 'Starfall Wanderer', poster: null, episodeCount: 12 },
    { id: '200', name: 'Lantern Tide', poster: null, episodeCount: 1 },
  ],
};

const CARD: ContinueItem = {
  kind: 'resume', discKey: '', discId: '', playlistId: 'mkv', encodeId: '100-2', timeUs: 754_000_000, durationUs: 1_420_000_000,
  titleId: '100', titleName: 'Starfall Wanderer', poster: null, seasonId: '100', seasonNumber: 1, episode: 2, kindOfTitle: 'series',
  updatedAt: 1, deviceName: 'Mac', settings: null,
};

function fakeNas(status: EncodesStatus, shows: () => Promise<EncodeShowList>, over: Record<string, unknown> = {}): NasClient {
  return {
    encodesStatus: vi.fn(async () => status),
    encodeShows: vi.fn(shows),
    continueWatching: vi.fn(async () => []),
    artUrl: vi.fn(async () => null),
    ...over,
  } as unknown as NasClient;
}

function fakeHistory(): NasHistory {
  return { push: vi.fn(), replace: vi.fn(), back: vi.fn(), pushPath: vi.fn(), route: vi.fn(() => ({ kind: 'encodes', q: '' })) } as unknown as NasHistory;
}

const show = (nas: NasClient, owner: boolean, history = fakeHistory()): NasHistory => {
  render(<EncodesLibrary nas={nas} history={history} owner={owner} route={{ kind: 'encodes', q: '' }} onClose={() => {}} player={{} as never} />);
  return history;
};

describe('the Encodes tab', () => {
  it("the encodes tab shows the owner's empty state without ENCODES_DIR", async () => {
    const nas = fakeNas({ configured: false, count: 0 }, async () => {
      throw new NasHttpError(404, 'not found');
    });
    show(nas, true);
    expect(await screen.findByText(/Set ENCODES_MOUNT on the NAS to hold encodes/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'How to set it up' }).getAttribute('href')).toBe('/help/nas#encodes');
    // no folder: no list to ask for
    expect(nas.encodeShows).not.toHaveBeenCalled();
  });

  it('tells an owner with the folder to encode an episode', async () => {
    show(fakeNas({ configured: true, count: 0 }, async () => ({ shows: [], unfiled: [] })), true);
    expect(await screen.findByText('Encode an episode in Seikou encoder to add it here.')).toBeTruthy();
  });

  it('a guest sees the library is currently empty', async () => {
    show(fakeNas({ configured: false, count: 0 }, async () => ({ shows: [] })), false);
    expect(await screen.findByText('The library is currently empty.')).toBeTruthy();
    expect(screen.getByText('Encoded episodes appear here once the owner adds them.')).toBeTruthy();
    expect(screen.queryByText(/ENCODES_MOUNT/)).toBeNull();
  });

  it('says it is indexing, then asks again after Retry-After', async () => {
    let resolve: (l: EncodeShowList) => void = () => {};
    const shows = vi
      .fn<() => Promise<EncodeShowList>>()
      .mockRejectedValueOnce(new NasHttpError(503, 'indexing', { retryAfter: 0.01 }))
      .mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    show(fakeNas({ configured: true, count: 2 }, shows), false);
    expect(await screen.findByText('Indexing the encodes…')).toBeTruthy();
    await waitFor(() => expect(shows).toHaveBeenCalledTimes(2));
    resolve(LIST);
    expect(await screen.findByText('Starfall Wanderer')).toBeTruthy();
    expect(screen.queryByText('Indexing the encodes…')).toBeNull();
  });

  it('lists the shows with their episode counts and opens one', async () => {
    const history = show(fakeNas({ configured: true, count: 13 }, async () => LIST), false);
    const tiles = await screen.findAllByTestId('encode-show-card');
    expect(tiles.map((t) => t.getAttribute('data-show-id'))).toEqual(['100', '200']);
    expect(screen.getByText('12 episodes')).toBeTruthy();
    expect(screen.getByText('1 episode')).toBeTruthy();
    fireEvent.click(tiles[0]!);
    expect(history.push).toHaveBeenCalledWith({ kind: 'encodeShow', showId: '100' });
  });

  it("shows the encodes' Continue watching row, and a card resumes its episode", async () => {
    const nas = fakeNas({ configured: true, count: 13 }, async () => LIST, { continueWatching: vi.fn(async () => [CARD]) });
    const history = show(nas, false);
    const card = await screen.findByTestId('continue-card');
    expect(nas.continueWatching).toHaveBeenCalledWith({ library: 'encodes' });
    fireEvent.click(card);
    expect(history.push).toHaveBeenCalledWith({ kind: 'encodePlay', encodeId: '100-2', timeS: 754, resume: true });
  });

  it('shows owners the files left unfiled, and the folder notices', async () => {
    const list: EncodeShowList = { ...LIST, unfiled: [{ path: 'misc/Untagged 01.mkv', size: 300_000_000 }] };
    show(fakeNas({ configured: true, count: 14, rootEmpty: true }, async () => list), true);
    expect(await screen.findByText('Not filed')).toBeTruthy();
    expect(screen.getByText('misc/Untagged 01.mkv')).toBeTruthy();
    expect(screen.getByText(/carry no AniList tags/)).toBeTruthy();
    expect(screen.getByText('The encodes folder is empty, but the library still lists earlier episodes.')).toBeTruthy();
  });

  it('shows a guest neither unfiled files nor notices', async () => {
    const list: EncodeShowList = { ...LIST, unfiled: [{ path: 'misc/Untagged 01.mkv', size: 1 }] };
    show(fakeNas({ configured: true, count: 14, rootMissing: true }, async () => list), false);
    await screen.findAllByTestId('encode-show-card');
    expect(screen.queryByText('Not filed')).toBeNull();
    expect(screen.queryByText(/isn't there/)).toBeNull();
  });
});
