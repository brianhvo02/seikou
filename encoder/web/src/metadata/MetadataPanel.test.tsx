// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useReducer } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HelperApi } from '../api';
import type { EpisodeInfo, EpisodesAnswer, ReleaseAnswer, SessionInfo, TitleHit } from '../api-types';
import { initialState, metadataDefaults, reduce, toRecord, type HelperState } from '../helper-model';
import { firstChapters } from './metadata-model';
import { MetadataPanel } from './MetadataPanel';
import { useEpisodeInfo } from './use-episode-info';

afterEach(cleanup);

const hit: TitleHit = { alId: 900101, title: 'Lantern Harbor', nativeTitle: null, year: 2021, format: 'TV', episodes: 2, poster: null };
const session: SessionInfo = { discKey: 'f.abc', label: 'HARBOR_1', playlistId: '00000', episodeSpec: '1-2,3', toolsReady: true };
const episodes: EpisodesAnswer = {
  episodes: [
    { index: 1, startUs: 0, durationUs: 60_000_000, chapters: [{ startUs: 0 }, { startUs: 30_000_000 }] },
    { index: 2, startUs: 60_000_000, durationUs: 40_000_000, chapters: [{ startUs: 60_000_000 }] },
  ],
  audio: [
    { pid: 4352, codingType: 0x80, language: 'jpn' },
    { pid: 4353, codingType: 0x81, language: 'eng' },
  ],
  pgCount: 0,
};
const release: ReleaseAnswer = {
  key: 'tosho-11',
  source: 'tosho',
  label: 'GroupA release',
  group: 'GroupA',
  files: [
    {
      id: 'f1',
      name: 'Lantern Harbor - 01.mkv',
      tracks: [
        { id: '2', name: 'Full dialogue', language: 'eng', path: 'a/1/2.ass', kind: 'full', dialogueLines: 300 },
        { id: '3', name: 'Signs and songs', language: 'eng', path: 'a/1/3.ass', kind: 'signs', dialogueLines: 20 },
      ],
    },
    { id: 'f2', name: 'Lantern Harbor - 02.mkv', tracks: [{ id: '2', name: 'Full dialogue', language: 'eng', path: 'a/2/2.ass', kind: 'full', dialogueLines: 280 }] },
  ],
  fonts: [],
  match: {
    rows: [
      { episode: 1, fileId: 'f1', candidates: ['f1'] },
      { episode: 2, fileId: 'f2', candidates: ['f2'] },
    ],
    unmatched: [],
  },
};

function start(): HelperState {
  let s = reduce(initialState(), { type: 'setTitle', title: hit });
  s = reduce(s, { type: 'addRelease', release, from: 'tosho' });
  return reduce(s, { type: 'fillDefaults', defaults: metadataDefaults(s, episodes, { 1: 'Arrival' }) });
}

const savedInfo = (chapterNames: Record<string, string>): EpisodeInfo => ({
  chapterNames,
  anilist: { '1': { anilistId: 900101, episode: 1, title: 'Arrival' } },
  savedAt: '2026-11-09T10:00:00.000Z',
});

/**
 * A client whose only working calls are the episode info's: `episodeInfo` answers `info` (rejects for `failed`) and
 * `saveEpisodeInfo` stores what it is sent.
 */
function infoApi(info: EpisodeInfo | null | 'failed' = null): HelperApi {
  const notCalled = () => Promise.reject(new Error('not expected'));
  return {
    session: notCalled,
    episodes: notCalled,
    searchTitles: notCalled,
    episodeTitles: notCalled,
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
    episodeInfo: vi.fn(async () => {
      if (info === 'failed') throw new Error('The app is not answering.');
      return info;
    }),
    saveEpisodeInfo: vi.fn(async (_key: string, _playlist: string, info: Omit<EpisodeInfo, 'savedAt'>) => ({ ...info, savedAt: '2026-11-09T11:00:00.000Z' })),
    remoteDisc: notCalled,
  };
}

/** The panel with the page's state and its episode info (`useEpisodeInfo`), whose names refill the draft's defaults as the page does. */
function Harness({ onState, api }: { onState: (s: HelperState) => void; api: HelperApi }) {
  const [state, dispatch] = useReducer(reduce, undefined, start);
  const { info, status, saveChapterNames } = useEpisodeInfo(api, session);
  useEffect(() => {
    const chapters = { names: info?.chapterNames ?? {}, firstChapters: firstChapters(session.episodeSpec) };
    dispatch({ type: 'fillDefaults', defaults: metadataDefaults(state, episodes, { 1: 'Arrival' }, chapters) });
    // the page refills on its own triggers; here only the info does
  }, [info]);
  onState(state);
  return (
    <MetadataPanel
      state={state}
      dispatch={dispatch}
      episodes={episodes}
      chaptersLocked={status === 'ready' ? null : status === 'loading' ? 'Loading.' : 'The saved chapter names could not be loaded, so they cannot be changed here.'}
      onChapterNames={saveChapterNames}
      onClose={() => undefined}
    />
  );
}

/** Renders the panel over `api` once its episode info has loaded (or failed to). */
async function renderPanel(api: HelperApi = infoApi()) {
  let latest: HelperState = start();
  render(<Harness onState={(s) => (latest = s)} api={api} />);
  await waitFor(() => expect(screen.queryByText('Loading.')).toBeNull());
  return () => latest;
}

const chapterField = (n: number): HTMLInputElement => screen.getByLabelText(`Chapter ${n} title`) as HTMLInputElement;

/** The rows of a track list, by the list's accessible name. */
function rows(name: string): HTMLElement[] {
  return within(screen.getByRole('list', { name })).getAllByRole('listitem');
}

describe('MetadataPanel', () => {
  it('shows the episode title, chapter titles and language names', async () => {
    await renderPanel();
    expect((screen.getByLabelText('MKV title') as HTMLInputElement).value).toBe('Lantern Harbor - 01 - Arrival');
    expect((screen.getByLabelText('Chapter 2 title') as HTMLInputElement).value).toBe('Chapter 2');
    const audio = rows('Audio');
    expect(within(audio[0]!).getByText('Japanese')).toBeTruthy();
    expect(within(audio[1]!).getByText('English')).toBeTruthy();
  });

  it('a typed title is saved', async () => {
    const state = await renderPanel();
    fireEvent.change(screen.getByLabelText('MKV title'), { target: { value: 'Harbor cut' } });
    expect(toRecord(state(), session, episodes).episodes[0]!.metadata.title).toBe('Harbor cut');
    expect(state().metadata.edited.has('episodes.1.title')).toBe(true);
  });

  it('reordering audio moves the Default mark', async () => {
    const state = await renderPanel();
    expect(within(rows('Audio')[0]!).queryByText('Default')).toBeTruthy();
    expect(within(rows('Audio')[1]!).queryByText('Default')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move English audio up' }));
    const after = rows('Audio');
    expect(within(after[0]!).getByText('English')).toBeTruthy();
    expect(within(after[0]!).queryByText('Default')).toBeTruthy();
    expect(within(after[1]!).queryByText('Default')).toBeNull();
    expect(toRecord(state(), session, episodes).episodes[0]!.metadata.audio.map((a) => a.pid)).toEqual([4353, 4352]);
  });

  it('unticking a subtitle track leaves it out of the record', async () => {
    const state = await renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include GroupA signs' }));
    const tracks = toRecord(state(), session, episodes).episodes[0]!.tracks;
    expect(tracks.map((t) => [t.file, t.included])).toEqual([
      ['a/1/2.ass', true],
      ['a/1/3.ass', false],
    ]);
  });

  it('the Default mark goes to the first ticked track', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include GroupA full' }));
    expect(within(rows('Subtitles')[0]!).queryByText('Default')).toBeNull();
    expect(within(rows('Subtitles')[1]!).queryByText('Default')).toBeTruthy();
  });

  it('Alt+ArrowUp moves a track up', async () => {
    const state = await renderPanel();
    const name = screen.getByLabelText('Name of subtitle track 2') as HTMLInputElement;
    expect(name.value).toBe('GroupA signs');
    name.focus();
    fireEvent.keyDown(name, { key: 'ArrowUp', altKey: true });
    expect(state().metadata.episodes[1]!.tracks.map((t) => t.key)).toEqual(['a/1/3.ass', 'a/1/2.ass']);
    expect(state().metadata.edited.has('episodes.1.tracks')).toBe(true);
    // focus stays with the moved track
    expect(document.activeElement).toBe(name);
    // a plain arrow key does nothing
    fireEvent.keyDown(name, { key: 'ArrowDown' });
    expect(state().metadata.episodes[1]!.tracks[0]!.key).toBe('a/1/3.ass');
  });

  it('Alt+ArrowDown moves a track down and keeps focus on it', async () => {
    const state = await renderPanel();
    const name = screen.getByLabelText('Name of subtitle track 1') as HTMLInputElement;
    name.focus();
    // React's commit already restores the focused element once (one focus call); the panel's own refocus after the
    // move is the second, which keeps focus where a browser drops it when the row's node is moved
    const focus = vi.spyOn(name, 'focus');
    fireEvent.keyDown(name, { key: 'ArrowDown', altKey: true });
    expect(state().metadata.episodes[1]!.tracks.map((t) => t.key)).toEqual(['a/1/3.ass', 'a/1/2.ass']);
    expect(focus.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(document.activeElement).toBe(name);
  });

  it('Alt+Arrow on a move button that becomes disabled moves focus to the other one', async () => {
    await renderPanel();
    const up = screen.getByRole('button', { name: 'Move GroupA signs up' });
    up.focus();
    fireEvent.keyDown(up, { key: 'ArrowUp', altKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move GroupA signs down' }));
  });

  it('the Down button keeps focus with the moved track, on Up once Down is disabled', async () => {
    const state = await renderPanel();
    const down = screen.getByRole('button', { name: 'Move GroupA full down' });
    down.focus();
    fireEvent.click(down);
    expect(state().metadata.episodes[1]!.tracks.map((t) => t.key)).toEqual(['a/1/3.ass', 'a/1/2.ass']);
    // the row is now last, so its Down button is disabled and focus goes to its Up button
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move GroupA full up' }));
  });

  it('the Up button keeps focus on the moved row while it can still move', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Move GroupA signs up' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move GroupA signs down' }));
  });

  it('a language code is kept to three lowercase letters, and und when it is not one', async () => {
    const state = await renderPanel();
    const code = screen.getByLabelText('Language of audio stream 1') as HTMLInputElement;
    fireEvent.change(code, { target: { value: 'FR' } });
    expect(code.value).toBe('fr');
    fireEvent.blur(code);
    expect(state().metadata.episodes[1]!.audio[0]!.language).toBe('und');
    fireEvent.change(code, { target: { value: 'fra' } });
    expect(within(rows('Audio')[0]!).getByText('French')).toBeTruthy();
  });

  it('switches to another episode', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Episode 2' }));
    expect((screen.getByLabelText('MKV title') as HTMLInputElement).value).toBe('Lantern Harbor - 02');
    expect(rows('Subtitles')).toHaveLength(1);
  });

  it('Escape closes it', () => {
    const onClose = vi.fn();
    render(
      <MetadataPanel state={start()} dispatch={() => undefined} episodes={episodes} chaptersLocked={null} onChapterNames={() => undefined} onClose={onClose} />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('MetadataPanel chapter titles', () => {
  it('shows the episode info\'s names by playlist chapter', async () => {
    // the session's episodes are 1-2 and 3: episode 2's first field is playlist chapter 3
    await renderPanel(infoApi(savedInfo({ '2': 'Opening', '3': 'Preview' })));
    await waitFor(() => expect(chapterField(2).value).toBe('Opening'));
    expect(chapterField(1).value).toBe('Chapter 1');
    expect(chapterField(2).value).toBe('Opening');
    fireEvent.click(screen.getByRole('button', { name: 'Episode 2' }));
    expect(chapterField(1).value).toBe('Preview');
  });

  it('a chapter title is saved to the episode info when its field is left, keeping the AniList choices', async () => {
    const api = infoApi(savedInfo({ '1': 'Avant' }));
    const state = await renderPanel(api);
    fireEvent.click(screen.getByRole('button', { name: 'Episode 2' }));
    fireEvent.change(chapterField(1), { target: { value: ' Ending ' } });
    expect(api.saveEpisodeInfo).not.toHaveBeenCalled();
    fireEvent.blur(chapterField(1));
    await waitFor(() => expect(api.saveEpisodeInfo).toHaveBeenCalledTimes(1));
    expect(api.saveEpisodeInfo).toHaveBeenCalledWith(session.discKey, session.playlistId, {
      chapterNames: { '1': 'Avant', '3': 'Ending' },
      anilist: savedInfo({}).anilist,
    });
    await waitFor(() => expect(state().metadata.episodes[2]!.chapters).toEqual(['Ending']));
    expect(chapterField(1).value).toBe('Ending');
    // a chapter name is not part of the record's draft: nothing is marked edited, and the record carries no names
    expect(state().metadata.edited.size).toBe(0);
    expect(toRecord(state(), session, episodes).episodes[1]!.metadata.chapters).toEqual([]);
  });

  it('an emptied field removes the name and shows the encoder\'s own again', async () => {
    const api = infoApi(savedInfo({ '2': 'Opening' }));
    await renderPanel(api);
    await waitFor(() => expect(chapterField(2).value).toBe('Opening'));
    fireEvent.change(chapterField(2), { target: { value: '' } });
    fireEvent.blur(chapterField(2));
    await waitFor(() => expect(api.saveEpisodeInfo).toHaveBeenCalledWith(session.discKey, session.playlistId, { chapterNames: {}, anilist: savedInfo({}).anilist }));
    expect(chapterField(2).value).toBe('Chapter 2');
  });

  it('a field left unchanged saves nothing', async () => {
    const api = infoApi();
    await renderPanel(api);
    fireEvent.blur(chapterField(1));
    expect(api.saveEpisodeInfo).not.toHaveBeenCalled();
  });

  it('Escape saves the field being typed in', async () => {
    const api = infoApi();
    await renderPanel(api);
    chapterField(2).focus();
    fireEvent.change(chapterField(2), { target: { value: 'Opening' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(api.saveEpisodeInfo).toHaveBeenCalledWith(session.discKey, session.playlistId, { chapterNames: { '2': 'Opening' }, anilist: {} }));
  });

  it('without the episode info the chapter titles cannot be changed', async () => {
    await renderPanel(infoApi('failed'));
    expect(chapterField(1).disabled).toBe(true);
    expect(screen.getByText('The saved chapter names could not be loaded, so they cannot be changed here.')).toBeTruthy();
  });
});
