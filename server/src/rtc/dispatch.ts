import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { WireServer } from '@seikou/nas/rtc-wire';
import type { WireChannel, WireRequest, WireResponse } from '@seikou/nas/rtc-wire';
import type { Auth } from '../auth';
import { handle, json, markChannelRequest, responseHeaders } from '../http';
import type { Handler, Response } from '../http';

/** A channel that has not started a session by then is closed. */
export const SESSION_DEADLINE_MS = 30_000;

/** The only requests a channel without a session may make (pairing, the session handshake and health). */
const OPEN_ROUTES: ReadonlySet<string> = new Set(['POST /api/pair/redeem', 'POST /api/session/challenge', 'POST /api/session', 'GET /api/health']);

/** What `serveChannel` needs besides the channel and the handlers. */
export interface ChannelOptions {
  /** Authenticates sessions and tells when a device is revoked. */
  auth: Auth;
  /** The peer's address, as `req.socket.remoteAddress` (the pairing routes count failures by it). */
  remoteAddress: string;
  /** The clock in milliseconds since the epoch. */
  now: () => number;
  /** Called with the device each time a session starts on this channel. */
  onSession?: (deviceId: string) => void;
}

/**
 * Answers API requests from one data channel with the same handlers and headers as the HTTPS server. Until a
 * `POST /api/session` on this channel answers 200, only the open routes run and everything else is answered 401;
 * the channel is closed after 30 s without a session, after a session attempt answers 401, and when the device
 * of its session is revoked.
 *
 * A session 401 closes the channel even after an earlier session succeeded on it. The session only opens the gate:
 * each request is still authenticated by its own token, as over HTTPS. A second successful session switches the
 * channel's device (the one whose revocation closes it) and calls `onSession` again.
 */
export function serveChannel(channel: WireChannel, handlers: readonly Handler[], opts: ChannelOptions): { close(): void } {
  const openedAt = opts.now();
  let deviceId: string | null = null;
  let closed = false;

  const deadline = setTimeout(() => {
    if (deviceId === null) server.close();
  }, SESSION_DEADLINE_MS);
  deadline.unref?.();
  const stopWatching = opts.auth.onDeviceGone((gone) => {
    if (gone === deviceId) server.close();
  });
  const cleanUp = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    stopWatching();
  };
  /** Closes the channel once the response in flight has gone out (its `end` frame is sent within this turn). */
  const closeSoon = (): void => {
    setImmediate(() => server.close());
  };

  const answer = async (wire: WireRequest): Promise<WireResponse> => {
    const route = `${wire.method} ${pathOf(wire.path)}`;
    if (deviceId === null) {
      if (opts.now() - openedAt >= SESSION_DEADLINE_MS) {
        closeSoon();
        return toWire(wire, json(401, { error: 'unauthorized' }));
      }
      if (!OPEN_ROUTES.has(route)) return toWire(wire, json(401, { error: 'unauthorized' }));
    }
    const req = standIn(wire, opts.remoteAddress);
    let response: Response;
    try {
      response = await handle(handlers, req);
    } catch (err) {
      console.error(err);
      response = json(500, { error: 'internal error' });
    } finally {
      req.destroy();
    }
    if (route === 'POST /api/session') {
      if (response.status === 200) {
        const device = sessionDevice(response, opts.auth);
        if (device !== null) {
          deviceId = device;
          try {
            opts.onSession?.(device);
          } catch (err) {
            console.error(err); // the session stands; only the note of its route is lost
          }
        }
      } else if (response.status === 401) {
        closeSoon();
      }
    }
    return toWire(wire, response);
  };

  const server = new WireServer(watched(channel, cleanUp), answer);
  return { close: () => server.close() };
}

/** The path without its query, or '' when it doesn't parse. */
function pathOf(path: string): string {
  try {
    return new URL(path, 'http://localhost').pathname;
  } catch {
    return '';
  }
}

/** The device of a `POST /api/session` answer, from the token it carries. */
function sessionDevice(response: Response, auth: Auth): string | null {
  if (typeof response.body !== 'string') return null;
  try {
    const { token } = JSON.parse(response.body) as { token?: unknown };
    return typeof token === 'string' ? (auth.verify(token)?.id ?? null) : null;
  } catch {
    return null;
  }
}

/** What the routes read of an IncomingMessage: a readable body, method, url, lower-case headers and the peer. */
function standIn(wire: WireRequest, remoteAddress: string): IncomingMessage {
  const body = Readable.from(buffers(wire.body), { objectMode: false });
  body.on('error', () => {}); // a reader sees the failure; nobody reading must not crash the server
  const req = Object.assign(body, { method: wire.method, url: wire.path, headers: peerHeaders(wire.headers), socket: { remoteAddress } });
  const stand = req as unknown as IncomingMessage;
  markChannelRequest(stand, wire.signal);
  return stand;
}

/** The peer's headers without the forwarding ones: only the trusted proxy may name a client, and a channel has none. */
function peerHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'forwarded' && !name.startsWith('x-forwarded-')));
}

async function* buffers(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  for await (const chunk of chunks) yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function toWire(wire: WireRequest, response: Response): WireResponse {
  const headers = responseHeaders(wire.headers.origin, response);
  const { body } = response;
  if (body === undefined) return { status: response.status, headers, body: null };
  if (typeof body === 'string' || body instanceof Uint8Array) return { status: response.status, headers, body };
  wire.signal.addEventListener('abort', () => body.destroy(), { once: true });
  if (wire.signal.aborted) body.destroy();
  return { status: response.status, headers, body: streamed(body, Number(response.headers?.['Content-Length'] ?? NaN)) };
}

/**
 * A file stream as a wire body: destroyed when the wire stops reading it, even before the first chunk, and an error
 * (not a clean end) when it gives fewer bytes than its Content-Length, as when the file shrank mid-read.
 */
function streamed(stream: Readable, length: number): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: () => {
      const inner = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
      let sent = 0;
      return {
        next: async () => {
          let result: IteratorResult<Buffer>;
          try {
            result = await inner.next();
          } catch (err) {
            // fs errors name library paths: log them here, and tell the peer only that the read failed
            console.error(err);
            stream.destroy();
            throw new Error('read failed');
          }
          if (result.done) {
            if (Number.isFinite(length) && sent < length) throw new Error('the file ended early');
            return result;
          }
          sent += result.value.length;
          return result;
        },
        return: async () => {
          stream.destroy();
          await inner.return?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/** `channel` as the wire sees it, calling `onGone` once when it closes from either side. */
function watched(channel: WireChannel, onGone: () => void): WireChannel {
  let gone = false;
  const done = (): void => {
    if (gone) return;
    gone = true;
    onGone();
  };
  let wireOnClose: (() => void) | null = null;
  channel.onclose = () => {
    wireOnClose?.();
    done();
  };
  return {
    send: (data) => channel.send(data),
    get bufferedAmount() {
      return channel.bufferedAmount;
    },
    get bufferedAmountLowThreshold() {
      return channel.bufferedAmountLowThreshold;
    },
    set bufferedAmountLowThreshold(value) {
      channel.bufferedAmountLowThreshold = value;
    },
    get onbufferedamountlow() {
      return channel.onbufferedamountlow;
    },
    set onbufferedamountlow(listener) {
      channel.onbufferedamountlow = listener;
    },
    get onmessage() {
      return channel.onmessage;
    },
    set onmessage(listener) {
      channel.onmessage = listener;
    },
    get onclose() {
      return wireOnClose;
    },
    set onclose(listener) {
      wireOnClose = listener;
    },
    close: () => {
      try {
        channel.close();
      } finally {
        done();
      }
    },
  };
}
