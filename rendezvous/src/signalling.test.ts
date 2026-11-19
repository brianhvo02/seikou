import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeRegistry } from './code-registry';
import type { MemoryStorage } from './memory-state';
import { fireAlarm, memoryState } from './memory-state';
import {
  SIGNAL_MAX_MESSAGE_BYTES,
  SIGNAL_PING_MESSAGE,
  SIGNAL_PONG_MESSAGE,
  SIGNAL_TICKET_MAX_AHEAD_MS,
  base64url,
  encodeTicket,
  signalAuthMessage,
  signalTicketMessage,
  signedMessage,
} from './protocol';
import { Signalling } from './signalling';
import type { AutoResponse, SignalSocket, SignallingState } from './signalling';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A server-side WebSocket stand-in: records what the Durable Object sends and how it closes the socket. */
class FakeSocket implements SignalSocket {
  readonly sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | undefined;
  private attachment: unknown = null;

  send(message: string): void {
    if (this.closed) throw new Error('send after close');
    this.sent.push(message);
  }

  close(code?: number, reason?: string): void {
    this.closed ??= { code, reason };
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  /** The parsed messages sent so far. */
  messages(): Record<string, unknown>[] {
    return this.sent.map((m) => JSON.parse(m) as Record<string, unknown>);
  }
}

/** The hibernation API in memory: accepted sockets stay listed, closed or not, until their peer's close arrives. */
class FakeState implements SignallingState {
  readonly storage: MemoryStorage = memoryState().storage;
  readonly accepted: { ws: FakeSocket; tags: string[] }[] = [];
  /** The auto-response the object set: the runtime answers it without calling the object. */
  autoResponse: AutoResponse | undefined;

  setWebSocketAutoResponse(pair: AutoResponse): void {
    this.autoResponse = { request: pair.request, response: pair.response };
  }

  acceptWebSocket(ws: SignalSocket, tags: string[] = []): void {
    this.accepted.push({ ws: ws as FakeSocket, tags });
  }

  getWebSockets(tag?: string): SignalSocket[] {
    return this.accepted.filter((a) => tag === undefined || a.tags.includes(tag)).map((a) => a.ws);
  }

  remove(ws: FakeSocket): void {
    this.accepted.splice(
      this.accepted.findIndex((a) => a.ws === ws),
      1,
    );
  }
}

let clock: number;
let state: FakeState;
let registry: CodeRegistry;
let signalling: Signalling;
let registryStorage: MemoryStorage;
let env: ConstructorParameters<typeof Signalling>[1];
let deps: ConstructorParameters<typeof Signalling>[2];
let keys: CryptoKeyPair;
let nasId: string;
/** The registry paths the Signalling object called, in order. */
let registryCalls: string[];

beforeEach(async () => {
  clock = 1_800_000_000_000;
  const registryState = memoryState();
  registryStorage = registryState.storage;
  registry = new CodeRegistry(registryState, undefined, () => clock);
  state = new FakeState();
  registryCalls = [];
  env = {
    CODE_REGISTRY: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: (r: Request) => {
          registryCalls.push(new URL(r.url).pathname);
          return registry.fetch(r);
        },
      }),
    },
  };
  deps = {
    now: () => clock,
    upgrade: () => ({ server: new FakeSocket(), response: new Response(null, { status: 200, headers: { 'X-Upgraded': '1' } }) }),
    pingAutoResponse: () => ({ request: SIGNAL_PING_MESSAGE, response: SIGNAL_PONG_MESSAGE }),
  };
  signalling = new Signalling(state, env, deps);
  keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  nasId = await registerNas(keys);
});

async function registerNas(pair: CryptoKeyPair): Promise<string> {
  const { kty, crv, x, y } = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const res = await registry.fetch(new Request('https://rendezvous.example/nas', { method: 'POST', body: JSON.stringify({ publicKeyJwk: { kty, crv, x, y } }) }));
  return ((await res.json()) as { nasId: string }).nasId;
}

async function sign(pair: CryptoKeyPair, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes)));
}

/** Opens a socket on `/signal/<role>`, with `query` added to the URL; the socket is undefined when the upgrade was refused. */
async function open(role: 'nas' | 'device', id = nasId, query: Record<string, string> = {}): Promise<{ res: Response; ws: FakeSocket | undefined }> {
  const before = state.accepted.length;
  const params = new URLSearchParams({ nasId: id, ...query });
  const res = await signalling.fetch(
    new Request(`https://rendezvous.example/signal/${role}?${params}`, { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '203.0.113.7' } }),
  );
  return { res, ws: state.accepted[before]?.ws };
}

/** A ticket signed by `pair` (the NAS's key unless given), for this NAS, valid for a day unless overridden. */
async function ticket(fields: { deviceId: string; nasId?: string; exp?: number }, pair = keys): Promise<string> {
  const body = { nasId: fields.nasId ?? nasId, deviceId: fields.deviceId, exp: fields.exp ?? clock + DAY };
  return encodeTicket({ ...body, signature: await sign(pair, signalTicketMessage(body)) });
}

/** Registers a live code with `codeHash` for this NAS, signed by its key. */
async function registerCode(codeHash: string): Promise<void> {
  const fields = { nasId, codeHash, routes: {}, expiresAt: clock + 10 * MINUTE };
  const res = await registry.fetch(
    new Request('https://rendezvous.example/codes', { method: 'POST', body: JSON.stringify({ ...fields, signature: await sign(keys, signedMessage(fields)) }) }),
  );
  expect(res.status).toBe(204);
}

/** The attempts recorded under a window key. */
async function hits(key: string): Promise<number> {
  return ((await state.storage.get<number[]>(key)) ?? []).length;
}

async function nasSocket(pair = keys): Promise<FakeSocket> {
  const { ws } = await open('nas');
  const challenge = ws!.messages()[0]!;
  expect(challenge.t).toBe('challenge');
  expect(challenge.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const signature = await sign(pair, signalAuthMessage({ nasId, nonce: challenge.nonce as string }));
  await signalling.webSocketMessage(ws!, JSON.stringify({ t: 'auth', signature }));
  return ws!;
}

/** An accepted device socket, its `hello` (which names its sid) checked and cleared; a refused one as it is. */
async function deviceSocket(query: Record<string, string> = {}): Promise<FakeSocket> {
  const { res, ws } = await open('device', nasId, query);
  expect(res.headers.get('X-Upgraded')).toBe('1');
  if (ws!.closed === undefined) {
    const [hello] = ws!.messages();
    expect(hello).toEqual({ t: 'hello', sid: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) });
    ws!.sent.length = 0;
  }
  return ws!;
}

/**
 * A message arrives as the runtime delivers it: one that matches the auto-response byte for byte is answered by the
 * runtime and never reaches the object; anything else goes to `webSocketMessage`.
 */
async function receive(ws: FakeSocket, message: string): Promise<void> {
  if (state.autoResponse !== undefined && message === state.autoResponse.request) ws.send(state.autoResponse.response);
  else await signalling.webSocketMessage(ws, message);
}

/** The peer's close frame arrives: the runtime calls the handler, then forgets the socket. */
async function peerCloses(ws: FakeSocket): Promise<void> {
  await signalling.webSocketClose(ws, 1000, '', true);
  state.remove(ws);
}

describe('NAS socket', () => {
  it('authenticates with a signature over the challenge', async () => {
    const nas = await nasSocket();
    expect(nas.closed).toBeUndefined();
    const device = await deviceSocket();
    expect(device.closed).toBeUndefined();
  });

  it('closes on a bad signature', async () => {
    const nas = await nasSocket(await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair);
    expect(nas.closed).toEqual({ code: 1008, reason: 'bad-auth' });
    expect((await deviceSocket()).closed).toEqual({ code: 4404, reason: 'nas-offline' });
  });

  it('closes on a code-registration signature replayed as auth', async () => {
    const { ws } = await open('nas');
    const registration = { nasId, codeHash: '0'.repeat(64), routes: {}, expiresAt: clock + 10 * MINUTE };
    await signalling.webSocketMessage(ws!, JSON.stringify({ t: 'auth', signature: await sign(keys, signedMessage(registration)) }));
    expect(ws!.closed).toEqual({ code: 1008, reason: 'bad-auth' });
  });

  it('closes on a signature over another challenge', async () => {
    const { ws } = await open('nas');
    const signature = await sign(keys, signalAuthMessage({ nasId, nonce: 'A'.repeat(43) }));
    await signalling.webSocketMessage(ws!, JSON.stringify({ t: 'auth', signature }));
    expect(ws!.closed).toEqual({ code: 1008, reason: 'bad-auth' });
  });

  it('closes on a NAS id the registry does not know', async () => {
    const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const { ws } = await open('nas', 'B'.repeat(43));
    const nonce = ws!.messages()[0]!.nonce as string;
    await signalling.webSocketMessage(ws!, JSON.stringify({ t: 'auth', signature: await sign(other, signalAuthMessage({ nasId: 'B'.repeat(43), nonce })) }));
    expect(ws!.closed).toEqual({ code: 1008, reason: 'bad-auth' });
  });

  it('closes on anything but auth before it authenticates', async () => {
    const { ws } = await open('nas');
    await signalling.webSocketMessage(ws!, JSON.stringify({ t: 'answer', sid: 'x' }));
    expect(ws!.closed).toEqual({ code: 1008, reason: 'bad-message' });
  });

  it('closes a socket that has not authenticated within 10 s', async () => {
    const { ws } = await open('nas');
    expect(state.storage.alarm).toBe(clock + 10_000);
    clock += 10_000;
    state.storage.alarm = null;
    await signalling.alarm();
    expect(ws!.closed).toEqual({ code: 1008, reason: 'auth-timeout' });
  });

  it('replaces the old NAS socket with a new one, and devices stay', async () => {
    const first = await nasSocket();
    const device = await deviceSocket();
    const second = await nasSocket();
    expect(first.closed).toEqual({ code: 4409, reason: 'replaced' });
    await peerCloses(first);
    expect(device.closed).toBeUndefined();
    await signalling.webSocketMessage(device, JSON.stringify({ t: 'offer', sdp: 'v=0' }));
    expect(second.messages().at(-1)).toMatchObject({ t: 'offer', sdp: 'v=0' });
    expect(first.messages().filter((m) => m.t === 'offer')).toEqual([]);
  });

  it('closes with bad-auth when the key lookup throws', async () => {
    const { ws } = await open('nas');
    const nonce = ws!.messages()[0]!.nonce as string;
    const signature = await sign(keys, signalAuthMessage({ nasId, nonce }));
    registry.fetch = () => Promise.reject(new Error('registry down'));
    await signalling.webSocketMessage(ws!, JSON.stringify({ t: 'auth', signature }));
    expect(ws!.closed).toEqual({ code: 1008, reason: 'bad-auth' });
  });

  it('keeps a NAS that only signals registered past 90 days', async () => {
    const nasKeyStatus = async (): Promise<number> =>
      (await registry.fetch(new Request(`https://registry.internal/internal/nas-key?nasId=${nasId}`))).status;
    for (let i = 0; i < 3; i++) {
      clock += 80 * DAY;
      await nasSocket();
      await fireAlarm(registryStorage, registry);
      expect(await nasKeyStatus()).toBe(200);
    }
    // Without a signal, it expires 90 days after the last one.
    clock += 90 * DAY;
    await fireAlarm(registryStorage, registry);
    expect(await nasKeyStatus()).toBe(404);
  });

  it('keeps working after the object is evicted and rebuilt over the same sockets', async () => {
    const nas = await nasSocket();
    const device = await deviceSocket();
    signalling = new Signalling(state, env, deps);
    await signalling.webSocketMessage(device, JSON.stringify({ t: 'offer', sdp: 'v=0' }));
    const offer = nas.messages().at(-1)!;
    expect(offer).toMatchObject({ t: 'offer', sdp: 'v=0' });
    await signalling.webSocketMessage(nas, JSON.stringify({ t: 'answer', sid: offer.sid, sdp: 'v=0 answer' }));
    expect(device.messages()).toEqual([{ t: 'answer', sdp: 'v=0 answer' }]);
  });

  it('closes the devices with 4404 when the NAS socket goes', async () => {
    const nas = await nasSocket();
    const device = await deviceSocket();
    await peerCloses(nas);
    expect(device.closed).toEqual({ code: 4404, reason: 'nas-offline' });
  });
});

describe('device socket', () => {
  it('is closed with 4404 nas-offline while no NAS socket is live', async () => {
    expect((await deviceSocket()).closed).toEqual({ code: 4404, reason: 'nas-offline' });
    await open('nas');
    // A NAS socket that hasn't authenticated doesn't count.
    expect((await deviceSocket()).closed).toEqual({ code: 4404, reason: 'nas-offline' });
  });

  it('forwards an offer to the NAS with the sid, and the answer back to that device without it', async () => {
    const nas = await nasSocket();
    const a = await deviceSocket();
    const b = await deviceSocket();
    await signalling.webSocketMessage(a, JSON.stringify({ t: 'offer', sdp: 'v=0 a', sid: 'forged' }));
    await signalling.webSocketMessage(b, JSON.stringify({ t: 'offer', sdp: 'v=0 b' }));
    const [offerA, offerB] = nas.messages().slice(-2);
    expect(offerA).toMatchObject({ t: 'offer', sdp: 'v=0 a' });
    expect(offerA!.sid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(offerA!.sid).not.toBe('forged');
    expect(offerB!.sid).not.toBe(offerA!.sid);

    await signalling.webSocketMessage(nas, JSON.stringify({ t: 'answer', sid: offerA!.sid, sdp: 'v=0 answer' }));
    await signalling.webSocketMessage(nas, JSON.stringify({ t: 'candidate', sid: offerB!.sid, candidate: 'c' }));
    expect(a.messages()).toEqual([{ t: 'answer', sdp: 'v=0 answer' }]);
    expect(b.messages()).toEqual([{ t: 'candidate', candidate: 'c' }]);
  });

  it('tells an accepted device its sid, the one its messages reach the NAS with; a refused one hears nothing', async () => {
    const nas = await nasSocket();
    const { ws } = await open('device');
    const [hello] = ws!.messages();
    expect(hello!.t).toBe('hello');
    await signalling.webSocketMessage(ws!, JSON.stringify({ t: 'turn-request', inviteHash: 'h' }));
    expect(nas.messages().at(-1)).toEqual({ t: 'turn-request', inviteHash: 'h', sid: hello!.sid });
    await peerCloses(nas);
    const refused = await open('device');
    expect(refused.ws!.sent).toEqual([]);
  });

  it('forwards candidates and TURN requests both ways', async () => {
    const nas = await nasSocket();
    const device = await deviceSocket();
    await signalling.webSocketMessage(device, JSON.stringify({ t: 'candidate', candidate: 'c' }));
    await signalling.webSocketMessage(device, JSON.stringify({ t: 'turn-request', deviceId: 'd' }));
    const sid = nas.messages().at(-1)!.sid;
    expect(nas.messages().slice(-2).map((m) => m.t)).toEqual(['candidate', 'turn-request']);
    await signalling.webSocketMessage(nas, JSON.stringify({ t: 'turn-response', sid, iceServers: [] }));
    expect(device.messages()).toEqual([{ t: 'turn-response', iceServers: [] }]);
  });

  it('closes a device that sends an unknown type, non-JSON or binary', async () => {
    const nas = await nasSocket();
    for (const message of [JSON.stringify({ t: 'answer', sdp: 'x' }), JSON.stringify({ t: 'auth' }), '{', '[]', new ArrayBuffer(4)]) {
      const device = await deviceSocket();
      await signalling.webSocketMessage(device, message);
      expect(device.closed).toEqual({ code: 1008, reason: 'bad-message' });
    }
    expect(nas.messages().map((m) => m.t)).toEqual(['challenge']);
  });

  it('rejects a message of 16 KB + 1 and forwards one of 16 KB', async () => {
    const nas = await nasSocket();
    const device = await deviceSocket();
    const frame = (size: number): string => {
      const head = JSON.stringify({ t: 'offer', sdp: '' });
      return JSON.stringify({ t: 'offer', sdp: 'x'.repeat(size - head.length) });
    };
    expect(new TextEncoder().encode(frame(SIGNAL_MAX_MESSAGE_BYTES)).byteLength).toBe(16_384);
    await signalling.webSocketMessage(device, frame(SIGNAL_MAX_MESSAGE_BYTES));
    expect(device.closed).toBeUndefined();
    expect(nas.messages().at(-1)!.t).toBe('offer');
    await signalling.webSocketMessage(device, frame(SIGNAL_MAX_MESSAGE_BYTES + 1));
    expect(device.closed).toEqual({ code: 1009, reason: 'too-big' });
    expect(nas.messages().filter((m) => m.t === 'offer')).toHaveLength(1);
  });

  it("answers the NAS's ping with the runtime's auto-response, so a heartbeat never wakes the object", async () => {
    expect(state.autoResponse).toEqual({ request: '{"t":"ping"}', response: '{"t":"pong"}' });
    const nas = await nasSocket();
    const device = await deviceSocket();
    nas.sent.length = 0;
    const woken = vi.spyOn(signalling, 'webSocketMessage');
    for (let i = 0; i < 100; i++) await receive(nas, SIGNAL_PING_MESSAGE);
    expect(woken).not.toHaveBeenCalled();
    expect(nas.messages()).toEqual(Array.from({ length: 100 }, () => ({ t: 'pong' })));
    expect(nas.closed).toBeUndefined();
    expect(device.sent).toEqual([]);
  });

  it('handles a ping in other bytes as any other message: dropped from the NAS, a bad message from a device', async () => {
    const nas = await nasSocket();
    const device = await deviceSocket();
    nas.sent.length = 0;
    await receive(nas, '{ "t": "ping" }');
    expect(nas.sent).toEqual([]);
    expect(nas.closed).toBeUndefined();
    await receive(device, '{ "t": "ping" }');
    expect(device.sent).toEqual([]);
    expect(device.closed).toMatchObject({ code: 1008, reason: 'bad-message' });
    expect(nas.sent).toEqual([]);
  });

  it('gives any socket a pong for the exact ping (it carries nothing), without counting or forwarding it', async () => {
    const { ws } = await open('nas');
    await receive(ws!, SIGNAL_PING_MESSAGE);
    expect(ws!.messages().map((m) => m.t)).toEqual(['challenge', 'pong']);
    expect(ws!.closed).toBeUndefined();
    const nas = await nasSocket();
    nas.sent.length = 0;
    const device = await deviceSocket();
    await receive(device, SIGNAL_PING_MESSAGE);
    expect(device.messages()).toEqual([{ t: 'pong' }]);
    expect(device.closed).toBeUndefined();
    expect(nas.sent).toEqual([]);
  });

  it('drops what the NAS sends of an unknown type, too big, to an unknown sid or without one', async () => {
    const nas = await nasSocket();
    const device = await deviceSocket();
    await signalling.webSocketMessage(device, JSON.stringify({ t: 'offer', sdp: 'v=0' }));
    const sid = nas.messages().at(-1)!.sid as string;
    for (const message of [
      JSON.stringify({ t: 'offer', sid }),
      JSON.stringify({ t: 'answer' }),
      JSON.stringify({ t: 'answer', sid: 'nobody' }),
      JSON.stringify({ t: 'answer', sid, sdp: 'x'.repeat(SIGNAL_MAX_MESSAGE_BYTES) }),
      '{',
      new ArrayBuffer(4),
    ]) {
      await signalling.webSocketMessage(nas, message);
    }
    expect(nas.closed).toBeUndefined();
    expect(device.sent).toEqual([]);
  });

  it('allows 30 device connection attempts per minute per NAS; the NAS itself still connects', async () => {
    await nasSocket();
    for (let i = 0; i < 30; i++) expect((await open('device')).res.status).toBe(200);
    const limited = await open('device');
    expect(limited.res.status).toBe(429);
    expect(limited.ws).toBeUndefined();
    expect((await nasSocket()).closed).toBeUndefined();
    clock += MINUTE;
    expect((await open('device')).res.status).toBe(200);
  });

  it('closes a device socket 60 s after it opens', async () => {
    await nasSocket();
    const early = await deviceSocket();
    clock += 30_000;
    const late = await deviceSocket();
    // The NAS's auth deadline (10 s) has passed; the alarm now waits for the first device's lifetime.
    state.storage.alarm = null;
    await signalling.alarm();
    expect(state.storage.alarm).toBe(clock + 30_000);
    clock += 30_000;
    state.storage.alarm = null;
    await signalling.alarm();
    expect(early.closed).toEqual({ code: 4408, reason: 'expired' });
    expect(late.closed).toBeUndefined();
    expect(state.storage.alarm).toBe(clock + 30_000);
    clock += 30_000;
    state.storage.alarm = null;
    await signalling.alarm();
    expect(late.closed).toEqual({ code: 4408, reason: 'expired' });
  });

  it('forwards 64 messages from a device and closes it on the 65th', async () => {
    const nas = await nasSocket();
    const device = await deviceSocket();
    for (let i = 0; i < 64; i++) await signalling.webSocketMessage(device, JSON.stringify({ t: 'candidate', candidate: `c${i}` }));
    expect(device.closed).toBeUndefined();
    await signalling.webSocketMessage(device, JSON.stringify({ t: 'candidate', candidate: 'c64' }));
    expect(device.closed).toEqual({ code: 1008, reason: 'too-many-messages' });
    expect(nas.messages().filter((m) => m.t === 'candidate')).toHaveLength(64);
  });

  it('refuses a 33rd open device socket with 4429 busy, and takes one again once a place frees', async () => {
    await nasSocket();
    // Ticketed, so the 34 attempts fit the allowances (one device's window of 10, the shared one of 30).
    const device = async (i: number): Promise<FakeSocket> => deviceSocket({ ticket: await ticket({ deviceId: `device-${i}` }) });
    const devices: FakeSocket[] = [];
    for (let i = 0; i < 32; i++) devices.push(await device(i));
    expect(devices.every((d) => d.closed === undefined)).toBe(true);
    expect((await device(32)).closed).toEqual({ code: 4429, reason: 'busy' });
    await peerCloses(devices[0]!);
    expect((await device(33)).closed).toBeUndefined();
  });

  it('deletes the stale attempt log in the alarm', async () => {
    await open('device');
    expect(state.storage.data.size).toBe(1);
    clock += MINUTE;
    state.storage.alarm = null;
    await signalling.alarm();
    expect(state.storage.data.size).toBe(0);
    expect(state.storage.alarm).toBeNull();
  });

  it('refuses requests that are not WebSocket upgrades, or for another path', async () => {
    expect((await signalling.fetch(new Request(`https://rendezvous.example/signal/device?nasId=${nasId}`))).status).toBe(426);
    expect((await signalling.fetch(new Request(`https://rendezvous.example/elsewhere?nasId=${nasId}`, { headers: { Upgrade: 'websocket' } }))).status).toBe(404);
    expect((await signalling.fetch(new Request('https://rendezvous.example/signal/device?nasId=x', { headers: { Upgrade: 'websocket' } }))).status).toBe(400);
  });
});

describe('device allowances', () => {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);

  it('a valid ticket connects while the shared window is full', async () => {
    await nasSocket();
    for (let i = 0; i < 30; i++) expect((await open('device')).res.status).toBe(200);
    expect((await open('device')).res.status).toBe(429);
    const ticketed = await open('device', nasId, { ticket: await ticket({ deviceId: 'device-a' }) });
    expect(ticketed.res.status).toBe(200);
    expect(ticketed.ws!.closed).toBeUndefined();
    expect(await hits('rate:device')).toBe(30);
    expect(await hits('rate:ticket:device-a')).toBe(1);
  });

  it('a ticketed device gets 10 a minute', async () => {
    await nasSocket();
    const mine = await ticket({ deviceId: 'device-a' });
    for (let i = 0; i < 10; i++) expect((await open('device', nasId, { ticket: mine })).res.status).toBe(200);
    expect((await open('device', nasId, { ticket: mine })).res.status).toBe(429);
    expect((await open('device', nasId, { ticket: await ticket({ deviceId: 'device-b' }) })).res.status).toBe(200);
    expect(await hits('rate:device')).toBe(0);
    expect(registryCalls).not.toContain('/internal/signal-attempt');
    clock += MINUTE;
    expect((await open('device', nasId, { ticket: mine })).res.status).toBe(200);
  });

  it('keeps the NAS key in memory for 10 minutes', async () => {
    const mine = await ticket({ deviceId: 'device-a', exp: clock + 30 * DAY });
    await open('device', nasId, { ticket: mine });
    await open('device', nasId, { ticket: mine });
    expect(registryCalls.filter((p) => p === '/internal/nas-key')).toHaveLength(1);
    clock += 10 * MINUTE;
    await open('device', nasId, { ticket: mine });
    expect(registryCalls.filter((p) => p === '/internal/nas-key')).toHaveLength(2);
  });

  it('a ticket for another NAS, an expired one, one too far ahead, or a forged one counts as shared and per address', async () => {
    await nasSocket();
    const other = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const otherId = await registerNas(other);
    const bad = [
      await ticket({ deviceId: 'device-a', nasId: otherId }, other),
      await ticket({ deviceId: 'device-a', nasId: otherId }),
      await ticket({ deviceId: 'device-a', exp: clock }),
      await ticket({ deviceId: 'device-a', exp: clock + SIGNAL_TICKET_MAX_AHEAD_MS + 1 }),
      await ticket({ deviceId: 'device-a' }, other),
      'not-a-ticket',
    ];
    for (const [i, t] of bad.entries()) {
      registryCalls.length = 0;
      expect((await open('device', nasId, { ticket: t })).res.status).toBe(200);
      expect(registryCalls.filter((p) => p === '/internal/signal-attempt')).toHaveLength(1);
      expect(await hits('rate:device')).toBe(i + 1);
    }
    expect(await hits('rate:ticket:device-a')).toBe(0);
  });

  it('a failed proof is refused when the address has used its unproven attempts', async () => {
    await nasSocket();
    const forged = await ticket({ deviceId: 'device-a' }, (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair);
    for (let i = 0; i < 10; i++) expect((await open('device', nasId, { ticket: forged })).res.status).toBe(200);
    expect((await open('device', nasId, { ticket: forged })).res.status).toBe(429);
    expect(await hits('rate:device')).toBe(10);
  });

  it('a live code hash gets its own window; an unknown one shares the pool', async () => {
    await nasSocket();
    await registerCode(HASH_A);
    for (let i = 0; i < 10; i++) expect((await open('device', nasId, { codeHash: HASH_A })).res.status).toBe(200);
    expect((await open('device', nasId, { codeHash: HASH_A })).res.status).toBe(429);
    expect(await hits(`rate:code:${HASH_A}`)).toBe(10);
    expect(await hits('rate:device')).toBe(0);
    registryCalls.length = 0;
    expect((await open('device', nasId, { codeHash: HASH_B })).res.status).toBe(200);
    expect(registryCalls).toContain('/internal/signal-attempt');
    expect(await hits(`rate:code:${HASH_B}`)).toBe(0);
    expect(await hits('rate:device')).toBe(1);
  });

  it('ticket and codeHash together: only the ticket\'s window is counted when it checks out, only the code\'s when the ticket fails', async () => {
    await nasSocket();
    await registerCode(HASH_A);
    expect((await open('device', nasId, { ticket: await ticket({ deviceId: 'device-a' }), codeHash: HASH_A })).res.status).toBe(200);
    expect(await hits('rate:ticket:device-a')).toBe(1);
    expect(await hits(`rate:code:${HASH_A}`)).toBe(0);
    registryCalls.length = 0;
    expect((await open('device', nasId, { ticket: await ticket({ deviceId: 'device-a', exp: clock }), codeHash: HASH_A })).res.status).toBe(200);
    expect(await hits('rate:ticket:device-a')).toBe(1);
    expect(await hits(`rate:code:${HASH_A}`)).toBe(1);
    expect(await hits('rate:device')).toBe(0);
    expect(registryCalls).not.toContain('/internal/signal-attempt');
    // Both fail: one address count, one shared slot.
    registryCalls.length = 0;
    expect((await open('device', nasId, { ticket: 'not-a-ticket', codeHash: HASH_B })).res.status).toBe(200);
    expect(registryCalls.filter((p) => p === '/internal/signal-attempt')).toHaveLength(1);
    expect(await hits('rate:device')).toBe(1);
  });

  it('deletes stale ticket and code windows in the alarm', async () => {
    await registerCode(HASH_A);
    await open('device', nasId, { ticket: await ticket({ deviceId: 'device-a' }) });
    await open('device', nasId, { codeHash: HASH_A });
    expect(await hits('rate:ticket:device-a')).toBe(1);
    expect(await hits(`rate:code:${HASH_A}`)).toBe(1);
    clock += MINUTE;
    state.storage.alarm = null;
    await signalling.alarm();
    expect(state.storage.data.size).toBe(0);
    expect(state.storage.alarm).toBeNull();
  });
});
