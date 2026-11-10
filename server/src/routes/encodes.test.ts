// SPDX-License-Identifier: LGPL-3.0-or-later
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscManifest } from '@seikou/nas/nas-api';
import { appHandlers } from '../app';
import { Auth } from '../auth';
import { BdjStore } from '../bdj-store';
import { EncodeIndex } from '../encodes/index-store';
import { retagged } from '../encodes/test-retag';
import { createServer } from '../http';
import { Library } from '../library';
import { Store } from '../store';
import type { Entry } from '@seikou/titles/sources';
import type { TitleLibrary } from './titles';

const FIXTURE = join(import.meta.dirname, '../../../fixtures/encodes/990001');
let tmp: string;
let base = '';
let close: (() => void) | undefined;
let auth: Auth;
let gate: 'owners' | 'everyone';
let known: Map<number, Entry>;
const arts = new Map<string, unknown>();

/** A made-up AniList TV entry. */
function tv(n: number, name: string): Entry {
  return {
    source: 'anilist', id: `anilist:${n}`, kind: 'series', format: 'TV', names: { english: name, romaji: null, native: null, synonyms: [] }, animation: true, year: 2020,
    episodes: 12, runtimeMin: 24, seasons: [], relations: [], poster: { small: 'https://img.example/s.jpg', large: 'https://img.example/l.jpg' }, banner: null,
  };
}

async function start(configured: boolean, opts: { scan?: boolean; waitMs?: number; dirOverride?: string; loose?: boolean; second?: boolean } = {}): Promise<EncodeIndex | undefined> {
  const data = join(tmp, 'data');
  const dir = join(tmp, 'encodes');
  mkdirSync(join(dir, '990001'), { recursive: true });
  cpSync(join(FIXTURE, '1.mkv'), join(dir, '990001/1.mkv'));
  if (opts.second) cpSync(join(FIXTURE, '2.mkv'), join(dir, '990001/2.mkv'));
  if (opts.loose) writeFileSync(join(dir, 'loose.mkv'), 'not an mkv');
  auth = new Auth(new Store(data), Date.now);
  const library = new Library([], join(data, 'library.json'), { scanPauseMs: 0 });
  const encodes = configured ? new EncodeIndex({ dir: opts.dirOverride ?? dir, dataDir: data, log: () => {}, settleMs: 0 }) : undefined;
  if (encodes && opts.scan !== false) void encodes.scan().catch(() => {});
  const titles = { service: { gate: () => gate, entriesFor: () => known, addEncodeArt: (a: Map<string, unknown>) => { for (const [k, v] of a) arts.set(k, v); } }, owner: {} } as unknown as TitleLibrary;
  const server = createServer(appHandlers({
    auth, library, bdjStore: new BdjStore(data), publicBase: 'https://nas.example/bluray/api/', titles, ...(encodes ? { encodes } : {}), ...(opts.waitMs !== undefined ? { encodesWaitMs: opts.waitMs } : {}),
  }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.close();
    server.closeAllConnections();
  };
  return encodes;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'encodes-routes-'));
  gate = 'everyone';
  known = new Map();
  arts.clear();
});
afterEach(() => {
  close?.();
  rmSync(tmp, { recursive: true, force: true });
});

async function token(name: string, owner: boolean): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const { code } = auth.createCode({ newPerson: { name, owner } });
  const device = auth.redeem(code, `${name}'s phone`, jwk)!;
  const challenge = auth.challenge(device.id)!;
  const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(challenge))).toString('base64url');
  return auth.startSession(device.id, challenge, signature)!.token;
}

const get = (path: string, t: string | null, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/api/encodes/${path}`, { headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...headers } });

describe('encodes routes', () => {
  it('serves a range of an episode with 206 and 416 out of range', async () => {
    await start(true);
    const t = await token('Guest', false);
    const bytes = readFileSync(join(FIXTURE, '1.mkv'));
    const manifest = (await (await get('990001-1/manifest', t)).json()) as DiscManifest;
    expect(manifest).toEqual({ discId: '990001-1', name: 'The Lantern Road', files: [{ path: 'EPISODE.MKV', size: bytes.length }], inline: {} });
    const part = await get('990001-1/files/EPISODE.MKV', t, { Range: 'bytes=100-299' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 100-299/${bytes.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 300))).toBe(true);
    const whole = await get('990001-1/files/EPISODE.MKV', t);
    expect(whole.status).toBe(200);
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);
    expect((await get('990001-1/files/EPISODE.MKV', t, { Range: `bytes=${bytes.length}-` })).status).toBe(416);
    expect((await get('990001-9/manifest', t)).status).toBe(404);
    expect((await get('990001-1/files/OTHER.MKV', t)).status).toBe(404);
    expect((await get('990001-1/manifest', null)).status).toBe(401);
  });

  it('answers the details without the server path', async () => {
    await start(true);
    const t = await token('Guest', false);
    const detail = (await (await get('990001-1', t)).json()) as Record<string, unknown>;
    expect(detail).toMatchObject({ id: '990001-1', anilistId: 990001, episode: 1, episodeTitle: 'The Lantern Road' });
    expect(detail.path).toBeUndefined();
    expect((detail.chapters as unknown[]).length).toBe(5);
    expect((detail.tracks as unknown[]).length).toBe(4);
    expect(JSON.stringify(detail)).not.toContain(tmp);
  });

  it('status says not configured without ENCODES_DIR', async () => {
    await start(false);
    const t = await token('Owner', true);
    expect(await (await get('status', t)).json()).toEqual({ configured: false, count: 0 });
    expect((await get('990001-1/manifest', t)).status).toBe(404);
  });

  it('status counts the indexed episodes once the first scan is done', async () => {
    await start(true);
    const t = await token('Owner', true);
    expect(await (await get('status', t)).json()).toEqual({ configured: true, count: 1 });
  });

  it('answers 503 indexing while the first scan has not finished, and status says scanning', async () => {
    await start(true, { scan: false, waitMs: 20 });
    const t = await token('Owner', true);
    const r = await get('990001-1/manifest', t);
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('5');
    expect(await r.json()).toEqual({ error: 'indexing' });
    expect(await (await get('status', t)).json()).toEqual({ configured: true, scanning: true });
  });

  it('answers 503 when a slow first scan outlasts the wait, then serves once it is done', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const data = join(tmp, 'data');
    const dir = join(tmp, 'encodes');
    mkdirSync(join(dir, '990001'), { recursive: true });
    cpSync(join(FIXTURE, '1.mkv'), join(dir, '990001/1.mkv'));
    const slow = new EncodeIndex({ dir, dataDir: data, log: () => {}, settleMs: 0, onRead: () => gate });
    void slow.scan();
    auth = new Auth(new Store(data), Date.now);
    const library = new Library([], join(data, 'library.json'), { scanPauseMs: 0 });
    const server = createServer(appHandlers({ auth, library, bdjStore: new BdjStore(data), publicBase: 'https://nas.example/bluray/api/', encodes: slow, encodesWaitMs: 30 }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => { server.close(); server.closeAllConnections(); };
    const t = await token('Owner', true);
    expect((await get('990001-1/manifest', t)).status).toBe(503);
    release();
    await slow.ready(2000);
    expect((await get('990001-1/manifest', t)).status).toBe(200);
  });

  it('status carries scanError and rootEmpty', async () => {
    const index = (await start(true, { waitMs: 2000 }))!;
    const t = await token('Owner', true);
    await index.ready(2000);
    rmSync(join(tmp, 'encodes', '990001'), { recursive: true });
    await index.scan();
    expect(await (await get('status', t)).json()).toEqual({ configured: true, count: 1, rootEmpty: true });
  });

  it('the manifest size is the live size of the file', async () => {
    const index = (await start(true, { waitMs: 2000 }))!;
    const t = await token('Owner', true);
    await index.ready(2000);
    const file = join(tmp, 'encodes/990001/1.mkv');
    appendFileSync(file, Buffer.alloc(1000));
    const manifest = (await (await get('990001-1/manifest', t)).json()) as DiscManifest;
    expect(manifest.files[0]!.size).toBe(statSync(file).size);
    const served = await get('990001-1/files/EPISODE.MKV', t);
    expect((await served.arrayBuffer()).byteLength).toBe(manifest.files[0]!.size);
  });

  it('status reports a missing folder', async () => {
    await start(true, { dirOverride: join(tmp, 'gone'), waitMs: 2000 });
    const t = await token('Owner', true);
    expect(await (await get('status', t)).json()).toEqual({ configured: true, count: 0, rootMissing: true });
  });

  it('a guest behind a closed gate gets 404', async () => {
    await start(true);
    gate = 'owners';
    const guest = await token('Guest', false);
    const owner = await token('Owner', true);
    expect((await get('status', guest)).status).toBe(404);
    expect((await get('990001-1/manifest', guest)).status).toBe(404);
    expect((await get('990001-1/files/EPISODE.MKV', guest)).status).toBe(404);
    expect((await get('990001-1/manifest', owner)).status).toBe(200);
  });

  describe('titles beyond AniList', () => {
    const TV = { ANILIST_ID: null, ENCODER: null, SEIKOU_TITLE: 'tmdb-tv:990101', SEASON: '1', EPISODE: '2' };
    const withTv = (): void => {
      mkdirSync(join(tmp, 'encodes/tv990101s1'), { recursive: true });
      writeFileSync(join(tmp, 'encodes/tv990101s1/2.mkv'), retagged(1, TV));
    };
    const call = (method: string, path: string, t: string | null): Promise<Response> =>
      fetch(`${base}/api/encodes/${path}`, { method, headers: t ? { Authorization: `Bearer ${t}` } : {} });

    it('ids lists every encode of either kind, sorted, behind the token and the gate', async () => {
      withTv();
      const index = await start(true, { second: true });
      await index!.ready(5000);
      const guest = await token('Guest', false);
      const r = await call('GET', 'ids', guest);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ids: ['990001-1', '990001-2', 'tv990101s1-2'] });
      expect((await call('GET', 'ids', null)).status).toBe(401);
      gate = 'owners';
      expect((await call('GET', 'ids', guest)).status).toBe(404);
      const owner = await token('Owner', true);
      expect((await call('GET', 'ids', owner)).status).toBe(200);
    });

    it('ids answers 503 indexing during the first scan', async () => {
      await start(true, { scan: false, waitMs: 20 });
      const owner = await token('Owner', true);
      const r = await call('GET', 'ids', owner);
      expect([r.status, r.headers.get('retry-after'), await r.json()]).toEqual([503, '5', { error: 'indexing' }]);
    });

    it('serves a TMDB episode by its id', async () => {
      withTv();
      const index = await start(true);
      await index!.ready(5000);
      const owner = await token('Owner', true);
      const detail = (await (await call('GET', 'tv990101s1-2', owner)).json()) as Record<string, unknown>;
      expect(detail).toMatchObject({ id: 'tv990101s1-2', anilistId: null, title: { source: 'tmdb-tv', tmdbId: 990101, season: 1 }, episode: 2 });
      expect(((await (await call('GET', 'tv990101s1-2/manifest', owner)).json()) as DiscManifest).discId).toBe('tv990101s1-2');
      expect((await call('GET', 'tv990101s1-2/files/EPISODE.MKV', owner)).status).toBe(200);
      expect((await call('GET', 'tv990101-2', owner)).status).toBe(404);
    });
  });

  describe('library', () => {
    const library = (path: string, t: string | null): Promise<Response> => fetch(`${base}/api/encodes/${path}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });

    it('lists shows grouped by AniList, and a show with its seasons', async () => {
      known = new Map([[990001, tv(990001, 'Lantern Road')]]);
      const index = await start(true, { second: true });
      await index!.ready(5000);
      const t = await token('Guest', false);
      const list = (await (await library('shows', t)).json()) as { shows: unknown[]; unfiled?: unknown };
      expect(list.shows).toEqual([expect.objectContaining({ id: '990001', name: 'Lantern Road', episodeCount: 2, anilistIds: [990001] })]);
      expect(list.unfiled).toBeUndefined();
      const show = (await (await library('shows/990001', t)).json()) as { name: string; poster: string; seasons: { episodes: { id: string }[] }[] };
      expect(show.name).toBe('Lantern Road');
      expect(show.seasons[0]!.episodes.map((e) => e.id)).toEqual(['990001-1', '990001-2']);
      expect(arts.has(show.poster)).toBe(true);
      expect((await library('shows/12345', t)).status).toBe(404);
      expect((await library('shows', null)).status).toBe(401);
    });

    it("lists every season's AniList id of a show, and a guest behind a closed gate gets 404 for the list", async () => {
      const second = tv(990002, 'Lantern Road Again');
      known = new Map([
        [990001, { ...tv(990001, 'Lantern Road'), relations: [{ type: 'SEQUEL', id: 'anilist:990002', format: 'TV', startDate: null }] }],
        [990002, { ...second, year: 2021, relations: [{ type: 'PREQUEL', id: 'anilist:990001', format: 'TV', startDate: null }] }],
      ]);
      // a second season: episode 1 again, its one ANILIST_ID tag value rewritten in place (same length)
      const bytes = readFileSync(join(FIXTURE, '1.mkv'));
      const at = bytes.indexOf('990001');
      expect(bytes.indexOf('990001', at + 1)).toBe(-1);
      bytes.write('990002', at);
      mkdirSync(join(tmp, 'encodes/990002'), { recursive: true });
      writeFileSync(join(tmp, 'encodes/990002/1.mkv'), bytes);
      const index = await start(true);
      await index!.ready(5000);
      const guest = await token('Guest', false);
      const list = (await (await library('shows', guest)).json()) as { shows: { id: string; anilistIds: number[]; episodeCount: number }[] };
      expect(list.shows).toEqual([expect.objectContaining({ id: '990001', episodeCount: 2, anilistIds: [990001, 990002] })]);
      gate = 'owners';
      expect((await library('shows', guest)).status).toBe(404);
      const owner = await token('Owner', true);
      expect((((await (await library('shows', owner)).json()) as { shows: { anilistIds: number[] }[] }).shows[0]!.anilistIds)).toEqual([990001, 990002]);
    });

    it('a show whose metadata is not loaded yet is named by its AniList id', async () => {
      const index = await start(true);
      await index!.ready(5000);
      const t = await token('Guest', false);
      expect(((await (await library('shows', t)).json()) as { shows: { name: string }[] }).shows[0]!.name).toBe('AniList 990001');
    });

    it("owners see unfiled files, guests don't", async () => {
      const index = await start(true, { loose: true });
      await index!.ready(5000);
      const owner = await token('Owner', true);
      const guest = await token('Guest', false);
      const seen = (await (await library('shows', owner)).json()) as { unfiled?: { path: string; size: number }[] };
      expect(seen.unfiled).toEqual([{ path: 'loose.mkv', size: 10 }]);
      expect(((await (await library('shows', guest)).json()) as { unfiled?: unknown }).unfiled).toBeUndefined();
    });

    it('a guest behind a closed gate gets 404, and the first scan is waited for', async () => {
      gate = 'owners';
      await start(true, { scan: false, waitMs: 20 });
      const guest = await token('Guest', false);
      expect((await library('shows', guest)).status).toBe(404);
      const owner = await token('Owner', true);
      const r = await library('shows', owner);
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: 'indexing' });
      expect((await library('shows/990001', owner)).status).toBe(503);
    });
  });
});
