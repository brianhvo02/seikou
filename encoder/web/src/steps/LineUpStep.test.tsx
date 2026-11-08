// SPDX-License-Identifier: LGPL-3.0-or-later
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useReducer } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerSnapshot } from '@seikou/engine';
import { ApiError, type HelperApi } from '../api';
import type { AlignAnswer, EpisodesAnswer, FansubAlignment, ReleaseAnswer, SessionInfo, TitleHit } from '../api-types';
import { initialState, reduce, type HelperAction } from '../helper-model';
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

/** A second release, the user's own files, with its own file for episode 2 and its own font. */
const other: ReleaseAnswer = {
  key: 'own-7',
  source: 'local',
  label: 'Own files',
  group: 'Own',
  files: [{ id: 'g2', name: 'Own - 02.ass', tracks: [{ id: '1', name: 'Own dialogue', language: 'eng', path: 'own/g2/1.ass', kind: 'full', dialogueLines: 250 }] }],
  fonts: [{ name: 'Own Serif.otf', path: 'fonts/own.otf' }],
  match: { rows: [{ episode: 2, fileId: 'g2', candidates: ['g2'] }], unmatched: [] },
};

function Harness({
  api,
  controller,
  tools = true,
  after = [],
  onAction,
  control,
}: {
  api: HelperApi;
  controller: PlayerLike;
  tools?: boolean;
  after?: readonly HelperAction[];
  onAction?: (action: HelperAction) => void;
  /** Filled with the harness's dispatch, so a test can change the state while the step is on screen. */
  control?: { dispatch?: (action: HelperAction) => void };
}) {
  const [state, dispatch] = useReducer(reduce, initialState(), (s) => {
    const withTitle = reduce(s, { type: 'setTitle', title: hit });
    const pooled = reduce(withTitle, { type: 'addRelease', release, from: 'tosho' });
    return reduce(after.reduce(reduce, pooled), { type: 'goTo', step: 3 });
  });
  const send = (action: HelperAction) => {
    onAction?.(action);
    dispatch(action);
  };
  if (control) control.dispatch = dispatch;
  return <LineUpStep api={api} state={state} dispatch={send} session={session(tools)} episodes={episodes} controller={controller} />;
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

  it('episode 2 from another release aligns and previews that release\'s file', async () => {
    const api = fakeApi(async () => answer({ kind: 'offset', offsetMs: 1200, confidence: 0.92 }));
    const controller = fakeController();
    const after: HelperAction[] = [
      { type: 'addRelease', release: other, from: 'local' },
      { type: 'chooseFile', episode: 2, releaseKey: 'own-7', fileId: 'g2' },
    ];
    render(<Harness api={api} controller={controller} after={after} />);
    await waitFor(() => expect(controller.setSubtitleStart).toHaveBeenCalledWith(0, 0));
    fireEvent.click(screen.getByRole('button', { name: 'Accept, next episode' }));
    await waitFor(() => expect(controller.setSubtitleStart).toHaveBeenCalledWith(0, 60_000_000));
    expect(api.align).toHaveBeenLastCalledWith(2, 'own-7', 'g2', expect.anything());
    expect(api.subtitleUrl).toHaveBeenLastCalledWith(2, 'own-7', 'g2', '1', { kind: 'offset', offsetMs: 1200, confidence: 0.92 });
    expect(api.fontUrl).toHaveBeenCalledWith('own-7', 'Own Serif.otf');
    const files = controller.loadSubtitleFiles.mock.calls.at(-1)![0];
    expect(files.map((f) => f.name)).toEqual(['Episode 2 - Own dialogue.ass', 'Own Serif.otf']);
  });

  it('Previous episode returns with its nudge kept', async () => {
    const api = fakeApi(async () => answer({ kind: 'offset', offsetMs: 1200, confidence: 0.92 }));
    const controller = fakeController();
    render(<Harness api={api} controller={controller} />);
    await waitFor(() => expect(controller.setSubtitleStart).toHaveBeenCalledWith(0, 0));
    act(() => {
      fireEvent.keyDown(window, { key: ']' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Accept, next episode' }));
    await waitFor(() => expect(controller.setSubtitleStart).toHaveBeenLastCalledWith(0, 60_000_000));
    expect(screen.getByText('0.000 s')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous episode' }));
    expect(screen.getByRole('heading', { name: 'Episode 1' })).toBeTruthy();
    expect(screen.getByText('+0.042 s')).toBeTruthy();
    await waitFor(() => expect(controller.setSubtitleStart).toHaveBeenLastCalledWith(0, 0));
    // the preview goes back to episode 1's first line, and the engine's file is put at the kept nudge again
    expect(controller.seek).toHaveBeenLastCalledWith(6_200_000);
    await waitFor(() => expect(controller.getSnapshot().subtitles?.text?.files[0]?.offsetMs).toBe(42));
    // episode 1 was lined up already: it is not asked again
    expect(api.align).toHaveBeenCalledTimes(2);
  });

  it('Previous episode is disabled on the first', async () => {
    const api = fakeApi(async () => answer({ kind: 'offset', offsetMs: 1200, confidence: 0.92 }));
    const controller = fakeController();
    render(<Harness api={api} controller={controller} />);
    await waitFor(() => expect(controller.setSubtitleStart).toHaveBeenCalledWith(0, 0));
    expect((screen.getByRole('button', { name: 'Previous episode' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Accept, next episode' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Previous episode' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('Back goes to step 2', async () => {
    const api = fakeApi(async () => answer({ kind: 'offset', offsetMs: 1200, confidence: 0.92 }));
    const controller = fakeController();
    const onAction = vi.fn();
    render(<Harness api={api} controller={controller} onAction={onAction} />);
    const back = await screen.findByRole('button', { name: 'Back' });
    const accept = screen.getByRole('button', { name: 'Accept, next episode' });
    expect(back.compareDocumentPosition(accept) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(back);
    expect(onAction).toHaveBeenCalledWith({ type: 'goTo', step: 2 });
  });

  it('choosing an episode\'s file again puts back the answer found for it without asking again', async () => {
    const api = fakeApi(async () => answer({ kind: 'offset', offsetMs: 1200, confidence: 0.92 }));
    const controller = fakeController();
    const onAction = vi.fn();
    const control: { dispatch?: (action: HelperAction) => void } = {};
    render(<Harness api={api} controller={controller} onAction={onAction} control={control} />);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'setTiming', episode: 1 })));
    onAction.mockClear();
    // the same file chosen again drops the episode's timing
    act(() => control.dispatch!({ type: 'chooseFile', episode: 1, releaseKey: 'tosho-11', fileId: 'f1' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: 'setTiming', episode: 1, alignment: { kind: 'offset', offsetMs: 1200, confidence: 0.92 } }));
    expect(api.align).toHaveBeenCalledTimes(1);
  });
});
