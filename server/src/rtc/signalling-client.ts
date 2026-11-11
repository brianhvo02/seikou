import { SIGNAL_PING_INTERVAL_MS, SIGNAL_PING_MESSAGE, SIGNAL_PONG_TIMEOUT_MS, signalAuthMessage } from '../../../rendezvous/src/protocol';
import { RtcRefused } from './peer';

/** The part of a WebSocket the client uses; Node's global `WebSocket` by default. */
export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** What the client needs of `RendezvousClient`: the NAS's id, registered (again) on demand, and its signature. */
export interface NasSigner {
  ensureRegistered(): Promise<string>;
  reregister(): Promise<string>;
  sign(message: Uint8Array<ArrayBuffer>): Promise<string>;
}

/** Where offers and candidates go (`RtcPeers`). */
export interface SignalPeers {
  answer(sid: string, offer: string): Promise<{ answer: string }>;
  candidate(sid: string, candidate: unknown): void;
}

/** The reconnect wait: it starts at `initialMs` and doubles to `maxMs`. */
export interface Backoff {
  /** The first wait, in milliseconds. */
  initialMs: number;
  /** The longest wait, in milliseconds. */
  maxMs: number;
}

/** What `SignallingClient` needs: the Worker's address, the NAS's signing key and where offers go. */
export interface SignallingOptions {
  /** `RENDEZVOUS_URL`. */
  url: string;
  /** Registers the NAS and signs the socket's authentication. */
  signer: NasSigner;
  /** Receives each device's offers and candidates. */
  peers: SignalPeers;
  /** Answers a device's `turn-request` (the relay); until there is one, no servers with reason `off`. */
  onTurnRequest?: (sid: string, request: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Opens the socket; Node's global `WebSocket` by default (tests inject one). */
  openSocket?: (url: string) => WebSocketLike;
  /** Reconnect waits; 1 s doubling to 60 s by default. */
  backoff?: Backoff;
  /** The heartbeat: a ping this often once authenticated, and a reconnect when its pong is this late. */
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  /** A number in [0, 1) for the backoff's jitter; `Math.random` by default. */
  random?: () => number;
  /** The clock in milliseconds since the epoch. */
  now?: () => number;
  /** Receives a line (and the error, if any) for each connection problem. */
  log?: (message: string, err?: unknown) => void;
}

/**
 * The largest message the NAS takes from the Worker. Devices may send 16 KB, and the Worker adds their `sid`, so
 * the NAS must take a little more than 16 KB; anything this large is not signalling.
 */
const MAX_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_BACKOFF: Backoff = { initialMs: 1_000, maxMs: 60_000 };
const SID = /^[A-Za-z0-9_-]{1,64}$/;

/** The wait before reconnect attempt `attempt` (0-based): `initialMs` doubling to `maxMs`, ±25 % jitter, at most `maxMs`. */
export function backoffDelay(attempt: number, backoff: Backoff, random: () => number): number {
  const base = Math.min(backoff.maxMs, backoff.initialMs * 2 ** Math.min(attempt, 30));
  return Math.min(backoff.maxMs, Math.round(base * (0.75 + random() * 0.5)));
}

/** The NAS's signalling socket URL: `<RENDEZVOUS_URL>/signal/nas?nasId=` on ws(s). */
function socketUrl(base: string, nasId: string): string {
  const url = new URL('signal/nas', base.endsWith('/') ? base : `${base}/`);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.searchParams.set('nasId', nasId);
  return url.toString();
}

/**
 * The NAS's end of WebRTC signalling: one WebSocket to its Durable Object on the rendezvous Worker. It answers the
 * Worker's challenge with the NAS key's signature, hands `offer` and `candidate` messages to the peers and sends
 * their answers back to the device's `sid`, and reconnects with backoff (1 s doubling to 60 s, with jitter). After a
 * `bad-auth` close it registers the NAS's key again first, as the Worker may have lost it. Once authenticated it
 * pings the Worker every 25 s (exactly `SIGNAL_PING_MESSAGE`, which the Worker's auto-response answers without waking
 * its Durable Object) and reconnects when a pong is 10 s late, so a socket that died silently (a NAT
 * mapping gone, a changed public address) doesn't leave the NAS unreachable; `reconnect()` forces one.
 */
export class SignallingClient {
  private socket: WebSocketLike | null = null;
  private timer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private stopped = true;
  private attempt = 0;
  private reregisterNext = false;
  private readonly backoff: Backoff;
  private readonly now: () => number;

  constructor(private readonly opts: SignallingOptions) {
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.now = opts.now ?? Date.now;
  }

  /** Connects to the Worker and keeps the socket up until `stop`; does nothing when already started. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  /** Closes the socket and stops reconnecting. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.drop(1000, 'stopping');
  }

  /** Drops the socket now and connects again (after the backoff), as when the public address changed. */
  reconnect(): void {
    if (this.stopped || this.socket === null) return;
    this.drop(4000, 'reconnecting');
    this.retry();
  }

  /** Forgets the current socket, so its late events are ignored, and closes it. */
  private drop(code: number, reason: string): void {
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(code, reason);
    } catch {
      // already closed
    }
  }

  private startHeartbeat(socket: WebSocketLike): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.socket !== socket) return;
      this.sendRaw(socket, SIGNAL_PING_MESSAGE); // exactly these bytes, which the Worker's auto-response answers
      if (this.pongTimer !== undefined) return; // the earlier ping's deadline still runs
      this.pongTimer = setTimeout(() => {
        if (this.socket !== socket) return;
        this.log('signalling: no pong from the rendezvous; reconnecting');
        this.drop(4000, 'no-pong');
        this.retry();
      }, this.opts.pongTimeoutMs ?? SIGNAL_PONG_TIMEOUT_MS);
      this.pongTimer.unref();
    }, this.opts.pingIntervalMs ?? SIGNAL_PING_INTERVAL_MS);
    this.pingTimer.unref();
  }

  private stopHeartbeat(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.pingTimer = undefined;
    this.pongTimer = undefined;
  }

  private log(message: string, err?: unknown): void {
    (this.opts.log ?? ((m: string, e?: unknown) => (e === undefined ? console.log(m) : console.error(m, e))))(message, err);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let nasId: string;
    try {
      nasId = this.reregisterNext ? await this.opts.signer.reregister() : await this.opts.signer.ensureRegistered();
      this.reregisterNext = false;
    } catch (err) {
      this.log('signalling: registering with the rendezvous failed', err);
      return this.retry();
    }
    if (this.stopped) return;
    let socket: WebSocketLike;
    try {
      socket = (this.opts.openSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike))(socketUrl(this.opts.url, nasId));
    } catch (err) {
      this.log('signalling: opening the socket failed', err);
      return this.retry();
    }
    this.socket = socket;
    const openedAt = this.now();
    socket.onmessage = (event) => {
      if (this.socket === socket) void this.message(socket, nasId, event.data);
    };
    socket.onerror = () => {}; // a close follows
    socket.onclose = ({ code, reason }) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopHeartbeat();
      // A socket that stayed up a while was a good connection: the next drop starts the backoff over.
      if (this.now() - openedAt >= this.backoff.maxMs) this.attempt = 0;
      if (reason === 'bad-auth') this.reregisterNext = true;
      this.log(`signalling: socket closed (${code}${reason ? ` ${reason}` : ''})`);
      // Another process with this NAS's key took over: wait the longest before taking it back.
      this.retry(reason === 'replaced' ? this.backoff.maxMs : undefined);
    };
  }

  private retry(delayMs?: number): void {
    if (this.stopped) return;
    const delay = delayMs ?? backoffDelay(this.attempt++, this.backoff, this.opts.random ?? Math.random);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), delay);
    this.timer.unref();
  }

  private send(socket: WebSocketLike, message: Record<string, unknown>): void {
    this.sendRaw(socket, JSON.stringify(message));
  }

  private sendRaw(socket: WebSocketLike, data: string): void {
    if (this.socket !== socket) return;
    try {
      socket.send(data);
    } catch {
      // closing; its close handler reconnects
    }
  }

  private async message(socket: WebSocketLike, nasId: string, data: unknown): Promise<void> {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE_BYTES || Buffer.byteLength(data) > MAX_MESSAGE_BYTES) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return;
    const m = msg as Record<string, unknown>;
    if (m.t === 'challenge') {
      if (typeof m.nonce !== 'string') return;
      try {
        const signature = await this.opts.signer.sign(signalAuthMessage({ nasId, nonce: m.nonce }));
        this.send(socket, { t: 'auth', signature });
        if (this.socket === socket) this.startHeartbeat(socket);
      } catch (err) {
        this.log('signalling: signing the challenge failed', err);
        socket.close();
      }
      return;
    }
    if (m.t === 'pong') {
      if (this.socket === socket) {
        clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
      }
      return;
    }
    const sid = m.sid;
    if (typeof sid !== 'string' || !SID.test(sid)) return;
    if (m.t === 'offer') {
      if (typeof m.sdp !== 'string') return;
      try {
        const { answer } = await this.opts.peers.answer(sid, m.sdp);
        this.send(socket, { t: 'answer', sid, sdp: answer });
      } catch (err) {
        if (!(err instanceof RtcRefused)) this.log('signalling: answering an offer failed', err);
        this.send(socket, { t: 'answer', sid, error: err instanceof RtcRefused ? err.reason : 'failed' });
      }
    } else if (m.t === 'candidate') {
      this.opts.peers.candidate(sid, m.candidate);
    } else if (m.t === 'turn-request') {
      let response: Record<string, unknown>;
      try {
        response = this.opts.onTurnRequest ? await this.opts.onTurnRequest(sid, m) : { iceServers: [], reason: 'off' };
      } catch (err) {
        this.log('signalling: answering a TURN request failed', err);
        response = { iceServers: [], reason: 'off' };
      }
      this.send(socket, { ...response, t: 'turn-response', sid });
    }
  }
}
