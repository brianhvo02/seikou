/**
 * WebRTC signalling for one NAS (`idFromName(nasId)`): the NAS keeps one authenticated WebSocket here, and
 * devices open theirs to send it SDP offers, ICE candidates and TURN requests (each device first hears its socket's
 * id, `SignalHello`, which it signs into a TURN request). The object forwards those
 * types and nothing else, and limits device connection attempts per NAS; the Worker in `index.ts` limits
 * attempts per client address. Hibernatable WebSockets, with every socket's state in its attachment, so the object
 * can sleep between messages; the NAS's heartbeat (`SIGNAL_PING_MESSAGE` every 25 s) is answered by the runtime's
 * WebSocket auto-response, set up in the constructor, so an idle NAS keeps its socket without waking the object.
 * Only offers, answers, candidates, TURN requests and socket opens and closes wake it.
 */
import { INTERNAL, REGISTRY_NAME } from './code-registry';
import type { RegistryStorage } from './code-registry';
import type { RegistryNamespace } from './index';
import {
  DEVICE_SIGNAL_TYPES,
  ECDSA_KEY,
  ECDSA_SIGN,
  NAS_SIGNAL_TYPES,
  SIGNAL_CLOSE,
  SIGNAL_DEVICES_PER_NAS,
  SIGNAL_DEVICE_LIFETIME_MS,
  SIGNAL_DEVICE_MESSAGES,
  SIGNAL_MAX_MESSAGE_BYTES,
  SIGNAL_PING_MESSAGE,
  SIGNAL_PONG_MESSAGE,
  base64url,
  fromBase64url,
  isNasId,
  signalAuthMessage,
} from './protocol';
import type { DeviceSignalForNas, NasSignalForDevice, SignalChallenge, SignalHello } from './protocol';
import type { EcPublicJwk } from '@seikou/nas/nas-api';

/** The part of a server-side `WebSocket` the object uses. */
export interface SignalSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** A WebSocket auto-response: a message of exactly `request` is answered with `response` without waking the object. */
export interface AutoResponse {
  readonly request: string;
  readonly response: string;
}

/** The part of `DurableObjectState` the object uses: storage for the attempt log and the hibernation API. */
export interface SignallingState {
  readonly storage: Pick<RegistryStorage, 'get' | 'put' | 'delete' | 'getAlarm' | 'setAlarm'>;
  acceptWebSocket(ws: SignalSocket, tags?: string[]): void;
  getWebSockets(tag?: string): SignalSocket[];
  setWebSocketAutoResponse(pair: AutoResponse): void;
}

export interface SignallingEnv {
  CODE_REGISTRY: RegistryNamespace;
}

/** A new socket pair: the server end to accept, and the 101 response that hands the client end out. */
export interface Upgrade {
  server: SignalSocket;
  response: Response;
}

export interface SignallingDeps {
  now(): number;
  upgrade(): Upgrade;
  /** The heartbeat's auto-response pair: the runtime's `WebSocketRequestResponsePair`, or a plain one in Node. */
  pingAutoResponse(): AutoResponse;
}

type Close = (typeof SIGNAL_CLOSE)[keyof typeof SIGNAL_CLOSE];

interface NasAttachment {
  role: 'nas';
  nasId: string;
  /** This socket's id, to tell it from the other NAS sockets. */
  conn: string;
  nonce: string;
  authed: boolean;
  openedAt: number;
  closed: boolean;
}

interface DeviceAttachment {
  role: 'device';
  sid: string;
  openedAt: number;
  /** Messages received so far, against `SIGNAL_DEVICE_MESSAGES`. */
  messages: number;
  closed: boolean;
}

type Attachment = NasAttachment | DeviceAttachment;

const MINUTE = 60_000;
/** A NAS socket that hasn't answered its challenge by then is closed. */
const AUTH_TIMEOUT_MS = 10_000;
/** Device connection attempts per NAS per minute (the NAS's own socket isn't counted, so a flood can't lock it out). */
const DEVICE_ATTEMPTS = { max: 100, windowMs: MINUTE };
const ATTEMPTS_KEY = 'rate:device';
const NAS_TAG = 'nas';
const DEVICE_TAG = 'device';
const sidTag = (sid: string): string => `sid:${sid}`;
const SID = /^[A-Za-z0-9_-]{22}$/;

const deviceTypes: ReadonlySet<string> = new Set(DEVICE_SIGNAL_TYPES);
const nasTypes: ReadonlySet<string> = new Set(NAS_SIGNAL_TYPES);

function randomId(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The Workers runtime's socket pair, declared here because Node's typechecks of this file's importers lack it. */
declare const WebSocketPair: new () => { 0: SignalSocket; 1: SignalSocket };

/** The Workers runtime's auto-response pair (a global there, absent in Node, where tests pass their own). */
declare const WebSocketRequestResponsePair: new (request: string, response: string) => AutoResponse;

function workersPingAutoResponse(): AutoResponse {
  return new WebSocketRequestResponsePair(SIGNAL_PING_MESSAGE, SIGNAL_PONG_MESSAGE);
}

function workersUpgrade(): Upgrade {
  const pair = new WebSocketPair();
  return { server: pair[1], response: new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit) };
}

/** The message as a JSON object, or null when it is binary, larger than allowed, not JSON or not an object. */
function parse(message: string | ArrayBuffer): { value: Record<string, unknown> | null; tooBig: boolean } {
  if (typeof message !== 'string') return { value: null, tooBig: false };
  if (message.length > SIGNAL_MAX_MESSAGE_BYTES || new TextEncoder().encode(message).byteLength > SIGNAL_MAX_MESSAGE_BYTES) {
    return { value: null, tooBig: true };
  }
  try {
    const value = JSON.parse(message) as unknown;
    return { value: typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null, tooBig: false };
  } catch {
    return { value: null, tooBig: false };
  }
}

export class Signalling {
  private readonly deps: SignallingDeps;

  constructor(
    private readonly state: SignallingState,
    private readonly env: SignallingEnv,
    deps?: Partial<SignallingDeps>,
  ) {
    this.deps = { now: deps?.now ?? Date.now, upgrade: deps?.upgrade ?? workersUpgrade, pingAutoResponse: deps?.pingAutoResponse ?? workersPingAutoResponse };
    // the heartbeat never reaches webSocketMessage, so it never wakes a hibernating object
    state.setWebSocketAutoResponse(this.deps.pingAutoResponse());
  }

  /** `GET /signal/nas?nasId=` or `GET /signal/device?nasId=` with `Upgrade: websocket`. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.pathname === '/signal/nas' ? 'nas' : url.pathname === '/signal/device' ? 'device' : null;
    if (role === null) return new Response('not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 });
    const nasId = url.searchParams.get('nasId');
    if (!isNasId(nasId)) return new Response('bad nas id', { status: 400 });

    if (role === 'nas') {
      const { server, response } = this.deps.upgrade();
      const attachment: NasAttachment = { role: 'nas', nasId, conn: randomId(16), nonce: randomId(32), authed: false, openedAt: this.deps.now(), closed: false };
      this.state.acceptWebSocket(server, [NAS_TAG]);
      server.serializeAttachment(attachment);
      const challenge: SignalChallenge = { t: 'challenge', nonce: attachment.nonce };
      server.send(JSON.stringify(challenge));
      await this.armAlarm(attachment.openedAt + AUTH_TIMEOUT_MS);
      return response;
    }

    if (!(await this.allowDevice())) return new Response('too many requests', { status: 429 });
    const open = this.state.getWebSockets(DEVICE_TAG).filter((ws) => attachmentOf(ws)?.closed === false).length;
    const { server, response } = this.deps.upgrade();
    const sid = randomId(16);
    const openedAt = this.deps.now();
    this.state.acceptWebSocket(server, [DEVICE_TAG, sidTag(sid)]);
    server.serializeAttachment({ role: 'device', sid, openedAt, messages: 0, closed: false } satisfies DeviceAttachment);
    if (open >= SIGNAL_DEVICES_PER_NAS) this.shut(server, SIGNAL_CLOSE.busy);
    else if (this.liveNas() === undefined) this.shut(server, SIGNAL_CLOSE.nasOffline);
    else {
      const hello: SignalHello = { t: 'hello', sid };
      server.send(JSON.stringify(hello));
      await this.armAlarm(openedAt + SIGNAL_DEVICE_LIFETIME_MS);
    }
    return response;
  }

  async webSocketMessage(ws: SignalSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = attachmentOf(ws);
    if (attachment === null || attachment.closed) return;
    if (attachment.role === 'device') this.fromDevice(ws, attachment, message);
    else if (attachment.authed) this.fromNas(message);
    else await this.authenticate(ws, attachment, message);
  }

  async webSocketClose(ws: SignalSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.gone(ws);
  }

  async webSocketError(ws: SignalSocket, _error: unknown): Promise<void> {
    this.gone(ws);
  }

  /**
   * Closes NAS sockets that missed the auth deadline and device sockets past their lifetime, and drops the stale
   * attempt log, then wakes for what's left.
   */
  async alarm(): Promise<void> {
    const now = this.deps.now();
    let next = Infinity;
    for (const ws of this.state.getWebSockets(NAS_TAG)) {
      const attachment = attachmentOf(ws);
      if (attachment?.role !== 'nas' || attachment.closed || attachment.authed) continue;
      const deadline = attachment.openedAt + AUTH_TIMEOUT_MS;
      if (deadline <= now) this.shut(ws, SIGNAL_CLOSE.authTimeout);
      else next = Math.min(next, deadline);
    }
    for (const ws of this.state.getWebSockets(DEVICE_TAG)) {
      const attachment = attachmentOf(ws);
      if (attachment?.role !== 'device' || attachment.closed) continue;
      const deadline = attachment.openedAt + SIGNAL_DEVICE_LIFETIME_MS;
      if (deadline <= now) this.shut(ws, SIGNAL_CLOSE.expired);
      else next = Math.min(next, deadline);
    }
    const hits = await this.recentAttempts(now);
    if (hits.length === 0) await this.state.storage.delete(ATTEMPTS_KEY);
    else next = Math.min(next, Math.max(...hits) + DEVICE_ATTEMPTS.windowMs);
    if (next !== Infinity) await this.armAlarm(next);
  }

  private fromDevice(ws: SignalSocket, attachment: DeviceAttachment, message: string | ArrayBuffer): void {
    if (attachment.messages >= SIGNAL_DEVICE_MESSAGES) return this.shut(ws, SIGNAL_CLOSE.tooManyMessages);
    ws.serializeAttachment({ ...attachment, messages: attachment.messages + 1 } satisfies DeviceAttachment);
    const { value, tooBig } = parse(message);
    if (tooBig) return this.shut(ws, SIGNAL_CLOSE.tooBig);
    if (value === null || typeof value.t !== 'string' || !deviceTypes.has(value.t)) return this.shut(ws, SIGNAL_CLOSE.badMessage);
    const nas = this.liveNas();
    if (nas === undefined) return this.shut(ws, SIGNAL_CLOSE.nasOffline);
    const forward = { ...value, sid: attachment.sid } as DeviceSignalForNas;
    trySend(nas, JSON.stringify(forward));
  }

  /**
   * What an authenticated NAS sends: forwarded to the device it names, or dropped. Its heartbeat never gets here (the
   * auto-response answers it).
   */
  private fromNas(message: string | ArrayBuffer): void {
    const { value } = parse(message);
    if (value === null || typeof value.t !== 'string' || !nasTypes.has(value.t) || typeof value.sid !== 'string' || !SID.test(value.sid)) return;
    const device = this.state.getWebSockets(sidTag(value.sid)).find((ws) => attachmentOf(ws)?.closed === false);
    if (device === undefined) return;
    const { sid: _sid, ...rest } = value;
    trySend(device, JSON.stringify(rest as NasSignalForDevice));
  }

  /** The first message on a NAS socket must be `{ t: 'auth', signature }` over this socket's challenge. */
  private async authenticate(ws: SignalSocket, attachment: NasAttachment, message: string | ArrayBuffer): Promise<void> {
    const { value } = parse(message);
    if (value === null || value.t !== 'auth' || typeof value.signature !== 'string') return this.shut(ws, SIGNAL_CLOSE.badMessage);
    let verified: boolean;
    try {
      verified = await this.verify(attachment, value.signature);
    } catch {
      verified = false;
    }
    if (!verified) {
      if (attachmentOf(ws)?.closed === false) this.shut(ws, SIGNAL_CLOSE.badAuth);
      return;
    }
    const current = attachmentOf(ws);
    if (current?.role !== 'nas' || current.closed) return;
    ws.serializeAttachment({ ...current, authed: true } satisfies NasAttachment);
    for (const other of this.state.getWebSockets(NAS_TAG)) {
      const theirs = attachmentOf(other);
      if (theirs?.role === 'nas' && theirs.conn !== attachment.conn && theirs.authed && !theirs.closed) this.shut(other, SIGNAL_CLOSE.replaced);
    }
    // After the replacement, with no await between marking this socket authed and closing the others.
    await this.touch(attachment.nasId);
  }

  private async verify(attachment: NasAttachment, signature: string): Promise<boolean> {
    const sig = fromBase64url(signature);
    if (sig === null || sig.length !== 64) return false;
    const registry = this.env.CODE_REGISTRY;
    const url = `https://registry.internal${INTERNAL.nasKey}?nasId=${encodeURIComponent(attachment.nasId)}`;
    const res = await registry.get(registry.idFromName(REGISTRY_NAME)).fetch(new Request(url));
    if (res.status !== 200) {
      await res.body?.cancel();
      return false;
    }
    const { publicKeyJwk } = (await res.json()) as { publicKeyJwk: EcPublicJwk };
    const key = await crypto.subtle.importKey('jwk', publicKeyJwk, ECDSA_KEY, false, ['verify']);
    return crypto.subtle.verify(ECDSA_SIGN, key, sig, signalAuthMessage({ nasId: attachment.nasId, nonce: attachment.nonce }));
  }

  /** Tells the registry the NAS was seen, so its record doesn't expire while it only signals. */
  private async touch(nasId: string): Promise<void> {
    const registry = this.env.CODE_REGISTRY;
    try {
      const res = await registry
        .get(registry.idFromName(REGISTRY_NAME))
        .fetch(new Request(`https://registry.internal${INTERNAL.nasTouch}?nasId=${encodeURIComponent(nasId)}`, { method: 'POST' }));
      await res.body?.cancel();
    } catch {
      // The record's expiry is 90 days away; the next authentication tries again.
    }
  }

  /** A socket's peer closed it or it failed: marks it closed and, when it was the live NAS, closes the devices. */
  private gone(ws: SignalSocket): void {
    const attachment = attachmentOf(ws);
    if (attachment === null) return;
    if (!attachment.closed) {
      ws.serializeAttachment({ ...attachment, closed: true });
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    if (attachment.role !== 'nas' || !attachment.authed || this.liveNas() !== undefined) return;
    for (const device of this.state.getWebSockets(DEVICE_TAG)) {
      if (attachmentOf(device)?.closed === false) this.shut(device, SIGNAL_CLOSE.nasOffline);
    }
  }

  /** The authenticated NAS socket, if one is open. */
  private liveNas(): SignalSocket | undefined {
    return this.state.getWebSockets(NAS_TAG).find((ws) => {
      const attachment = attachmentOf(ws);
      return attachment?.role === 'nas' && attachment.authed && !attachment.closed;
    });
  }

  /** Closes a socket we're done with, marked first so nothing else treats it as open while its close completes. */
  private shut(ws: SignalSocket, close: Close): void {
    const attachment = attachmentOf(ws);
    if (attachment !== null) ws.serializeAttachment({ ...attachment, closed: true });
    try {
      ws.close(close.code, close.reason);
    } catch {
      // already closed
    }
  }

  private async recentAttempts(now: number): Promise<number[]> {
    return ((await this.state.storage.get<number[]>(ATTEMPTS_KEY)) ?? []).filter((t) => t > now - DEVICE_ATTEMPTS.windowMs);
  }

  /** A sliding-window log of device attempts: records this one unless the window is full. */
  private async allowDevice(): Promise<boolean> {
    const now = this.deps.now();
    const hits = await this.recentAttempts(now);
    if (hits.length >= DEVICE_ATTEMPTS.max) return false;
    hits.push(now);
    await this.state.storage.put(ATTEMPTS_KEY, hits);
    await this.armAlarm(now + DEVICE_ATTEMPTS.windowMs);
    return true;
  }

  /** Moves the alarm earlier, never later. */
  private async armAlarm(time: number): Promise<void> {
    const current = await this.state.storage.getAlarm();
    if (current === null || current > time) await this.state.storage.setAlarm(time);
  }
}

function attachmentOf(ws: SignalSocket): Attachment | null {
  return (ws.deserializeAttachment() as Attachment | null) ?? null;
}

function trySend(ws: SignalSocket, message: string): void {
  try {
    ws.send(message);
  } catch {
    // The socket is closing; its close handler cleans up.
  }
}
