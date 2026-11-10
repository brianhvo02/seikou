// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StoredSubtitle, TitleSummary } from '@seikou/nas/nas-api';
import { SubtitleUploadsSection } from './SubtitleUploadsSection';
import { NasHttpError } from './nas-client';

afterEach(cleanup);

const sub = (id: string, attachment: StoredSubtitle['attachment'], attached: boolean): StoredSubtitle =>
  ({ id, name: `Subs ${id}`, language: 'en', offsetMs: 0, fileName: 'a.ass', fileSize: 1, fonts: [], attachment, uploadedAt: 0, attached }) as StoredSubtitle;
const star = { id: 'star', names: { english: 'Starfall Wanderer', romaji: null, native: null, synonyms: [], display: null } } as unknown as TitleSummary;

it('lists every upload, the ones not attached first, and deletes one after a confirm', async () => {
  const deleteSubtitle = vi.fn(async () => {});
  const subs = [
    sub('a', { kind: 'episode', discKey: 'f.X', playlistId: '00001', titleId: 'star', seasonId: 's1', episode: 2 }, true),
    sub('b', { kind: 'chapter', discKey: 'd.0123456789abcdef', playlistId: '00800', chapter: 0 }, false),
  ];
  render(<SubtitleUploadsSection nas={{ allSubtitles: async () => subs, titles: async () => [star], deleteSubtitle }} />);
  expect((await screen.findByTestId('nas-uploads-summary')).textContent).toBe('2 subtitles, 1 not attached');
  await waitFor(() => expect(screen.getAllByTestId('nas-upload-where').map((e) => e.textContent)).toEqual([
    'Not attached: its disc or playlist is gone · was A disc · playlist 00800 · chapter 1',
    'Starfall Wanderer · episode 2',
  ]));
  fireEvent.click(screen.getAllByTestId('nas-upload-delete')[0]!);
  fireEvent.click(screen.getByTestId('nas-upload-delete-confirm'));
  await waitFor(() => expect(screen.getAllByTestId('nas-upload')).toHaveLength(1));
  expect(deleteSubtitle).toHaveBeenCalledWith('b');
  expect(screen.getByTestId('nas-uploads-summary').textContent).toBe('1 subtitle');
});

it('names rows without titles when the title list fails, and says when nothing is stored', async () => {
  const subs = [sub('a', { kind: 'episode', discKey: 'f.X', playlistId: '00001', titleId: 'star', seasonId: 's1', episode: 2 }, true)];
  const { unmount } = render(<SubtitleUploadsSection nas={{ allSubtitles: async () => subs, titles: async () => Promise.reject(new Error('404')), deleteSubtitle: async () => {} }} />);
  expect((await screen.findByTestId('nas-upload-where')).textContent).toBe('A title no longer on the NAS · episode 2');
  unmount();
  render(<SubtitleUploadsSection nas={{ allSubtitles: async () => [], titles: async () => [], deleteSubtitle: async () => {} }} />);
  expect(await screen.findByText('No subtitles are stored on the NAS.')).toBeTruthy();
});

it('shows nothing on a NAS that answers all=1 with 400 (from before it), and says so when the list fails otherwise', async () => {
  const old = render(<SubtitleUploadsSection nas={{ allSubtitles: async () => Promise.reject(new NasHttpError(400, 'bad request')), titles: async () => [], deleteSubtitle: async () => {} }} />);
  await new Promise((r) => setTimeout(r, 0));
  expect(old.container.innerHTML).toBe('');
  old.unmount();
  render(<SubtitleUploadsSection nas={{ allSubtitles: async () => Promise.reject(new Error('offline')), titles: async () => [], deleteSubtitle: async () => {} }} />);
  expect(await screen.findByText("The subtitle uploads didn't load.")).toBeTruthy();
});
