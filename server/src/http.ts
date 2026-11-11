import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { PREFLIGHT_HEADERS, corsHeaders } from './cors';

/** What a handler answers: a status, optional headers and an optional body (a stream is piped, a string or buffer is sent whole). */
export interface Response {
  /** The HTTP status code. */
  status: number;
  /** Headers added to the answer (CORS headers are added by `responseHeaders`). */
  headers?: Record<string, string>;
  /** The body; absent for an answer with none. */
  body?: Buffer | string | Readable;
}

/** Answers a request, or returns null to let the next handler try. */
export type Handler = (req: IncomingMessage, url: URL) => Promise<Response | null>;

/** A JSON answer: `value` serialised, with `Content-Type: application/json; charset=utf-8` and any extra `headers`. */
export function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(value) };
}

/** Thrown by a handler to answer `status` with `{"error": message}`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const MAX_JSON_BYTES = 16 * 1024;

/** The request's JSON body: 415 unless it is `application/json`, 413 above 16 KiB, 400 if it doesn't parse. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'expected application/json');
  const tooLarge = new HttpError(413, 'body too large', { Connection: 'close' });
  if (Number(req.headers['content-length'] ?? 0) > MAX_JSON_BYTES) throw tooLarge;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw tooLarge;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'bad request');
  }
}

/** A request body went past its limit (declared or streamed). */
export class BodyTooLargeError extends Error {
  constructor() {
    super('body too large');
    this.name = 'BodyTooLargeError';
  }
}

/** After refusing a body, how far past the limit it is dropped, and for how long, so the client sees the answer. */
const DRAIN_BYTES = 8 * 1024 * 1024;
const DRAIN_MS = 2_000;

/** Reads and drops what is left of the body, until it ends, 8 MB go by or 2 s pass; then stops reading. */
async function drain(req: IncomingMessage, it: AsyncIterator<Buffer>, read: number, limit: number): Promise<void> {
  const deadline = new Promise<'timeout'>((resolve) => setTimeout(resolve, DRAIN_MS, 'timeout').unref());
  let size = read;
  try {
    for (;;) {
      const next = await Promise.race([it.next(), deadline]);
      if (next === 'timeout' || next.done) break;
      size += next.value.length;
      if (size > Math.max(read, limit) + DRAIN_BYTES) break;
    }
  } catch {
    // the client went; nothing is left to drop
  }
  req.pause();
}

/**
 * The body's chunks, at most `limit` bytes: a {@link BodyTooLargeError} once it passes (declared or streamed), an
 * HttpError 400 if the client goes mid-body. Stopping early (an error, or the consumer's `break`) reads and drops
 * the rest of the body (see `drain`), because closing the connection on unread bytes would reset it before the
 * client reads the answer.
 */
export async function* bodyStream(req: IncomingMessage, limit: number): AsyncGenerator<Buffer, void, undefined> {
  const it = (req as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  let size = 0;
  let ended = false;
  try {
    if (Number(req.headers['content-length'] ?? 0) > limit) throw new BodyTooLargeError();
    for (;;) {
      let next: IteratorResult<Buffer>;
      try {
        next = await it.next();
      } catch {
        // a client gone mid-upload (a page closing) is not a server fault: no answer reaches it
        ended = true;
        throw new HttpError(400, 'request ended early');
      }
      if (next.done) {
        ended = true;
        return;
      }
      size += next.value.length;
      if (size > limit) throw new BodyTooLargeError();
      yield next.value;
    }
  } finally {
    if (!ended) await drain(req, it, size, limit);
  }
}

/** The whole body, or null once it passes `limit` bytes (the rest of it dropped); a 400 if the client goes. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of bodyStream(req, limit)) chunks.push(chunk);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return null;
    throw err;
  }
  return Buffer.concat(chunks);
}

const health: Handler = async (req, url) => {
  if (url.pathname !== '/api/health') return null;
  if (req.method === 'GET') return json(200, { ok: true });
  if (req.method === 'HEAD') return { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } };
  return null;
};

/** Above Caddy's 2-minute upstream idle timeout, so Caddy never reuses a connection we have closed. */
const KEEP_ALIVE_TIMEOUT_MS = 130_000;

/** On every response: the bytes are user content on a shared origin, so never sniff them or run them as a page. */
const SAFETY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'",
};

/** The headers a response goes out with, on either route: safety, CORS for `origin`, then the handler's own. */
export function responseHeaders(origin: string | undefined, response: Response): Record<string, string> {
  return { ...SAFETY_HEADERS, ...corsHeaders(origin), ...response.headers };
}

/** Requests that came over a WebRTC data channel rather than HTTPS. */
const channelRequests = new WeakSet<IncomingMessage>();

/** A data channel request's own abort: the peer cancelled it, or the channel closed. */
const channelSignals = new WeakMap<IncomingMessage, AbortSignal>();

/** Marks a data channel's request stand-in, for {@link viaChannel}, with the signal that aborts it ({@link requestSignal}). */
export function markChannelRequest(req: IncomingMessage, signal?: AbortSignal): void {
  channelRequests.add(req);
  if (signal) channelSignals.set(req, signal);
}

/**
 * A signal that aborts when the requester has gone away: the data channel's request was cancelled, or the HTTP
 * connection closed. Call `done` once the handler has stopped waiting.
 */
export function requestSignal(req: IncomingMessage): { signal: AbortSignal; done: () => void } {
  const channel = channelSignals.get(req);
  if (channel) return { signal: channel, done: () => {} };
  const abort = new AbortController();
  const socket = req.socket as Partial<Pick<NodeJS.EventEmitter, 'once' | 'off'>> | undefined;
  const onClose = (): void => abort.abort(new Error('the client went away'));
  socket?.once?.('close', onClose);
  return { signal: abort.signal, done: () => socket?.off?.('close', onClose) };
}

/** Whether `req` came over a data channel (see `rtc/dispatch.ts`); false for HTTPS. */
export const viaChannel = (req: IncomingMessage): boolean => channelRequests.has(req);

function send(res: ServerResponse, origin: string | undefined, response: Response): void {
  res.writeHead(response.status, responseHeaders(origin, response));
  const { body } = response;
  if (body instanceof Readable) {
    const length = Number(response.headers?.['Content-Length'] ?? NaN);
    let sent = 0;
    body.on('data', (chunk: Buffer) => (sent += chunk.length));
    body.on('error', () => res.destroy());
    // A file that shrank mid-read: end the connection, or the client waits for bytes that never come.
    body.on('end', () => (Number.isFinite(length) && sent < length ? res.destroy() : res.end()));
    res.on('close', () => body.destroy());
    body.pipe(res, { end: false });
  } else {
    res.end(body);
  }
}

/**
 * Answers `req` with the built-in health check, then `handlers`; HttpErrors become their answers, anything else
 * thrown is the caller's to answer (a generic 500). Both the HTTPS server and the data channels use it.
 */
export function handle(handlers: readonly Handler[], req: IncomingMessage): Promise<Response> {
  return route([health, ...handlers], req);
}

async function route(handlers: readonly Handler[], req: IncomingMessage): Promise<Response> {
  if (req.method === 'OPTIONS') return { status: 204, headers: { ...PREFLIGHT_HEADERS } };
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return json(400, { error: 'bad request' });
  }
  try {
    for (const handler of handlers) {
      const response = await handler(req, url);
      if (response) return response;
    }
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message }, err.headers);
    throw err;
  }
  return json(404, { error: 'not found' });
}

/** An HTTP server running `handlers` after the built-in health check, with CORS on every response. */
export function createServer(handlers: readonly Handler[]): http.Server {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    handle(handlers, req)
      .then((response) => send(res, origin, response))
      .catch((err: unknown) => {
        console.error(err);
        if (res.headersSent) {
          res.destroy();
          return;
        }
        try {
          send(res, origin, json(500, { error: 'internal error' }));
        } catch {
          res.destroy();
        }
      });
  });
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000;
  return server;
}
