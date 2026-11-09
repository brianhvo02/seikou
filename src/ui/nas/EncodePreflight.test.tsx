// @vitest-environment jsdom
// SPDX-License-Identifier: LGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ContinueItem, DiscPlaces, EncodeDetail, PlaceSettings, PlaybackPlace } from '@seikou/nas/nas-api';
import type { PlayerController } from '@seikou/engine/controller/player-controller';
import type { PlaceSaver } from '../place-saver';
import { EncodePreflight, encodeCarried, encodeOffer } from './EncodePreflight';
import { AV1_UNSUPPORTED_COPY } from './encode-launch';
import type { NasClient } from './nas-client';
import type { NasHistory } from './nas-history';
import { PlayingRoute } from './playing-route';

afterEach(cleanup);

const S = 1e6;
const settings: PlaceSettings = { audioLanguage: 'jpn', pgLanguage: 'eng', textFiles: [], psr1: 1, psr2: 0x80000002, psr3: 1, textOn: false, textScale: 1, shaderSet: null, volume: 1, muted: false };
const place = (over: Partial<PlaybackPlace> = {}): PlaybackPlace => ({
  discKey: 'e.100.3', discId: '100-3', playlistId: 'mkv', timeUs: 600 * S, durationUs: 1440 * S, finished: false,
  mode: 'none', title: null, psrs: [], gprs: null, settings, updatedAt: Date.now() - 60_000, deviceName: 'iPad', ...over,
});
const ENTRY: EncodeDetail = {
  id: '100-3', anilistId: 100, episode: 3, episodeTitle: 'The Lantern Gate', discKey: null, playlistId: null, episodeStartMs: null, size: 1, mtimeMs: 1,
  durationMs: 1_440_000, chapters: [], tracks: [{ kind: 'video', codec: 'V_AV1', language: '', name: '', isDefault: true, isForced: false }],
};

function fakes(places: DiscPlaces | null, over: Record<string, unknown> = {}) {
  const nas = {
    encode: vi.fn(async () => ENTRY),
    playbackPlaces: vi.fn(async () => places),
    continueWatching: vi.fn(async (): Promise<ContinueItem[]> => []),
    encodeBase: vi.fn(async (id: string) => `https://nas.example/bluray/api/encodes/${id}/`),
    encodeManifest: vi.fn(async (id: string) => ({ discId: id, name: 'x', files: [{ path: 'EPISODE.MKV', size: 10 }], inline: {} })),
    session: vi.fn(async () => ({ token: 'tok' })),
    pairing: vi.fn(async () => ({ deviceId: 'd', base: 'https://nas.example/bluray/api/', deviceName: 'iPad' })),
    freshSession: vi.fn(),
    discFetch: vi.fn(),
    ...over,
  } as unknown as NasClient;
  const controller = { startAudio: vi.fn(), openEncode: vi.fn() } as unknown as PlayerController;
  const saver = { begin: vi.fn() } as unknown as PlaceSaver;
  const history = { back: vi.fn(), route: vi.fn(() => ({ kind: 'encodePlay', encodeId: '100-3', timeS: null, resume: false })) } as unknown as NasHistory;
  const playingRoute = new PlayingRoute({ route: () => null, replace: () => {} }, () => 0);
  return { nas, controller, saver, history, playingRoute };
}

describe('the encode pre-flight', () => {
  it("shows the AV1 warning and opens nothing on a device that can't decode it", async () => {
    const f = fakes(null);
    render(<EncodePreflight nas={f.nas} controller={f.controller} places={f.saver} history={f.history} playingRoute={f.playingRoute} encodeId="100-3" startTimeS={null} resume={false} checkAv1={async () => false} />);
    expect((await screen.findByRole('alert')).textContent).toBe(AV1_UNSUPPORTED_COPY);
    expect(screen.queryByTestId('encode-preflight-play')).toBeNull();
    expect(screen.getByRole('link', { name: 'About encodes' }).getAttribute('href')).toBe('/help/nas#encodes');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(f.history.back).toHaveBeenCalledWith({ kind: 'encodes', q: '' });
    expect(f.controller.openEncode).not.toHaveBeenCalled();
  });

  it('asks to resume a place, and Resume opens the episode there with its tracks', async () => {
    const f = fakes({ defaults: settings, places: { mkv: place() } });
    const check = vi.fn(async () => true);
    render(<EncodePreflight nas={f.nas} controller={f.controller} places={f.saver} history={f.history} playingRoute={f.playingRoute} encodeId="100-3" startTimeS={null} resume={false} checkAv1={check} />);
    const resume = await screen.findByTestId('resume-at');
    expect(resume.textContent).toBe('Resume at 10:00');
    expect(check).toHaveBeenCalledWith('V_AV1');
    await waitFor(() => expect((resume as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(resume);
    await waitFor(() => expect(f.controller.openEncode).toHaveBeenCalled());
    const [spec, , startUs] = vi.mocked(f.controller.openEncode).mock.calls[0]!;
    expect(spec).toMatchObject({ base: 'https://nas.example/bluray/api/encodes/100-3/', token: 'tok', encodeId: '100-3' });
    expect(startUs).toBe(600 * S);
    expect(f.saver.begin).toHaveBeenCalledWith(expect.objectContaining({ discKey: 'e.100.3', discId: '100-3', chosen: 'mkv', encode: true, remote: true }), { settings, byLanguage: false });
    expect(f.playingRoute.encodeId).toBe('100-3');
  });

  it('plays from the start with the Up next settings carried by language', async () => {
    const upNext = { kind: 'up-next', encodeId: '100-3', settings } as unknown as ContinueItem;
    const f = fakes(null, { continueWatching: vi.fn(async () => [upNext]) });
    render(<EncodePreflight nas={f.nas} controller={f.controller} places={f.saver} history={f.history} playingRoute={f.playingRoute} encodeId="100-3" startTimeS={null} resume={false} checkAv1={async () => true} />);
    const play = await screen.findByTestId('encode-preflight-play');
    await waitFor(() => expect((play as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(play);
    await waitFor(() => expect(f.controller.openEncode).toHaveBeenCalled());
    expect(vi.mocked(f.controller.openEncode).mock.calls[0]![2]).toBeUndefined();
    expect(f.saver.begin).toHaveBeenCalledWith(expect.anything(), { settings, byLanguage: true });
  });
});

describe('encodeOffer and encodeCarried', () => {
  it('has no changed case: a place at its end is no place', () => {
    expect(encodeOffer({ defaults: null, places: { mkv: place({ timeUs: 1440 * S }) } }).kind).toBe('none');
    expect(encodeOffer({ defaults: null, places: { mkv: place() } }).kind).toBe('ask');
    expect(encodeOffer({ defaults: null, places: { mkv: place({ timeUs: 5 * S }) } }).kind).toBe('short');
  });
  it("carries an Up next card's settings, else the episode's defaults", () => {
    const upNext = { kind: 'up-next', encodeId: '100-3', settings: { ...settings, volume: 0.5 } } as unknown as ContinueItem;
    expect(encodeCarried([upNext], '100-3', null)?.settings.volume).toBe(0.5);
    expect(encodeCarried([upNext], '100-4', { defaults: settings, places: {} })).toEqual({ settings, byLanguage: true });
    expect(encodeCarried(null, '100-4', null)).toBeUndefined();
  });
});
