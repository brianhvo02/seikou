// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MkvTextExtract } from '@seikou/engine/subs/mkv-extract';
import { ReleaseUpload } from './ReleaseUpload';
import { releaseRow, seasonBefore } from './release-model';

afterEach(cleanup);

const track = (number: number, language: string, kind: 'ass' | 'srt' = 'ass') => ({ number, kind, name: null, language, isDefault: false, isForced: false, dialogueLines: 3, text: `[Events]\n${number}` });
const extractOf = (tracks: MkvTextExtract['tracks']): MkvTextExtract => ({ tracks, fonts: [], via: 'cues' });
const file = (name: string) => new File(['x'], name);
const season = { seasonId: 's1', titleId: 'star', count: 12, before: 0 };
const episodes = [1, 2, 3].map((number) => ({ number, name: null }));

function fakeNas() {
  let n = 0;
  return {
    fansubLanguages: vi.fn(async () => ['ja']),
    createSubtitle: vi.fn(async () => ({ id: `id${++n}`, needFonts: [] }) as never),
    uploadSubtitleFile: vi.fn(async (id: string) => ({ id }) as never),
    uploadSubtitleFont: vi.fn(async (id: string) => ({ id }) as never),
    deleteSubtitle: vi.fn(async () => {}),
  };
}
const targetOf = async (episode: number) => ({ kind: 'episode' as const, titleId: 'star', seasonId: 's1', episode });

it('reads each file, shows its tracks and uploads the ticked ones', async () => {
  const nas = fakeNas();
  const extract = vi.fn(async () => extractOf([track(2, 'eng'), track(3, 'fre')]));
  render(<ReleaseUpload nas={nas} files={[file('[Grp] Star - 01.mkv'), file('[Grp] Star - 02.mkv')]} season={season} episodes={episodes} targetOf={targetOf} extract={extract} onDone={() => {}} />);
  await waitFor(() => expect(screen.getAllByTestId('release-row').map((r) => r.getAttribute('data-state'))).toEqual(['read', 'read']));
  expect(extract).toHaveBeenCalledTimes(2);
  expect(screen.getAllByTestId('release-track').map((c) => (c as HTMLInputElement).checked)).toEqual([true, false, true, false]);
  fireEvent.click(screen.getByTestId('release-upload'));
  await waitFor(() => expect(screen.getByTestId('release-status')).toBeTruthy());
  expect(nas.createSubtitle).toHaveBeenCalledTimes(2);
});

it('a file that fails to read shows why and the others still upload', async () => {
  const nas = fakeNas();
  const extract = vi.fn(async (f: File) => {
    if (f.name.includes('01')) throw new Error('not a Matroska file');
    return extractOf([track(2, 'eng')]);
  });
  render(<ReleaseUpload nas={nas} files={[file('Star - 01.mkv'), file('Star - 02.mkv')]} season={season} episodes={episodes} targetOf={targetOf} extract={extract} onDone={() => {}} />);
  await waitFor(() => expect(screen.getAllByTestId('release-row').map((r) => r.getAttribute('data-state'))).toEqual(['failed', 'read']));
  expect(screen.getByText(/not a Matroska file/)).toBeTruthy();
  fireEvent.click(screen.getByTestId('release-upload'));
  await waitFor(() => expect(screen.getByTestId('release-status')).toBeTruthy());
  expect(nas.createSubtitle).toHaveBeenCalledTimes(1);
});

it('says when a file has no text subtitles', async () => {
  render(<ReleaseUpload nas={fakeNas()} files={[file('Star - 01.mkv')]} season={season} episodes={episodes} targetOf={targetOf} extract={async () => extractOf([])} onDone={() => {}} />);
  expect(await screen.findByText('This file has no text subtitles.')).toBeTruthy();
  expect((screen.getByTestId('release-upload') as HTMLButtonElement).disabled).toBe(true);
});

it('after upload, says the tracks will show once lined up with the disc', async () => {
  const onDone = vi.fn();
  render(<ReleaseUpload nas={fakeNas()} files={[file('Star - 03.mkv')]} season={season} episodes={episodes} targetOf={targetOf} extract={async () => extractOf([track(2, 'eng')])} onDone={onDone} />);
  await waitFor(() => expect((screen.getByTestId('release-upload') as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByTestId('release-episode') as HTMLSelectElement).value).toBe('3');
  fireEvent.click(screen.getByTestId('release-upload'));
  const status = await screen.findByTestId('release-status');
  expect(status.textContent).toMatch(/once the NAS has lined them up with the disc/);
  expect(onDone).toHaveBeenCalled();
});

it('a new but equal files array does not read again or reset the ticks', async () => {
  const extract = vi.fn(async () => extractOf([track(2, 'eng'), track(3, 'fre')]));
  const f = file('Star - 01.mkv');
  const props = { nas: fakeNas(), season, episodes, targetOf, extract, onDone: () => {} };
  const { rerender } = render(<ReleaseUpload {...props} files={[f]} />);
  await waitFor(() => expect(screen.getAllByTestId('release-track')).toHaveLength(2));
  fireEvent.click(screen.getAllByTestId('release-track')[1]!);
  rerender(<ReleaseUpload {...props} files={[f]} />);
  expect(extract).toHaveBeenCalledTimes(1);
  expect(screen.getAllByTestId('release-track').map((c) => (c as HTMLInputElement).checked)).toEqual([true, true]);
});

it('cannot upload twice, and a retry sends only the files that failed', async () => {
  const nas = fakeNas();
  let fail = true;
  nas.createSubtitle.mockImplementation((async (body: { release?: { fileName: string } }) => {
    if (fail && body.release?.fileName.includes('02')) throw new Error('boom');
    return { id: 'x', needFonts: [] };
  }) as never);
  render(<ReleaseUpload nas={nas} files={[file('Star - 01.mkv'), file('Star - 02.mkv')]} season={season} episodes={episodes} targetOf={targetOf} extract={async () => extractOf([track(2, 'eng')])} onDone={() => {}} />);
  await waitFor(() => expect((screen.getByTestId('release-upload') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId('release-upload'));
  await waitFor(() => expect(screen.getByTestId('release-error')).toBeTruthy());
  expect(nas.createSubtitle).toHaveBeenCalledTimes(2);
  fail = false;
  fireEvent.click(screen.getByTestId('release-upload'));
  await waitFor(() => expect(nas.createSubtitle).toHaveBeenCalledTimes(3));
  await waitFor(() => expect((screen.getByTestId('release-upload') as HTMLButtonElement).disabled).toBe(true));
  fireEvent.click(screen.getByTestId('release-upload'));
  expect(nas.createSubtitle).toHaveBeenCalledTimes(3);
});

it('maps a running number onto the second season', () => {
  const seasons = [
    { id: 'anilist:1#season', episodes: Array.from({ length: 13 }, (_, i) => ({ number: i + 1 })) },
    { id: 'anilist:2#season', episodes: [{ number: 1 }, { number: 2 }] },
  ];
  const before = seasonBefore(seasons, 'anilist:2#season');
  expect(before).toBe(13);
  expect(seasonBefore(seasons, 'anilist:1#season')).toBe(0);
  expect(releaseRow(file('[G] Star - 14.mkv'), { count: 2, before }).episode).toBe(1);
});
