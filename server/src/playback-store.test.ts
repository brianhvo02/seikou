import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlaybackPlace } from '@seikou/nas/nas-api';
import { fitsKey, isPlaybackPlace, PlaybackStore } from './playback-store';

// Every name here is made up.

const KEY = `f.${'A'.repeat(32)}`;
const OTHER = `d.${'0123456789abcdef'}`;

const place = (over: Partial<PlaybackPlace> = {}): PlaybackPlace => ({
  discKey: KEY, discId: 'disc1', playlistId: '00001', timeUs: 5_000_000, durationUs: 60_000_000, finished: false,
  mode: 'none', title: null, psrs: [1, 2], gprs: null,
  settings: { pgLanguage: null, textFiles: [], audioLanguage: 'jpn', psr1: 1, psr2: 2, psr3: 3, textOn: false, textScale: 1, shaderSet: null, volume: 1, muted: false },
  updatedAt: 1000, deviceName: 'Mika phone', ...over,
});

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'playback-store-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('PlaybackStore', () => {
  it('round-trips a place and answers null for an unknown disc', () => {
    const store = new PlaybackStore(tmp);
    expect(store.get('mika', KEY)).toBeNull();
    expect(store.put('mika', place())).toBe('stored');
    const got = store.get('mika', KEY)!;
    expect(got.places['00001']).toEqual(place());
    expect(store.all('mika')).toEqual([place()]);
    expect(store.get('sora', KEY)).toBeNull();
  });

  it('refuses a stale put and keeps the newer place', () => {
    const store = new PlaybackStore(tmp);
    store.put('mika', place({ timeUs: 9_000_000, updatedAt: 2000 }));
    expect(store.put('mika', place({ timeUs: 1_000_000, updatedAt: 1500 }))).toBe('stale');
    expect(store.get('mika', KEY)!.places['00001']!.timeUs).toBe(9_000_000);
    expect(store.put('mika', place({ timeUs: 9_500_000, updatedAt: 2000 }))).toBe('stored');
    // another playlist is not compared with it
    expect(store.put('mika', place({ playlistId: '00002', updatedAt: 10 }))).toBe('stored');
  });

  it('keeps the settings of the latest put as defaults', () => {
    const store = new PlaybackStore(tmp);
    store.put('mika', place());
    const settings = { ...place().settings, volume: 0.5, muted: true };
    store.put('mika', place({ playlistId: '00002', updatedAt: 2000, settings }));
    expect(store.get('mika', KEY)!.defaults).toEqual(settings);
  });

  it('deletes one playlist or a whole disc', () => {
    const store = new PlaybackStore(tmp);
    store.put('mika', place());
    store.put('mika', place({ playlistId: '00002' }));
    store.delete('mika', KEY, '00001');
    expect(Object.keys(store.get('mika', KEY)!.places)).toEqual(['00002']);
    store.delete('mika', KEY);
    expect(store.get('mika', KEY)).toBeNull();
    expect(readdirSync(join(tmp, 'users', 'mika', 'playback'))).toEqual([]);
    store.delete('mika', OTHER);
  });

  it('prunes finished places first, then the oldest, over the cap', () => {
    const store = new PlaybackStore(tmp, { maxPlaces: 3 });
    store.put('mika', place({ playlistId: '1', updatedAt: 10 }));
    store.put('mika', place({ playlistId: '2', updatedAt: 20, finished: true }));
    store.put('mika', place({ discKey: OTHER, playlistId: '3', updatedAt: 5 }));
    store.put('mika', place({ playlistId: '4', updatedAt: 30 }));
    expect(store.all('mika').map((p) => p.playlistId).sort()).toEqual(['1', '3', '4']);
    store.put('mika', place({ playlistId: '5', updatedAt: 40 }));
    expect(store.all('mika').map((p) => p.playlistId).sort()).toEqual(['1', '4', '5']);
    expect(existsSync(join(tmp, 'users', 'mika', 'playback', `${OTHER}.json`))).toBe(false);
  });

  it('clamps a far-future updatedAt to the server clock plus five minutes', () => {
    let now = 1_000_000;
    const store = new PlaybackStore(tmp, { now: () => now });
    store.put('mika', place({ updatedAt: now + 3_600_000 }));
    expect(store.get('mika', KEY)!.places['00001']!.updatedAt).toBe(now + 300_000);
    now += 6 * 60_000;
    expect(store.put('mika', place({ timeUs: 7, updatedAt: now + 3_600_000 }))).toBe('stored');
    expect(store.get('mika', KEY)!.places['00001']!.timeUs).toBe(7);
  });

  it('rejects a bad disc key or person', () => {
    const store = new PlaybackStore(tmp);
    expect(() => store.get('mika', '../x')).toThrow();
    expect(() => store.put('mika', place({ discKey: 'f.zz' }))).toThrow();
    expect(() => store.get('../mika', KEY)).toThrow();
    expect(() => store.all('a/b')).toThrow();
  });
});

describe('isPlaybackPlace', () => {
  const withFile = (file: Record<string, unknown>): unknown => {
    const p = place();
    return { ...p, settings: { ...p.settings, textFiles: [{ name: 'ep1.ass', size: 10, startUs: 0, offsetMs: 900, ...file }] } };
  };
  it('takes a text file with or without a stored subtitle id and language', () => {
    expect(isPlaybackPlace(withFile({}))).toBe(true);
    expect(isPlaybackPlace(withFile({ subtitleId: 'a'.repeat(64), language: 'en' }))).toBe(true);
    expect(isPlaybackPlace(withFile({ subtitleId: 's1' }))).toBe(true);
  });
  it('refuses a bad stored subtitle id or language', () => {
    expect(isPlaybackPlace(withFile({ subtitleId: 'a'.repeat(65) }))).toBe(false);
    expect(isPlaybackPlace(withFile({ subtitleId: '' }))).toBe(false);
    expect(isPlaybackPlace(withFile({ subtitleId: 7 }))).toBe(false);
    expect(isPlaybackPlace(withFile({ subtitleId: 's1', language: '' }))).toBe(false);
    expect(isPlaybackPlace(withFile({ subtitleId: 's1', language: 'x'.repeat(36) }))).toBe(false);
    expect(isPlaybackPlace(withFile({ subtitleId: 's1', language: null }))).toBe(false);
  });
  it("takes a viewer's Anime Tosho pick and refuses a malformed one", () => {
    const fansub = { releaseId: 7001, fileId: 7101, track: 0, trackName: 'Full' };
    expect(isPlaybackPlace(withFile({ language: 'eng', fansub }))).toBe(true);
    expect(isPlaybackPlace(withFile({ fansub: { ...fansub, trackName: '' } }))).toBe(true);
    expect(isPlaybackPlace(withFile({ fansub: { ...fansub, fileId: -1 } }))).toBe(false);
    expect(isPlaybackPlace(withFile({ fansub: { ...fansub, track: 0.5 } }))).toBe(false);
    expect(isPlaybackPlace(withFile({ fansub: { fileId: 7101, track: 0, trackName: 'Full' } }))).toBe(false);
    expect(isPlaybackPlace(withFile({ fansub: { ...fansub, trackName: 'x'.repeat(257) } }))).toBe(false);
    expect(isPlaybackPlace(withFile({ fansub: null }))).toBe(false);
  });
});

describe('encode places', () => {
  const EKEY = 'e.990001.2';
  const encodePlace = (over: Partial<PlaybackPlace> = {}): PlaybackPlace => place({ discKey: EKEY, discId: '990001-2', playlistId: 'mkv', psrs: [], ...over });

  it('an e. key stores and reads a place', () => {
    const store = new PlaybackStore(tmp);
    expect(store.put('mika', encodePlace())).toBe('stored');
    expect(store.get('mika', EKEY)!.places.mkv).toEqual(encodePlace());
    expect(existsSync(join(tmp, 'users', 'mika', 'playback', `${EKEY}.json`))).toBe(true);
    store.put('mika', place());
    expect(store.all('mika')).toHaveLength(2);
    expect(store.all('mika', 'encode')).toEqual([encodePlace()]);
    expect(store.all('mika', 'disc')).toEqual([place()]);
    store.delete('mika', EKEY, 'mkv');
    expect(store.get('mika', EKEY)).toBeNull();
    expect(() => store.get('mika', 'e.0.1')).toThrow();
  });

  it('counts encode and disc places under one cap', () => {
    const store = new PlaybackStore(tmp, { maxPlaces: 2 });
    store.put('mika', place({ updatedAt: 1 }));
    store.put('mika', encodePlace({ updatedAt: 2 }));
    store.put('mika', encodePlace({ discKey: 'e.990001.3', discId: '990001-3', updatedAt: 3 }));
    expect(store.all('mika').map((p) => p.discKey).sort()).toEqual(['e.990001.2', 'e.990001.3']);
  });

  it('fitsKey wants an encode place to be the encode with no program state', () => {
    expect(fitsKey(encodePlace())).toBe(true);
    expect(fitsKey(place())).toBe(true);
    expect(fitsKey(encodePlace({ discId: '990001-3' }))).toBe(false);
    expect(fitsKey(encodePlace({ playlistId: '00001' }))).toBe(false);
    expect(fitsKey(encodePlace({ mode: 'hdmv' }))).toBe(false);
    expect(fitsKey(encodePlace({ psrs: [1] }))).toBe(false);
    expect(fitsKey(encodePlace({ gprs: { 1: 2 } }))).toBe(false);
    expect(fitsKey(encodePlace({ title: 1 }))).toBe(false);
    expect(fitsKey(place({ discKey: 'x.1' }))).toBe(false);
  });
});
