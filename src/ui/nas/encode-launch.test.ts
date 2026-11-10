// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerController } from '@seikou/engine/controller/player-controller';
import type { PlaceSaver } from '../place-saver';
import { AUDIO_START_WAIT_MS, launchEncode } from './encode-launch';
import type { NasClient } from './nas-client';
import { PlayingRoute } from './playing-route';

afterEach(() => {
  vi.useRealTimers();
});

function fakes(startAudio: () => Promise<void>) {
  const nas = {
    encodeBase: vi.fn(async (id: string) => `https://nas.example/bluray/api/encodes/${id}/`),
    encodeManifest: vi.fn(async (id: string) => ({ discId: id, name: 'x', files: [{ path: 'EPISODE.MKV', size: 10 }], inline: {} })),
    session: vi.fn(async () => ({ token: 'tok' })),
    pairing: vi.fn(async () => ({ deviceId: 'd', base: 'https://nas.example/bluray/api/', deviceName: 'iPad' })),
    freshSession: vi.fn(),
    discFetch: vi.fn(),
  } as unknown as NasClient;
  const controller = { startAudio: vi.fn(startAudio), openEncode: vi.fn() } as unknown as PlayerController;
  const places = { begin: vi.fn() } as unknown as PlaceSaver;
  const playingRoute = new PlayingRoute({ route: () => null, replace: () => {} }, () => 0);
  return { nas, controller, places, playingRoute };
}

describe('launchEncode', () => {
  it('waits for the audio to start, then opens', async () => {
    let started = (): void => {};
    const f = fakes(() => new Promise<void>((r) => (started = r)));
    const launched = launchEncode(f, '100-2');
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.controller.openEncode).not.toHaveBeenCalled();
    started();
    expect(await launched).toBe(true);
    expect(f.controller.openEncode).toHaveBeenCalledTimes(1);
  });

  it('opens without audio when the audio has not started within its wait (an auto-advance with no gesture)', async () => {
    vi.useFakeTimers();
    const f = fakes(() => new Promise<void>(() => {}));
    const launched = launchEncode(f, '100-2');
    await vi.advanceTimersByTimeAsync(AUDIO_START_WAIT_MS - 1);
    expect(f.controller.openEncode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await launched).toBe(true);
    expect(f.controller.openEncode).toHaveBeenCalledTimes(1);
    expect(f.places.begin).toHaveBeenCalledTimes(1);
  });

  it('saves the place of an encode of any title under its own key', async () => {
    const f = fakes(async () => undefined);
    expect(await launchEncode(f, 'tv990101s1-2')).toBe(true);
    expect(vi.mocked(f.controller.openEncode).mock.calls[0]![0]).toMatchObject({ encodeId: 'tv990101s1-2' });
    expect(f.places.begin).toHaveBeenCalledWith(expect.objectContaining({ discKey: 'e.tv990101s1.2', discId: 'tv990101s1-2', encode: true }), undefined);
    expect(f.playingRoute.encodeId).toBe('tv990101s1-2');
  });
});
