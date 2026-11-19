import type { DeviceSignal, NasSignalForDevice, NasSignalType } from '../../../../rendezvous/src/protocol';

/** The signalling socket closed (or never opened): `code` is the WebSocket close code, e.g. 4404 when the NAS is offline. */
export class SignallingClosed extends Error {
  constructor(readonly code: number) {
    super(`Signalling closed (${code}).`);
  }
}

/** No answer within the time allowed. */
export class SignallingTimeout extends Error {
  constructor(what: string) {
    super(`No ${what} from signalling in time.`);
  }
}

interface Waiter {
  readonly type: NasSignalType;
  readonly resolve: (m: NasSignalForDevice) => void;
  readonly reject: (err: unknown) => void;
}

/** How long the Worker's `hello` may take. */
const HELLO_TIMEOUT_MS = 10_000;

/**
 * A device's signalling socket to the rendezvous Worker (`/signal/device?nasId=`, with `ticket` or `codeHash`): it
 * opens on the Worker's `hello`, which names the socket (`sid`), then carries offers, candidates and TURN requests to
 * the NAS and its answers back.
 */
export class SignallingClient {
  private readonly queue: NasSignalForDevice[] = [];
  private readonly waiters = new Set<Waiter>();
  private closeCode: number | null = null;
  private readonly skips = new Map<NasSignalType, number>();

  private constructor(
    private readonly socket: WebSocket,
    readonly sid: string,
  ) {}

  /** Opens the socket at `url` and resolves on `hello`; rejects with SignallingClosed or SignallingTimeout. */
  static connect(url: string, openSocket: (url: string) => WebSocket): Promise<SignallingClient> {
    return new Promise((resolve, reject) => {
      let client: SignallingClient | null = null;
      let socket: WebSocket;
      try {
        socket = openSocket(url);
      } catch {
        reject(new SignallingClosed(1006));
        return;
      }
      const timer = setTimeout(() => {
        reject(new SignallingTimeout('hello'));
        try {
          socket.close();
        } catch {
          // already closing
        }
      }, HELLO_TIMEOUT_MS);
      socket.onmessage = (ev: MessageEvent) => {
        const m = parse(ev.data);
        if (m === null) return;
        if (client) {
          client.receive(m as NasSignalForDevice);
          return;
        }
        if (m.t === 'hello' && typeof m.sid === 'string') {
          clearTimeout(timer);
          client = new SignallingClient(socket, m.sid);
          resolve(client);
        }
      };
      socket.onclose = (ev: CloseEvent) => {
        clearTimeout(timer);
        if (client) client.closed(ev.code);
        else reject(new SignallingClosed(ev.code));
      };
    });
  }

  get isClosed(): boolean {
    return this.closeCode !== null;
  }

  /** Sends `message`; false when the socket has closed. */
  send(message: DeviceSignal): boolean {
    if (this.closeCode !== null) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The next message of `type` (one already received counts); rejects when the socket closes, after `timeoutMs`, or
   * when `signal` aborts (the waiter is then gone, so a later message goes to the next caller).
   */
  next(type: NasSignalType, timeoutMs: number, signal?: AbortSignal): Promise<NasSignalForDevice> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const index = this.queue.findIndex((m) => m.t === type);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    if (this.closeCode !== null) return Promise.reject(new SignallingClosed(this.closeCode));
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        done();
        reject(signal!.reason);
      };
      const timer = setTimeout(() => {
        done();
        reject(new SignallingTimeout(type));
      }, timeoutMs);
      const waiter: Waiter = {
        type,
        resolve: (m) => {
          done();
          resolve(m);
        },
        reject: (err) => {
          done();
          reject(err);
        },
      };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Drops the next message of `type`, queued or still to come: the answer to an offer given up on, so it can't be
   * taken as the answer to the next one (the NAS answers offers in order).
   */
  skipNext(type: NasSignalType): void {
    const index = this.queue.findIndex((m) => m.t === type);
    if (index >= 0) this.queue.splice(index, 1);
    else this.skips.set(type, (this.skips.get(type) ?? 0) + 1);
  }

  close(): void {
    if (this.closeCode === null) this.closed(1000);
    try {
      this.socket.close();
    } catch {
      // already closing
    }
  }

  private receive(m: NasSignalForDevice): void {
    const skip = this.skips.get(m.t) ?? 0;
    if (skip > 0) {
      this.skips.set(m.t, skip - 1);
      return;
    }
    for (const waiter of this.waiters) {
      if (waiter.type !== m.t) continue;
      this.waiters.delete(waiter);
      waiter.resolve(m);
      return;
    }
    if (this.queue.length < 16) this.queue.push(m);
  }

  private closed(code: number): void {
    if (this.closeCode !== null) return;
    this.closeCode = code;
    const err = new SignallingClosed(code);
    for (const waiter of [...this.waiters]) waiter.reject(err);
    this.waiters.clear();
  }
}

function parse(data: unknown): { t: string; [field: string]: unknown } | null {
  if (typeof data !== 'string') return null;
  try {
    const m = JSON.parse(data) as unknown;
    return typeof m === 'object' && m !== null && typeof (m as { t?: unknown }).t === 'string' ? (m as { t: string }) : null;
  } catch {
    return null;
  }
}
