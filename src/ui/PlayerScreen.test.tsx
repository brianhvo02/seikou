// @vitest-environment jsdom
// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EncodeDetail, EncodeShow, PlaceSettings, PlaybackPlace, StoredSubtitle } from '@seikou/nas/nas-api';
import { INITIAL_SNAPSHOT, type PlayerController, type PlayerSnapshot } from '@seikou/engine/controller/player-controller';
import type { NasClient } from './nas/nas-client';
import type { NasHistory } from './nas/nas-history';
import type { NasRoute } from './nas/nas-route';
import { PlayingRoute } from './nas/playing-route';
import type { PlaceSaver } from './place-saver';
import { PlayerScreen } from './PlayerScreen';
import type { ShaderModel, ShaderModelState } from './shader-model';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const S = 1e6;
const SHOW: EncodeShow = {
  id: '100', name: 'Starfall Wanderer', poster: null,
  seasons: [
    { anilistId: 100, name: 'Starfall Wanderer', kind: 'season', number: 1, episodes: [{ episode: 1, id: '100-1', title: null, durationMs: 1 }, { episode: 2, id: '100-2', title: null, durationMs: 1 }] },
  ],
};
const CHAPTERS = [
  { index: 0, startUs: 0, name: 'Prologue' },
  { index: 1, startUs: 90 * S, name: 'Opening' },
  { index: 2, startUs: 180 * S, name: 'Part A' },
  { index: 3, startUs: 1300 * S, name: 'Ending' },
];
const settings: PlaceSettings = { audioLanguage: 'jpn', pgLanguage: 'eng', textFiles: [], psr1: 1, psr2: 0x80000002, psr3: 1, textOn: false, textScale: 1, shaderSet: null, volume: 0.7, muted: false };

function snapshotAt(encodeId: string, timeUs: number, over: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    ...INITIAL_SNAPSHOT, encodeId, remoteDisc: true, engineState: 'playing', currentPlaylistId: 'mkv', durationUs: 1440 * S, timeUs, chapters: CHAPTERS,
    audioTracks: [{ index: 1, codec: 'opus', language: 'jpn', channels: 'stereo', playable: true, name: 'Stereo' }], selectedAudio: 1,
    subtitles: { pg: [{ index: 1, language: 'eng', name: 'Signs & Songs' }, { index: 2, language: 'eng', name: 'Full' }], text: null, selected: { pg: 2 }, scale: 1 },
    ...over,
  };
}

function setup(snapshot: PlayerSnapshot, nasOver: Record<string, unknown> = {}) {
  let snap = snapshot;
  const engineListeners = new Set<() => void>();
  const controller = {
    discOpens: 1,
    attachCanvas: vi.fn(),
    resize: vi.fn(),
    getSnapshot: () => snap,
    subscribe: (l: () => void) => (engineListeners.add(l), () => void engineListeners.delete(l)),
    seek: vi.fn(),
    showNotice: vi.fn(),
    dismissNotice: vi.fn(),
    startAudio: vi.fn(),
    openEncode: vi.fn(),
    closeDisc: vi.fn(),
  } as unknown as PlayerController;
  const finished: PlaybackPlace = {
    discKey: 'e.100.1', discId: '100-1', playlistId: 'mkv', timeUs: 1310 * S, durationUs: 1440 * S, finished: true, mode: 'none', title: null, psrs: [], gprs: null, settings, updatedAt: 1, deviceName: 'iPad',
  };
  const places = {
    observe: vi.fn(),
    takeLaunchSettings: vi.fn(() => null),
    flushNow: vi.fn(async () => undefined),
    finishNow: vi.fn(async () => finished),
    end: vi.fn(),
    begin: vi.fn(),
    noteStoredSubtitle: vi.fn(),
    noteFansubPick: vi.fn(),
  } as unknown as PlaceSaver;
  const nas = {
    encodeShow: vi.fn(async (id: string) => (id === '100' ? SHOW : null)),
    encode: vi.fn(async () => null),
    encodeShows: vi.fn(async () => ({ shows: [] })),
    playerSettings: vi.fn(async () => ({ nextEpisodeCountdown: false })),
    putPlayerSettings: vi.fn(async (s: unknown) => s),
    encodeBase: vi.fn(async (id: string) => `https://nas.example/bluray/api/encodes/${id}/`),
    encodeManifest: vi.fn(async (id: string) => ({ discId: id, name: 'x', files: [{ path: 'EPISODE.MKV', size: 10 }], inline: {} })),
    session: vi.fn(async () => ({ token: 'tok' })),
    pairing: vi.fn(async () => ({ deviceId: 'd', base: 'https://nas.example/bluray/api/', deviceName: 'iPad' })),
    freshSession: vi.fn(),
    discFetch: vi.fn(),
    onRoute: vi.fn(() => () => undefined),
    ...nasOver,
  } as unknown as NasClient;
  let route: NasRoute | null = { kind: 'encodePlay', encodeId: snapshot.encodeId!, timeS: null, resume: false };
  const listeners = new Set<() => void>();
  const history = {
    route: () => route,
    replace: vi.fn((r: NasRoute | null) => {
      route = r;
      for (const l of listeners) l();
    }),
    back: vi.fn(),
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as NasHistory;
  const playingRoute = new PlayingRoute(history, () => 0);
  playingRoute.startEncode(snapshot.encodeId!);
  const shaderModel = { cycle: vi.fn() } as unknown as ShaderModel;
  const shaderState: ShaderModelState = { sets: [], files: [], imported: [], selected: null, selectedMissing: false, report: null };
  const view = (s: PlayerSnapshot) => <PlayerScreen controller={controller} snapshot={s} shaderModel={shaderModel} shaderState={shaderState} nas={nas} places={places} history={history} playingRoute={playingRoute} />;
  const r = render(view(snap));
  return {
    controller, places, nas, history, playingRoute,
    show(s: PlayerSnapshot) {
      snap = s;
      r.rerender(view(s));
      for (const l of [...engineListeners]) l();
    },
  };
}

describe('the player for an encoded episode', () => {
  it('Skip opening seeks to the chapter after the Opening', async () => {
    const t = setup(snapshotAt('100-1', 100 * S));
    const skip = await screen.findByTestId('skip-chapter');
    expect(skip.textContent).toBe('Skip opening');
    fireEvent.click(skip);
    expect(t.controller.seek).toHaveBeenCalledWith(180 * S);
    t.show(snapshotAt('100-1', 200 * S));
    expect(screen.queryByTestId('chapter-action')).toBeNull();
  });

  it('Next episode saves the finished place and opens the next encode with the tracks carried by language and name', async () => {
    const t = setup(snapshotAt('100-1', 1310 * S));
    const next = await screen.findByTestId('next-episode');
    fireEvent.click(next);
    await waitFor(() => expect(t.controller.openEncode).toHaveBeenCalled());
    expect(t.places.finishNow).toHaveBeenCalledTimes(1);
    expect(vi.mocked(t.places.end).mock.invocationCallOrder[0]!).toBeGreaterThan(vi.mocked(t.places.finishNow).mock.invocationCallOrder[0]!);
    expect(t.places.end).toHaveBeenCalledWith({ keepNotes: true });
    expect(vi.mocked(t.controller.openEncode).mock.calls[0]![0]).toMatchObject({ encodeId: '100-2' });
    expect(t.places.begin).toHaveBeenCalledWith(expect.objectContaining({ discKey: 'e.100.2', encode: true }), { settings, byLanguage: true, names: { audio: 'Stereo', subtitle: 'Full' } });
    expect(t.history.replace).toHaveBeenCalledWith({ kind: 'encodePlay', encodeId: '100-2', timeS: null, resume: false });
    expect(t.playingRoute.encodeId).toBe('100-2');
    expect(t.controller.closeDisc).not.toHaveBeenCalled();
    // a second click on the same episode does nothing more
    fireEvent.click(next);
    await Promise.resolve();
    expect(t.places.finishNow).toHaveBeenCalledTimes(1);
  });

  it("offers no Next episode at the show's last episode", async () => {
    const t = setup(snapshotAt('100-2', 1310 * S));
    await waitFor(() => expect(t.nas.encodeShow).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByTestId('next-episode')).toBeNull();
    expect(screen.queryByTestId('chapter-action')).toBeNull();
  });

  it('with the countdown on, the next episode starts by itself after 10 s', async () => {
    vi.useFakeTimers();
    const flush = (ms: number): Promise<void> =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    const t = setup(snapshotAt('100-1', 1310 * S), { playerSettings: vi.fn(async () => ({ nextEpisodeCountdown: true })) });
    await flush(0); // the show and the setting arrive
    expect(screen.getByRole('button', { name: 'Cancel next episode countdown' })).toBeTruthy();
    await flush(9_900);
    expect(t.controller.openEncode).not.toHaveBeenCalled();
    await flush(100);
    await flush(0);
    expect(t.controller.openEncode).toHaveBeenCalled();
  });

  it('when the next episode fails to open, the episode plays on with its places saved again, still finished', async () => {
    const t = setup(snapshotAt('100-1', 1310 * S), { encodeManifest: vi.fn(async () => Promise.reject(new Error('The NAS is not reachable.'))) });
    fireEvent.click(await screen.findByTestId('next-episode'));
    await waitFor(() => expect(t.controller.showNotice).toHaveBeenCalledWith('next-episode', "Couldn't open the next episode: The NAS is not reachable."));
    expect(t.controller.openEncode).not.toHaveBeenCalled();
    expect(t.history.replace).toHaveBeenLastCalledWith({ kind: 'encodePlay', encodeId: '100-1', timeS: 1310, resume: false });
    expect(t.playingRoute.encodeId).toBe('100-1');
    await waitFor(() => expect(t.places.begin).toHaveBeenCalledWith(expect.objectContaining({ discKey: 'e.100.1', discId: '100-1', encode: true, finished: true }), undefined, { keepNotes: true }));
    expect(t.controller.closeDisc).not.toHaveBeenCalled();
  });

  it('holds the countdown while the episode buffers or loads', async () => {
    vi.useFakeTimers();
    const flush = (ms: number): Promise<void> =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    const t = setup(snapshotAt('100-1', 1310 * S), { playerSettings: vi.fn(async () => ({ nextEpisodeCountdown: true })) });
    await flush(0);
    await flush(4_000);
    t.show(snapshotAt('100-1', 1314 * S, { engineState: 'buffering' }));
    await flush(30_000);
    t.show(snapshotAt('100-1', 1314 * S, { engineState: 'loading' }));
    await flush(30_000);
    expect(t.controller.openEncode).not.toHaveBeenCalled();
    t.show(snapshotAt('100-1', 1314 * S));
    await flush(5_900);
    expect(t.controller.openEncode).not.toHaveBeenCalled();
    await flush(100);
    await flush(0);
    expect(t.controller.openEncode).toHaveBeenCalled();
  });

  it('lists the chapters, switches the countdown setting on the NAS, and Close goes back to the encodes', async () => {
    const t = setup(snapshotAt('100-1', 100 * S));
    fireEvent.click(screen.getByTestId('chapter-menu'));
    expect(screen.getAllByRole('menuitemradio').map((i) => i.textContent)).toContain('Opening · 1:30');
    fireEvent.click(screen.getByTestId('player-settings-menu'));
    const item = await screen.findByTestId('countdown-setting');
    await waitFor(() => expect((item as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(item);
    expect(t.nas.putPlayerSettings).toHaveBeenCalledWith({ nextEpisodeCountdown: true });
    expect(screen.queryByText('Playlists')).toBeNull();
    fireEvent.click(screen.getByTestId('close-episode'));
    expect(t.controller.closeDisc).toHaveBeenCalled();
    expect(t.history.back).toHaveBeenCalledWith({ kind: 'encodes', q: '' });
  });

  it("offers the source disc's stored episode subtitle and places it back by the episode's start", async () => {
    const key = `f.${'D'.repeat(32)}`;
    const stored: StoredSubtitle = {
      id: 'sub-1', name: 'Fansub', language: 'en', offsetMs: 0, fileName: 'ep2.ass', fileSize: 10, fonts: [], uploadedAt: 1,
      attachment: { kind: 'episode', discKey: key, playlistId: '00000', titleId: 't', seasonId: 's', episode: 2 },
    };
    const other: StoredSubtitle = { ...stored, id: 'sub-2', attachment: { ...stored.attachment, playlistId: '00001' } };
    const entry: EncodeDetail = {
      id: '100-2', anilistId: 100, episode: 2, episodeTitle: null, discKey: key, playlistId: '00000', episodeStartMs: 1440_000,
      size: 1, mtimeMs: 1, durationMs: 1440_000, chapters: [], tracks: [],
    };
    const t = setup(snapshotAt('100-2', 10 * S), {
      encode: vi.fn(async () => entry),
      subtitlesForDisc: vi.fn(async () => [stored, other]),
      subtitleFiles: vi.fn(async () => [new File(['[Script Info]'], 'ep2.ass')]),
      searchTosho: vi.fn(async () => []),
    });
    const loaded = vi.fn(async () => {
      const s = snapshotAt('100-2', 10 * S);
      t.show({ ...s, subtitles: { ...s.subtitles!, text: { files: [{ name: 'ep2.ass', format: 'ass', cues: 1, startUs: null, offsetMs: 0 }], missingFonts: [], episodeStarts: [] } } });
    });
    Object.assign(t.controller, { loadSubtitleFiles: loaded, setSubtitleStart: vi.fn(), shiftSubtitleFile: vi.fn(), selectSubtitle: vi.fn() });
    await waitFor(() => expect(t.nas.subtitlesForDisc).toHaveBeenCalledWith(key, expect.anything()));
    fireEvent.click(screen.getByTestId('subtitle-menu'));
    const item = await screen.findByTestId('subtitle-stored-sub-1');
    expect(screen.queryByTestId('subtitle-stored-sub-2')).toBeNull();
    fireEvent.click(item);
    await waitFor(() => expect(t.controller.setSubtitleStart).toHaveBeenCalledWith(0, -1440 * S));
    expect(t.controller.selectSubtitle).toHaveBeenCalledWith({ kind: 'text' });
    // noted for the place with the disc and playlist it belongs to, so a resume finds it again
    expect(t.places.noteStoredSubtitle).toHaveBeenCalledWith('ep2.ass', 'sub-1', 10, 'en', { discKey: key, playlistId: '00000' });
  });
});
