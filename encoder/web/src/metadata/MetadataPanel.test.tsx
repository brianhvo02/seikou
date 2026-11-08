// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useReducer } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EpisodesAnswer, ReleaseAnswer, SessionInfo, TitleHit } from '../api-types';
import { initialState, metadataDefaults, reduce, toRecord, type HelperState } from '../helper-model';
import { MetadataPanel } from './MetadataPanel';

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
  s = reduce(s, { type: 'setRelease', release, from: 'tosho' });
  return reduce(s, { type: 'fillDefaults', defaults: metadataDefaults(s, episodes, { 1: 'Arrival' }) });
}

function Harness({ onState }: { onState: (s: HelperState) => void }) {
  const [state, dispatch] = useReducer(reduce, undefined, start);
  onState(state);
  return <MetadataPanel state={state} dispatch={dispatch} episodes={episodes} onClose={() => undefined} />;
}

function renderPanel() {
  let latest: HelperState = start();
  render(<Harness onState={(s) => (latest = s)} />);
  return () => latest;
}

/** The rows of a track list, by the list's accessible name. */
function rows(name: string): HTMLElement[] {
  return within(screen.getByRole('list', { name })).getAllByRole('listitem');
}

describe('MetadataPanel', () => {
  it('shows the episode title, chapter titles and language names', () => {
    renderPanel();
    expect((screen.getByLabelText('MKV title') as HTMLInputElement).value).toBe('Lantern Harbor - 01 - Arrival');
    expect((screen.getByLabelText('Chapter 2 title') as HTMLInputElement).value).toBe('Chapter 2');
    const audio = rows('Audio');
    expect(within(audio[0]!).getByText('Japanese')).toBeTruthy();
    expect(within(audio[1]!).getByText('English')).toBeTruthy();
  });

  it('a typed title is saved', () => {
    const state = renderPanel();
    fireEvent.change(screen.getByLabelText('MKV title'), { target: { value: 'Harbor cut' } });
    expect(toRecord(state(), session, episodes).episodes[0]!.metadata.title).toBe('Harbor cut');
    expect(state().metadata.edited.has('episodes.1.title')).toBe(true);
  });

  it('reordering audio moves the Default mark', () => {
    const state = renderPanel();
    expect(within(rows('Audio')[0]!).queryByText('Default')).toBeTruthy();
    expect(within(rows('Audio')[1]!).queryByText('Default')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move English audio up' }));
    const after = rows('Audio');
    expect(within(after[0]!).getByText('English')).toBeTruthy();
    expect(within(after[0]!).queryByText('Default')).toBeTruthy();
    expect(within(after[1]!).queryByText('Default')).toBeNull();
    expect(toRecord(state(), session, episodes).episodes[0]!.metadata.audio.map((a) => a.pid)).toEqual([4353, 4352]);
  });

  it('unticking a subtitle track leaves it out of the record', () => {
    const state = renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include GroupA signs' }));
    const tracks = toRecord(state(), session, episodes).episodes[0]!.tracks;
    expect(tracks.map((t) => [t.file, t.included])).toEqual([
      ['a/1/2.ass', true],
      ['a/1/3.ass', false],
    ]);
  });

  it('the Default mark goes to the first ticked track', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include GroupA full' }));
    expect(within(rows('Subtitles')[0]!).queryByText('Default')).toBeNull();
    expect(within(rows('Subtitles')[1]!).queryByText('Default')).toBeTruthy();
  });

  it('Alt+ArrowUp moves a track up', () => {
    const state = renderPanel();
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

  it('Alt+ArrowDown moves a track down and keeps focus on it', () => {
    const state = renderPanel();
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

  it('Alt+Arrow on a move button that becomes disabled moves focus to the other one', () => {
    renderPanel();
    const up = screen.getByRole('button', { name: 'Move GroupA signs up' });
    up.focus();
    fireEvent.keyDown(up, { key: 'ArrowUp', altKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move GroupA signs down' }));
  });

  it('the Down button keeps focus with the moved track, on Up once Down is disabled', () => {
    const state = renderPanel();
    const down = screen.getByRole('button', { name: 'Move GroupA full down' });
    down.focus();
    fireEvent.click(down);
    expect(state().metadata.episodes[1]!.tracks.map((t) => t.key)).toEqual(['a/1/3.ass', 'a/1/2.ass']);
    // the row is now last, so its Down button is disabled and focus goes to its Up button
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move GroupA full up' }));
  });

  it('the Up button keeps focus on the moved row while it can still move', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Move GroupA signs up' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move GroupA signs down' }));
  });

  it('a language code is kept to three lowercase letters, and und when it is not one', () => {
    const state = renderPanel();
    const code = screen.getByLabelText('Language of audio stream 1') as HTMLInputElement;
    fireEvent.change(code, { target: { value: 'FR' } });
    expect(code.value).toBe('fr');
    fireEvent.blur(code);
    expect(state().metadata.episodes[1]!.audio[0]!.language).toBe('und');
    fireEvent.change(code, { target: { value: 'fra' } });
    expect(within(rows('Audio')[0]!).getByText('French')).toBeTruthy();
  });

  it('switches to another episode', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Episode 2' }));
    expect((screen.getByLabelText('MKV title') as HTMLInputElement).value).toBe('Lantern Harbor - 02');
    expect(rows('Subtitles')).toHaveLength(1);
  });

  it('Escape closes it', () => {
    const onClose = vi.fn();
    render(<MetadataPanel state={start()} dispatch={() => undefined} episodes={episodes} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
