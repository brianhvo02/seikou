// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ToshoReleaseFiles, ToshoSearchResult } from '@seikou/nas/nas-api';
import type { SubtitlesState } from '../player/player-controller';
import { SubtitleMenu } from './SubtitleMenu';
import type { ToshoSearch } from './ToshoSearch';
import { LINING_UP } from './nas/tosho-search-model';

afterEach(cleanup);

const subtitles: SubtitlesState = { pg: [], text: null, selected: 'off', scale: 1 };
const results: ToshoSearchResult[] = [
  { id: 7001, title: '[GroupA] Starfall Wanderer (BD 1080p)', date: 1_700_000_000, seadex: 'best' },
  { id: 7002, title: '[GroupB] Starfall Wanderer (WEB 1080p)', date: 1_600_000_000, seadex: null },
];
const files: ToshoReleaseFiles['files'] = [
  { id: 7101, name: 'ep1.mkv', episode: 1, tracks: [{ track: 1, language: 'spa', name: 'Completo' }, { track: 0, language: 'eng', name: 'Full' }] },
  { id: 7102, name: 'ep2.mkv', episode: 2, tracks: [{ track: 0, language: 'eng', name: 'Full' }] },
];
const listing = (matchedFileId: number | null): ToshoReleaseFiles => ({ release: results[0]!, files, matchedFileId });

function menu(search: Partial<ToshoSearch> | null) {
  const full: ToshoSearch | null = search && {
    query: 'Starfall Wanderer',
    search: vi.fn(async () => results),
    release: vi.fn(async () => listing(7101)),
    pick: vi.fn(async () => true),
    active: null,
    ...search,
  };
  const view = render(
    <SubtitleMenu
      subtitles={subtitles} isMasked={() => false} chapters={[]} nowUs={0} showingFile={null} search={full}
      onSelect={() => {}} onLoadFiles={() => {}} onAddFonts={() => {}} onShift={() => {}} onStart={() => {}} onScale={() => {}} onRemove={() => {}} onOpenChange={() => {}}
    />,
  );
  fireEvent.click(screen.getByTestId('subtitle-menu'));
  return { search: full, view };
}

const trackNames = (): string[] => screen.getAllByTestId(/^tosho-track-/).map((b) => b.textContent ?? '');

describe('SubtitleMenu: Search Anime Tosho', () => {
  it('shows the entry only when the menu has a search', () => {
    menu(null);
    expect(screen.queryByTestId('subtitle-tosho')).toBeNull();
    cleanup();
    menu({});
    expect(screen.getByTestId('subtitle-tosho').textContent).toBe('Search Anime Tosho…');
  });

  it("searches with the box's words, badges SeaDex releases, and lists the matched file's tracks, English first", async () => {
    const { search } = menu({});
    fireEvent.click(screen.getByTestId('subtitle-tosho'));
    expect((screen.getByTestId('tosho-query') as HTMLInputElement).value).toBe('Starfall Wanderer');
    expect(await screen.findByTestId('tosho-release-7001')).toBeTruthy();
    expect(search!.search).toHaveBeenCalledWith('Starfall Wanderer');
    expect(screen.getByTestId('tosho-release-7001').textContent).toContain('SeaDex best');
    expect(screen.getByTestId('tosho-release-7002').textContent).not.toContain('SeaDex');
    fireEvent.click(screen.getByTestId('tosho-release-7001'));
    await waitFor(() => expect(trackNames()).toEqual(['English · Full', 'Spanish · Completo']));
    expect(search!.release).toHaveBeenCalledWith(7001);
    expect(screen.getByTestId('tosho-back').textContent).toContain('Episode 1');
  });

  it('lists the files first when no file matched the episode, and Back goes up a step at a time', async () => {
    menu({ release: vi.fn(async () => listing(null)) });
    fireEvent.click(screen.getByTestId('subtitle-tosho'));
    fireEvent.click(await screen.findByTestId('tosho-release-7001'));
    fireEvent.click(await screen.findByTestId('tosho-file-7102'));
    await waitFor(() => expect(trackNames()).toEqual(['English · Full']));
    fireEvent.click(screen.getByTestId('tosho-back'));
    expect(await screen.findByTestId('tosho-file-7101')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tosho-back'));
    expect(await screen.findByTestId('tosho-release-7002')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tosho-back'));
    expect(screen.getByTestId('subtitle-tosho')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId('subtitle-tosho'));
  });

  it('says Lining up… while the pick goes, then checks the track', async () => {
    let finish!: (placed: boolean) => void;
    const pick = vi.fn(() => new Promise<boolean>((r) => (finish = r)));
    const { search, view } = menu({ pick });
    fireEvent.click(screen.getByTestId('subtitle-tosho'));
    fireEvent.click(await screen.findByTestId('tosho-release-7001'));
    fireEvent.click(await screen.findByTestId('tosho-track-7101-0'));
    expect(pick).toHaveBeenCalledWith(7001, 7101, { track: 0, language: 'eng', name: 'Full' });
    expect(screen.getByTestId('tosho-status').textContent).toBe(LINING_UP);
    finish(true);
    await waitFor(() => expect(screen.queryByTestId('tosho-status')).toBeNull());
    // the player marks the pick active once it is the text set
    view.rerender(
      <SubtitleMenu
        subtitles={subtitles} isMasked={() => false} chapters={[]} nowUs={0} showingFile={null} search={{ ...search!, active: { fileId: 7101, track: 0 } }}
        onSelect={() => {}} onLoadFiles={() => {}} onAddFonts={() => {}} onShift={() => {}} onStart={() => {}} onScale={() => {}} onRemove={() => {}} onOpenChange={() => {}}
      />,
    );
    expect(screen.getByTestId('tosho-track-7101-0').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('tosho-track-7101-1').getAttribute('aria-checked')).toBe('false');
  });

  it('searches again with Enter in the box, and reaches the results with the arrow keys', async () => {
    const { search } = menu({});
    fireEvent.click(screen.getByTestId('subtitle-tosho'));
    const box = screen.getByTestId('tosho-query') as HTMLInputElement;
    await screen.findByTestId('tosho-release-7001');
    fireEvent.change(box, { target: { value: 'Starfall' } });
    fireEvent.submit(box.form!);
    await waitFor(() => expect(search!.search).toHaveBeenLastCalledWith('Starfall'));
    box.focus();
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('tosho-release-7001'));
  });

  it('waits with an empty box when there are no words to search with', async () => {
    const { search } = menu({ query: '' });
    fireEvent.click(screen.getByTestId('subtitle-tosho'));
    expect((screen.getByTestId('tosho-query') as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('tosho-message')).toBeNull();
    expect(search!.search).not.toHaveBeenCalled();
  });

  it('keeps the focus on the picked track while it lines up, and takes no second pick meanwhile', async () => {
    let finish!: (placed: boolean) => void;
    const pick = vi.fn(() => new Promise<boolean>((r) => (finish = r)));
    menu({ pick });
    fireEvent.click(screen.getByTestId('subtitle-tosho'));
    fireEvent.click(await screen.findByTestId('tosho-release-7001'));
    const full = await screen.findByTestId('tosho-track-7101-0');
    full.focus();
    fireEvent.click(full);
    expect(document.activeElement).toBe(full);
    expect(full.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(screen.getByTestId('tosho-track-7101-1'));
    expect(pick).toHaveBeenCalledTimes(1);
    finish(true);
    await waitFor(() => expect(screen.queryByTestId('tosho-status')).toBeNull());
    expect(document.activeElement).toBe(full);
  });

  it("says so when Anime Tosho can't be reached", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    menu({ search: vi.fn(async () => { throw new Error('offline'); }) });
    fireEvent.click(screen.getByTestId('subtitle-tosho'));
    await waitFor(() => expect(screen.getByTestId('tosho-message').textContent).toBe("Couldn't reach Anime Tosho."));
    warn.mockRestore();
  });
});
