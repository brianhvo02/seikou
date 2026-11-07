/*
 * Original code for bluray-web: HTTP-shaped requests and responses over one ordered, reliable data channel (the
 * WebRTC route to the NAS). The NAS server and the browser both use it.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

/**
 * The part of a data channel the wire needs; werift's and the browser's channels are adapted to it. Binary messages
 * arrive as Uint8Array.
 */
export interface WireChannel {
  send(data: string | Uint8Array): void;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  onbufferedamountlow: (() => void) | null;
  onmessage: ((data: string | Uint8Array) => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

/** The largest binary message: a 4-byte request id and its payload together. */
export const MAX_CHUNK = 65536;
/** bufferedAmountLowThreshold: a paused sender resumes when the channel's buffer drains to this. */
export const LOW_WATER = 1 << 20;
/** A sender pauses while the channel buffers more than this. */
export const HIGH_WATER = 4 << 20;
/** The largest text frame (a head), in UTF-8 bytes. */
export const MAX_HEAD_BYTES = 16384;
/** Requests a server handles at once on one channel; one more is answered `error` "too many requests". */
export const MAX_REQUESTS = 64;
/** Request body bytes a server holds unread for one request; more closes the channel. */
export const MAX_QUEUED_BODY_BYTES = 16 << 20;

const ID_BYTES = 4;
/** Body bytes per binary message, so that a whole message stays within MAX_CHUNK (Safari's limit). */
const PAYLOAD_BYTES = MAX_CHUNK - ID_BYTES;
const MAX_ID = 0xffffffff;
const MAX_ERROR_MESSAGE = 1000;

export interface WireRequest {
  readonly method: string;
  /** The path and query, e.g. `/bluray/api/discs/x/files/BDMV/index.bdmv?t=…`. */
  readonly path: string;
  /** Lower-case names. */
  readonly headers: Record<string, string>;
  readonly body: AsyncIterable<Uint8Array>;
  /** Aborts when the client cancels the request or the channel closes. */
  readonly signal: AbortSignal;
}

export interface WireResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: AsyncIterable<Uint8Array> | Uint8Array | string | null;
}

type Frame =
  | { t: 'req'; id: number; method: string; path: string; headers: Record<string, string> }
  | { t: 'body-end'; id: number }
  | { t: 'res'; id: number; status: number; headers: Record<string, string> }
  | { t: 'end'; id: number }
  | { t: 'cancel'; id: number }
  | { t: 'error'; id: number; message: string };

/** Statuses whose Response must have a null body. */
export const isNullBodyStatus = (status: number): boolean => status === 101 || status === 103 || status === 204 || status === 205 || status === 304;

const encoder = new TextEncoder();

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= MAX_ID;

function isHeaders(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
}

const headBytes = (text: string): number => (text.length > MAX_HEAD_BYTES ? text.length : encoder.encode(text).byteLength);

/** A text frame's head, or null when it is malformed (too long, not JSON, or not one of the frames). */
function parseHead(text: string): Frame | null {
  if (headBytes(text) > MAX_HEAD_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const f = v as Record<string, unknown>;
  if (!isId(f.id)) return null;
  switch (f.t) {
    case 'req':
      return typeof f.method === 'string' && /^[A-Z]{1,16}$/.test(f.method) && typeof f.path === 'string' && f.path.startsWith('/') && isHeaders(f.headers)
        ? (f as Frame)
        : null;
    case 'res':
      return typeof f.status === 'number' && Number.isInteger(f.status) && f.status >= 200 && f.status <= 599 && isHeaders(f.headers) ? (f as Frame) : null;
    case 'error':
      return typeof f.message === 'string' ? (f as Frame) : null;
    case 'body-end':
    case 'end':
    case 'cancel':
      return f as Frame;
    default:
      return null;
  }
}

function binaryFrame(id: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(ID_BYTES + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, id);
  frame.set(payload, ID_BYTES);
  return frame;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_MESSAGE);

/** Thrown inside a frame handler: the peer broke the protocol. */
class Garbage extends Error {}

/** The channel with pacing by the water marks and one way to shut it. */
class Link {
  closed = false;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly channel: WireChannel,
    onText: (frame: Frame) => void,
    onBinary: (id: number, payload: Uint8Array) => void,
    private readonly onShut: () => void,
  ) {
    channel.bufferedAmountLowThreshold = LOW_WATER;
    channel.onbufferedamountlow = () => this.wake();
    channel.onclose = () => this.shut();
    channel.onmessage = (data) => {
      if (this.closed) return;
      try {
        if (typeof data === 'string') {
          const frame = parseHead(data);
          if (!frame) throw new Garbage('malformed head');
          onText(frame);
        } else {
          if (data.byteLength < ID_BYTES || data.byteLength > ID_BYTES + MAX_CHUNK) throw new Garbage('malformed body frame');
          onBinary(new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0), data.subarray(ID_BYTES));
        }
      } catch {
        this.shut();
      }
    };
  }

  /** Resolves true once the channel buffers no more than HIGH_WATER, or false when it has closed. */
  async ready(): Promise<boolean> {
    while (!this.closed && this.channel.bufferedAmount > HIGH_WATER) await new Promise<void>((resolve) => this.waiters.push(resolve));
    return !this.closed;
  }

  send(data: string | Uint8Array): boolean {
    if (this.closed) return false;
    try {
      this.channel.send(data);
      return true;
    } catch {
      this.shut();
      return false;
    }
  }

  sendHead(frame: Frame): boolean {
    return this.send(JSON.stringify(frame));
  }

  shut(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
    try {
      this.channel.close();
    } catch {
      // already closed
    }
    this.onShut();
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

/** Splits `chunk` into body frames for `id`, pacing each; false when sending should stop. */
async function sendChunk(link: Link, id: number, chunk: Uint8Array, stillWanted: () => boolean): Promise<boolean> {
  for (let at = 0; at < chunk.byteLength; at += PAYLOAD_BYTES) {
    if (!(await link.ready()) || !stillWanted()) return false;
    if (!link.send(binaryFrame(id, chunk.subarray(at, at + PAYLOAD_BYTES)))) return false;
  }
  return stillWanted();
}

interface ClientPending {
  readonly reject: (err: unknown) => void;
  resolve: ((res: Response) => void) | null; // null once answered
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  /** Cancelled here or failed: the upload stops. The upload outlives the response otherwise, up to `body-end`. */
  stopped: boolean;
  readonly headOnly: boolean;
  readonly done: () => void;
}

const closedError = (): TypeError => new TypeError('The connection to the NAS closed.');

/** Requests over a channel, as `fetch`. Only the URL's path and query are sent. */
export class WireClient {
  private readonly link: Link;
  private readonly open = new Map<number, ClientPending>();
  /** Requests cancelled here whose closing frame (`end` or `error`) has not come back yet. */
  private readonly cancelled = new Set<number>();
  /** Requests whose body is still going out; this can outlast the response (an early `error`, say). */
  private readonly uploads = new Map<number, ClientPending>();
  private nextId = 1;
  private failure: unknown = null;

  constructor(channel: WireChannel) {
    this.link = new Link(
      channel,
      (frame) => this.onHead(frame),
      (id, payload) => this.onBody(id, payload),
      () => this.fail(closedError()),
    );
  }

  /** Bound, so it can be handed on as a `typeof fetch`. */
  readonly fetch = async (input: Request | string | URL, init: RequestInit = {}): Promise<Response> => {
    if (typeof Request !== 'undefined' && input instanceof Request) {
      init = { method: input.method, headers: input.headers, signal: input.signal, body: input.body ? await input.arrayBuffer() : null, ...init };
      input = input.url;
    }
    if (this.failure !== null) throw this.failure;
    const signal = init.signal ?? null;
    signal?.throwIfAborted();
    const url = new URL(String(input), 'http://wire.invalid/');
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    let body: ReadableStream<Uint8Array> | null = null;
    if (init.body !== undefined && init.body !== null) {
      if (method === 'GET' || method === 'HEAD') throw new TypeError(`A ${method} request cannot have a body.`);
      const wrapped = new Response(init.body);
      const type = wrapped.headers.get('content-type');
      if (type !== null && !headers.has('content-type')) headers.set('content-type', type);
      body = wrapped.body;
    }
    const id = this.takeId();
    const head = JSON.stringify({ t: 'req', id, method, path: url.pathname + url.search, headers: Object.fromEntries(headers) } satisfies Frame);
    if (headBytes(head) > MAX_HEAD_BYTES) throw new TypeError('The request head is too large.');

    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => {
        if (this.open.has(id)) this.cancel(id, signal!.reason);
        else this.stopUpload(id);
      };
      const pending: ClientPending = {
        resolve,
        reject,
        controller: null,
        stopped: false,
        headOnly: method === 'HEAD',
        done: () => signal?.removeEventListener('abort', onAbort),
      };
      this.open.set(id, pending);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (!this.link.send(head)) return;
      void this.upload(id, pending, body);
    });
  };

  /** Rejects every pending fetch and errors every open body with `reason`, and closes the channel. */
  close(reason: Error): void {
    this.fail(reason);
    this.link.shut();
  }

  private fail(reason: unknown): void {
    if (this.failure !== null) return;
    this.failure = reason;
    const all = [...this.open.values()];
    const uploading = [...this.uploads.values()];
    this.open.clear();
    this.uploads.clear();
    this.cancelled.clear();
    for (const p of all) {
      this.settle(p, reason);
      p.done();
    }
    for (const p of uploading) {
      p.stopped = true;
      p.done();
    }
  }

  private takeId(): number {
    let id = this.nextId;
    while (this.open.has(id) || this.cancelled.has(id) || this.uploads.has(id)) id = id >= MAX_ID ? 1 : id + 1;
    this.nextId = id >= MAX_ID ? 1 : id + 1;
    return id;
  }

  private async upload(id: number, p: ClientPending, body: ReadableStream<Uint8Array> | null): Promise<void> {
    const wanted = (): boolean => !p.stopped && !this.link.closed;
    this.uploads.set(id, p);
    try {
      if (body) {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!(await sendChunk(this.link, id, value, wanted))) {
              void reader.cancel().catch(() => {});
              return;
            }
          }
        } catch (err) {
          const reason = new TypeError(`The request body failed: ${messageOf(err)}`);
          if (this.open.has(id)) this.cancel(id, reason);
          else this.stopUpload(id);
          return;
        }
      }
      if (wanted()) this.link.sendHead({ t: 'body-end', id });
    } finally {
      if (this.uploads.get(id) === p) this.uploads.delete(id);
      this.release(id, p);
    }
  }

  /** Stops the body of a request whose response already closed; the server then forgets it (no closing frame comes back). */
  private stopUpload(id: number): void {
    const p = this.uploads.get(id);
    if (!p || p.stopped) return;
    p.stopped = true;
    this.link.sendHead({ t: 'cancel', id });
  }

  /** Drops the abort listener once neither the response nor the upload needs it. */
  private release(id: number, p: ClientPending): void {
    if (this.open.get(id) !== p && this.uploads.get(id) !== p) p.done();
  }

  /** Gives up on `id`: tells the server, and rejects or errors with `reason`. */
  private cancel(id: number, reason: unknown): void {
    const p = this.open.get(id);
    if (!p) return;
    this.open.delete(id);
    p.stopped = true;
    this.cancelled.add(id);
    this.link.sendHead({ t: 'cancel', id });
    this.settle(p, reason);
    this.release(id, p);
  }

  private settle(p: ClientPending, reason: unknown): void {
    if (p.resolve) p.reject(reason);
    else
      try {
        p.controller?.error(reason);
      } catch {
        // already errored or closed
      }
  }

  private onHead(frame: Frame): void {
    if (frame.t === 'req' || frame.t === 'body-end' || frame.t === 'cancel') throw new Garbage(`a client got ${frame.t}`);
    const { id } = frame;
    if (this.cancelled.has(id)) {
      if (frame.t === 'end' || frame.t === 'error') this.cancelled.delete(id);
      return;
    }
    const p = this.open.get(id);
    if (!p) throw new Garbage('a frame for an unknown request');
    switch (frame.t) {
      case 'res': {
        if (!p.resolve) throw new Garbage('a second response head');
        const resolve = p.resolve;
        const stream =
          p.headOnly || isNullBodyStatus(frame.status)
            ? null
            : new ReadableStream<Uint8Array>({
                start: (controller) => {
                  p.controller = controller;
                },
                cancel: (reason) => this.cancel(id, reason),
              });
        const res = new Response(stream, { status: frame.status, headers: frame.headers }); // throws on bad header names: garbage
        p.resolve = null;
        resolve(res);
        return;
      }
      case 'end':
        if (p.resolve) throw new Garbage('an end before the response head');
        this.open.delete(id);
        this.release(id, p);
        p.controller?.close();
        return;
      case 'error':
        this.open.delete(id);
        this.settle(p, new TypeError(frame.message)); // the upload goes on: the server takes the body up to body-end
        this.release(id, p);
        return;
    }
  }

  private onBody(id: number, payload: Uint8Array): void {
    if (this.cancelled.has(id)) return;
    const p = this.open.get(id);
    if (!p || !p.controller) throw new Garbage('a body frame for an unknown request or one without a body');
    p.controller.enqueue(payload);
  }
}

/** A request body the handler reads while its frames arrive. */
class BodyQueue implements AsyncIterable<Uint8Array> {
  /** Bytes pushed and not yet read. */
  queuedBytes = 0;
  private chunks: Uint8Array[] = [];
  private ended = false;
  private error: unknown = null;
  private wake: (() => void) | null = null;

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.queuedBytes += chunk.byteLength;
    this.notify();
  }

  end(): void {
    this.ended = true;
    this.notify();
  }

  fail(err: unknown): void {
    if (this.ended) return;
    this.error = err;
    this.ended = true;
    this.chunks = [];
    this.queuedBytes = 0;
    this.notify();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (;;) {
      const next = this.chunks.shift();
      if (next) {
        this.queuedBytes -= next.byteLength;
        yield next;
        continue;
      }
      if (this.error !== null) throw this.error;
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

interface ServerActive {
  readonly abort: AbortController;
  readonly body: BodyQueue;
  /** `body-end` or `cancel` came: no more frames from the client for this id. */
  bodyDone: boolean;
  /** The closing frame (`end` or `error`) went out: nothing more is sent for this id. */
  responded: boolean;
}

/** Answers a WireClient's requests with `handle`. */
export class WireServer {
  private readonly link: Link;
  private readonly active = new Map<number, ServerActive>();
  /** Requests whose handler has not finished. */
  private running = 0;

  constructor(
    channel: WireChannel,
    private readonly handle: (req: WireRequest) => Promise<WireResponse>,
  ) {
    this.link = new Link(
      channel,
      (frame) => this.onHead(frame),
      (id, payload) => this.onBody(id, payload),
      () => this.abortAll(),
    );
  }

  close(): void {
    this.link.shut();
  }

  private abortAll(): void {
    const reason = closedError();
    for (const a of this.active.values()) {
      a.body.fail(reason);
      a.abort.abort(reason);
    }
    this.active.clear();
  }

  private onHead(frame: Frame): void {
    switch (frame.t) {
      case 'req': {
        if (this.active.has(frame.id)) throw new Garbage('a request id in use');
        // requests turned away still wait here for their body-end; a peer that never sends it is a broken one
        if (this.active.size >= 2 * MAX_REQUESTS) throw new Garbage('too many open requests');
        const a: ServerActive = { abort: new AbortController(), body: new BodyQueue(), bodyDone: false, responded: false };
        this.active.set(frame.id, a);
        if (this.running >= MAX_REQUESTS) {
          this.finish(frame.id, a, { t: 'error', id: frame.id, message: 'too many requests' });
          return;
        }
        const req: WireRequest = { method: frame.method, path: frame.path, headers: lowerCase(frame.headers), body: a.body, signal: a.abort.signal };
        void this.run(frame.id, a, req);
        return;
      }
      case 'body-end': {
        const a = this.active.get(frame.id);
        if (!a || a.bodyDone) throw new Garbage('body-end for an unknown request');
        a.bodyDone = true;
        a.body.end();
        this.forget(frame.id, a);
        return;
      }
      case 'cancel': {
        const a = this.active.get(frame.id);
        if (!a) return; // it finished before the cancel arrived; the client takes the end it was sent
        a.bodyDone = true;
        const reason = new DOMException('The client cancelled the request.', 'AbortError');
        a.body.fail(reason);
        a.abort.abort(reason);
        this.finish(frame.id, a, { t: 'error', id: frame.id, message: 'cancelled' });
        this.forget(frame.id, a);
        return;
      }
      default:
        throw new Garbage(`a server got ${frame.t}`);
    }
  }

  private onBody(id: number, payload: Uint8Array): void {
    const a = this.active.get(id);
    if (!a || a.bodyDone) throw new Garbage('a body frame for an unknown request');
    if (a.responded) return; // nobody reads it once the response is out
    if (a.body.queuedBytes + payload.byteLength > MAX_QUEUED_BODY_BYTES) throw new Garbage('too much unread request body');
    a.body.push(payload);
  }

  /** Sends the closing frame for `id` once. */
  private finish(id: number, a: ServerActive, frame: Frame): void {
    if (a.responded) return;
    a.responded = true;
    this.link.sendHead(frame);
    this.forget(id, a);
  }

  private forget(id: number, a: ServerActive): void {
    if (a.responded && a.bodyDone && this.active.get(id) === a) this.active.delete(id);
  }

  private async run(id: number, a: ServerActive, req: WireRequest): Promise<void> {
    const wanted = (): boolean => !a.responded && !this.link.closed;
    let res: WireResponse | null = null;
    let iterated = false;
    this.running++;
    try {
      res = await this.handle(req);
      if (!wanted()) return;
      const head = JSON.stringify({ t: 'res', id, status: res.status, headers: res.headers } satisfies Frame);
      if (!Number.isInteger(res.status) || res.status < 200 || res.status > 599 || !isHeaders(res.headers) || headBytes(head) > MAX_HEAD_BYTES) {
        throw new Error('the handler gave an invalid response head');
      }
      this.link.send(head);
      if (res.body !== null && req.method !== 'HEAD' && !isNullBodyStatus(res.status)) {
        const chunks = typeof res.body === 'string' ? [encoder.encode(res.body)] : res.body instanceof Uint8Array ? [res.body] : res.body;
        iterated = true; // for await closes the iterator when it stops early
        for await (const chunk of chunks) {
          if (!(await sendChunk(this.link, id, chunk, wanted))) break;
        }
      }
      if (wanted()) this.finish(id, a, { t: 'end', id });
    } catch (err) {
      if (wanted()) this.finish(id, a, { t: 'error', id, message: messageOf(err) });
    } finally {
      this.running--;
      if (res && !iterated) discard(res.body);
    }
  }
}

/** Closes a body that will not be read (a file stream on the NAS), ignoring how that goes. */
function discard(body: WireResponse['body']): void {
  if (body === null || typeof body === 'string' || body instanceof Uint8Array) return;
  try {
    void Promise.resolve(body[Symbol.asyncIterator]().return?.()).catch(() => {});
  } catch {
    // a broken iterable: nothing more to do
  }
}

function lowerCase(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}
