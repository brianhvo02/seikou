// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type HelperApi } from './api';
import type { EpisodesAnswer, ReleaseAnswer, SessionInfo, SubtitleRecord } from './api-types';
import { App } from './App';

afterEach(cleanup);

const session: SessionInfo = { discKey: `f.${'a'.repeat(32)}`, label: 'LANTERN_HARBOR_D1', playlistId: '00000', episodeSpec: '1-3,4-5', toolsReady: true };
const episodes: EpisodesAnswer = {
  episodes: [
    { index: 1, startUs: 0, durationUs: 1, chapters: [{ startUs: 0 }] },
    { index: 2, startUs: 1, durationUs: 1, chapters: [{ startUs: 1 }] },
  ],
  audio: [{ pid: 0x1100, codingType: 0x80, language: 'jpn' }],
  pgCount: 0,
};
const release: ReleaseAnswer = {
  key: 'tosho-7',
  source: 'tosho',
  label: '[GroupA] Lantern Harbor (BD 1080p)',
  group: 'GroupA',
  files: [
    { id: '11', name: 'Lantern Harbor - 01.mkv', tracks: [{ id: 't1', name: 'English', language: 'eng', path: 'releases/tosho-7/11-t1.ass', kind: 'full', dialogueLines: 9 }] },
    { id: '12', name: 'Lantern Harbor - 02.mkv', tracks: [{ id: 't1', name: 'English', language: 'eng', path: 'releases/tosho-7/12-t1.ass', kind: 'full', dialogueLines: 9 }] },
  ],
  fonts: [],
  match: {
    rows: [
      { episode: 1, fileId: '11', candidates: ['11'] },
      { episode: 2, fileId: '12', candidates: ['12'] },
    ],
    unmatched: [],
  },
};

const recordTrack = (file: string) => ({ file, release: 'tosho-7', kind: 'full' as const, language: 'eng', name: 'GroupA full', shiftMs: 1200, nudgeMs: 0, split: null, included: true });
const meta = (title: string) => ({ title, video: { name: '', language: 'und' }, audio: [{ pid: 0x1100, name: 'Japanese', language: 'jpn', included: true }], chapters: ['Chapter 1'] });
const record: SubtitleRecord = {
  disc: { key: session.discKey, label: session.label },
  playlist: '00000',
  episodeSpec: '1-3,4-5',
  anilist: { id: 900101, title: 'Lantern Harbor', episodeOffset: 0 },
  releases: [{ source: 'seadex', id: 'tosho-7', group: 'GroupA', label: release.label }],
  fonts: [],
  episodes: [
    { index: 1, title: 'Arrival', tracks: [recordTrack('releases/tosho-7/11-t1.ass')], metadata: meta('Harbor premiere') },
    { index: 2, title: 'Episode 2', tracks: [recordTrack('releases/tosho-7/12-t1.ass')], metadata: meta('Lantern Harbor - 02') },
  ],
  savedAt: '2026-11-07T10:00:00.000Z',
};

function fakeApi(overrides: Partial<HelperApi> = {}): HelperApi {
  const notCalled = () => Promise.reject(new Error('not expected'));
  return {
    session: vi.fn(async () => session),
    episodes: vi.fn(async () => episodes),
    searchTitles: notCalled,
    episodeTitles: vi.fn(async () => ({})),
    seadex: vi.fn(async () => ({ notes: '', comparison: '', url: 'https://releases.moe/900101/', releases: [] })),
    searchTosho: notCalled,
    fetchRelease: notCalled,
    upload: notCalled,
    release: notCalled,
    align: notCalled,
    subtitleUrl: () => '',
    fontUrl: () => '',
    record: vi.fn(async () => ({ record: null, missing: [] })),
    saveRecord: notCalled,
    remoteDisc: notCalled,
    ...overrides,
  };
}

const stepButton = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('SaveBar', () => {
  it('restores a saved record', async () => {
    const api = fakeApi({ record: vi.fn(async () => ({ record, missing: [] })), release: vi.fn(async () => release) });
    render(<App api={api} />);
    await waitFor(() => expect(stepButton(/Episodes/).disabled).toBe(false));
    expect(api.release).toHaveBeenCalledWith('tosho-7', 0);
    expect(stepButton(/Line up/).disabled).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('Restored the choices saved');
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect((screen.getByLabelText('MKV title') as HTMLInputElement).value).toBe('Harbor premiere');
  });

  it('offers to fetch a missing release again', async () => {
    const api = fakeApi({
      record: vi.fn(async () => ({ record, missing: [{ release: release.label, files: ['releases/tosho-7/11-t1.ass'] }] })),
      release: vi.fn(async () => Promise.reject(new ApiError(404, 'not-found', 'No such release.'))),
      fetchRelease: vi.fn(async () => release),
    });
    render(<App api={api} />);
    const again = await screen.findByRole('button', { name: `Fetch ${release.label} again` });
    expect(stepButton(/Episodes/).disabled).toBe(true);
    fireEvent.click(again);
    await waitFor(() => expect(stepButton(/Episodes/).disabled).toBe(false));
    expect(api.fetchRelease).toHaveBeenCalledWith(7, 0);
    expect(screen.queryByRole('button', { name: `Fetch ${release.label} again` })).toBeNull();
  });

  it('keeps Save off while the saved release is missing, and keeps the saved tracks', async () => {
    const saveRecord = vi.fn(async (r: SubtitleRecord) => r);
    const api = fakeApi({
      record: vi.fn(async () => ({ record, missing: [{ release: release.label, files: ['releases/tosho-7/11-t1.ass'] }] })),
      release: vi.fn(async () => Promise.reject(new ApiError(404, 'not-found', 'No such release.'))),
      saveRecord,
    });
    render(<App api={api} />);
    await screen.findByRole('button', { name: `Fetch ${release.label} again` });
    const save = screen.getByRole('button', { name: 'Save for encoding' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/Saving is off until the release is back/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect((screen.getByLabelText('Name of subtitle track 1') as HTMLInputElement).value).toBe('GroupA full');
  });

  it('says to add the files again when the missing release was the user own', async () => {
    const local = { ...record, releases: [{ source: 'local' as const, id: `local-${'b'.repeat(16)}`, group: '', label: 'Your files' }] };
    const api = fakeApi({
      record: vi.fn(async () => ({ record: local, missing: [{ release: 'Your files', files: ['x.ass'] }] })),
      release: vi.fn(async () => Promise.reject(new ApiError(404, 'not-found', 'No such release.'))),
    });
    render(<App api={api} />);
    expect(await screen.findByText(/Add them again in step 1/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Fetch/ })).toBeNull();
  });

  it('saves the record and answers with the time', async () => {
    const saveRecord = vi.fn(async (r: SubtitleRecord) => ({ ...r, savedAt: '2026-11-07T10:00:00.000Z' }));
    render(<App api={fakeApi({ saveRecord })} />);
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save for encoding' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Save for encoding' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Saved at /));
    expect(saveRecord.mock.calls[0]![0].episodes.map((e) => e.metadata.title)).toEqual(['01', '02']);
  });

  it("shows the server's message when saving fails", async () => {
    const saveRecord = vi.fn(async () => Promise.reject(new ApiError(400, 'bad-record', 'episodes[0].tracks[0].language: expected a three-letter code')));
    render(<App api={fakeApi({ saveRecord })} />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save for encoding' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Save for encoding' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('expected a three-letter code'));
  });

  it('starts fresh when the saved record cannot be read', async () => {
    const api = fakeApi({ record: vi.fn(async () => ({ record: null, missing: [], error: { code: 'record-unreadable' as const, message: 'bad json' } })) });
    render(<App api={api} />);
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
  });
});
