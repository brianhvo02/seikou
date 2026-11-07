import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlaybackPlace } from '@seikou/nas/nas-api';
import { appHandlers } from '../app';
import { lockFile } from '../atomic-json';
import { Auth } from '../auth';
import { BdjStore } from '../bdj-store';
import { createServer } from '../http';
import { Library } from '../library';
import type { TitleLibrary } from './titles';
import type { Catalogue } from '../titles/catalogue';
import type { DiscEvidence } from '../titles/evidence';
import { PlaybackStore } from '../playback-store';
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
