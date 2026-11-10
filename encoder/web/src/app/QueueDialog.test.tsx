// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import type { EpisodeInfo, LibraryAnswer, NasStatus, PlaylistDetail, Profile } from '../api-types';
import type { AppApi } from './app-api';
import { takeReplacesFilesNotice } from './job-model';
import { makeJob, DEFAULT_TEST_SETTINGS } from './job-test-support';
import { QueueDialog } from './QueueDialog';

afterEach(() => {
  cleanup();
  history.replaceState(null, '', '/');
});

const key = `f.${'a'.repeat(32)}`;
const standard: Profile = { id: 'default', name: 'Default', builtIn: true, settings: DEFAULT_TEST_SETTINGS };
const small: Profile = { id: 'ab12', name: 'Small files', builtIn: false, settings: { ...DEFAULT_TEST_SETTINGS, crf: 32, web: true } };
const library: LibraryAnswer = {
  roots: ['/discs'],
  savedRoots: ['/discs'],
  runRoots: [],
  unreadableRoots: [],
  nas: { paired: false, scanning: false, reachable: null },
  scanning: false,
  discs: [{ key, label: 'LANTERN_HARBOR_D1', relPath: 'LANTERN_HARBOR_D1', root: '/discs', source: 'local', playlistCount: 2, recordPlaylists: [], otherPaths: [] }],
};
const playlist: PlaylistDetail = {
  id: '00001',
  durationMs: 6 * 60_000,
  chapters: [1, 2, 3, 4, 5, 6].map((index) => ({ index, startMs: (index - 1) * 60_000, lengthMs: 60_000 })),
  record: null,
};

function fakeApi(over: Partial<AppApi> = {}): AppApi {
  return {
    library: vi.fn(async () => library),
    playlist: vi.fn(async () => playlist),
    profiles: vi.fn(async () => [standard, small]),
    jobDefaults: vi.fn(async () => ({ outDir: '/data/output/LANTERN_HARBOR_D1/00001' })),
    createJob: vi.fn(async () => makeJob({ id: 'bbbbbbbbbbbbbbbb' })),
    createSession: vi.fn(async () => 'cccccccccccccccc'),
    nas: vi.fn(async (): Promise<NasStatus> => ({ paired: false })),
    episodeInfo: vi.fn(async (): Promise<EpisodeInfo | null> => null),
    ...over,
  } as unknown as AppApi;
}

const props = { discKey: key, playlistId: '00001', spec: '1-3,4-6', noSubtitles: false };

describe('QueueDialog', () => {
  it('shows the disc, its episodes, the profile summary and the default folder, and queues the job', async () => {
    const api = fakeApi();
    render(<QueueDialog api={api} {...props} />);
    await screen.findByText('LANTERN_HARBOR_D1', { selector: 'p' });
    expect(screen.getByText(/2 episodes/)).toBeTruthy();
    expect(screen.getByText(/CRF 25, preset 4, film grain 4, Opus default, with PGS/)).toBeTruthy();
    const folder = (await screen.findByLabelText('Output folder')) as HTMLInputElement;
    await waitFor(() => expect(folder.value).toBe('/data/output/LANTERN_HARBOR_D1/00001'));
    fireEvent.change(screen.getByLabelText('Settings profile'), { target: { value: 'ab12' } });
    expect(screen.getByText(/CRF 32, preset 4, film grain 4, Opus default, with PGS/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Queue encode' }));
    await waitFor(() =>
      expect(api.createJob).toHaveBeenCalledWith({
        discKey: key,
        playlistId: '00001',
        episodeSpec: '1-3,4-6',
        settings: small.settings,
        outDir: '/data/output/LANTERN_HARBOR_D1/00001',
        noSubtitles: false,
      }),
    );
    await waitFor(() => expect(location.pathname).toBe('/queue/bbbbbbbbbbbbbbbb'));
  });

  it('ticks Encode without subtitles when the route says so', async () => {
    render(<QueueDialog api={fakeApi()} {...props} noSubtitles />);
    expect(((await screen.findByLabelText('Encode without subtitles')) as HTMLInputElement).checked).toBe(true);
  });

  it('shows an output folder error beside the folder', async () => {
    const api = fakeApi({
      createJob: vi.fn(async () => {
        throw new ApiError(400, 'output-not-allowed', 'That folder is inside the library.');
      }),
    });
    render(<QueueDialog api={api} {...props} />);
    await screen.findByLabelText('Output folder');
    fireEvent.click(screen.getByRole('button', { name: 'Queue encode' }));
    const folder = await screen.findByLabelText('Output folder');
    await waitFor(() => expect(folder.getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByText('That folder is inside the library.')).toBeTruthy();
  });

  it('shows a folder another encode uses beside the folder', async () => {
    const api = fakeApi({
      createJob: vi.fn(async () => {
        throw new ApiError(409, 'output-in-use', '/out is the output folder of another encode (SHOW_B, done). Choose another folder, such as /out-2.', { suggestedOutDir: '/out-2' });
      }),
    });
    render(<QueueDialog api={api} {...props} />);
    await screen.findByLabelText('Output folder');
    fireEvent.click(screen.getByRole('button', { name: 'Queue encode' }));
    const folder = await screen.findByLabelText('Output folder');
    await waitFor(() => expect(folder.getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByText(/another encode \(SHOW_B, done\)/)).toBeTruthy();
  });

  it('a re-encode that replaces earlier files leaves a notice for the job page', async () => {
    const api = fakeApi({ createJob: vi.fn(async () => ({ ...makeJob({ id: 'dddddddddddddddd' }), warning: 'replaces-files' as const })) });
    render(<QueueDialog api={api} {...props} />);
    await screen.findByLabelText('Output folder');
    fireEvent.click(screen.getByRole('button', { name: 'Queue encode' }));
    await waitFor(() => expect(location.pathname).toBe('/queue/dddddddddddddddd'));
    expect(takeReplacesFilesNotice('dddddddddddddddd')).toBe(true);
    expect(takeReplacesFilesNotice('dddddddddddddddd')).toBe(false);
  });

  it('shows any other error as an alert', async () => {
    const api = fakeApi({
      createJob: vi.fn(async () => {
        throw new ApiError(400, 'bad-setting', 'CRF must be 0 to 63.');
      }),
    });
    render(<QueueDialog api={api} {...props} />);
    await screen.findByLabelText('Output folder');
    fireEvent.click(screen.getByRole('button', { name: 'Queue encode' }));
    expect((await screen.findByRole('alert')).textContent).toContain('CRF must be 0 to 63.');
  });

  it('the dialog shows the record mismatch with its two ways out', async () => {
    const mismatch = new ApiError(409, 'record-mismatch', 'The saved choices are for other episodes.', { recordEpisodeSpec: '1-2,3-4', episodeSpec: '1-3,4-6' });
    const createJob = vi.fn().mockRejectedValueOnce(mismatch).mockResolvedValue(makeJob({ id: 'bbbbbbbbbbbbbbbb' }));
    const api = fakeApi({ createJob });
    render(<QueueDialog api={api} {...props} />);
    await screen.findByLabelText('Output folder');
    fireEvent.click(screen.getByRole('button', { name: 'Queue encode' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('1-2,3-4');
    expect(alert.textContent).toContain('1-3,4-6');
    // the second way out: the helper for this episode list
    fireEvent.click(screen.getByRole('button', { name: 'Open the helper' }));
    await waitFor(() => expect(api.createSession).toHaveBeenCalledWith(key, '00001', '1-3,4-6'));
    await waitFor(() => expect(location.pathname).toBe('/helper/cccccccccccccccc'));
  });

  it('Encode without subtitles on a mismatch queues the job again without subtitles', async () => {
    const mismatch = new ApiError(409, 'record-mismatch', 'x', { recordEpisodeSpec: '1-2,3-4', episodeSpec: '1-3,4-6' });
    const createJob = vi.fn().mockRejectedValueOnce(mismatch).mockResolvedValue(makeJob({ id: 'bbbbbbbbbbbbbbbb' }));
    render(<QueueDialog api={fakeApi({ createJob })} {...props} />);
    await screen.findByLabelText('Output folder');
    fireEvent.click(screen.getByRole('button', { name: 'Queue encode' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Encode without subtitles' }));
    await waitFor(() => expect(createJob).toHaveBeenCalledTimes(2));
    expect(createJob.mock.calls[1]![0]).toMatchObject({ noSubtitles: true });
    await waitFor(() => expect(location.pathname).toBe('/queue/bbbbbbbbbbbbbbbb'));
  });

  it('leaves the folder empty and editable, with a hint, when no folder can be suggested', async () => {
    const api = fakeApi({ jobDefaults: vi.fn(async () => Promise.reject(new ApiError(500, 'boom', 'No folder.'))) });
    render(<QueueDialog api={api} {...props} />);
    const folder = (await screen.findByLabelText('Output folder')) as HTMLInputElement;
    expect(folder.value).toBe('');
    expect(screen.getByText(/Couldn't suggest a folder; type a full path/)).toBeTruthy();
    fireEvent.change(folder, { target: { value: '/out/here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue encode' }));
    await waitFor(() => expect(api.createJob).toHaveBeenCalledWith(expect.objectContaining({ outDir: '/out/here' })));
  });

  it('falls back to the built-in Default settings when the profiles cannot be read', async () => {
    const api = fakeApi({ profiles: vi.fn(async () => Promise.reject(new ApiError(500, 'boom', 'No profiles.'))) });
    render(<QueueDialog api={api} {...props} />);
    await screen.findByLabelText('Output folder');
    expect(screen.getByText(/CRF 25, preset 4, film grain 4, Opus default, with PGS/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Queue encode' }));
    await waitFor(() => expect(api.createJob).toHaveBeenCalledWith(expect.objectContaining({ settings: DEFAULT_TEST_SETTINGS })));
  });

  it('starts on the profile the route names', async () => {
    const api = fakeApi();
    render(<QueueDialog api={api} {...props} profile="ab12" />);
    await screen.findByLabelText('Output folder');
    expect((screen.getByLabelText('Settings profile') as HTMLSelectElement).value).toBe('ab12');
    fireEvent.click(screen.getByRole('button', { name: 'Queue encode' }));
    await waitFor(() => expect(api.createJob).toHaveBeenCalledWith(expect.objectContaining({ settings: small.settings })));
  });

  it('runs a test encode of the ticked profiles first and opens its page', async () => {
    const createTest = vi.fn(async () => makeJob({ id: 'dddddddddddddddd', kind: 'test', cli: '' }));
    const api = fakeApi({ createTest });
    render(<QueueDialog api={api} {...props} />);
    await screen.findByLabelText('Output folder');
    const group = screen.getByRole('group', { name: 'Run a test encode first' });
    const boxes = within(group).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    fireEvent.click(within(group).getByLabelText('Small files'));
    fireEvent.click(within(group).getByRole('button', { name: 'Run test encode' }));
    await waitFor(() =>
      expect(createTest).toHaveBeenCalledWith({
        discKey: key,
        playlistId: '00001',
        episodeSpec: '1-3,4-6',
        profiles: [
          { id: 'default', name: 'Default', settings: standard.settings },
          { id: 'ab12', name: 'Small files', settings: small.settings },
        ],
        noSubtitles: false,
      }),
    );
    await waitFor(() => expect(location.pathname).toBe('/test/dddddddddddddddd'));
    expect(api.createJob).not.toHaveBeenCalled();
  });

  it('lets a test take at most three profiles and needs one', async () => {
    const many: Profile[] = [standard, small, { ...small, id: 'cd34', name: 'Tiny' }, { ...small, id: 'ef56', name: 'Huge' }];
    render(<QueueDialog api={fakeApi({ profiles: vi.fn(async () => many) })} {...props} />);
    await screen.findByLabelText('Output folder');
    const group = screen.getByRole('group', { name: 'Run a test encode first' });
    fireEvent.click(within(group).getByLabelText('Small files'));
    fireEvent.click(within(group).getByLabelText('Tiny'));
    expect((within(group).getByLabelText('Huge') as HTMLInputElement).disabled).toBe(true);
    for (const name of ['Default', 'Small files', 'Tiny']) fireEvent.click(within(group).getByLabelText(name));
    expect((within(group).getByRole('button', { name: 'Run test encode' }) as HTMLButtonElement).disabled).toBe(true);
  });

  describe('to the NAS', () => {
    const paired: NasStatus = { paired: true, host: 'nas.example', personName: 'Mika', reachable: true, encodes: 'ready' };
    const info = (anilist: EpisodeInfo['anilist']): EpisodeInfo => ({ chapterNames: {}, anilist, savedAt: '2026-11-09T10:00:00.000Z' });
    const both = info({ '1': { anilistId: 990001, episode: 1, title: null }, '4': { anilistId: 990001, episode: 2, title: null } });
    const nasRadio = () => screen.getByLabelText('The NAS (Encodes library)') as HTMLInputElement;
    const queueButton = () => screen.getByRole('button', { name: 'Queue encode' }) as HTMLButtonElement;

    it('offers the NAS only when paired, pointing to Settings otherwise', async () => {
      render(<QueueDialog api={fakeApi()} {...props} />);
      await screen.findByLabelText('Output folder');
      expect((screen.getByLabelText('A folder on this Mac') as HTMLInputElement).checked).toBe(true);
      expect(nasRadio().disabled).toBe(true);
      expect(screen.getByText(/Pair with your NAS in/).textContent).toBe('Pair with your NAS in Settings');
      expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/settings');
    });

    it('queues to the NAS with the web package off and no folder field', async () => {
      const api = fakeApi({ nas: vi.fn(async () => paired), episodeInfo: vi.fn(async () => both), profiles: vi.fn(async () => [small]) });
      render(<QueueDialog api={api} {...props} />);
      await screen.findByLabelText('Output folder');
      fireEvent.click(nasRadio());
      expect(screen.queryByLabelText('Output folder')).toBeNull();
      expect(queueButton().disabled).toBe(false);
      fireEvent.click(queueButton());
      await waitFor(() =>
        expect(api.createJob).toHaveBeenCalledWith(expect.objectContaining({ settings: { ...small.settings, web: false, destination: 'nas' } })),
      );
    });

    it('a profile that sends to the NAS starts the dialog on the NAS', async () => {
      const toNas: Profile = { ...small, settings: { ...small.settings, destination: 'nas' } };
      const api = fakeApi({ nas: vi.fn(async () => paired), episodeInfo: vi.fn(async () => both), profiles: vi.fn(async () => [standard, toNas]) });
      render(<QueueDialog api={api} {...props} profile="ab12" />);
      await waitFor(() => expect(nasRadio().checked).toBe(true));
      fireEvent.change(screen.getByLabelText('Settings profile'), { target: { value: 'default' } });
      expect((screen.getByLabelText('A folder on this Mac') as HTMLInputElement).checked).toBe(true);
    });

    it('a profile that sends to the NAS starts on the folder while unpaired', async () => {
      const toNas: Profile = { ...small, settings: { ...small.settings, destination: 'nas' } };
      render(<QueueDialog api={fakeApi({ profiles: vi.fn(async () => [toNas]) })} {...props} />);
      await screen.findByLabelText('Output folder');
      expect((screen.getByLabelText('A folder on this Mac') as HTMLInputElement).checked).toBe(true);
    });

    it('holds Queue back while an episode has no AniList entry, linking to the Episodes page', async () => {
      const api = fakeApi({ nas: vi.fn(async () => paired), episodeInfo: vi.fn(async () => info({ '1': { anilistId: 990001, episode: 1, title: null } })) });
      render(<QueueDialog api={api} {...props} />);
      await screen.findByLabelText('Output folder');
      fireEvent.click(nasRadio());
      expect(screen.getByText('Episode 2 has no AniList entry')).toBeTruthy();
      expect(queueButton().disabled).toBe(true);
      expect(screen.getByRole('link', { name: 'Choose them on the Episodes page' }).getAttribute('href')).toBe(`/disc/${key}/00001`);
      fireEvent.click(screen.getByLabelText('A folder on this Mac'));
      expect(queueButton().disabled).toBe(false);
    });

    it('counts a suggested entry that was never saved as missing', async () => {
      const api = fakeApi({
        nas: vi.fn(async () => paired),
        playlist: vi.fn(async () => ({ ...playlist, record: { episodeSpec: '1-3,4-6', anilist: { id: 990001, title: 'Lantern Harbor' } } })),
      });
      render(<QueueDialog api={api} {...props} />);
      await screen.findByLabelText('Output folder');
      fireEvent.click(nasRadio());
      expect(screen.getByText(/Episodes 1 and 2 have a suggested AniList entry\. Confirm on the Episodes page\./)).toBeTruthy();
      expect(queueButton().disabled).toBe(true);
    });

    it('names episodes that share one AniList episode', async () => {
      const same = info({ '1': { anilistId: 990001, episode: 1, title: null }, '4': { anilistId: 990001, episode: 1, title: null } });
      render(<QueueDialog api={fakeApi({ nas: vi.fn(async () => paired), episodeInfo: vi.fn(async () => same) })} {...props} />);
      await screen.findByLabelText('Output folder');
      fireEvent.click(nasRadio());
      expect(screen.getByText(/Episodes 1 and 2 are the same AniList episode/)).toBeTruthy();
      expect(queueButton().disabled).toBe(true);
    });

    it('holds Queue back while encodes are not set up on the NAS', async () => {
      const off: NasStatus = { ...paired, encodes: 'not-configured' };
      render(<QueueDialog api={fakeApi({ nas: vi.fn(async () => off), episodeInfo: vi.fn(async () => both) })} {...props} />);
      await screen.findByLabelText('Output folder');
      fireEvent.click(nasRadio());
      expect(screen.getByText(/The NAS has no encodes folder/)).toBeTruthy();
      expect(queueButton().disabled).toBe(true);
    });

    it('shows a 409 nas-needs-anilist from the backend the same way', async () => {
      const createJob = vi.fn(async () => {
        throw new ApiError(409, 'nas-needs-anilist', 'Every episode needs an AniList entry.', { episodes: [2] });
      });
      render(<QueueDialog api={fakeApi({ nas: vi.fn(async () => paired), episodeInfo: vi.fn(async () => both), createJob })} {...props} />);
      await screen.findByLabelText('Output folder');
      fireEvent.click(nasRadio());
      fireEvent.click(queueButton());
      expect((await screen.findByRole('alert')).textContent).toContain('Episode 2 has no AniList entry');
    });

    it('shows a 409 nas-duplicate-episodes from the backend, naming the episodes', async () => {
      const createJob = vi.fn(async () => {
        throw new ApiError(409, 'nas-duplicate-episodes', 'Two episodes share one.', { episodes: [1, 2] });
      });
      render(<QueueDialog api={fakeApi({ nas: vi.fn(async () => paired), episodeInfo: vi.fn(async () => both), createJob })} {...props} />);
      await screen.findByLabelText('Output folder');
      fireEvent.click(nasRadio());
      fireEvent.click(queueButton());
      expect((await screen.findByRole('alert')).textContent).toContain('Episodes 1 and 2 are the same AniList episode');
    });
  });
});
