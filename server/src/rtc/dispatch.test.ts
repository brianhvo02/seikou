import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WireClient } from '@seikou/nas/rtc-wire';
import type { WireChannel } from '@seikou/nas/rtc-wire';
import { appHandlers } from '../app';
import { Auth } from '../auth';
import { BdjStore } from '../bdj-store';
import { createServer } from '../http';
import type { Handler, Response as HttpResponse } from '../http';
import type { LevelRouteService } from '../routes/discs';
import { discRoutes } from '../routes/discs';
import { Library, SETTLE_MS } from '../library';
import { Store } from '../store';
import { serveChannel } from './dispatch';

// Every name here is made up.

/** One end of an in-memory ordered channel. */
class MemChannel implements WireChannel {
  peer!: MemChannel;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onbufferedamountlow: (() => void) | null = null;
  onmessage: ((data: string | Uint8Array) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  send(data: string | Uint8Array): void {
    if (this.closed) throw new Error('InvalidStateError: closed');
    const copy = typeof data === 'string' ? data : data.slice();
    const peer = this.peer;
    queueMicrotask(() => {
      if (!peer.closed) peer.onmessage?.(copy);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = this.peer.closed = true;
    queueMicrotask(() => {
      this.onclose?.();
      this.peer.onclose?.();
    });
  }
}

function channelPair(): { client: MemChannel; server: MemChannel } {
  const client = new MemChannel();
  const server = new MemChannel();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

const INDEX = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37 + 11) & 0xff));

let tmp: string;
let clock: number;
let auth: Auth;
let library: Library;
let handlers: Handler[];
/** Runs before every app handler: whether a request reached the handlers at all. */
let reached: ReturnType<typeof vi.fn<Handler>>;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'rtc-dispatch-'));
  clock = 1_800_000_000_000;
  const data = join(tmp, 'data');
  const disc = join(tmp, 'root', 'Starfall Wanderer Vol 1', 'BDMV');
  mkdirSync(disc, { recursive: true });
  writeFileSync(join(disc, 'index.bdmv'), INDEX);
  auth = new Auth(new Store(data), () => clock);
  library = new Library([{ name: 'drv', dir: join(tmp, 'root') }], join(data, 'library.json'), { scanPauseMs: 0, now: () => Date.now() + SETTLE_MS + 1 });
  await library.scan();
  reached = vi.fn<Handler>(async () => null);
  handlers = [
    reached,
    ...appHandlers({ auth, library, bdjStore: new BdjStore(data), now: () => clock, publicBase: 'https://nas.example/bluray/api/' }),
  ];
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(tmp, { recursive: true, force: true });
});

async function deviceKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const sign = async (text: string): Promise<string> =>
    Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(text))).toString('base64url');
  return { jwk, sign };
}

function open(onSession?: (deviceId: string) => void) {
  const channels = channelPair();
  const served = serveChannel(channels.server, handlers, { auth, remoteAddress: '203.0.113.7', now: () => clock, onSession });
  const client = new WireClient(channels.client);
  const post = (path: string, body: unknown): Promise<Response> =>
    client.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { channels, served, client, post };
}

type Conn = ReturnType<typeof open>;

/** Redeems a fresh guest code over `conn`: the device id and its signer. */
async function redeemOver(conn: Conn): Promise<{ deviceId: string; sign: (text: string) => Promise<string> }> {
  const { jwk, sign } = await deviceKey();
  const { code } = auth.createCode({ newPerson: { name: 'Mika', owner: false } });
  const res = await conn.post('/api/pair/redeem', { code, deviceName: 'Phone', publicKeyJwk: jwk });
  expect(res.status).toBe(200);
  const { deviceId } = (await res.json()) as { deviceId: string };
  return { deviceId, sign };
}

/** Redeems and starts a session over `conn`: the device id and its token. */
async function sessionOver(conn: Conn): Promise<{ deviceId: string; token: string }> {
  const { deviceId, sign } = await redeemOver(conn);
  const { challenge } = (await (await conn.post('/api/session/challenge', { deviceId })).json()) as { challenge: string };
  const res = await conn.post('/api/session', { deviceId, challenge, signature: await sign(challenge) });
  expect(res.status).toBe(200);
  const { token } = (await res.json()) as { token: string };
  return { deviceId, token };
}

describe('serveChannel', () => {
  it('answers 401 to an unpaired channel without running a handler', async () => {
    const conn = open();
    const res = await conn.client.fetch('/api/library?path=');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    for (const [method, path] of [
      ['GET', '/api/discs/x/manifest'],
      ['OPTIONS', '/api/library'],
      ['HEAD', '/api/health'],
      ['POST', '/api/health'],
      ['GET', '/api/session'],
    ] as const) {
      expect((await conn.client.fetch(path, { method })).status, `${method} ${path}`).toBe(401);
    }
    expect(reached).not.toHaveBeenCalled();
    const health = await conn.client.fetch('/api/health');
    expect(health.status).toBe(200);
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await conn.post('/api/session/challenge', { deviceId: 'nope' })).status).toBe(401);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it('pairs a device with a code', async () => {
    const conn = open();
    const { deviceId } = await redeemOver(conn);
    expect(auth.devices().map((d) => [d.id, d.name, d.personName])).toEqual([[deviceId, 'Phone', 'Mika']]);
  });

  it('opens every route once a session starts, and reports the device', async () => {
    const onSession = vi.fn();
    const conn = open(onSession);
    const { deviceId, token } = await sessionOver(conn);
    expect(onSession).toHaveBeenCalledWith(deviceId);
    const res = await conn.client.fetch('/api/library', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { discs: unknown[] }).discs).toHaveLength(1);
    // a token is still needed on each request
    expect((await conn.client.fetch('/api/library')).status).toBe(401);
  });

  it('reads a disc range byte-exact', async () => {
    const conn = open();
    const { token } = await sessionOver(conn);
    const [disc] = library.list('')!.discs;
    const res = await conn.client.fetch(`/api/discs/${disc!.id}/files/BDMV/index.bdmv?t=${encodeURIComponent(token)}`, { headers: { Range: 'bytes=100-4099' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 100-4099/${INDEX.length}`);
    expect(Buffer.from(await res.arrayBuffer()).equals(INDEX.subarray(100, 4100))).toBe(true);
  });

  it('closes the channel after a failed session attempt, once the 401 is out', async () => {
    const conn = open();
    const { deviceId } = await redeemOver(conn);
    const { challenge } = (await (await conn.post('/api/session/challenge', { deviceId })).json()) as { challenge: string };
    const res = await conn.post('/api/session', { deviceId, challenge, signature: 'AAAA' });
    expect(res.status).toBe(401);
    await flush();
    expect(conn.channels.server.closed).toBe(true);
    await expect(conn.client.fetch('/api/health')).rejects.toThrow();
  });

  it('closes a channel with no session at 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const conn = open();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(conn.channels.server.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(conn.channels.server.closed).toBe(true);
  });

  it('closes a channel whose clock has run past 30 s before its next request', async () => {
    const conn = open();
    clock += 30_000;
    expect((await conn.client.fetch('/api/health')).status).toBe(401);
    await flush();
    expect(conn.channels.server.closed).toBe(true);
  });

  it('keeps a channel with a session open past 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const conn = open();
    await sessionOver(conn);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(conn.channels.server.closed).toBe(false);
  });

  it('closes the channel when its device is revoked or its person removed, but not when the device moves', async () => {
    const first = open();
    const a = await sessionOver(first);
    const second = open();
    const b = await sessionOver(second);
    auth.moveDevice(a.deviceId, auth.createPerson('Den TV', false).id);
    await flush();
    expect(first.channels.server.closed).toBe(false);
    auth.revokeDevice(a.deviceId);
    await flush();
    expect(first.channels.server.closed).toBe(true);
    expect(second.channels.server.closed).toBe(false);
    auth.removePerson(auth.devices().find((d) => d.id === b.deviceId)!.personId);
    await flush();
    expect(second.channels.server.closed).toBe(true);
  });

  it('closes a channel that sends garbage, and keeps serving others', async () => {
    const bad = open();
    const good = open();
    bad.channels.client.send('{not json');
    await flush();
    expect(bad.channels.server.closed).toBe(true);
    bad.served.close();
    expect((await good.client.fetch('/api/health')).status).toBe(200);
  });

  it('answers a handler failure with a generic 500', async () => {
    handlers = [async () => { throw new Error('secret internal detail'); }];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const conn = open();
    const res = await conn.post('/api/session/challenge', {});
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal error"}');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('destroys a streamed body when the read is cancelled, and errors a body shorter than its length', async () => {
    let stream: Readable | undefined;
    handlers.unshift(async (_req, url): Promise<HttpResponse | null> => {
      if (url.pathname === '/api/test/endless') {
        stream = new Readable({ read() { this.push(Buffer.alloc(1024)); } });
        return { status: 200, headers: { 'Content-Type': 'application/octet-stream' }, body: stream };
      }
      if (url.pathname === '/api/test/short') return { status: 200, headers: { 'Content-Length': '10' }, body: Readable.from([Buffer.from('12345')]) };
      return null;
    });
    const conn = open();
    const { token } = await sessionOver(conn);
    const auth = { Authorization: `Bearer ${token}` };
    const abort = new AbortController();
    const res = await conn.client.fetch('/api/test/endless', { headers: auth, signal: abort.signal });
    expect(res.status).toBe(200);
    abort.abort();
    await flush();
    expect(stream!.destroyed).toBe(true);
    await expect((await conn.client.fetch('/api/test/short', { headers: auth })).arrayBuffer()).rejects.toThrow(/ended early/);
    // the channel stays usable after both
    expect((await conn.client.fetch('/api/health')).status).toBe(200);
  });
});

describe('serveChannel and the quality levels', () => {
  /** A level service whose reads answer `retryAfter`, or wait until their signal aborts. */
  function stubLevels(read: LevelRouteService['read']): LevelRouteService {
    return {
      manifest: async () => null,
      levels: async () => null,
      release: () => {},
      size: async () => 1 << 20,
      originalPlayable: async () => true,
      read,
    };
  }
  const discId = (): string => library.list('drv')!.discs[0]!.id;

  it('answers a level read the encoder hasn’t reached with 503 and Retry-After: 1', async () => {
    handlers.unshift(discRoutes(library, { service: stubLevels(async () => ({ retryAfter: 1 })), auth }));
    const conn = open();
    const { token } = await sessionOver(conn);
    const res = await conn.client.fetch(`/api/discs/${discId()}/files/BDMV/STREAM/00001.M2TS?level=h264-1080&audio=1`, {
      headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-191' },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(await res.json()).toEqual({ error: 'retry' });
  });

  it('aborts a waiting level read when the peer cancels the request', async () => {
    let signal: AbortSignal | undefined;
    const aborted = new Promise<void>((resolve) => {
      handlers.unshift(
        discRoutes(library, {
          service: stubLevels(async (_d, _l, _a, _p, _o, _n, _v, s) => {
            signal = s;
            await new Promise<void>((r) => s.addEventListener('abort', () => r(), { once: true }));
            resolve();
            return { retryAfter: 1 };
          }),
          auth,
        }),
      );
    });
    const conn = open();
    const { token } = await sessionOver(conn);
    const abort = new AbortController();
    const pending = conn.client.fetch(`/api/discs/${discId()}/files/BDMV/STREAM/00001.M2TS?level=h264-1080&audio=1`, {
      headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-191' },
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(signal!.aborted).toBe(false);
    abort.abort();
    await expect(pending).rejects.toThrow();
    await aborted;
    expect(signal!.aborted).toBe(true);
    expect((await conn.client.fetch('/api/health')).status).toBe(200);
  });
});

describe('serveChannel streams', () => {
  let stream: Readable | undefined;
  let seen: Record<string, unknown> | undefined;
  beforeEach(() => {
    stream = undefined;
    handlers.unshift(async (req, url): Promise<HttpResponse | null> => {
      if (url.pathname === '/api/test/broken') {
        stream = new Readable({ read() {} });
        stream.push(Buffer.alloc(100));
        setImmediate(() => stream!.destroy(new Error("ENOENT: no such file or directory, open '/mnt/media/Starfall Wanderer/BDMV/STREAM/00001.m2ts'")));
        return { status: 200, headers: {}, body: stream };
      }
      if (url.pathname === '/api/test/endless') {
        stream = new Readable({ read() { this.push(Buffer.alloc(1024)); } });
        return { status: 200, headers: {}, body: stream };
      }
      if (url.pathname === '/api/test/echo') {
        seen = { ...req.headers, remote: req.socket.remoteAddress };
        return { status: 204 };
      }
      return null;
    });
  });

  it('tells the peer only that a read failed, never the error itself', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const conn = open();
    const { token } = await sessionOver(conn);
    const res = await conn.client.fetch('/api/test/broken', { headers: { Authorization: `Bearer ${token}` } });
    const failure = await res.arrayBuffer().then(() => null, (err: unknown) => err as Error);
    expect(failure?.message).toBe('read failed');
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('/mnt/media') }));
    expect(stream!.destroyed).toBe(true);
    error.mockRestore();
  });

  it('destroys the stream when the channel closes mid-read', async () => {
    const conn = open();
    const { token } = await sessionOver(conn);
    const res = await conn.client.fetch('/api/test/endless', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    conn.channels.client.close();
    await flush();
    await flush();
    expect(stream!.destroyed).toBe(true);
  });

  it('drops forwarding headers from the peer', async () => {
    const conn = open();
    const { token } = await sessionOver(conn);
    const res = await conn.client.fetch('/api/test/echo', {
      headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': '10.0.0.1', 'X-Forwarded-Proto': 'https', Forwarded: 'for=10.0.0.1', 'X-Other': 'kept' },
    });
    expect(res.status).toBe(204);
    expect(seen).toMatchObject({ 'x-other': 'kept', remote: '203.0.113.7' });
    expect(Object.keys(seen!).filter((k) => k === 'forwarded' || k.startsWith('x-forwarded-'))).toEqual([]);
  });
});

describe('lastRoute', () => {
  it('is https after an HTTPS session and webrtc once the rtc layer notes it', async () => {
    const server = createServer(handlers);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { jwk, sign } = await deviceKey();
      const { code } = auth.createCode({ personId: auth.firstOwnerPerson().id });
      const post = (path: string, body: unknown): Promise<Response> =>
        fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const { deviceId } = (await (await post('/api/pair/redeem', { code, deviceName: 'Mac', publicKeyJwk: jwk })).json()) as { deviceId: string };
      expect(auth.devices()[0]!.lastRoute).toBeUndefined();
      const { challenge } = (await (await post('/api/session/challenge', { deviceId })).json()) as { challenge: string };
      const { token } = (await (await post('/api/session', { deviceId, challenge, signature: await sign(challenge) })).json()) as { token: string };
      expect(auth.devices()[0]!.lastRoute).toBe('https');

      const people = async () =>
        ((await (await fetch(`${base}/api/admin/people`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { people: { devices: { lastRoute?: string }[] }[] })
          .people[0]!.devices[0]!.lastRoute;
      expect(await people()).toBe('https');

      // over a channel the session route leaves the note to onSession
      const conn = open((id) => auth.noteRoute(id, 'webrtc'));
      const over = await sessionOver(conn);
      expect(auth.devices().find((d) => d.id === over.deviceId)!.lastRoute).toBe('webrtc');
      auth.noteRoute(deviceId, 'webrtc');
      expect(await people()).toBe('webrtc');
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});
