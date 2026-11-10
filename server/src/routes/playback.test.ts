import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlaybackPlace } from '@seikou/nas/nas-api';
import { appHandlers } from '../app';
import { lockFile } from '@seikou/titles/atomic-json';
import { Auth } from '../auth';
import { BdjStore } from '../bdj-store';
import { createServer } from '../http';
import { Library } from '../library';
import type { TitleLibrary } from './titles';
import type { Catalogue } from '@seikou/titles/catalogue';
import type { DiscEvidence } from '../titles/evidence';
import { PlaybackStore } from '../playback-store';
import type { EncodeIndex } from '../encodes/index-store';
import { Store } from '../store';

// Every name here is made up.

const KEY = `f.${'B'.repeat(32)}`;

let tmp: string;
let data: string;
let base = '';
let close: (() => void) | undefined;
let auth: Auth;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'playback-routes-'));
  data = join(tmp, 'data');
  auth = new Auth(new Store(data), Date.now);
  const library = new Library([], join(data, 'library.json'), { scanPauseMs: 0 });
  const server = createServer(appHandlers({
    auth, library, bdjStore: new BdjStore(data), playbackStore: new PlaybackStore(data), publicBase: 'https://nas.example/bluray/api/',
  }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.close();
    server.closeAllConnections();
  };
});
afterEach(() => {
  close?.();
  rmSync(tmp, { recursive: true, force: true });
});

async function tokenFor(name: string, owner: boolean): Promise<{ token: string; personId: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const { code } = auth.createCode({ newPerson: { name, owner } });
  const device = auth.redeem(code, `${name}'s phone`, jwk)!;
  const challenge = auth.challenge(device.id)!;
  const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(challenge))).toString('base64url');
  return { token: auth.startSession(device.id, challenge, signature)!.token, personId: device.personId };
}

const place = (over: Partial<PlaybackPlace> = {}): PlaybackPlace => ({
  discKey: KEY, discId: 'disc1', playlistId: '00001', timeUs: 5_000_000, durationUs: 60_000_000, finished: false,
  mode: 'none', title: null, psrs: [1, 2], gprs: null,
  settings: { pgLanguage: null, textFiles: [], audioLanguage: null, psr1: 1, psr2: 2, psr3: 3, textOn: false, textScale: 1, shaderSet: null, volume: 1, muted: false },
  updatedAt: 1000, deviceName: 'Phone', ...over,
});

const call = (method: string, path: string, token: string | null, body?: unknown): Promise<Response> =>
  fetch(`${base}/api/me/playback/${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('playback routes', () => {
  it('answers 401 without a token', async () => {
    expect((await call('GET', KEY, null)).status).toBe(401);
    expect((await call('PUT', `${KEY}/00001`, null, place())).status).toBe(401);
  });

  it('puts, gets and deletes places', async () => {
    const { token } = await tokenFor('Mika', false);
    expect((await call('GET', KEY, token)).status).toBe(404);
    expect((await call('PUT', `${KEY}/00001`, token, place())).status).toBe(204);
    expect((await call('PUT', `${KEY}/00002`, token, place({ playlistId: '00002' }))).status).toBe(204);
    const got = (await (await call('GET', KEY, token)).json()) as { places: Record<string, PlaybackPlace> };
    expect(Object.keys(got.places).sort()).toEqual(['00001', '00002']);
    expect((await call('DELETE', `${KEY}/00001`, token)).status).toBe(204);
    const left = (await (await call('GET', KEY, token)).json()) as { places: Record<string, PlaybackPlace> };
    expect(Object.keys(left.places)).toEqual(['00002']);
    expect((await call('DELETE', KEY, token)).status).toBe(204);
    expect((await call('GET', KEY, token)).status).toBe(404);
  });

  it('keeps one person\'s places from another', async () => {
    const owner = await tokenFor('Hana', true);
    const guest = await tokenFor('Mika', false);
    await call('PUT', `${KEY}/00001`, guest.token, place());
    expect((await call('GET', KEY, owner.token)).status).toBe(404);
    expect((await call('DELETE', KEY, owner.token)).status).toBe(204);
    expect((await call('GET', KEY, guest.token)).status).toBe(200);
    await call('PUT', `${KEY}/00001`, owner.token, place({ timeUs: 1 }));
    const mine = (await (await call('GET', KEY, guest.token)).json()) as { places: Record<string, PlaybackPlace> };
    expect(mine.places['00001']!.timeUs).toBe(5_000_000);
  });

  it('answers 409 for a stale put', async () => {
    const { token } = await tokenFor('Mika', false);
    await call('PUT', `${KEY}/00001`, token, place({ updatedAt: 2000 }));
    const res = await call('PUT', `${KEY}/00001`, token, place({ updatedAt: 1000 }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'stale' });
  });

  it('answers 413 over 256 KiB, 400 for a mismatched key or bad body, 404 for a bad path', async () => {
    const { token } = await tokenFor('Mika', false);
    const big = place({ psrs: new Array<number>(60_000).fill(123_456) });
    expect((await call('PUT', `${KEY}/00001`, token, big)).status).toBe(413);
    expect((await call('PUT', `${KEY}/00009`, token, place())).status).toBe(400);
    expect((await call('PUT', `f.${'C'.repeat(32)}/00001`, token, place())).status).toBe(400);
    expect((await call('PUT', `${KEY}/00001`, token, '{nope')).status).toBe(400);
    expect((await call('PUT', `${KEY}/00001`, token, { ...place(), timeUs: 'x' })).status).toBe(400);
    expect((await call('GET', '..%2Fx', token)).status).toBe(404);
    expect((await call('GET', 'f.zz', token)).status).toBe(404);
    expect((await call('GET', `${KEY}/00001/x`, token)).status).toBe(404);
    // a bad key says so, unlike a NAS without these routes
    const bad = await call('PUT', `${KEY}/a.b`, token, place());
    expect([bad.status, await bad.json()]).toEqual([404, { error: 'bad-key' }]);
  });

  it('is cleared with the person\'s saved data', async () => {
    const owner = await tokenFor('Hana', true);
    const guest = await tokenFor('Mika', false);
    await call('PUT', `${KEY}/00001`, guest.token, place());
    const dir = join(data, 'users', guest.personId, 'playback');
    expect(existsSync(dir)).toBe(true);
    const res = await fetch(`${base}/api/admin/people/${guest.personId}/saved-data`, { method: 'DELETE', headers: { Authorization: `Bearer ${owner.token}` } });
    expect(res.status).toBe(204);
    expect(existsSync(dir)).toBe(false);
    expect((await call('GET', KEY, guest.token)).status).toBe(404);
  });

  it('answers 413 for an over-limit body streamed without a Content-Length', async () => {
    const { token } = await tokenFor('Mika', false);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/api/me/playback/${KEY}/00001`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      for (let i = 0; i < 6; i++) req.write(Buffer.alloc(64 * 1024, 0x20));
      req.end();
    });
    expect(status).toBe(413);
  });

  it('answers 503 with Retry-After while the disc file is locked', async () => {
    const { token, personId } = await tokenFor('Mika', false);
    const dir = join(data, 'users', personId, 'playback');
    mkdirSync(dir, { recursive: true });
    const unlock = lockFile(join(dir, `${KEY}.json`));
    try {
      const res = await call('PUT', `${KEY}/00001`, token, place());
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
    } finally {
      unlock();
    }
  }, 15_000);

  it('keeps both of two puts to different playlists of one disc', async () => {
    const { token } = await tokenFor('Mika', false);
    const results = await Promise.all([
      call('PUT', `${KEY}/00001`, token, place()),
      call('PUT', `${KEY}/00002`, token, place({ playlistId: '00002' })),
    ]);
    expect(results.map((r) => r.status)).toEqual([204, 204]);
    const got = (await (await call('GET', KEY, token)).json()) as { places: Record<string, PlaybackPlace> };
    expect(Object.keys(got.places).sort()).toEqual(['00001', '00002']);
  });
});

describe('Continue watching routes', () => {
  const summary = { id: 'star', kind: 'series', names: { english: 'Starfall Wanderer', romaji: null, native: null, synonyms: [], display: null }, poster: 'art1', year: null, seasons: 1, discs: 1, addedAt: 0, own: false };
  const ep = (number: number, playlistId: string) => ({ number, name: null, runtimeMin: 24, discId: 'disc1', playlistId });
  const detail = {
    title: summary, banner: null, related: [], extras: [],
    seasons: [{ id: 's1', label: '', number: 1, discs: [{ number: 1, label: 'Disc 1', copies: [{ discId: 'disc1', root: 'r', folder: 'f', displayName: null }] }], episodes: [ep(1, '00001'), ep(2, '00002')], extras: [] }],
  };
  const catalogue = { titles: [summary], detail: (id: string) => (id === 'star' ? detail : null), unsorted: [], hidden: [], art: () => null, provisional: [] } as unknown as Catalogue;
  let gate: 'owners' | 'everyone' = 'everyone';
  const titles = { service: { gate: () => gate, catalogue: () => catalogue }, owner: {} } as unknown as TitleLibrary;
  let url = '';
  let stop: (() => void) | undefined;

  beforeEach(async () => {
    gate = 'everyone';
    const library = { evidence: () => [{ discId: 'disc1', fingerprint: 'B'.repeat(32) }] as unknown as DiscEvidence[] } as unknown as Library;
    const server = createServer(appHandlers({ auth, library, bdjStore: new BdjStore(data), playbackStore: new PlaybackStore(data), publicBase: 'https://nas.example/bluray/api/', titles }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stop = () => { server.close(); server.closeAllConnections(); };
  });
  afterEach(() => stop?.());

  const get = (path: string, token: string | null): Promise<Response> => fetch(`${url}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  it('lists resume and up-next cards and answers a title\'s progress', async () => {
    const { token } = await tokenFor('Mika', false);
    expect((await get('/api/me/playback', null)).status).toBe(401);
    expect(await (await get('/api/me/playback', token)).json()).toEqual([]);
    await call('PUT', `${KEY}/00001`, token, place({ finished: true, updatedAt: 2000 }));
    const list = (await (await get('/api/me/playback', token)).json()) as { kind: string; discKey: string; playlistId: string; titleName: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'up-next', discKey: KEY, playlistId: '00002', titleName: 'Starfall Wanderer' });
    await call('PUT', `${KEY}/00002`, token, place({ playlistId: '00002', updatedAt: 3000 }));
    const after = (await (await get('/api/me/playback', token)).json()) as { kind: string }[];
    expect(after.map((i) => i.kind)).toEqual(['resume']);
    const progress = await (await get('/api/me/playback/title/star', token)).json();
    expect(progress).toEqual({ disc1: { '00001': { timeUs: 5_000_000, durationUs: 60_000_000, finished: true }, '00002': { timeUs: 5_000_000, durationUs: 60_000_000, finished: false } } });
    expect((await get('/api/me/playback/title/nope', token)).status).toBe(404);
  });

  it('hides the catalogue from a guest while the gate is owners', async () => {
    gate = 'owners';
    const guest = await tokenFor('Mika', false);
    const owner = await tokenFor('Hana', true);
    await call('PUT', `${KEY}/00001`, guest.token, place({ finished: true }));
    await call('PUT', `${KEY}/00002`, guest.token, place({ playlistId: '00002', updatedAt: 500 }));
    expect((await get('/api/me/playback/title/star', guest.token)).status).toBe(404);
    const list = (await (await get('/api/me/playback', guest.token)).json()) as { kind: string; titleId: string | null }[];
    expect(list).toEqual([expect.objectContaining({ kind: 'resume', titleId: null })]);
    await call('PUT', `${KEY}/00001`, owner.token, place({ finished: true }));
    expect((await get('/api/me/playback/title/star', owner.token)).status).toBe(200);
  });
});

describe('encode places', () => {
  const EKEY = 'e.990001.1';
  const encodePlace = (over: Partial<PlaybackPlace> = {}): PlaybackPlace => place({ discKey: EKEY, discId: '990001-1', playlistId: 'mkv', psrs: [], ...over });
  const entry = (episode: number) => ({ id: `990001-${episode}`, title: { source: 'anilist' as const, anilistId: 990001 }, titleName: null, anilistId: 990001, episode, episodeTitle: null, durationMs: 1_440_000, path: '/x' });
  let gate: 'owners' | 'everyone' = 'everyone';
  let url = '';
  let stop: (() => void) | undefined;

  beforeEach(async () => {
    gate = 'everyone';
    const library = new Library([], join(data, 'library.json'), { scanPauseMs: 0 });
    const titles = { service: { gate: () => gate, catalogue: () => ({ titles: [], detail: () => null }), entriesFor: () => new Map(), encodeNames: () => () => null, addEncodeArt: () => {} }, owner: {} } as unknown as TitleLibrary;
    const encodes = { ready: async () => true, list: () => [entry(1), entry(2)] } as unknown as EncodeIndex;
    const server = createServer(appHandlers({ auth, library, bdjStore: new BdjStore(data), playbackStore: new PlaybackStore(data), publicBase: 'https://nas.example/bluray/api/', titles, encodes }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stop = () => { server.close(); server.closeAllConnections(); };
  });
  afterEach(() => stop?.());

  const at = (method: string, path: string, token: string, body?: unknown): Promise<Response> =>
    fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('an e. key stores and reads a place', async () => {
    const { token } = await tokenFor('Mika', false);
    expect((await at('PUT', `/api/me/playback/${EKEY}/mkv`, token, encodePlace())).status).toBe(204);
    expect((await (await at('GET', `/api/me/playback/${EKEY}`, token)).json() as { places: Record<string, unknown> }).places).toEqual({ mkv: encodePlace() });
    expect((await at('PUT', `/api/me/playback/${EKEY}/mkv`, token, encodePlace({ mode: 'hdmv' }))).status).toBe(400);
    expect((await at('PUT', `/api/me/playback/${EKEY}/mkv`, token, encodePlace({ discId: '990001-2' }))).status).toBe(400);
    expect((await at('DELETE', `/api/me/playback/${EKEY}/mkv`, token)).status).toBe(204);
    expect((await at('GET', `/api/me/playback/${EKEY}`, token)).status).toBe(404);
  });

  it('a TMDB episode key stores a place, and a TMDB series key without a season is bad-key', async () => {
    const { token } = await tokenFor('Mika', false);
    const tv = encodePlace({ discKey: 'e.tv990101s1.2', discId: 'tv990101s1-2' });
    expect((await at('PUT', '/api/me/playback/e.tv990101s1.2/mkv', token, tv)).status).toBe(204);
    expect((await (await at('GET', '/api/me/playback/e.tv990101s1.2', token)).json() as { places: Record<string, unknown> }).places).toEqual({ mkv: tv });
    const bad = await at('PUT', '/api/me/playback/e.tv990101.2/mkv', token, encodePlace({ discKey: 'e.tv990101.2', discId: 'tv990101-2' }));
    expect([bad.status, await bad.json()]).toEqual([404, { error: 'bad-key' }]);
  });

  it('a disc route answers 404 bad-key for an e. key', async () => {
    const { token } = await tokenFor('Mika', false);
    const wrong = await at('PUT', `/api/me/playback/${EKEY}/00001`, token, encodePlace({ playlistId: '00001' }));
    expect([wrong.status, await wrong.json()]).toEqual([404, { error: 'bad-key' }]);
    const bad = await at('GET', '/api/me/playback/e.0.1', token);
    expect([bad.status, await bad.json()]).toEqual([404, { error: 'bad-key' }]);
    expect((await at('GET', `/api/discs/resolve/${EKEY}`, token)).status).toBe(404);
  });

  it('continue watching lists encodes only in the encodes list', async () => {
    const { token } = await tokenFor('Mika', false);
    await at('PUT', `/api/me/playback/${EKEY}/mkv`, token, encodePlace({ finished: true, updatedAt: 2000 }));
    await at('PUT', `/api/me/playback/${KEY}/00001`, token, place());
    const discs = (await (await at('GET', '/api/me/playback', token)).json()) as { discKey: string }[];
    expect(discs.map((i) => i.discKey)).toEqual([KEY]);
    const list = (await (await at('GET', '/api/me/playback?library=encodes', token)).json()) as unknown[];
    expect(list).toEqual([expect.objectContaining({ kind: 'up-next', encodeId: '990001-2', discKey: '', discId: '', playlistId: 'mkv', titleId: '990001', titleName: 'AniList 990001' })]);
    expect((await at('GET', '/api/me/playback?library=nope', token)).status).toBe(400);
    const progress = await (await at('GET', '/api/me/playback/title/990001?library=encodes', token)).json();
    expect(progress).toEqual({ '990001-1': { mkv: { timeUs: 5_000_000, durationUs: 60_000_000, finished: true } } });
    expect((await at('GET', '/api/me/playback/title/42?library=encodes', token)).status).toBe(404);
  });

  it('hides the encodes catalogue from a guest while the gate is owners', async () => {
    gate = 'owners';
    const { token } = await tokenFor('Mika', false);
    await at('PUT', `/api/me/playback/${EKEY}/mkv`, token, encodePlace({ finished: true }));
    await at('PUT', '/api/me/playback/e.990001.2/mkv', token, encodePlace({ discKey: 'e.990001.2', discId: '990001-2' }));
    const list = (await (await at('GET', '/api/me/playback?library=encodes', token)).json()) as unknown[];
    expect(list).toEqual([expect.objectContaining({ kind: 'resume', encodeId: '990001-2', titleId: null })]);
    expect((await at('GET', '/api/me/playback/title/990001?library=encodes', token)).status).toBe(404);
  });
});
