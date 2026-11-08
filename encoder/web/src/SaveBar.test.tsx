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

const releaseB: ReleaseAnswer = {
  ...release,
  key: 'tosho-8',
  files: release.files.map((f) => ({ ...f, tracks: f.tracks.map((t) => ({ ...t, path: t.path.replace('tosho-7', 'tosho-8') })) })),
};
const trackOfB = (file: string) => ({ ...recordTrack(file), release: 'tosho-8' });
// episode 1 from release A and episode 2 from release B, whose labels are the same (two batches of one group)
const twoRecord: SubtitleRecord = {
  ...record,
  releases: [record.releases[0]!, { source: 'tosho', id: 'tosho-8', group: 'GroupA', label: release.label }],
  episodes: [record.episodes[0]!, { ...record.episodes[1]!, tracks: [trackOfB('releases/tosho-8/12-t1.ass')] }],
};
const answerFor = (...found: ReleaseAnswer[]) =>
  vi.fn(async (id: string) => found.find((r) => r.key === id) ?? Promise.reject(new ApiError(404, 'not-found', 'No such release.')));
const saveButton = () => screen.getByRole('button', { name: 'Save for encoding' }) as HTMLButtonElement;

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

  it('Queue encode is off until a record is saved, then opens the queue dialog for the run', async () => {
    const api = fakeApi();
    render(<App api={api} />);
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect((screen.getByRole('button', { name: 'Queue encode' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const saved = fakeApi({ record: vi.fn(async () => ({ record, missing: [] })), release: vi.fn(async () => release) });
    render(<App api={saved} />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Queue encode' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Queue encode' }));
    const q = new URLSearchParams(location.search);
    expect(location.pathname).toBe('/queue/new');
    expect([q.get('disc'), q.get('playlist'), q.get('spec'), q.get('noSubtitles')]).toEqual([session.discKey, '00000', '1-3,4-5', null]);
    history.replaceState(null, '', '/');
  });

  it('offers to fetch a missing release again', async () => {
    const api = fakeApi({
      record: vi.fn(async () => ({ record, missing: [{ id: 'tosho-7', release: release.label, files: ['releases/tosho-7/11-t1.ass'] }] })),
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
      record: vi.fn(async () => ({ record, missing: [{ id: 'tosho-7', release: release.label, files: ['releases/tosho-7/11-t1.ass'] }] })),
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
      record: vi.fn(async () => ({ record: local, missing: [{ id: `local-${'b'.repeat(16)}`, release: 'Your files', files: ['x.ass'] }] })),
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

  it('says choices are saved for another episode list, and Save replaces them only after saying so', async () => {
    const saveRecord = vi.fn(async (r: SubtitleRecord, _replace?: boolean) => ({ ...r, savedAt: '2026-11-07T10:00:00.000Z' }));
    const api = fakeApi({ record: vi.fn(async () => ({ record: null, missing: [], otherEpisodeSpec: '1-5' })), saveRecord });
    render(<App api={api} />);
    expect(await screen.findByText('Subtitle choices are saved for episodes 1-5; saving here replaces them.')).toBeTruthy();
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Saved at /));
    expect(saveRecord.mock.calls[0]![1]).toBe(true);
    expect(screen.queryByText(/saving here replaces them/)).toBeNull();
  });

  it('asks before replacing choices another episode list saved meanwhile', async () => {
    const saveRecord = vi.fn(async (r: SubtitleRecord, replace?: boolean) =>
      replace === true
        ? { ...r, savedAt: '2026-11-07T10:00:00.000Z' }
        : Promise.reject(new ApiError(409, 'other-episode-spec', 'Choices are saved for another episode list.', { episodeSpec: '1-5' })),
    );
    render(<App api={fakeApi({ saveRecord })} />);
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    expect(await screen.findByText('Subtitle choices are saved for episodes 1-5; saving here replaces them.')).toBeTruthy();
    expect(saveRecord).toHaveBeenCalledTimes(1);
    expect(saveRecord.mock.calls[0]![1]).not.toBe(true);
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Saved at /));
    expect(saveRecord.mock.calls[1]![1]).toBe(true);
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

  it('restores a two-release record', async () => {
    const api = fakeApi({ record: vi.fn(async () => ({ record: twoRecord, missing: [] })), release: answerFor(release, releaseB) });
    render(<App api={api} />);
    await waitFor(() => expect(stepButton(/Line up/).disabled).toBe(false));
    expect(api.release).toHaveBeenCalledWith('tosho-7', 0);
    expect(api.release).toHaveBeenCalledWith('tosho-8', 0);
    expect(screen.getByRole('status').textContent).toContain('Restored the choices saved');
    expect(screen.queryByRole('button', { name: /^Fetch/ })).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it('restores an old record', async () => {
    const { releases: _releases, episodes: _episodes, ...rest } = record;
    const old = {
      ...rest,
      release: record.releases[0]!,
      episodes: record.episodes.map((e) => ({ ...e, tracks: e.tracks.map(({ release: _r, ...t }) => t) })),
    };
    const api = fakeApi({ record: vi.fn(async () => ({ record: old as unknown as SubtitleRecord, missing: [] })), release: answerFor(release) });
    render(<App api={api} />);
    await waitFor(() => expect(stepButton(/Line up/).disabled).toBe(false));
    expect(api.release).toHaveBeenCalledWith('tosho-7', 0);
    expect(screen.getByRole('status').textContent).toContain('Restored the choices saved');
  });

  it('offers to fetch each missing release, even when two share a label', async () => {
    const fetchRelease = vi.fn(async (id: number) => (id === 7 ? release : releaseB));
    const api = fakeApi({
      record: vi.fn(async () => ({
        record: twoRecord,
        missing: [
          { id: 'tosho-7', release: release.label, files: ['releases/tosho-7/11-t1.ass'] },
          { id: 'tosho-8', release: release.label, files: ['releases/tosho-8/12-t1.ass', 'releases/tosho-8/13-t1.ass'] },
        ],
      })),
      release: answerFor(),
      fetchRelease,
    });
    render(<App api={api} />);
    const buttons = await screen.findAllByRole('button', { name: `Fetch ${release.label} again` });
    expect(buttons).toHaveLength(2);
    // each notice counts only its own release's files
    expect(screen.getByText(/^1 file of /)).toBeTruthy();
    expect(screen.getByText(/^2 files of /)).toBeTruthy();
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(screen.getAllByRole('button', { name: `Fetch ${release.label} again` })).toHaveLength(1));
    expect(fetchRelease).toHaveBeenCalledWith(8, 0);
    expect(screen.getByText(/^1 file of /)).toBeTruthy();
  });

  it('keeps Save off until every release the episodes use is back', async () => {
    const api = fakeApi({
      record: vi.fn(async () => ({ record: twoRecord, missing: [{ id: 'tosho-8', release: release.label, files: ['releases/tosho-8/12-t1.ass'] }] })),
      release: answerFor(release),
      fetchRelease: vi.fn(async () => releaseB),
    });
    render(<App api={api} />);
    const again = await screen.findByRole('button', { name: `Fetch ${release.label} again` });
    // release A is pooled, but B is missing
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(again);
    await waitFor(() => expect(saveButton().disabled).toBe(false));
  });

  it('fetching again leaves the pooled releases and the other choices as the user has them', async () => {
    const api = fakeApi({
      record: vi.fn(async () => ({ record: twoRecord, missing: [{ id: 'tosho-8', release: release.label, files: ['releases/tosho-8/12-t1.ass'] }] })),
      release: answerFor(release),
      fetchRelease: vi.fn(async () => releaseB),
    });
    render(<App api={api} />);
    await screen.findByRole('button', { name: `Fetch ${release.label} again` });
    fireEvent.click(stepButton(/Episodes/));
    const select = (await screen.findAllByRole('combobox'))[0] as HTMLSelectElement;
    // the user takes episode 1 out of release A
    fireEvent.change(select, { target: { value: '' } });
    expect(select.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: `Fetch ${release.label} again` }));
    await waitFor(() => expect(screen.queryByRole('button', { name: `Fetch ${release.label} again` })).toBeNull());
    // episode 1 stays empty (no fill from the fetched release); episode 2 gets release B's file back
    expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('');
    expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe(JSON.stringify(['tosho-8', '12']));
  });

  it('turns Save back on when the episodes that needed the missing release get other files', async () => {
    const api = fakeApi({
      record: vi.fn(async () => ({ record: twoRecord, missing: [{ id: 'tosho-8', release: release.label, files: ['releases/tosho-8/12-t1.ass'] }] })),
      release: answerFor(release),
    });
    render(<App api={api} />);
    await screen.findByRole('button', { name: `Fetch ${release.label} again` });
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(stepButton(/Episodes/));
    const select = (await screen.findAllByRole('combobox'))[1] as HTMLSelectElement;
    fireEvent.change(select, { target: { value: JSON.stringify(['tosho-7', '12']) } });
    await waitFor(() => expect(saveButton().disabled).toBe(false));
  });
});
