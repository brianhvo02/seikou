import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { PlaceSettings, PlaybackPlace } from '@seikou/nas/nas-api';
import { idbPlaceStore, MAX_SEND_ATTEMPTS, MAX_TEXT_FILE_BYTES, MAX_TEXT_FILES_BYTES } from './place-store';

const KEY = `f.${'A'.repeat(32)}`;
const settings: PlaceSettings = { audioLanguage: 'jpn', pgLanguage: null, textFiles: [], psr1: 1, psr2: 0, psr3: 1, textOn: false, textScale: 1, shaderSet: null, volume: 1, muted: false };
const place = (over: Partial<PlaybackPlace> = {}): PlaybackPlace => ({
  discKey: KEY, discId: '', playlistId: '00001', timeUs: 5e6, durationUs: 1440e6, finished: false,
  mode: 'none', title: null, psrs: [0, 1], gprs: null, settings, updatedAt: 1000, deviceName: 'iPad', ...over,
});

describe('idbPlaceStore', () => {
  it("keeps each playlist's place of a disc, with the newest one's settings as the defaults", async () => {
    const store = idbPlaceStore(new IDBFactory(), IDBKeyRange);
    expect(await store.get(KEY)).toEqual({ defaults: null, places: {} });
    await store.put(place());
    await store.put(place({ playlistId: '00002', timeUs: 9e6, updatedAt: 2000, settings: { ...settings, volume: 0.5 } }));
    await store.put(place({ discKey: `f.${'B'.repeat(32)}`, updatedAt: 3000 }));
    const got = await store.get(KEY);
    expect(Object.keys(got.places).sort()).toEqual(['00001', '00002']);
    expect(got.places['00002']!.timeUs).toBe(9e6);
    expect(got.defaults?.volume).toBe(0.5);
    await store.put(place({ timeUs: 7e6, updatedAt: 4000 }));
    expect((await store.get(KEY)).places['00001']!.timeUs).toBe(7e6);
  });

  it('never replaces a place with an older one', async () => {
    const store = idbPlaceStore(new IDBFactory(), IDBKeyRange);
    await store.put(place({ timeUs: 7e6, updatedAt: 4000 }));
    await store.put(place({ timeUs: 1e6, updatedAt: 3000 }));
    expect((await store.get(KEY)).places['00001']!.timeUs).toBe(7e6);
  });

  it('keeps the newest unsent place per key in the outbox, with its pairing, until it is sent', async () => {
    const store = idbPlaceStore(new IDBFactory(), IDBKeyRange);
    await store.queue(place({ updatedAt: 1000 }), 'dev1@https://nas/');
    await store.queue(place({ playlistId: '00002', updatedAt: 1500 }), 'dev1@https://nas/');
    await store.queue(place({ updatedAt: 2000, timeUs: 8e6 }), 'dev1@https://nas/');
    const out = await store.outbox();
    expect(out.map((e) => [e.place.playlistId, e.place.updatedAt, e.pairing, e.attempts])).toEqual([['00001', 2000, 'dev1@https://nas/', 0], ['00002', 1500, 'dev1@https://nas/', 0]]);
    // the send of an older copy doesn't take a newer one out
    await store.sent(`${KEY}/00001`, 1000);
    expect((await store.outbox()).map((e) => e.place.updatedAt)).toEqual([2000, 1500]);
    await store.sent(`${KEY}/00001`, 2000);
    await store.sent(`${KEY}/00002`, 1500);
    expect(await store.outbox()).toEqual([]);
  });

  it('counts refusals and lets a place go after the fifth; clears the outbox on demand', async () => {
    const store = idbPlaceStore(new IDBFactory(), IDBKeyRange);
    await store.queue(place(), 'p');
    for (let i = 1; i < MAX_SEND_ATTEMPTS; i++) {
      await store.failed(`${KEY}/00001`, 1000);
      expect((await store.outbox()).map((e) => e.attempts)).toEqual([i]);
    }
    await store.failed(`${KEY}/00001`, 1000);
    expect(await store.outbox()).toEqual([]);
    await store.queue(place(), 'p');
    await store.queue(place({ playlistId: '00002' }), 'p');
    await store.clearOutbox();
    expect(await store.outbox()).toEqual([]);
  });

  it('keeps text files per disc, leaving out a file over 5 MB and a set over 50 MB', async () => {
    const store = idbPlaceStore(new IDBFactory(), IDBKeyRange);
    expect(await store.textFiles(KEY)).toEqual([]);
    const small = { name: 'ep1.ass', bytes: new Uint8Array([1, 2, 3]) };
    const big = { name: 'huge.ttf', bytes: new Uint8Array(MAX_TEXT_FILE_BYTES + 1) };
    await store.putTextFiles(KEY, [small, big]);
    const kept = await store.textFiles(KEY);
    expect(kept.map((f) => f.name)).toEqual(['ep1.ass']);
    expect([...kept[0]!.bytes]).toEqual([1, 2, 3]);
    // eleven files of 5 MB pass 50 MB: the set isn't stored, and the one before stays
    const many = Array.from({ length: Math.floor(MAX_TEXT_FILES_BYTES / MAX_TEXT_FILE_BYTES) + 1 }, (_, i) => ({ name: `f${i}.ttf`, bytes: new Uint8Array(MAX_TEXT_FILE_BYTES) }));
    await store.putTextFiles(KEY, many);
    expect((await store.textFiles(KEY)).map((f) => f.name)).toEqual(['ep1.ass']);
    // a new set replaces the old one
    await store.putTextFiles(KEY, [{ name: 'ep2.srt', bytes: new Uint8Array([9]) }]);
    expect((await store.textFiles(KEY)).map((f) => f.name)).toEqual(['ep2.srt']);
  });

  it('opens a version 4 database without losing its records', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const req = factory.open('bluray-web', 4);
      req.onupgradeneeded = () => req.result.createObjectStore('settings', { keyPath: 'key' }).put({ key: 'volume', value: 0.3 });
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    const store = idbPlaceStore(factory, IDBKeyRange);
    await store.put(place());
    expect(Object.keys((await store.get(KEY)).places)).toEqual(['00001']);
    const kept = await new Promise<unknown>((resolve, reject) => {
      const req = factory.open('bluray-web');
      req.onsuccess = () => {
        const get = req.result.transaction('settings').objectStore('settings').get('volume');
        get.onsuccess = () => {
          req.result.close();
          resolve(get.result);
        };
      };
      req.onerror = () => reject(req.error);
    });
    expect(kept).toEqual({ key: 'volume', value: 0.3 });
  });

  it("never answers a NAS disc's place, and drops the ones older versions stored on upgrading", async () => {
    const factory = new IDBFactory();
    const nasPlace = place({ discId: '0123456789abcdef', playlistId: '00002', updatedAt: 2000 });
    // a version 5 database, as the branch's first builds wrote it: a NAS place and a local one under one fingerprint
    await new Promise<void>((resolve, reject) => {
      const req = factory.open('bluray-web', 5);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore('places', { keyPath: 'key' });
        s.put({ key: `${KEY}/00001`, place: place() });
        s.put({ key: `${KEY}/00002`, place: nasPlace });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    const store = idbPlaceStore(factory, IDBKeyRange);
    expect(Object.keys((await store.get(KEY)).places)).toEqual(['00001']);
    const left = await new Promise<unknown[]>((resolve, reject) => {
      const req = factory.open('bluray-web');
      req.onsuccess = () => {
        const all = req.result.transaction('places').objectStore('places').getAllKeys();
        all.onsuccess = () => {
          req.result.close();
          resolve(all.result);
        };
      };
      req.onerror = () => reject(req.error);
    });
    expect(left).toEqual([`${KEY}/00001`]);
    // and one put by mistake is never read back
    await store.put(place({ discId: 'fedcba9876543210', playlistId: '00003' }));
    expect(Object.keys((await store.get(KEY)).places)).toEqual(['00001']);
  });
});
