import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appHandlers } from '../../../server/src/app';
import { Auth } from '../../../server/src/auth';
import { codeHash } from '../../../server/src/codes';
import { HttpError, json } from '../../../server/src/http';
import type { Handler, Response as ServerResponse } from '../../../server/src/http';
import { serveChannel } from '../../../server/src/rtc/dispatch';
import { codeHashOf, fromBase64url, turnProofMessage } from '../../../rendezvous/src/protocol';
import { FakeRtcWorld } from '../../../tests/helpers/rtc-fakes';
import type { FakeRtcOptions } from '../../../tests/helpers/rtc-fakes';
import { NAS_LOST_MESSAGE } from '@seikou/engine/disc/http-transport';
import { RTC_UNREACHABLE, RtcConnection } from './rtc/rtc-connection';
import type { RtcLink, RtcOpenOptions } from './rtc/rtc-connection';
import type { Library } from '../../../server/src/library';
import { BdjStore } from '../../../server/src/bdj-store';
import { PlaybackStore } from '../../../server/src/playback-store';
import { Store } from '../../../server/src/store';
import type { CodeLookup, CodeRoutes, PlaceSettings, PlaybackPlace, StoredSubtitle } from '@seikou/nas/nas-api';
import { normalizeCode } from '@seikou/nas/pairing-code';
import { NAS_MESSAGES, NasBusyError, NasClient, NasLostError, PLACE_TIMEOUT_MS, defaultDeviceName, groupCodeInput } from './nas-client';
import type { NasClientDeps } from './nas-client';
import type { NasPairing, NasStore } from './nas-store';

const RENDEZVOUS = 'https://rendezvous.example';
const BASE = 'https://nas.example/bluray/api/';
const MINUTE = 60_000;

let tmp: string;
let clock: number;
const now = (): number => clock;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'nas-client-'));
  clock = 1_800_000_000_000;
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(tmp, { recursive: true, force: true });
});

function memoryStore(): NasStore & { value: NasPairing | null } {
  return {
    value: null,
    async get() {
      return this.value;
    },
    async put(pairing) {
      this.value = pairing;
    },
    async clear() {
      this.value = null;
    },
  };
}

interface FakeServer {
  readonly auth: Auth;
  readonly fetch: typeof fetch;
  /** Registers a fresh code with the rendezvous service and returns it. */
  code(routes?: CodeRoutes): Promise<string>;
  /** NAS requests by route, e.g. 'session' → 2. */
  readonly hits: Record<string, number>;
  /** Folder paths the library was listed at. */
  readonly listed: string[];
  /** Answer rendezvous lookups with 429. */
  lookupRateLimited: boolean;
  /** Overrides for NAS requests (not rendezvous). */
  nas?: (url: URL, init?: RequestInit) => Promise<Response>;
  /** The same handlers as HTTPS, for a data channel (`serveChannel`); `GET /api/library` waits while `holdLibrary` is set. */
  readonly handlers: readonly Handler[];
  holdLibrary: Promise<void> | null;
  /** Art requests that reached the channel's handlers, as `<artId> <size>`. */
  readonly artFetched: string[];
}

/**
 * The rendezvous Worker's lookup (a map of code hashes), and the NAS server's real handlers (`appHandlers`:
 * pairing, sessions, the token guard, library) over a real `Auth`, with Caddy's `/bluray` prefix stripped.
 */
function fakeServer(): FakeServer {
  const auth = new Auth(new Store(tmp), now);
  const codes = new Map<string, CodeLookup>();
  const hits: Record<string, number> = {};
  const listed: string[] = [];
  const library = {
    scanning: false,
    list: (path: string) => {
      listed.push(path);
      return { folders: [{ name: 'media5', path: 'media5', discs: 1 }], discs: [] };
    },
    evidence: () => [],
  } as unknown as Library;
  const handlers = appHandlers({ auth, library, bdjStore: new BdjStore(tmp), playbackStore: new PlaybackStore(tmp, { now }), publicBase: BASE, now });
  /** `GET /api/me` (the title routes need a title service), behind the token like the rest. */
  const me: Handler = async (_req, url) => {
    if (url.pathname === '/api/me') return json(200, { owner: true, titleLibrary: true, personName: 'Owner' });
    const art = /^\/api\/art\/([^/]+)$/.exec(url.pathname);
    if (!art) return null;
    server.artFetched.push(`${art[1]} ${url.searchParams.get('size')}`);
    return { status: 200, headers: { 'Content-Type': 'image/jpeg' }, body: `art ${art[1]}` };
  };
  const held: Handler = async (_req, url) => {
    if (url.pathname === '/api/library' && server.holdLibrary) await server.holdLibrary;
    return null;
  };

  const serve = async (url: URL, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? Buffer.from(init.body, 'utf8') : null;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
    if (body) headers['content-length'] = String(body.length);
    const path = url.pathname.replace(/^\/bluray/, '') + url.search;
    if (path === '/api/health') return Response.json({ ok: true }); // the server answers it before the handlers
    const req = Object.assign(Readable.from(body ? [body] : []), {
      method: init?.method ?? 'GET',
      url: path,
      headers,
      socket: { remoteAddress: '100.64.0.2' },
    }) as unknown as IncomingMessage;
    let res: ServerResponse | null = null;
    try {
      for (const handler of handlers) if ((res = await handler(req, new URL(path, 'http://localhost')))) break;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      res = json(err.status, { error: err.message }, err.headers);
    }
    res ??= json(404, { error: 'not found' });
    return new Response(typeof res.body === 'string' ? res.body : null, { status: res.status, headers: res.headers });
  };

  const server: FakeServer = {
    auth,
    handlers: [held, ...handlers, me],
    holdLibrary: null,
    artFetched: [],
    hits,
    listed,
    lookupRateLimited: false,
    async code(routes = { https: BASE }) {
      const { record, code } = auth.createCode({ personId: auth.firstOwnerPerson().id });
      codes.set(record.hash, { nasId: 'nas1', routes });
      return code;
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.href.startsWith(RENDEZVOUS)) {
        if (server.lookupRateLimited) return Response.json({ error: 'too many lookups' }, { status: 429 });
        if (url.href !== `${RENDEZVOUS}/codes/lookup` || init?.method !== 'POST') return new Response(null, { status: 404 });
        const { code } = JSON.parse(String(init.body)) as { code: string };
        const found = normalizeCode(code) === null ? undefined : codes.get(codeHash(code));
        return found ? Response.json(found) : Response.json({ error: 'unknown code' }, { status: 404 });
      }
      if (!url.href.startsWith(BASE)) return new Response(null, { status: 404 });
      if (server.nas) return server.nas(url, init);
      const route = url.pathname.slice(new URL(BASE).pathname.length);
      hits[route] = (hits[route] ?? 0) + 1;
      return serve(url, init);
    }) as typeof fetch,
  };
  return server;
}

function client(server: FakeServer, store: NasStore = memoryStore(), rendezvousUrl: string | undefined = RENDEZVOUS): NasClient {
  return new NasClient({ fetch: server.fetch, subtle: crypto.subtle, store, now, rendezvousUrl });
}

describe('NasClient', () => {
  it('pairs, starts a session and lists the library', async () => {
    const server = fakeServer();
    const store = memoryStore();
    const nas = client(server, store);
    await nas.pair(await server.code(), 'Mac Safari');
    expect(store.value).toMatchObject({ base: BASE, deviceName: 'Mac Safari', owner: true });
    expect(server.auth.devices().map((d) => d.name)).toEqual(['Mac Safari']);
    const session = await nas.session();
    expect(server.auth.verify(session.token)?.id).toBe(store.value!.deviceId);
    const listing = await nas.library('media5/[BD] 鋼の旅団 #1? 100% a+b');
    expect(listing).toEqual({ folders: [{ name: 'media5', path: 'media5', discs: 1 }], discs: [], scanning: false });
    expect(server.listed).toEqual(['media5/[BD] 鋼の旅団 #1? 100% a+b']);
  });

  it('asks the NAS who this device is, and reads titles, a title and art', async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    const asked: string[] = [];
    const real = server.fetch;
    const answer = async (url: URL, init?: RequestInit): Promise<Response> => {
      const route = url.pathname.slice(new URL(BASE).pathname.length);
      if (route.startsWith('session')) {
        // sessions from the real handlers
        server.nas = undefined;
        try {
          return await real(url, init);
        } finally {
          server.nas = answer;
        }
      }
      asked.push(`${route} ${new Headers(init?.headers).get('Authorization')?.slice(0, 7) ?? ''}`);
      if (route === 'me') return Response.json({ owner: false, titleLibrary: true });
      if (route === 'titles') return Response.json({ titles: [{ id: 'anilist:1' }] });
      if (route === 'titles/anilist%3A1') return Response.json({ title: { id: 'anilist:1' } });
      return Response.json({ error: 'not found' }, { status: 404 });
    };
    server.nas = answer;
    expect(await nas.me()).toEqual({ owner: false, titleLibrary: true });
    expect(await nas.titles()).toEqual([{ id: 'anilist:1' }]);
    expect(await nas.title('anilist:1')).toEqual({ title: { id: 'anilist:1' } });
    expect(asked).toEqual(['me Bearer ', 'titles Bearer ', 'titles/anilist%3A1 Bearer ']);
    const { token } = await nas.session();
    expect(await nas.artUrl('0123456789abcdef0123456789abcdef', 'large')).toBe(`${BASE}art/0123456789abcdef0123456789abcdef?size=large&t=${encodeURIComponent(token)}`);
  });

  it('resolves a disc key, null when the NAS has none', async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    const disc = { id: '0123456789abcdef', name: 'Disc', path: 'media5/Disc', kind: 'folder' };
    await nas.session();
    server.nas = async (url) => {
      const route = url.pathname.slice(new URL(BASE).pathname.length);
      return route === 'discs/resolve/d.0123456789abcdef' ? Response.json({ disc }) : Response.json({ error: 'not-found' }, { status: 404 });
    };
    expect(await nas.resolveDisc('d.0123456789abcdef')).toEqual(disc);
    expect(await nas.resolveDisc('d.fedcba9876543210')).toBeNull();
  });

  it('gives a failed art URL a fresh token, never the one it carried', async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    const artId = '0123456789abcdef0123456789abcdef';
    const first = await nas.artUrl(artId, 'small');
    const stale = new URL(first).searchParams.get('t');
    clock += 1_000; // a token is made from the device and its expiry
    const retry = await nas.freshArtUrl(artId, 'small', first);
    const fresh = new URL(retry).searchParams.get('t');
    expect(fresh).not.toBe(stale);
    expect(retry).toBe(`${BASE}art/${artId}?size=small&t=${encodeURIComponent(fresh!)}`);
    expect(server.auth.verify(fresh!)).not.toBeNull();
  });

  it("sends the owner's title routes, and reads Retry-After and a copy's source from refusals", async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    const real = server.fetch;
    const sent: string[] = [];
    const answer = async (url: URL, init?: RequestInit): Promise<Response> => {
      const route = url.pathname.slice(new URL(BASE).pathname.length) + url.search;
      if (route.startsWith('session')) {
        server.nas = undefined;
        try {
          return await real(url, init);
        } finally {
          server.nas = answer;
        }
      }
      sent.push(`${init?.method ?? 'GET'} ${route}${typeof init?.body === 'string' ? ` ${init.body}` : ''}`);
      if (route.startsWith('admin/unsorted')) return Response.json({ items: [], total: 0 });
      if (route === 'admin/hidden') return Response.json({ discs: [{ discId: 'd1', root: 'media5', folder: 'A/B', displayName: null }] });
      if (route.startsWith('admin/lookup?q=Ember') && url.searchParams.get('source') === 'tmdb') return Response.json({ error: 'too-many-lookups' }, { status: 429, headers: { 'Retry-After': '7' } });
      if (route.startsWith('admin/lookup')) return Response.json({ titles: [{ id: 'anilist:1' }] });
      if (route === 'admin/discs/d%2F1/choice' && init?.method === 'PUT') {
        return JSON.parse(String(init.body)).applyToGroup ? Response.json({ skipped: [{ discId: 'd2', reason: 'copy' }] }) : new Response(null, { status: 204 });
      }
      if (route === 'admin/discs/d%2F1/choice') return Response.json({ error: 'copy-follows-source', source: 'd0' }, { status: 409 });
      if (route === 'admin/titles' || route.startsWith('admin/titles/')) {
        return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ id: 'own:x', kind: 'music', name: 'Live 2024', seasons: null });
      }
      return new Response(null, { status: 204 });
    };
    server.nas = answer;

    expect(await nas.admin.unsorted(50, 50)).toEqual({ items: [], total: 0 });
    expect(await nas.admin.hidden()).toEqual([{ discId: 'd1', root: 'media5', folder: 'A/B', displayName: null }]);
    expect(await nas.admin.lookup('星 & co', 'anilist')).toEqual([{ id: 'anilist:1' }]);
    await expect(nas.admin.lookup('Ember', 'tmdb')).rejects.toMatchObject({ status: 429, code: 'too-many-lookups', detail: { retryAfter: 7 } });
    const choice = { kind: 'title', titleId: 'anilist:1', season: 1, disc: 2 } as const;
    expect(await nas.admin.setChoice('d/1', choice)).toEqual([]);
    expect(await nas.admin.setChoice('d/1', choice, true)).toEqual([{ discId: 'd2', reason: 'copy' }]);
    await expect(nas.admin.clearChoice('d/1')).rejects.toMatchObject({ status: 409, code: 'copy-follows-source', detail: { source: 'd0' } });
    await nas.admin.setName('music:ab', 'Spring Live');
    await nas.admin.setName('music:ab', null);
    await nas.admin.setMusic('music:ab', { artist: 'Aoi Hoshino', rejectMatch: true });
    await nas.admin.createTitle('music', 'Live 2024', null);
    await nas.admin.createTitle('series', 'Ember Tide', 2);
    await nas.admin.updateTitle('own:x', { name: 'Live 2025' });
    await nas.admin.updateTitle('own:x', { seasons: 3 });
    await nas.admin.deleteTitle('own:x');
    await nas.admin.setTitleLibrary('everyone');
    expect(sent).toEqual([
      'GET admin/unsorted?offset=50&limit=50',
      'GET admin/hidden',
      'GET admin/lookup?q=%E6%98%9F%20%26%20co&source=anilist',
      'GET admin/lookup?q=Ember&source=tmdb',
      `PUT admin/discs/d%2F1/choice ${JSON.stringify({ choice })}`,
      `PUT admin/discs/d%2F1/choice ${JSON.stringify({ choice, applyToGroup: true })}`,
      'DELETE admin/discs/d%2F1/choice',
      'PUT admin/names/music%3Aab {"name":"Spring Live"}',
      'PUT admin/names/music%3Aab {"name":null}',
      'PUT admin/music/music%3Aab {"artist":"Aoi Hoshino","rejectMatch":true}',
      'POST admin/titles {"kind":"music","name":"Live 2024"}',
      'POST admin/titles {"kind":"series","name":"Ember Tide","seasons":2}',
      'PATCH admin/titles/own%3Ax {"name":"Live 2025"}',
      'PATCH admin/titles/own%3Ax {"seasons":3}',
      'DELETE admin/titles/own%3Ax',
      'PUT admin/settings/title-library {"gate":"everyone"}',
    ]);
  });

  it("sends the owner's people, device and code routes", async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    const real = server.fetch;
    const sent: string[] = [];
    const mika = { id: 'p1', name: 'Mika', owner: false, createdAt: 1, savedBytes: 0, devices: [] };
    const minted = { code: 'K7QM-4XP2-R9TD', link: 'https://example/?pair=K7QM4XP2R9TD', expiresAt: 2, rendezvous: true, personId: 'p1', personName: 'Mika', invite: true };
    const answer = async (url: URL, init?: RequestInit): Promise<Response> => {
      const route = url.pathname.slice(new URL(BASE).pathname.length) + url.search;
      if (route.startsWith('session')) {
        server.nas = undefined;
        try {
          return await real(url, init);
        } finally {
          server.nas = answer;
        }
      }
      sent.push(`${init?.method ?? 'GET'} ${route}${typeof init?.body === 'string' ? ` ${init.body}` : ''}`);
      if (route === 'admin/people' && init?.method === 'POST') return Response.json(mika, { status: 201 });
      if (route === 'admin/people') return Response.json({ people: [mika] });
      if (route === 'admin/codes' && init?.method === 'POST') return Response.json(minted);
      if (route === 'admin/codes') return Response.json({ codes: [{ id: 'c1', personId: 'p1', personName: 'Mika', invite: true, expiresAt: 2 }] });
      if (route === 'admin/people/p%2F2' && init?.method === 'PATCH') return Response.json({ error: 'last-owner' }, { status: 409 });
      if (route.startsWith('admin/people/') && init?.method === 'PATCH') return Response.json({ ...mika, name: 'Sora' });
      return new Response(null, { status: 204 });
    };
    server.nas = answer;

    expect(await nas.admin.people()).toEqual([mika]);
    expect(await nas.admin.createPerson('Mika', false)).toEqual(mika);
    expect(await nas.admin.updatePerson('p1', { name: 'Sora' })).toEqual({ ...mika, name: 'Sora' });
    await expect(nas.admin.updatePerson('p/2', { owner: false })).rejects.toMatchObject({ status: 409, code: 'last-owner' });
    await nas.admin.removePerson('p1');
    await nas.admin.clearSavedData('p1');
    await nas.admin.moveDevice('d1', 'p1');
    await nas.admin.revokeDevice('d1');
    expect(await nas.admin.createCode({ personId: 'p1' }, false)).toEqual(minted);
    expect(await nas.admin.createCode({ newPerson: { name: 'Mika', owner: false } }, true)).toEqual(minted);
    expect(await nas.admin.codes()).toEqual([{ id: 'c1', personId: 'p1', personName: 'Mika', invite: true, expiresAt: 2 }]);
    expect(sent).toEqual([
      'GET admin/people',
      'POST admin/people {"name":"Mika","owner":false}',
      'PATCH admin/people/p1 {"name":"Sora"}',
      'PATCH admin/people/p%2F2 {"owner":false}',
      'DELETE admin/people/p1',
      'DELETE admin/people/p1/saved-data',
      'PATCH admin/devices/d1 {"personId":"p1"}',
      'DELETE admin/devices/d1',
      'POST admin/codes {"personId":"p1","invite":false}',
      'POST admin/codes {"newPerson":{"name":"Mika","owner":false},"invite":true}',
      'GET admin/codes',
    ]);
  });

  it("makes a code for a new person on the real server, and the device that redeems it is that person's", async () => {
    const server = fakeServer();
    const owner = client(server);
    await owner.pair(await server.code(), 'Mac Safari');
    const minted = await owner.admin.createCode({ newPerson: { name: 'Mika', owner: false } }, true);
    expect(minted).toMatchObject({ personName: 'Mika', invite: true });
    // The server here has no registrar, so the guest's lookup is answered directly.
    const store = memoryStore();
    const guest = client(server, store);
    const lookup = vi.spyOn(guest, 'lookup').mockResolvedValue({ nasId: 'nas1', routes: { https: BASE } });
    await guest.pair(minted.code, 'iPad');
    expect(lookup).toHaveBeenCalledOnce();
    expect(store.value).toMatchObject({ deviceName: 'iPad', owner: false, personName: 'Mika' });
    const people = await owner.admin.people();
    expect(people.find((p) => p.name === 'Mika')).toMatchObject({ owner: false, savedBytes: 0, devices: [{ name: 'iPad' }] });
  });

  it('loads a pairing stored before people, without a person name', async () => {
    const server = fakeServer();
    const store = memoryStore();
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    store.value = { base: BASE, deviceId: 'd1', deviceName: 'iPad', owner: true, key };
    const nas = client(server, store);
    expect(await nas.pairing()).toEqual({ base: BASE, deviceId: 'd1', deviceName: 'iPad', owner: true, key });
    expect(store.value).not.toBeNull();
  });

  it("takes the person's name and owner status from `me` into the stored pairing when they differ", async () => {
    const server = fakeServer();
    const store = memoryStore();
    const nas = client(server, store);
    await nas.pair(await server.code(), 'iPad');
    const stored = store.value!;
    expect(stored.personName).toBe('Owner');
    const real = server.fetch;
    let personName = 'Sora';
    let owner = true;
    const answer = async (url: URL, init?: RequestInit): Promise<Response> => {
      const route = url.pathname.slice(new URL(BASE).pathname.length);
      if (route === 'me') return Response.json({ owner, titleLibrary: true, personId: 'p0', personName });
      server.nas = undefined;
      try {
        return await real(url, init);
      } finally {
        server.nas = answer;
      }
    };
    server.nas = answer;
    const put = vi.spyOn(store, 'put');
    expect(await nas.me()).toMatchObject({ personName: 'Sora' });
    expect(store.value).toEqual({ ...stored, personName: 'Sora' });
    expect((await nas.pairing())?.personName).toBe('Sora');
    await nas.me();
    expect(put).toHaveBeenCalledOnce();
    personName = 'Mika';
    await nas.me();
    expect(store.value?.personName).toBe('Mika');
    // An owner took this device's owner status away: the stored pairing follows, so the settings button goes.
    owner = false;
    await nas.me();
    expect(store.value).toMatchObject({ owner: false, personName: 'Mika' });
    expect((await nas.pairing())?.owner).toBe(false);
  });

  it("stores the NAS's id from `me` on a pairing made before WebRTC, so route choice can use it", async () => {
    const server = fakeServer();
    const store = memoryStore();
    const nas = client(server, store);
    await nas.pair(await server.code(), 'iPad');
    const { nasId: _none, ...old } = store.value!;
    store.value = old;
    const fresh = client(server, store);
    expect((await fresh.pairing())?.nasId).toBeUndefined();
    const real = server.fetch;
    let nasId: unknown = 'N'.repeat(43);
    const answer = async (url: URL, init?: RequestInit): Promise<Response> => {
      const route = url.pathname.slice(new URL(BASE).pathname.length);
      if (route === 'me') return Response.json({ owner: true, titleLibrary: true, personId: 'p0', personName: old.personName, nasId });
      server.nas = undefined;
      try {
        return await real(url, init);
      } finally {
        server.nas = answer;
      }
    };
    server.nas = answer;
    const put = vi.spyOn(store, 'put');
    await fresh.me();
    expect(store.value).toEqual({ ...old, nasId: 'N'.repeat(43) });
    expect((await fresh.pairing())?.nasId).toBe('N'.repeat(43));
    await fresh.me();
    expect(put).toHaveBeenCalledOnce();
    // a different id (the NAS made a new key) replaces it; null or junk (no rendezvous) keeps what is stored
    nasId = 'M'.repeat(43);
    await fresh.me();
    expect(store.value?.nasId).toBe('M'.repeat(43));
    for (const value of [null, 'not an id', 42]) {
      nasId = value;
      await fresh.me();
      expect(store.value?.nasId).toBe('M'.repeat(43));
    }
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('keeps the private key non-extractable', async () => {
    const server = fakeServer();
    const store = memoryStore();
    await client(server, store).pair(await server.code(), 'iPad');
    expect(store.value!.key.privateKey.extractable).toBe(false);
  });

  it('reuses a 50-minute-old session and refreshes a 56-minute-old one before use', async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    await nas.library('');
    expect(server.hits.session).toBe(1);
    clock += 50 * MINUTE;
    await nas.library('');
    expect(server.hits.session).toBe(1);
    clock += 6 * MINUTE;
    await nas.library('');
    expect(server.hits.session).toBe(2);
  });

  it('shares one session request between concurrent calls', async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    await Promise.all([nas.library(''), nas.library('media5'), nas.session()]);
    expect(server.hits.session).toBe(1);
  });

  it('clears the pairing when the NAS has revoked the device', async () => {
    const server = fakeServer();
    const store = memoryStore();
    const nas = client(server, store);
    await nas.pair(await server.code(), 'iPad');
    await nas.library('');
    // The server refuses to revoke the last owner device, so another owner device is paired first.
    await client(server, memoryStore()).pair(await server.code(), 'Mac');
    server.auth.revokeDevice(store.value!.deviceId);
    await expect(nas.library('')).rejects.toThrow(NAS_MESSAGES.unpaired);
    expect(NAS_MESSAGES.unpaired).toBe('This device is no longer paired with the NAS.');
    expect(store.value).toBeNull();
    expect(await nas.pairing()).toBeNull();
  });

  it('treats a stored record without a usable key as not paired, and clears it', async () => {
    const server = fakeServer();
    const store = memoryStore();
    store.value = { base: BASE, deviceId: 'd1', deviceName: 'iPad', owner: false, key: {} } as unknown as NasPairing;
    const nas = client(server, store);
    expect(await nas.pairing()).toBeNull();
    expect(store.value).toBeNull();
    await expect(nas.session()).rejects.toThrow(NAS_MESSAGES.unpaired);
  });

  it('forgets a pairing whose key can no longer sign, and tells the listeners', async () => {
    const server = fakeServer();
    const store = memoryStore();
    await client(server, store).pair(await server.code(), 'iPad');
    const { publicKey } = store.value!.key;
    store.value = { ...store.value!, key: { publicKey, privateKey: publicKey } }; // a key that can't sign
    const nas = client(server, store);
    const unpaired = vi.fn();
    nas.onUnpaired(unpaired);
    await expect(nas.library('')).rejects.toThrow(NAS_MESSAGES.unpaired);
    expect(store.value).toBeNull();
    expect(await nas.pairing()).toBeNull();
    expect(unpaired).toHaveBeenCalledTimes(1);
  });

  it('tells the listeners when the NAS has revoked the device', async () => {
    const server = fakeServer();
    const store = memoryStore();
    const nas = client(server, store);
    await nas.pair(await server.code(), 'iPad');
    const unpaired = vi.fn();
    const unsubscribe = nas.onUnpaired(unpaired);
    // The server refuses to revoke the last owner device, so another owner device is paired first.
    await client(server, memoryStore()).pair(await server.code(), 'Mac');
    server.auth.revokeDevice(store.value!.deviceId);
    await expect(nas.library('')).rejects.toThrow(NAS_MESSAGES.unpaired);
    expect(unpaired).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('reads the pairing from the store once', async () => {
    const server = fakeServer();
    const store = memoryStore();
    await client(server, store).pair(await server.code(), 'iPad');
    const get = vi.spyOn(store, 'get');
    const nas = client(server, store);
    await Promise.all([nas.pairing(), nas.pairing()]);
    await nas.library('');
    await nas.pairing();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('forgets the pairing on request, so the code field can come back', async () => {
    const server = fakeServer();
    const store = memoryStore();
    const nas = client(server, store);
    await nas.pair(await server.code(), 'iPad');
    await nas.library('');
    await nas.forget();
    expect(store.value).toBeNull();
    expect(await nas.pairing()).toBeNull();
    await expect(nas.library('')).rejects.toThrow(NAS_MESSAGES.unpaired);
    await nas.pair(await server.code(), 'iPad');
    expect((await nas.library('')).folders).toHaveLength(1);
  });

  it("doesn't cache a session started for a pairing forgotten meanwhile", async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    const old = nas.session();
    await nas.forget();
    await old;
    await expect(nas.session()).rejects.toThrow(NAS_MESSAGES.unpaired);
  });

  it("keeps a newer session when a request made with an older token gets 401", async () => {
    const server = fakeServer();
    let nas!: NasClient;
    let intercept = true;
    const fetchWithLateRefusal = (async (input: string | URL | Request, init?: RequestInit) => {
      if (intercept && String(input).startsWith(`${BASE}library`)) {
        intercept = false;
        // While this request is out, its token is replaced by a refresh; then the NAS refuses the old token.
        clock += 56 * MINUTE;
        await nas.session();
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return server.fetch(input, init);
    }) as typeof fetch;
    nas = new NasClient({ fetch: fetchWithLateRefusal, subtle: crypto.subtle, store: memoryStore(), now, rendezvousUrl: RENDEZVOUS });
    await nas.pair(await server.code(), 'iPad');
    await nas.session();
    await nas.library('');
    expect(server.hits.session).toBe(2);
  });

  it('gives the engine a new token for the one it reports rejected, even while that one looks fresh (a slow clock)', async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    const first = await nas.session();
    clock += MINUTE; // tokens are made from the expiry time, so a later session gets another one
    expect((await nas.session()).token).toBe(first.token);
    const fresh = await nas.freshSession(first.token);
    expect(fresh.token).not.toBe(first.token);
    expect(server.hits.session).toBe(2);
    // A rejection of a token already replaced keeps the newer one.
    expect((await nas.freshSession(first.token)).token).toBe(fresh.token);
    expect(server.hits.session).toBe(2);
  });

  it('pairs with a code typed in lower case with spaces', async () => {
    expect(normalizeCode('k7qm 4xp2 r9td')).toBe('K7QM4XP2R9TD');
    const server = fakeServer();
    const store = memoryStore();
    const code = await server.code();
    const typed = `${code.slice(0, 4)} ${code.slice(4, 8)} ${code.slice(8)}`.toLowerCase();
    await client(server, store).pair(typed, 'iPad');
    expect(store.value).not.toBeNull();
  });

  it('answers an unknown or expired code', async () => {
    expect(NAS_MESSAGES.invalidCode).toBe("That code didn't work. Codes last 10 minutes; ask for a new one.");
    const server = fakeServer();
    const nas = client(server);
    await expect(nas.pair('K7QM-4XP2-R9TD', 'iPad')).rejects.toThrow(NAS_MESSAGES.invalidCode);
    await expect(nas.pair('not a code', 'iPad')).rejects.toThrow(NAS_MESSAGES.invalidCode);
    const code = await server.code();
    clock += 11 * MINUTE; // still in the rendezvous map here, but the NAS refuses it
    await expect(nas.pair(code, 'iPad')).rejects.toThrow(NAS_MESSAGES.invalidCode);
  });

  it('answers too many tries, from the rendezvous service or the NAS', async () => {
    expect(NAS_MESSAGES.tooMany).toBe('Too many tries. Wait a minute and try again.');
    const server = fakeServer();
    const nas = client(server);
    const code = await server.code();
    server.lookupRateLimited = true;
    await expect(nas.pair(code, 'iPad')).rejects.toThrow(NAS_MESSAGES.tooMany);
    server.lookupRateLimited = false;
    // The NAS allows 10 failed redeems a minute per client; an expired code fails there.
    clock += 11 * MINUTE;
    for (let i = 0; i < 10; i++) await expect(nas.pair(code, 'iPad')).rejects.toThrow(NAS_MESSAGES.invalidCode);
    await expect(nas.pair(code, 'iPad')).rejects.toThrow(NAS_MESSAGES.tooMany);
  });

  it('answers a lookup without any route', async () => {
    expect(NAS_MESSAGES.noRoute).toBe("This NAS isn't reachable from here yet.");
    const server = fakeServer();
    const nas = client(server);
    const code = await server.code({});
    await expect(nas.pair(code, 'iPad')).rejects.toThrow(NAS_MESSAGES.noRoute);
  });

  it('says pairing by code is unavailable without a rendezvous service', async () => {
    const server = fakeServer();
    const nas = client(server, memoryStore(), '');
    await expect(nas.pair(await server.code(), 'iPad')).rejects.toThrow("Pairing by code isn't available right now.");
  });

  it('gives up on the NAS after 20 s while the browser waits on local network access', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = fakeServer();
    let asked!: () => void;
    const reached = new Promise<void>((resolve) => (asked = resolve));
    server.nas = (_url, init) =>
      new Promise((_resolve, reject) => {
        asked();
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const nas = client(server);
    const pairing = nas.pair(await server.code(), 'iPad');
    const outcome = expect(pairing).rejects.toThrow(NAS_MESSAGES.unreachable);
    await reached;
    await vi.advanceTimersByTimeAsync(19_999);
    let settled = false;
    void pairing.catch(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
  });

  it('says the NAS is unreachable when the browser blocks the request', async () => {
    expect(NAS_MESSAGES.unreachable).toBe(
      "Couldn't reach the NAS. If your browser asked about local network access, allow it, and check that this device is on your tailnet.",
    );
    const server = fakeServer();
    server.nas = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(client(server).pair(await server.code(), 'iPad')).rejects.toThrow(NAS_MESSAGES.unreachable);
  });
});

const NAS_ID = 'n'.repeat(43);

/** A NAS reachable over WebRTC (fake peers and sockets) serving the fake server's handlers through `serveChannel`. */
function rtcWorld(server: FakeServer, opts: Partial<FakeRtcOptions> = {}): FakeRtcWorld & { opened: RtcOpenOptions[]; openRtc: (o: RtcOpenOptions) => Promise<RtcConnection> } {
  const world = new FakeRtcWorld({
    direct: true,
    serve: (channel) => serveChannel(channel, server.handlers, { auth: server.auth, remoteAddress: '198.51.100.9', now }),
    ...opts,
  });
  const opened: RtcOpenOptions[] = [];
  return Object.assign(world, {
    opened,
    openRtc: (o: RtcOpenOptions) => {
      opened.push(o);
      return RtcConnection.open({ ...o, createPeer: world.createPeer, openSocket: world.openSocket });
    },
  });
}

function rtcClient(
  server: FakeServer,
  world: { openRtc: (o: RtcOpenOptions) => Promise<RtcLink> },
  store: NasStore = memoryStore(),
  objectUrls?: NasClientDeps['objectUrls'],
): NasClient {
  return new NasClient({ fetch: server.fetch, subtle: crypto.subtle, store, now, rendezvousUrl: RENDEZVOUS, openRtc: world.openRtc, ...(objectUrls ? { objectUrls } : {}) });
}

/** Object URLs as `blob:fake/<n>`, with the ones revoked. */
function fakeObjectUrls(): NonNullable<NasClientDeps['objectUrls']> & { live: Set<string>; revoked: string[] } {
  let n = 0;
  const live = new Set<string>();
  const revoked: string[] = [];
  return {
    live,
    revoked,
    create: () => {
      const url = `blob:fake/${++n}`;
      live.add(url);
      return url;
    },
    revoke: (url) => {
      live.delete(url);
      revoked.push(url);
    },
  };
}

describe('NasClient over WebRTC', () => {

  it('sends places over the connection, without keepalive', async () => {
    const server = fakeServer();
    const world = rtcWorld(server);
    const inits: (RequestInit | undefined)[] = [];
    const openRtc = async (o: RtcOpenOptions): Promise<RtcLink> => {
      const link = await world.openRtc(o);
      const inner = link.fetch;
      const watching = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes('/me/playback/')) inits.push(init);
        return inner(input, init);
      }) as typeof fetch;
      return Object.assign(Object.create(link) as RtcLink, { fetch: watching });
    };
    const nas = rtcClient(server, { openRtc });
    await nas.pair(await server.code({ webrtc: { nasId: NAS_ID } }), 'iPhone');
    expect(await nas.putPlace(playbackPlace(), { keepalive: true })).toBe('stored');
    expect(inits).toHaveLength(1);
    expect(inits[0]?.keepalive).toBeUndefined();
    expect((await nas.playbackPlaces(PLACE_KEY))?.places['00001']?.timeUs).toBe(60e6);
    expect(Object.keys(server.hits)).toEqual([]); // nothing went over HTTPS
  });
  it('pairs over WebRTC when the lookup has no HTTPS route, then reads me and the library on a new connection', async () => {
    const server = fakeServer();
    const world = rtcWorld(server);
    const store = memoryStore();
    const nas = rtcClient(server, world, store);
    const code = await server.code({ webrtc: { nasId: NAS_ID } });
    await nas.pair(code, 'iPhone');
    expect(store.value).toMatchObject({ base: '', nasId: NAS_ID, deviceName: 'iPhone', owner: true });
    expect(server.auth.devices().map((d) => d.name)).toEqual(['iPhone']);
    expect(world.opened[0]).toMatchObject({ nasId: NAS_ID, signallingUrl: RENDEZVOUS, inviteHash: await codeHashOf(code) });
    expect(world.opened[0].deviceProof).toBeUndefined();
    expect(world.peers[0].closed).toBe(true); // the redeem connection is only for the redeem

    expect(await nas.me()).toMatchObject({ owner: true, titleLibrary: true });
    expect(await nas.library('media5')).toEqual({ folders: [{ name: 'media5', path: 'media5', discs: 1 }], discs: [], scanning: false });
    expect(world.peers).toHaveLength(2);
    expect(world.opened[1].inviteHash).toBeUndefined();
    expect(world.opened[1].deviceProof).toBeTypeOf('function');
    expect(await nas.discBase('d/1')).toBe(`rtc://${NAS_ID}/api/discs/d%2F1/`);
    expect(Object.keys(server.hits)).toEqual([]); // nothing went over HTTPS
  });

  it('pairs over WebRTC when HTTPS fails its check, and keeps the HTTPS base', async () => {
    const server = fakeServer();
    const world = rtcWorld(server);
    const store = memoryStore();
    const nas = rtcClient(server, world, store);
    const tried: string[] = [];
    server.nas = async (url) => {
      tried.push(url.href);
      throw new TypeError('Failed to fetch');
    };
    await nas.pair(await server.code({ https: BASE, webrtc: { nasId: NAS_ID } }), 'iPhone');
    expect(store.value).toMatchObject({ base: BASE, nasId: NAS_ID });
    expect(tried).toEqual([`${BASE}health`]);
    expect((await nas.library('media5')).folders).toHaveLength(1);
    expect(tried).toEqual([`${BASE}health`, `${BASE}health`]);
  });

  it('pairs over HTTPS when it answers its check', async () => {
    const server = fakeServer();
    const world = rtcWorld(server);
    const store = memoryStore();
    const nas = rtcClient(server, world, store);
    await nas.pair(await server.code({ https: BASE, webrtc: { nasId: NAS_ID } }), 'iPhone');
    expect(store.value).toMatchObject({ base: BASE, nasId: NAS_ID });
    expect(server.hits).toMatchObject({ health: 1, 'pair/redeem': 1 });
    expect(world.peers).toHaveLength(0);
  });

  it('fails requests in flight as nas-lost when the connection closes, and reconnects on the next one', async () => {
    const server = fakeServer();
    const world = rtcWorld(server);
    const nas = rtcClient(server, world);
    await nas.pair(await server.code({ webrtc: { nasId: NAS_ID } }), 'iPhone');
    await nas.me();
    let release!: () => void;
    server.holdLibrary = new Promise<void>((resolve) => (release = resolve));
    const listing = nas.library('media5');
    const outcome = expect(listing).rejects.toMatchObject({ reason: 'nas-lost', message: NAS_LOST_MESSAGE });
    await new Promise((r) => setTimeout(r, 0));
    world.peers[1].fail(); // Wi-Fi to cellular
    await outcome;
    server.holdLibrary = null;
    release();
    expect((await nas.library('media5')).folders).toHaveLength(1);
    expect(world.peers).toHaveLength(3);
  });

  it('keeps the pairing through two drops in a row, one of them right after a session started', async () => {
    const server = fakeServer();
    const world = rtcWorld(server);
    let dropAfterSession = 0;
    const openRtc = async (o: RtcOpenOptions): Promise<RtcLink> => {
      const link = await world.openRtc(o);
      const inner = link.fetch;
      const dropping = (async (input: string | URL | Request, init?: RequestInit) => {
        const res = await inner(input, init);
        if (!String(input).endsWith('/api/session') || dropAfterSession === 0) return res;
        dropAfterSession--;
        const body = await res.text();
        link.close(); // the path goes just after the session answered
        return new Response(body, { status: res.status, headers: res.headers });
      }) as typeof fetch;
      return Object.assign(Object.create(link) as RtcLink, { fetch: dropping });
    };
    const store = memoryStore();
    const nas = rtcClient(server, { openRtc }, store);
    await nas.pair(await server.code({ webrtc: { nasId: NAS_ID } }), 'iPhone');
    await nas.me();
    world.peers.at(-1)!.fail(); // first drop
    dropAfterSession = 1; // second drop, as the new connection's session answers
    expect((await nas.library('media5')).folders).toHaveLength(1);
    expect(store.value).not.toBeNull();
    expect(server.auth.devices()).toHaveLength(1);
    world.peers.at(-1)!.fail();
    world.peers.at(-2)!.fail();
    expect((await nas.library('media5')).folders).toHaveLength(1);
    expect(store.value).not.toBeNull();
  });

  it('fetches art over WebRTC as object URLs, keeps the last 64 and revokes the rest', async () => {
    const server = fakeServer();
    const world = rtcWorld(server);
    const urls = fakeObjectUrls();
    const nas = rtcClient(server, world, memoryStore(), urls);
    await nas.pair(await server.code({ webrtc: { nasId: NAS_ID } }), 'iPhone');
    const first = await nas.artUrl('a0', 'small');
    expect(first).toBe('blob:fake/1');
    expect(await nas.artUrl('a0', 'small')).toBe(first);
    expect(server.artFetched).toEqual(['a0 small']);
    for (let i = 1; i <= 64; i++) await nas.artUrl(`a${i}`, 'small');
    expect(urls.revoked).toEqual([first]); // the least recently used went
    expect(urls.live.size).toBe(64);
    const fresh = await nas.freshArtUrl('a64', 'small', 'blob:fake/65');
    expect(fresh).toBe('blob:fake/66');
    expect(urls.revoked).toEqual([first, 'blob:fake/65']);
    expect(server.artFetched.at(-1)).toBe('a64 small');
    await nas.forget();
    expect(urls.live.size).toBe(0);
  });

  it('reads disc files through discFetch after a drop, once the engine has a fresh token', async () => {
    const server = fakeServer();
    const world = rtcWorld(server);
    const nas = rtcClient(server, world);
    await nas.pair(await server.code({ webrtc: { nasId: NAS_ID } }), 'iPhone');
    const url = `rtc://${NAS_ID}/api/library?path=media5`;
    const read = (token: string): Promise<Response> => nas.discFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const { token } = await nas.session();
    expect((await read(token)).status).toBe(200);
    world.peers.at(-1)!.fail();
    await new Promise((r) => setTimeout(r, 0));
    expect((await read(token)).status).toBe(401); // a new channel has seen no session yet
    const fresh = await nas.freshSession(token);
    expect((await read(fresh.token)).status).toBe(200);
    expect(world.peers).toHaveLength(3);

    let release!: () => void;
    server.holdLibrary = new Promise<void>((resolve) => (release = resolve));
    const inFlight = read(fresh.token);
    const outcome = expect(inFlight).rejects.toBeInstanceOf(NasLostError);
    await new Promise((r) => setTimeout(r, 0));
    world.peers.at(-1)!.fail();
    await outcome;
    server.holdLibrary = null;
    release();
  });

  it('reconnects an rtc:// disc over WebRTC after a drop even when HTTPS answers by then, and starts the next session there', async () => {
    const server = fakeServer();
    const world = rtcWorld(server);
    const nas = rtcClient(server, world);
    server.nas = async () => {
      throw new TypeError('Failed to fetch');
    };
    await nas.pair(await server.code({ https: BASE, webrtc: { nasId: NAS_ID } }), 'iPhone');
    const base = await nas.discBase('d1');
    expect(base).toBe(`rtc://${NAS_ID}/api/discs/d1/`);
    const url = `rtc://${NAS_ID}/api/library?path=media5`;
    const read = (token: string): Promise<Response> => nas.discFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const { token } = await nas.session();
    expect((await read(token)).status).toBe(200);

    server.nas = undefined; // HTTPS is reachable from here now
    world.peers.at(-1)!.fail();
    await new Promise((r) => setTimeout(r, 0));
    const peers = world.peers.length;
    expect((await read(token)).status).toBe(401); // over a new connection, which has seen no session yet
    expect(world.peers).toHaveLength(peers + 1);
    const healthChecks = server.hits.health ?? 0;
    const fresh = await nas.freshSession(token);
    expect((await read(fresh.token)).status).toBe(200); // the session was started on that connection
    expect(server.hits.health ?? 0).toBe(healthChecks); // the disc's route stays WebRTC: no check sends it to HTTPS
    expect(world.peers).toHaveLength(peers + 1);
  });

  it('fails discFetch as nas-lost while no connection can be made, and is plain fetch on HTTPS', async () => {
    const server = fakeServer();
    const world = rtcWorld(server);
    const nas = rtcClient(server, world);
    await nas.pair(await server.code({ webrtc: { nasId: NAS_ID } }), 'iPhone');
    world.opts.refuseSocket = 4404;
    await expect(nas.discFetch(`rtc://${NAS_ID}/api/library`)).rejects.toBeInstanceOf(NasLostError);
    expect((await nas.discFetch(`${BASE}health`)).ok).toBe(true);
  });

  it("proves the device with its key for TURN, and passes on the copy when there's no relay", async () => {
    const server = fakeServer();
    const store = memoryStore();
    const proofs: Array<Record<string, unknown>> = [];
    const world = rtcWorld(server, {
      turn: (m) => {
        proofs.push(m);
        return { iceServers: [], reason: 'off' };
      },
    });
    const nas = rtcClient(server, world, store);
    await nas.pair(await server.code({ webrtc: { nasId: NAS_ID } }), 'iPhone');
    world.opts.direct = false;
    await expect(nas.me()).rejects.toThrow(RTC_UNREACHABLE);
    const proof = proofs.at(-1)!;
    expect(proof.deviceId).toBe(store.value!.deviceId);
    const sid = world.sent.find((m) => m.t === 'turn-request')!.sid;
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      store.value!.key.publicKey,
      fromBase64url(String(proof.signature))!,
      turnProofMessage({ sid, ts: Number(proof.ts) }),
    );
    expect(ok).toBe(true);
  });
});

describe('NasClient pairing links', () => {
  /** The app's own Worker in these tests, which the fake server doesn't answer: a lookup there fails. */
  const BUILT_IN = 'https://builtin.example';
  const counting = (server: FakeServer): { fetch: typeof fetch; lookups: string[] } => {
    const lookups: string[] = [];
    const counted = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/codes/lookup')) lookups.push(String(input));
      return server.fetch(input, init);
    }) as typeof server.fetch;
    return { fetch: counted, lookups };
  };

  it('pair with nas skips the lookup', async () => {
    const server = fakeServer();
    const { fetch, lookups } = counting(server);
    const store = memoryStore();
    // a link with nas pairs even when the app has no Worker
    const nas = new NasClient({ fetch, subtle: crypto.subtle, store, now, rendezvousUrl: undefined });
    expect(nas.canPairByCode).toBe(false);
    await nas.pair(await server.code(), 'iPad', { nas: BASE });
    expect(lookups).toEqual([]);
    expect(store.value).toMatchObject({ base: BASE, deviceName: 'iPad', owner: true });
    expect(store.value).not.toHaveProperty('nasId');
    expect(store.value).not.toHaveProperty('rendezvousUrl');
    expect(server.hits['pair/redeem']).toBe(1);
    expect((await nas.library('media5')).folders).toHaveLength(1);
  });

  it('pair with rv looks up at rv and stores it', async () => {
    const server = fakeServer();
    const { fetch, lookups } = counting(server);
    const store = memoryStore();
    const nas = new NasClient({ fetch, subtle: crypto.subtle, store, now, rendezvousUrl: BUILT_IN });
    await nas.pair(await server.code(), 'iPad', { rv: `${RENDEZVOUS}/` });
    expect(lookups).toEqual([`${RENDEZVOUS}/codes/lookup`]);
    expect(store.value).toMatchObject({ base: BASE, rendezvousUrl: RENDEZVOUS });
  });

  it('pair with rv naming the built-in Worker stores no Worker of its own', async () => {
    const server = fakeServer();
    const store = memoryStore();
    const nas = client(server, store);
    await nas.pair(await server.code(), 'iPad', { rv: RENDEZVOUS });
    expect(store.value).not.toHaveProperty('rendezvousUrl');
  });

  it("signalling uses the pairing's own Worker", async () => {
    const server = fakeServer();
    const world = rtcWorld(server);
    const store = memoryStore();
    const deps = { fetch: server.fetch, subtle: crypto.subtle, store, now, rendezvousUrl: BUILT_IN, openRtc: world.openRtc };
    const nas = new NasClient(deps);
    await nas.pair(await server.code({ webrtc: { nasId: NAS_ID } }), 'iPhone', { rv: RENDEZVOUS });
    expect(store.value).toMatchObject({ base: '', nasId: NAS_ID, rendezvousUrl: RENDEZVOUS });
    expect(world.opened[0]).toMatchObject({ nasId: NAS_ID, signallingUrl: RENDEZVOUS });
    await nas.me();
    expect(world.opened[1]).toMatchObject({ nasId: NAS_ID, signallingUrl: RENDEZVOUS });
    // after a reload too
    const again = new NasClient(deps);
    await again.me();
    expect(world.opened[2]).toMatchObject({ nasId: NAS_ID, signallingUrl: RENDEZVOUS });
  });

  it('an old pairing uses the built-in Worker', async () => {
    const server = fakeServer();
    const world = rtcWorld(server);
    const store = memoryStore();
    await rtcClient(server, world, store).pair(await server.code({ webrtc: { nasId: NAS_ID } }), 'iPhone');
    expect(store.value).not.toHaveProperty('rendezvousUrl');
    const nas = new NasClient({ fetch: server.fetch, subtle: crypto.subtle, store, now, rendezvousUrl: BUILT_IN, openRtc: world.openRtc });
    await nas.me();
    expect(world.opened.at(-1)).toMatchObject({ nasId: NAS_ID, signallingUrl: BUILT_IN });
  });

  it('a pairing made straight at a server takes no NAS id from me, so it never signals through the built-in Worker', async () => {
    const server = fakeServer();
    const withNasId = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await server.fetch(input, init);
      if (!String(input).endsWith('/api/me')) return res;
      return Response.json({ ...((await res.json()) as object), nasId: NAS_ID });
    }) as typeof server.fetch;
    const direct = memoryStore();
    const nas = new NasClient({ fetch: withNasId, subtle: crypto.subtle, store: direct, now, rendezvousUrl: BUILT_IN });
    await nas.pair(await server.code(), 'iPad', { nas: BASE });
    expect(direct.value).toMatchObject({ direct: true });
    await nas.me();
    expect(direct.value).not.toHaveProperty('nasId');
    // one that names a Worker (here with nas too) takes it, as a looked-up one does
    const named = memoryStore();
    const nas2 = new NasClient({ fetch: withNasId, subtle: crypto.subtle, store: named, now, rendezvousUrl: BUILT_IN });
    await nas2.pair(await server.code(), 'iPad', { nas: BASE, rv: RENDEZVOUS });
    expect(named.value).not.toHaveProperty('direct');
    await nas2.me();
    expect(named.value).toMatchObject({ nasId: NAS_ID, rendezvousUrl: RENDEZVOUS });
    const looked = memoryStore();
    const nas3 = new NasClient({ fetch: withNasId, subtle: crypto.subtle, store: looked, now, rendezvousUrl: RENDEZVOUS });
    await nas3.pair(await server.code(), 'iPad');
    await nas3.me();
    expect(looked.value).toMatchObject({ nasId: NAS_ID });
  });

  it('clears a stored pairing whose Worker or direct mark is damaged', async () => {
    const server = fakeServer();
    for (const damage of [{ rendezvousUrl: 42 }, { direct: 'yes' }]) {
      const store = memoryStore();
      await client(server, store).pair(await server.code(), 'iPad');
      store.value = { ...store.value!, ...damage } as unknown as NasPairing;
      const nas = client(server, store);
      expect(await nas.pairing()).toBeNull();
      expect(store.value).toBeNull();
    }
  });

  it('compares the built-in Worker as a URL: case, :443 and a trailing slash name the same Worker', async () => {
    const server = fakeServer();
    const store = memoryStore();
    const nas = new NasClient({ fetch: server.fetch, subtle: crypto.subtle, store, now, rendezvousUrl: 'https://Rendezvous.Example:443/' });
    await nas.pair(await server.code(), 'iPad', { rv: RENDEZVOUS });
    expect(store.value).not.toHaveProperty('rendezvousUrl');
  });

  it("a nas link to a server that doesn't answer fails with noRoute", async () => {
    const server = fakeServer();
    server.nas = async () => {
      throw new TypeError('Failed to fetch');
    };
    const store = memoryStore();
    await expect(client(server, store).pair(await server.code(), 'iPad', { nas: BASE })).rejects.toThrow(NAS_MESSAGES.noRoute);
    expect(store.value).toBeNull();
  });
});

const PLACE_KEY = `f.${'C'.repeat(32)}`;
const placeSettings: PlaceSettings = { audioLanguage: 'jpn', pgLanguage: null, textFiles: [], psr1: 1, psr2: 0, psr3: 1, textOn: false, textScale: 1, shaderSet: null, volume: 1, muted: false };
const playbackPlace = (over: Partial<PlaybackPlace> = {}): PlaybackPlace => ({
  discKey: PLACE_KEY, discId: '0123456789abcdef', playlistId: '00001', timeUs: 60e6, durationUs: 1440e6, finished: false,
  mode: 'none', title: null, psrs: [0, 1], gprs: null, settings: placeSettings, updatedAt: clock - 1000, deviceName: 'iPad', ...over,
});

describe('NasClient places', () => {
  it("stores this person's places on the NAS, answers stale for an older one, and reads and deletes them", async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    expect(await nas.playbackPlaces(PLACE_KEY)).toBeNull();
    expect(await nas.putPlace(playbackPlace())).toBe('stored');
    expect(await nas.putPlace(playbackPlace({ playlistId: '00002', updatedAt: clock - 500 }))).toBe('stored');
    expect(await nas.putPlace(playbackPlace({ timeUs: 1e6, updatedAt: clock - 2000 }))).toBe('stale');
    const places = await nas.playbackPlaces(PLACE_KEY);
    expect(places?.places['00001']?.timeUs).toBe(60e6);
    expect(Object.keys(places!.places).sort()).toEqual(['00001', '00002']);
    expect((await nas.continueWatching()).map((c) => [c.kind, c.playlistId])).toEqual([['resume', '00002'], ['resume', '00001']]);
    await nas.deletePlace(PLACE_KEY, '00002');
    expect(Object.keys((await nas.playbackPlaces(PLACE_KEY))!.places)).toEqual(['00001']);
    await nas.deletePlace(PLACE_KEY);
    expect(await nas.playbackPlaces(PLACE_KEY)).toBeNull();
    expect(await nas.titleProgress('anilist:1')).toBeNull(); // no title library on this NAS
  });

  it('refuses a malformed place with the error the NAS gives', async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    await expect(nas.putPlace(playbackPlace({ playlistId: 'a/b' }))).rejects.toMatchObject({ status: 404 });
  });

  it('sends a place with keepalive over HTTPS when asked, never one too large for it', async () => {
    const server = fakeServer();
    const sent: (boolean | undefined)[] = [];
    const watching = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/me/playback/')) sent.push(init?.keepalive);
      return server.fetch(input, init);
    }) as typeof fetch;
    const nas2 = new NasClient({ fetch: watching, subtle: crypto.subtle, store: memoryStore(), now, rendezvousUrl: RENDEZVOUS });
    await nas2.pair(await server.code(), 'iPad');
    expect(await nas2.putPlace(playbackPlace(), { keepalive: true })).toBe('stored');
    expect(await nas2.putPlace(playbackPlace({ updatedAt: clock - 900 }))).toBe('stored');
    const gprs = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [i, 0x7fffffff]));
    expect(await nas2.putPlace(playbackPlace({ updatedAt: clock - 800, mode: 'hdmv', title: 1, gprs }), { keepalive: true })).toBe('stored');
    expect(sent).toEqual([true, undefined, undefined]);
  });

  it('gives up on a place whose request stalls, as the NAS being unreachable', async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    await nas.session();
    server.nas = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const put = nas.putPlace(playbackPlace());
    const outcome = expect(put).rejects.toThrow(NAS_MESSAGES.unreachable);
    await vi.advanceTimersByTimeAsync(PLACE_TIMEOUT_MS);
    await outcome;
  });

  it('tells its listeners when the pairing changes: paired, forgotten', async () => {
    const server = fakeServer();
    const nas = client(server);
    const changed = vi.fn();
    nas.onPairingChange(changed);
    await nas.pair(await server.code(), 'iPad');
    expect(changed).toHaveBeenCalledTimes(1);
    await nas.forget();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('tells its listeners when a session starts, so places waiting on the device can go', async () => {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    const started = vi.fn();
    const off = nas.onSession(started);
    await nas.session();
    await nas.session(); // reused: no new session
    expect(started).toHaveBeenCalledTimes(1);
    off();
    clock += 56 * MINUTE;
    await nas.session();
    expect(started).toHaveBeenCalledTimes(1);
  });
});

describe('groupCodeInput', () => {
  it('groups as typed and accepts dashes and spaces', () => {
    expect(groupCodeInput('k7q')).toBe('K7Q');
    expect(groupCodeInput('k7qm4')).toBe('K7QM-4');
    expect(groupCodeInput('k7qm 4xp2-r9td')).toBe('K7QM-4XP2-R9TD');
    expect(groupCodeInput('K7QM-4XP2-R9TDXX')).toBe('K7QM-4XP2-R9TD');
    expect(groupCodeInput('K7QM - 4XP2 - R9TD')).toBe('K7QM-4XP2-R9TD'); // pasted: 18 characters, none lost
  });
});

describe('defaultDeviceName', () => {
  it('names the platform briefly', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    expect(defaultDeviceName(mac, 0)).toBe('Mac Safari');
    expect(defaultDeviceName(mac, 5)).toBe('iPad');
    expect(defaultDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 5)).toBe('iPhone');
    expect(defaultDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0', 0)).toBe('Firefox');
    expect(defaultDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 0)).toBe(
      'Windows Chrome',
    );
    expect(defaultDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 5)).toBe(
      'Android',
    );
  });
});

describe('NasClient subtitles', () => {
  const stored: StoredSubtitle = { id: '0123456789abcdef', name: 'Fan', language: 'en', offsetMs: 0, fileName: 'a b.srt', fileSize: 3, fonts: [{ name: 'f#1.ttf', size: 2 }], attachment: { kind: 'chapter', discKey: 'd.1', playlistId: '00001', chapter: 0 }, uploaderPersonId: 'p', uploadedAt: 1 };

  async function paired(): Promise<{ nas: NasClient; server: FakeServer; calls: { method: string; route: string; body: unknown; signal?: AbortSignal | null }[] }> {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    await nas.session();
    const calls: { method: string; route: string; body: unknown; signal?: AbortSignal | null }[] = [];
    server.nas = async (url, init) => {
      const route = url.pathname.slice(new URL(BASE).pathname.length) + url.search;
      calls.push({ method: init?.method ?? 'GET', route, body: init?.body, signal: init?.signal });
      if (route === 'subtitles/0123456789abcdef/file') return new Response('abc');
      if (init?.method !== 'PUT' && route.startsWith('subtitles/0123456789abcdef/fonts/')) return new Response(new Uint8Array([1, 2]));
      if (route.startsWith('subtitles/0123456789abcdef/file/a%20b.srt')) return Response.json(stored);
      if (route.includes('refused')) return Response.json({ error: 'forbidden' }, { status: 403 });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (route.startsWith('subtitles?')) return Response.json([stored]);
      return Response.json(stored, { status: init?.method === 'POST' ? 201 : 200 });
    };
    return { nas, server, calls };
  }

  it('lists by disc and by title with the keys encoded', async () => {
    const { nas, calls } = await paired();
    expect(await nas.subtitlesForDisc('d.0123')).toEqual([stored]);
    expect(await nas.subtitlesForTitle('anilist:1')).toEqual([stored]);
    expect(calls.map((c) => c.route)).toEqual(['subtitles?discKey=d.0123', 'subtitles?titleId=anilist%3A1']);
  });

  it('downloads the file, then the fonts, as Files named as stored', async () => {
    const { nas, calls } = await paired();
    const files = await nas.subtitleFiles(stored);
    expect(files.map((f) => f.name)).toEqual(['a b.srt', 'f#1.ttf']);
    expect(await files[0].text()).toBe('abc');
    expect((await files[1].arrayBuffer()).byteLength).toBe(2);
    expect(calls.map((c) => c.route)).toEqual(['subtitles/0123456789abcdef/file', 'subtitles/0123456789abcdef/fonts/f%231.ttf']);
  });

  it('reads a pick\'s files from the picks path', async () => {
    const { nas, calls } = await paired();
    const pick = { ...stored, pick: true as const };
    await nas.subtitleFiles(pick);
    expect(calls.map((c) => c.route)).toEqual(['fansubs/picks/0123456789abcdef/file', 'fansubs/picks/0123456789abcdef/fonts/f%231.ttf']);
  });

  it('posts a pick and calls the fansub routes', async () => {
    const { nas, calls } = await paired();
    const body = { fileId: 5, track: 2, discKey: 'd.1', playlistId: '00001' };
    await nas.pickFansub(body);
    await nas.runFansubs('anilist:1');
    await nas.fansubTitle('anilist:1');
    await nas.undeleteFansubs('anilist:1');
    await nas.realignFansub('x');
    await nas.originalFansubTiming('x');
    await nas.searchTosho('Starfall Wanderer', 'anilist:1');
    await nas.searchTosho('a b');
    await nas.toshoRelease(7, 'd.1', '00001');
    expect(calls.map((c) => `${c.method} ${c.route}`)).toEqual([
      'POST fansubs/picks', 'POST fansubs/titles/anilist%3A1/run', 'GET fansubs/titles/anilist%3A1', 'POST fansubs/titles/anilist%3A1/undelete',
      'POST fansubs/subtitles/x/realign', 'POST fansubs/subtitles/x/original',
      'GET fansubs/search?q=Starfall+Wanderer&titleId=anilist%3A1', 'GET fansubs/search?q=a+b', 'GET fansubs/releases/7?discKey=d.1&playlistId=00001',
    ]);
    expect(JSON.parse(calls[0].body as string)).toEqual(body);
  });

  it('reads and sets the fansub languages', async () => {
    const { nas, server } = await paired();
    const inner = server.nas!;
    server.nas = async (url, init) => (url.pathname.endsWith('fansubs/languages') ? Response.json({ languages: ['en', 'ja'] }) : inner(url, init));
    expect(await nas.fansubLanguages()).toEqual(['en', 'ja']);
    expect(await nas.setFansubLanguages(['en', 'ja'])).toEqual(['en', 'ja']);
  });

  it("aborts a download's requests through the caller's signal", async () => {
    const { nas, calls } = await paired();
    const abort = new AbortController();
    await nas.subtitleFiles(stored, abort.signal);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.signal?.aborted === false)).toBe(true);
    abort.abort();
    expect(calls.every((c) => c.signal?.aborted === true)).toBe(true);
  });

  it("a download stopped by its caller is no sign of an unreachable NAS", async () => {
    const { nas, server } = await paired();
    let reached!: () => void;
    const fetched = new Promise<void>((r) => (reached = r));
    server.nas = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        reached();
      });
    const abort = new AbortController();
    const files = nas.subtitleFiles(stored, abort.signal);
    await fetched;
    abort.abort();
    await expect(files).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('creates, patches and deletes', async () => {
    const { nas, calls } = await paired();
    const forEpisode = { kind: 'episode', titleId: 't', seasonId: 's', episode: 2 } as const;
    expect(await nas.createSubtitle({ name: 'Fan', language: 'en', for: forEpisode })).toEqual(stored);
    expect(await nas.updateSubtitle(stored.id, { offsetMs: -500 })).toEqual(stored);
    await nas.deleteSubtitle(stored.id);
    expect(calls.map((c) => [c.method, c.route, c.body])).toEqual([
      ['POST', 'subtitles', JSON.stringify({ name: 'Fan', language: 'en', for: forEpisode })],
      ['PATCH', 'subtitles/0123456789abcdef', JSON.stringify({ offsetMs: -500 })],
      ['DELETE', 'subtitles/0123456789abcdef', undefined],
    ]);
  });

  it('uploads the File as the raw body under its encoded name', async () => {
    const { nas, calls } = await paired();
    const file = new File(['abc'], 'a b.srt');
    const sent: number[] = [];
    expect(await nas.uploadSubtitleFile(stored.id, file, (n) => sent.push(n))).toEqual(stored);
    expect(await nas.uploadSubtitleFont(stored.id, new File([new Uint8Array([1])], 'f#1.ttf'))).toEqual(stored);
    expect(calls.map((c) => [c.method, c.route])).toEqual([
      ['PUT', 'subtitles/0123456789abcdef/file/a%20b.srt'],
      ['PUT', 'subtitles/0123456789abcdef/fonts/f%231.ttf'],
    ]);
    expect(calls[0].body).toBe(file);
    expect(sent).toEqual([3]);
  });

  it('sends an HTTPS upload through sendWithProgress and passes its progress on', async () => {
    const server = fakeServer();
    const sentBy: string[] = [];
    const nas = new NasClient({
      fetch: server.fetch, subtle: crypto.subtle, store: memoryStore(), now, rendezvousUrl: RENDEZVOUS,
      sendWithProgress: async (url, init, onSent) => {
        sentBy.push(`${init.method} ${new URL(url).pathname.split('/').at(-1)}`);
        onSent(1);
        onSent(3);
        return server.fetch(url, init);
      },
    });
    await nas.pair(await server.code(), 'iPad');
    server.nas = async () => Response.json(stored);
    const sent: number[] = [];
    expect(await nas.uploadSubtitleFile(stored.id, new File(['abc'], 'a b.srt'), (n) => sent.push(n))).toEqual(stored);
    expect(sent).toEqual([1, 3]);
    await nas.createSubtitle({ name: 'Fan', language: 'en', for: { kind: 'episode', titleId: 't', seasonId: 's', episode: 1 } });
    expect(sentBy).toEqual(['PUT a%20b.srt']); // only uploads that report progress go that way
  });

  it('turns a 403 into a NasHttpError and aborts the refused upload', async () => {
    const { nas, calls } = await paired();
    await expect(nas.uploadSubtitleFile(stored.id, new File(['abc'], 'refused.srt'))).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(calls).toHaveLength(1);
    expect(calls[0].signal?.aborted).toBe(true);
  });
});

describe('NasClient quality levels', () => {
  const BUSY = 'The NAS is busy re-encoding for others. This will play at original quality.';
  async function paired(answer: (route: string, method: string) => Response): Promise<{ nas: NasClient; routes: { method: string; route: string }[] }> {
    const server = fakeServer();
    const nas = client(server);
    await nas.pair(await server.code(), 'iPad');
    await nas.session();
    const routes: { method: string; route: string }[] = [];
    server.nas = async (url, init) => {
      const route = url.pathname.slice(new URL(BASE).pathname.length) + url.search;
      const method = init?.method ?? 'GET';
      routes.push({ method, route });
      return answer(route, method);
    };
    return { nas, routes };
  }

  it('levels asks with the device flags and audio, and answers null on 404', async () => {
    const levels = [{ level: 'original', label: 'Original', budgetMbps: 30, available: true }];
    let n = 0;
    const { nas, routes } = await paired(() => (n++ === 0 ? Response.json({ levels }) : Response.json({ error: 'not-found' }, { status: 404 })));
    expect(await nas.levels('d1', { hevc: true, hevc10: false, hdr: false, audio: 2 })).toEqual(levels);
    expect(routes[0].route).toBe('discs/d1/levels?hevc=1&hevc10=0&hdr=0&audio=2');
    expect(await nas.levels('d1', { hevc: false, hevc10: false, hdr: false, audio: 1 })).toBeNull();
  });

  it('admin.encodingNow reads admin/encoding and answers null on 404', async () => {
    const encoding = [{ personName: 'Owner', deviceName: 'Mac', discName: 'Starfall Wanderer Vol 1', level: 'h264-1080', label: '1080p', gpuPercent: 16 }];
    let n = 0;
    const { nas, routes } = await paired(() => (n++ === 0 ? Response.json({ encoding }) : Response.json({ error: 'not found' }, { status: 404 })));
    expect(await nas.admin.encodingNow()).toEqual(encoding);
    expect(routes[0].route).toBe('admin/encoding');
    expect(await nas.admin.encodingNow()).toBeNull();
  });

  it('manifest at a level asks with level and audio, and Original with neither', async () => {
    const m = { discId: 'd1', name: 'Disc', files: [], inline: {} };
    const { nas, routes } = await paired(() => Response.json(m));
    await nas.manifest('d1', { level: 'phone-720', audio: 1 });
    await nas.manifest('d1');
    await nas.manifest('d1', { level: 'original', audio: 3 });
    expect(routes.map((r) => r.route)).toEqual(['discs/d1/manifest?level=phone-720&audio=1', 'discs/d1/manifest', 'discs/d1/manifest']);
  });

  it('manifest throws NasBusyError with the NAS message on 503 busy', async () => {
    const { nas } = await paired(() => Response.json({ error: 'busy', message: BUSY }, { status: 503 }));
    const err = await nas.manifest('d1', { level: 'h264-1080', audio: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NasBusyError);
    expect(err).toMatchObject({ name: 'NasBusyError', message: BUSY });
  });

  it('releaseViewing sends DELETE viewing and swallows errors', async () => {
    let status = 204;
    const { nas, routes } = await paired(() => new Response(null, { status }));
    await nas.releaseViewing('d1', { level: 'h264-1080', audio: 3 });
    status = 500;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(nas.releaseViewing('d1', { level: 'h264-1080', audio: 3 })).resolves.toBeUndefined();
    expect(routes).toEqual([
      { method: 'DELETE', route: 'discs/d1/viewing?level=h264-1080&audio=3' },
      { method: 'DELETE', route: 'discs/d1/viewing?level=h264-1080&audio=3' },
    ]);
  });
});
