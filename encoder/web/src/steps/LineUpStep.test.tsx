// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useReducer } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerSnapshot } from '@seikou/engine';
import { ApiError, type HelperApi } from '../api';
import type { AlignAnswer, EpisodesAnswer, FansubAlignment, ReleaseAnswer, SessionInfo, TitleHit } from '../api-types';
import { initialState, reduce } from '../helper-model';
import type { PlayerLike } from '../player/use-controller';
import { LineUpStep } from './LineUpStep';

const hit: TitleHit = { alId: 900101, title: 'Lantern Harbor', nativeTitle: null, year: 2021, format: 'TV', episodes: 2, poster: null };
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
  fonts: [{ name: 'Harbor Sans.ttf', path: 'fonts/harbor.ttf' }],
  match: {
    rows: [
      { episode: 1, fileId: 'f1', candidates: ['f1'] },
      { episode: 2, fileId: 'f2', candidates: ['f2'] },
    ],
    unmatched: [],
  },
};

const session = (toolsReady = true): SessionInfo => ({ discKey: 'f.abc', label: 'HARBOR_1', playlistId: '00000', episodeSpec: '1-3,4-5', toolsReady });
const episodes: EpisodesAnswer = {
  episodes: [
    { index: 1, startUs: 0, durationUs: 60_000_000, chapters: [{ startUs: 0 }] },
    { index: 2, startUs: 60_000_000, durationUs: 40_000_000, chapters: [{ startUs: 60_000_000 }] },
  ],
  audio: [{ pid: 4352, codingType: 0x80, language: 'jpn' }],
  pgCount: 0,
};

const ASS = '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,Hello\n';

function fakeApi(align: HelperApi['align']): HelperApi {
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
    align: vi.fn(align),
    subtitleUrl: vi.fn((episode: number, rel: string, file: string, track: string, timing: FansubAlignment) => `/sub/${episode}/${rel}/${file}/${track}/${timing.kind}`),
    fontUrl: vi.fn((rel: string, name: string) => `/font/${rel}/${encodeURIComponent(name)}`),
    record: notCalled,
    saveRecord: notCalled,
    remoteDisc: vi.fn(async (discKey: string) => ({ kind: 'remote' as const, base: `http://127.0.0.1/api/discs/${discKey}/`, token: 'tok', manifest: { discId: 'x', name: 'HARBOR_1', files: [], inline: {} } })),
  };
}

const answer = (alignment: FansubAlignment): AlignAnswer => ({
  alignment,
  trackId: '2',
  speech: [{ fromMs: 6_200, toMs: 8_200 }],
  dialogue: [{ fromMs: 5_000, toMs: 7_000 }],
});

/** A stand-in for the engine's controller: it records calls and keeps the subtitle file's offset as the engine would. */
function fakeController() {
  let snapshot = { timeUs: 0, durationUs: 100_000_000, engineState: 'playing', subtitles: null } as unknown as PlayerSnapshot;
  const listeners = new Set<() => void>();
  const update = (next: Partial<PlayerSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const l of listeners) l();
  };
  const textOf = (offsetMs: number, name: string) =>
    ({ pg: [], selected: 'text', scale: 1, text: { files: [{ name, format: 'ass', cues: 1, startUs: 0, offsetMs }], missingFonts: [], episodeStarts: [] } }) as PlayerSnapshot['subtitles'];
  const controller = {
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => snapshot,
    attachCanvas: vi.fn(),
    resize: vi.fn(),
    startAudio: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    openRemote: vi.fn(),
    loadSubtitleFiles: vi.fn(async (files: readonly File[]) => {
      update({ subtitles: textOf(0, files[0]!.name) });
    }),
    setSubtitleStart: vi.fn(),
    shiftSubtitleFile: vi.fn((file: number, deltaMs: number) => {
      const current = snapshot.subtitles?.text?.files[file];
      if (current) update({ subtitles: textOf(current.offsetMs + deltaMs, current.name) });
    }),
  } satisfies PlayerLike;
  return controller;
}

function Harness({ api, controller, tools = true }: { api: HelperApi; controller: PlayerLike; tools?: boolean }) {
  const [state, dispatch] = useReducer(reduce, initialState(), (s) => {
    const withTitle = reduce(s, { type: 'setTitle', title: hit });
    return reduce(reduce(withTitle, { type: 'setRelease', release, from: 'tosho' }), { type: 'goTo', step: 3 });
  });
  return <LineUpStep api={api} state={state} dispatch={dispatch} session={session(tools)} episodes={episodes} controller={controller} />;
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => new Response(url.startsWith('/font/') ? new Uint8Array([0, 1, 0, 0]) : ASS)),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LineUpStep', () => {
  it('shows the shift and places the track at the episode start', async () => {
    const api = fakeApi(async () => answer({ kind: 'offset', offsetMs: 1200, confidence: 0.92 }));
    const controller = fakeController();
    render(<Harness api={api} controller={controller} />);
    expect(await screen.findByText('Shifted +1.20 s, confident')).toBeTruthy();
    await waitFor(() => expect(controller.setSubtitleStart).toHaveBeenCalledWith(0, 0));
    expect(api.align).toHaveBeenCalledWith(1, 'tosho-11', 'f1', expect.anything());
    const files = controller.loadSubtitleFiles.mock.calls.at(-1)![0];
    expect(files.map((f) => f.name.slice(f.name.lastIndexOf('.')))).toEqual(['.ass', '.ttf']);
    expect(files[1]!.name).toBe('Harbor Sans.ttf');
    // the track the backend lined up on, retimed with what it found
    expect(api.subtitleUrl).toHaveBeenLastCalledWith(1, 'tosho-11', 'f1', '2', { kind: 'offset', offsetMs: 1200, confidence: 0.92 });
    // the disc opens at the first line's retimed start
    await waitFor(() => expect(controller.openRemote).toHaveBeenCalled());
    const start = controller.openRemote.mock.calls[0]![4];
    expect(start).toEqual({ playlistId: '00000', timeUs: 6_200_000, hdmv: null, playback: null });
  });

  it('] nudges by 42 ms and { by -10 ms', async () => {
    const api = fakeApi(async () => answer({ kind: 'offset', offsetMs: 1200, confidence: 0.92 }));
    const controller = fakeController();
    render(<Harness api={api} controller={controller} />);
    await waitFor(() => expect(controller.setSubtitleStart).toHaveBeenCalled());
    act(() => {
      fireEvent.keyDown(window, { key: ']' });
    });
    expect(controller.shiftSubtitleFile).toHaveBeenLastCalledWith(0, 42);
    act(() => {
      fireEvent.keyDown(window, { key: '{' });
    });
    expect(controller.shiftSubtitleFile).toHaveBeenLastCalledWith(0, -10);
    expect(controller.shiftSubtitleFile).toHaveBeenCalledTimes(2);
    expect(screen.getByText('+0.032 s')).toBeTruthy();
  });

  it('nudge keys work with the track switch focused but not while typing', async () => {
    const api = fakeApi(async () => answer({ kind: 'offset', offsetMs: 1200, confidence: 0.92 }));
    const controller = fakeController();
    render(<Harness api={api} controller={controller} />);
    await waitFor(() => expect(controller.setSubtitleStart).toHaveBeenCalled());
    const radio = screen.getAllByRole('radio')[0]!;
    radio.focus();
    act(() => {
      fireEvent.keyDown(radio, { key: ']' });
    });
    expect(controller.shiftSubtitleFile).toHaveBeenLastCalledWith(0, 42);
    const text = document.createElement('input');
    text.type = 'text';
    document.body.append(text);
    text.focus();
    act(() => {
      fireEvent.keyDown(text, { key: ']' });
    });
    expect(controller.shiftSubtitleFile).toHaveBeenCalledTimes(1);
    text.remove();
  });

  it('shows the reason and keeps original timing when alignment is none', async () => {
    const api = fakeApi(async () => answer({ kind: 'none', reason: 'no-speech' }));
    const controller = fakeController();
    render(<Harness api={api} controller={controller} />);
    expect(await screen.findByText('Could not line up: too little dialogue')).toBeTruthy();
    await waitFor(() => expect(controller.loadSubtitleFiles).toHaveBeenCalled());
    expect(api.subtitleUrl).toHaveBeenLastCalledWith(1, 'tosho-11', 'f1', '2', { kind: 'original' });
  });

  it('without tools it previews at original timing with the VapourSynth message', async () => {
    const api = fakeApi(async () => {
      throw new Error('not expected');
    });
    const controller = fakeController();
    render(<Harness api={api} controller={controller} tools={false} />);
    expect(await screen.findByText(/needs VapourSynth with BestSource/)).toBeTruthy();
    await waitFor(() => expect(controller.setSubtitleStart).toHaveBeenCalledWith(0, 0));
    expect(api.align).not.toHaveBeenCalled();
    expect(api.subtitleUrl).toHaveBeenLastCalledWith(1, 'tosho-11', 'f1', '2', { kind: 'original' });
  });

  it('a tools-missing answer says the same and previews at original timing', async () => {
    const api = fakeApi(async () => {
      throw new ApiError(503, 'tools-missing', 'VapourSynth is missing.');
    });
    const controller = fakeController();
    render(<Harness api={api} controller={controller} />);
    expect(await screen.findByText(/needs VapourSynth with BestSource/)).toBeTruthy();
    await waitFor(() => expect(controller.loadSubtitleFiles).toHaveBeenCalled());
    expect(api.subtitleUrl).toHaveBeenLastCalledWith(1, 'tosho-11', 'f1', '2', { kind: 'original' });
  });

  it('accepting moves to the next episode, which is lined up in turn and sought to', async () => {
    const api = fakeApi(async (episode) => (episode === 1 ? answer({ kind: 'offset', offsetMs: 1200, confidence: 0.92 }) : answer({ kind: 'split', parts: [{ fromMs: 0, offsetMs: 1200 }, { fromMs: 724_000, offsetMs: 840 }], confidence: 0.8 })));
    const controller = fakeController();
    render(<Harness api={api} controller={controller} />);
    await waitFor(() => expect(controller.setSubtitleStart).toHaveBeenCalledWith(0, 0));
    fireEvent.click(screen.getByRole('button', { name: 'Accept, next episode' }));
    expect(await screen.findByText('Split at 12:04: +1.20 s, then +0.84 s')).toBeTruthy();
    await waitFor(() => expect(controller.setSubtitleStart).toHaveBeenCalledWith(0, 60_000_000));
    expect(controller.seek).toHaveBeenLastCalledWith(60_000_000 + 6_200_000);
    expect(controller.openRemote).toHaveBeenCalledTimes(1);
  });

  it('the last episode reads Accept, and accepting it says every episode is lined up', async () => {
    const api = fakeApi(async () => answer({ kind: 'offset', offsetMs: 1200, confidence: 0.92 }));
    const controller = fakeController();
    render(<Harness api={api} controller={controller} />);
    await waitFor(() => expect(controller.setSubtitleStart).toHaveBeenCalledWith(0, 0));
    expect(screen.queryByText(/Every episode is lined up/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Accept, next episode' }));
    await waitFor(() => expect(controller.setSubtitleStart).toHaveBeenCalledWith(0, 60_000_000));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect((await screen.findByRole('status', { name: /Every episode is lined up/ })).textContent).toMatch(/Save for encoding/);
  });
});
