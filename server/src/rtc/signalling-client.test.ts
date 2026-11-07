import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { ECDSA_KEY, ECDSA_SIGN, SIGNAL_PING_MESSAGE, SIGNAL_PONG_MESSAGE, fromBase64url, nasIdOf, signalAuthMessage } from '../../../rendezvous/src/protocol';
import type { EcPublicJwk } from '@seikou/nas/nas-api';
import { RendezvousClient } from '../rendezvous-client';
import { backoffDelay, SignallingClient } from './signalling-client';
import type { SignalPeers, WebSocketLike } from './signalling-client';
import { RtcRefused } from './peer';

/** The Worker's end of one socket the NAS opened. */
class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  /** Answer each ping with a pong, as the Worker does. */
  autoPong = false;
  pings = 0;

  constructor(readonly url: string) {}

  send(data: string): void {
    const message = JSON.parse(data) as { t: string };
    if (message.t === 'ping') {
      // the Worker's auto-response matches the bytes exactly; a ping in other bytes would wake it and get no pong
      expect(data).toBe(SIGNAL_PING_MESSAGE);
      this.pings++;
      if (this.autoPong) queueMicrotask(() => this.deliver(SIGNAL_PONG_MESSAGE));
    }
    this.sent.push(message);
  }

  close(): void {
    this.drop(1000, '');
  }

  /** Worker → NAS. */
  deliver(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  drop(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code, reason });
  }
}

let tmp: string;
let sockets: FakeSocket[];
let registrations: EcPublicJwk[];
let rendezvous: RendezvousClient;
let peers: { answer: Mock<SignalPeers['answer']>; candidate: Mock<SignalPeers['candidate']> };
let client: SignallingClient;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'signalling-client-'));
  sockets = [];
  registrations = [];
  const fakeFetch = (async (url: URL | string, init?: RequestInit) => {
    expect(String(url)).toBe('https://rv.example/nas');
    const { publicKeyJwk } = JSON.parse(String(init!.body)) as { publicKeyJwk: EcPublicJwk };
    registrations.push(publicKeyJwk);
    return new Response(JSON.stringify({ nasId: await nasIdOf(publicKeyJwk) }), { status: 200 });
  }) as typeof fetch;
  rendezvous = new RendezvousClient('https://rv.example', join(tmp, 'rendezvous-key.json'), fakeFetch);
  peers = {
    answer: vi.fn<SignalPeers['answer']>(async (_sid, sdp) => ({ answer: `answer to ${sdp}` })),
    candidate: vi.fn<SignalPeers['candidate']>(),
  };
});

afterEach(() => {
  client?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

function start(extra: Partial<ConstructorParameters<typeof SignallingClient>[0]> = {}): SignallingClient {
  client = new SignallingClient({
    url: 'https://rv.example',
    signer: rendezvous,
    peers,
    openSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      queueMicrotask(() => socket.onopen?.());
      return socket;
    },
    backoff: { initialMs: 10, maxMs: 40 },
    log: () => {},
    ...extra,
  });
  client.start();
  return client;
}

/** Sends a challenge on `socket` and checks the NAS's signature over it. */
async function authenticate(socket: FakeSocket): Promise<void> {
  socket.deliver({ t: 'challenge', nonce: 'nonce-1' });
  await vi.waitFor(() => expect(socket.sent.some((m) => (m as { t: string }).t === 'auth')).toBe(true));
  const auth = socket.sent.find((m) => (m as { t: string }).t === 'auth') as { t: string; signature: string };
  expect(socket.sent.filter((m) => (m as { t: string }).t !== 'ping')).toEqual([auth]);
  const jwk = registrations.at(-1)!;
  const key = await crypto.subtle.importKey('jwk', jwk, ECDSA_KEY, false, ['verify']);
  const nasId = await nasIdOf(jwk);
  expect(await crypto.subtle.verify(ECDSA_SIGN, key, fromBase64url(auth.signature)!, signalAuthMessage({ nasId, nonce: 'nonce-1' }))).toBe(true);
  socket.sent.length = 0;
}

describe('SignallingClient', () => {
  it('registers, connects to the NAS socket and answers the challenge with its signature', async () => {
    start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const nasId = await nasIdOf(registrations[0]!);
    expect(sockets[0]!.url).toBe(`wss://rv.example/signal/nas?nasId=${nasId}`);
    await authenticate(sockets[0]!);
  });

  it('routes an offer to answer and a candidate to the peers, and sends the answer back to the sid', async () => {
    start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    await authenticate(socket);
    socket.deliver({ t: 'offer', sid: 'sid-1', sdp: 'v=0 offer' });
    await vi.waitFor(() => expect(socket.sent).toEqual([{ t: 'answer', sid: 'sid-1', sdp: 'answer to v=0 offer' }]));
    expect(peers.answer).toHaveBeenCalledWith('sid-1', 'v=0 offer');
    socket.deliver({ t: 'candidate', sid: 'sid-1', candidate: { candidate: 'candidate:1 1 udp 1 192.0.2.4 5000 typ host', sdpMid: '0' } });
    expect(peers.candidate).toHaveBeenCalledWith('sid-1', { candidate: 'candidate:1 1 udp 1 192.0.2.4 5000 typ host', sdpMid: '0' });
  });

  it('answers a refused offer with its reason', async () => {
    peers.answer.mockRejectedValueOnce(new RtcRefused('busy'));
    peers.answer.mockRejectedValueOnce(new Error('werift fell over'));
    start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    await authenticate(socket);
    socket.deliver({ t: 'offer', sid: 'sid-1', sdp: 'v=0' });
    socket.deliver({ t: 'offer', sid: 'sid-2', sdp: 'v=0' });
    await vi.waitFor(() =>
      expect(socket.sent).toEqual([
        { t: 'answer', sid: 'sid-1', error: 'busy' },
        { t: 'answer', sid: 'sid-2', error: 'failed' },
      ]),
    );
  });

  it('answers a TURN request with no servers while the relay does not exist', async () => {
    start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    await authenticate(socket);
    socket.deliver({ t: 'turn-request', sid: 'sid-1' });
    await vi.waitFor(() => expect(socket.sent).toEqual([{ t: 'turn-response', sid: 'sid-1', iceServers: [], reason: 'off' }]));
  });

  it('ignores malformed messages, messages without a sid and messages over 64 KB, but takes one just over 16 KB', async () => {
    start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    await authenticate(socket);
    socket.deliver('not json');
    socket.deliver({ t: 'offer', sdp: 'no sid' });
    socket.deliver({ t: 'offer', sid: 'sid-1', sdp: 'x'.repeat(70_000) });
    socket.deliver({ t: 'unknown', sid: 'sid-1' });
    const big = 'y'.repeat(16 * 1024 + 30);
    socket.deliver({ t: 'offer', sid: 'sid-2', sdp: big });
    await vi.waitFor(() => expect(peers.answer).toHaveBeenCalledTimes(1));
    expect(peers.answer).toHaveBeenCalledWith('sid-2', big);
    expect(socket.closed).toBe(false);
  });

  it('reconnects after a drop, and answers the new challenge', async () => {
    start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await authenticate(sockets[0]!);
    sockets[0]!.drop(1006, '');
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await authenticate(sockets[1]!);
    expect(registrations).toHaveLength(1);
  });

  it('registers the NAS again before reconnecting after a bad-auth close', async () => {
    start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.deliver({ t: 'challenge', nonce: 'nonce-1' });
    await vi.waitFor(() => expect(sockets[0]!.sent).toHaveLength(1));
    sockets[0]!.drop(1008, 'bad-auth');
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(registrations).toHaveLength(2);
    await authenticate(sockets[1]!);
  });

  it('keeps trying while the rendezvous cannot be reached', async () => {
    let failures = 2;
    const flaky = (async (_url: URL | string, init?: RequestInit) => {
      if (failures-- > 0) throw new TypeError('fetch failed');
      const { publicKeyJwk } = JSON.parse(String(init!.body)) as { publicKeyJwk: EcPublicJwk };
      registrations.push(publicKeyJwk);
      return new Response(JSON.stringify({ nasId: await nasIdOf(publicKeyJwk) }), { status: 200 });
    }) as typeof fetch;
    rendezvous = new RendezvousClient('https://rv.example', join(tmp, 'rendezvous-key.json'), flaky);
    start({ signer: rendezvous });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
  });

  it('pings once authenticated and stays while pongs come back', async () => {
    start({ pingIntervalMs: 20, pongTimeoutMs: 30 });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0]!;
    socket.autoPong = true;
    await authenticate(socket);
    await new Promise((r) => setTimeout(r, 200));
    expect(socket.pings).toBeGreaterThan(4);
    expect(socket.closed).toBe(false);
    expect(sockets).toHaveLength(1);
  });

  it('sends no ping before it has answered the challenge', async () => {
    start({ pingIntervalMs: 10, pongTimeoutMs: 10 });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 60));
    expect(sockets[0]!.sent).toEqual([]);
    expect(sockets).toHaveLength(1);
  });

  it('reconnects when a pong is late', async () => {
    start({ pingIntervalMs: 20, pongTimeoutMs: 30 });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await authenticate(sockets[0]!);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[0]!.pings).toBeGreaterThan(0);
    expect(sockets[0]!.closed).toBe(true);
    await authenticate(sockets[1]!);
  });

  it('reconnects on demand, as when the public address changed', async () => {
    start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await authenticate(sockets[0]!);
    client.reconnect();
    expect(sockets[0]!.closed).toBe(true);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await authenticate(sockets[1]!);
  });

  it('stops for good', async () => {
    start();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    client.stop();
    expect(sockets[0]!.closed).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(sockets).toHaveLength(1);
  });
});

describe('backoffDelay', () => {
  it('doubles from 1 s to 60 s, with jitter', () => {
    const mid = (): number => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffDelay(n, { initialMs: 1000, maxMs: 60_000 }, mid))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
    const low = backoffDelay(3, { initialMs: 1000, maxMs: 60_000 }, () => 0);
    const high = backoffDelay(3, { initialMs: 1000, maxMs: 60_000 }, () => 0.999);
    expect(low).toBeLessThan(8000);
    expect(high).toBeGreaterThan(8000);
    expect(backoffDelay(10, { initialMs: 1000, maxMs: 60_000 }, () => 0.999)).toBeLessThanOrEqual(60_000);
  });
});
