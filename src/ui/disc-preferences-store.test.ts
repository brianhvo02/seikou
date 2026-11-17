// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { AUTO_DISC_PREFERENCES, type DiscPreferences, type PlayerSettings } from '@seikou/nas/nas-api';
import type { PlayerSettings as EngineSettings } from '@seikou/engine';
import { DiscPreferencesStore, type DiscPreferencesDeps } from './disc-preferences-store';

const jpn: DiscPreferences = { ...AUTO_DISC_PREFERENCES, audioLanguage: 'jpn' };
const eng: DiscPreferences = { ...AUTO_DISC_PREFERENCES, audioLanguage: 'eng' };
const KEY = (scope: string) => `bluray-web:disc-preferences:${scope}`;

function memoryStorage(init: Record<string, unknown> = {}): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function setup(opts: { storage?: DiscPreferencesDeps['storage']; scope?: string; get?: () => Promise<PlayerSettings>; put?: (b: unknown) => Promise<PlayerSettings>; nas?: boolean } = {}) {
  let scope = opts.scope ?? 'nas#mika';
  const sent: EngineSettings[] = [];
  const get = vi.fn(opts.get ?? (() => new Promise<PlayerSettings>(() => undefined)));
  const put = vi.fn(opts.put ?? (async (b: unknown) => ({ nextEpisodeCountdown: false, discPreferences: (b as { discPreferences: DiscPreferences }).discPreferences })));
  const storage = opts.storage ?? memoryStorage();
  const store = new DiscPreferencesStore({
    storage,
    scope: () => scope,
    nas: () => (opts.nas === false ? null : { get, put }),
    send: (s) => sent.push(s),
    locale: () => 'en-US',
    countdown: () => false,
  });
  return { store, sent, get, put, storage, setScope: (s: string) => (scope = s) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('DiscPreferencesStore', () => {
  it('sends the device copy at once, before the NAS answers', async () => {
    const t = setup({ storage: memoryStorage({ [KEY('nas#mika')]: { prefs: jpn, pending: false } }) });
    void t.store.load();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ audioLanguage: 'jpn' });
  });

  it("the NAS's copy wins when nothing is pending", async () => {
    const t = setup({ storage: memoryStorage({ [KEY('nas#mika')]: { prefs: jpn, pending: false } }), get: async () => ({ nextEpisodeCountdown: false, discPreferences: eng }) });
    await t.store.load();
    expect(t.store.current().audioLanguage).toBe('eng');
    expect(t.sent.at(-1)).toMatchObject({ audioLanguage: 'eng' });
    expect(JSON.parse(t.storage.getItem(KEY('nas#mika'))!)).toEqual({ prefs: eng, pending: false });
    expect(t.store.state()).toBe('synced');
  });

  it('a pending edit wins over the NAS and is put again', async () => {
    const t = setup({ storage: memoryStorage({ [KEY('nas#mika')]: { prefs: jpn, pending: true } }), get: async () => ({ nextEpisodeCountdown: true, discPreferences: eng }) });
    await t.store.load();
    expect(t.put).toHaveBeenCalledWith({ nextEpisodeCountdown: true, discPreferences: jpn });
    expect(t.store.current().audioLanguage).toBe('jpn');
    expect(JSON.parse(t.storage.getItem(KEY('nas#mika'))!)).toEqual({ prefs: jpn, pending: false });
  });

  it('a NAS that never saved any gets the device copy', async () => {
    const t = setup({ storage: memoryStorage({ [KEY('nas#mika')]: { prefs: jpn, pending: false } }), get: async () => ({ nextEpisodeCountdown: false, discPreferences: null }) });
    await t.store.load();
    expect(t.put).toHaveBeenCalledWith({ nextEpisodeCountdown: false, discPreferences: jpn });
  });

  it('an older NAS keeps them on the device', async () => {
    const t = setup({ get: async () => ({ nextEpisodeCountdown: true }) as PlayerSettings });
    await t.store.load();
    expect(t.store.state()).toBe('device-only');
    await t.store.set(jpn);
    expect(t.put).not.toHaveBeenCalled();
    expect(t.store.current()).toEqual(jpn);
    expect(t.sent.at(-1)).toMatchObject({ audioLanguage: 'jpn' });
  });

  it('an edit with the NAS down stays pending', async () => {
    const t = setup({ get: async () => ({ nextEpisodeCountdown: false, discPreferences: null }), put: async () => Promise.reject(new Error('offline')) });
    await t.store.load();
    await t.store.set(jpn);
    await flush();
    expect(JSON.parse(t.storage.getItem(KEY('nas#mika'))!)).toEqual({ prefs: jpn, pending: true });
    expect(t.store.state()).toBe('pending');
  });

  it("another person on the device never gets the first's pins", async () => {
    const t = setup({ storage: memoryStorage({ [KEY('nas#mika')]: { prefs: jpn, pending: false } }) });
    void t.store.load();
    t.setScope('nas#sora');
    void t.store.rescope();
    expect(t.store.current()).toEqual(AUTO_DISC_PREFERENCES);
    expect(t.sent.at(-1)).not.toHaveProperty('audioLanguage');
  });

  it('a newly paired person starts from the unpaired copy', async () => {
    const t = setup({ storage: memoryStorage({ [KEY('local')]: { prefs: jpn, pending: false } }) });
    void t.store.load();
    expect(t.store.current()).toEqual(jpn);
  });

  it('with no pairing the unpaired copy is the only one', async () => {
    const t = setup({ scope: 'local', nas: false });
    await t.store.load();
    expect(t.store.state()).toBe('unpaired');
    await t.store.set(jpn);
    expect(JSON.parse(t.storage.getItem(KEY('local'))!)).toEqual({ prefs: jpn, pending: false });
  });

  it('storage that throws reads as Auto', async () => {
    const t = setup({ storage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } });
    void t.store.load();
    expect(t.store.current()).toEqual(AUTO_DISC_PREFERENCES);
    await t.store.set(jpn);
    expect(t.store.current()).toEqual(jpn);
  });

  it('tells subscribers when the preferences change', async () => {
    const t = setup({ nas: false, scope: 'local' });
    const fn = vi.fn();
    t.store.subscribe(fn);
    await t.store.set(jpn);
    expect(fn).toHaveBeenCalled();
  });
});
