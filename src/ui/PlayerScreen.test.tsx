// @vitest-environment jsdom
// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EncodeShow, PlaceSettings, PlaybackPlace } from '@seikou/nas/nas-api';
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
  const controller = {
    discOpens: 1,
    attachCanvas: vi.fn(),
    resize: vi.fn(),
    getSnapshot: () => snap,
    subscribe: () => () => undefined,
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
  } as unknown as PlaceSaver;
  const nas = {
    encodeShow: vi.fn(async (id: string) => (id === '100' ? SHOW : null)),
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
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    await flush(9_900);
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
});
