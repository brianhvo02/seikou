/*
 * Original code for bluray-web: fetch over a MessagePort, so a worker can reach a connection that lives on the main
 * thread (the WebRTC route to the NAS). Bodies cross as transferred ArrayBuffers, and so does an abort.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { isNullBodyStatus } from '@seikou/nas/rtc-wire';

type ToServer =
  | { t: 'req'; id: number; url: string; method: string; headers: Array<[string, string]>; body: ArrayBuffer | null }
  | { t: 'abort'; id: number };

type ToClient =
  | { t: 'res'; id: number; status: number; statusText: string; headers: Array<[string, string]>; hasBody: boolean }
  | { t: 'chunk'; id: number; chunk: ArrayBuffer }
  | { t: 'end'; id: number }
  | { t: 'error'; id: number; message: string };

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isPairs = (v: unknown): v is Array<[string, string]> =>
  Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string');

function isToServer(v: unknown): v is ToServer {
  if (!isRecord(v) || !isId(v.id)) return false;
  if (v.t === 'abort') return true;
  return v.t === 'req' && typeof v.url === 'string' && typeof v.method === 'string' && isPairs(v.headers) && (v.body === null || v.body instanceof ArrayBuffer);
}

function isToClient(v: unknown): v is ToClient {
  if (!isRecord(v) || !isId(v.id)) return false;
  switch (v.t) {
    case 'res':
      return typeof v.status === 'number' && typeof v.statusText === 'string' && isPairs(v.headers) && typeof v.hasBody === 'boolean';
    case 'chunk':
      return v.chunk instanceof ArrayBuffer;
    case 'end':
      return true;
    case 'error':
      return typeof v.message === 'string';
    default:
      return false;
  }
}

/** The bytes of `chunk` as an ArrayBuffer that can be transferred without detaching anything else. */
function ownBuffer(chunk: Uint8Array): ArrayBuffer {
  const { buffer } = chunk;
  return buffer instanceof ArrayBuffer && chunk.byteOffset === 0 && chunk.byteLength === buffer.byteLength ? buffer : chunk.slice().buffer;
}

interface Served {
  readonly abort: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
}

/** Answers `portFetch` requests arriving on `port` with `fetchFn`. The returned function stops and aborts them all. */
export function serveFetch(port: MessagePort, fetchFn: typeof fetch): () => void {
  const served = new Map<number, Served>();
  const post = (msg: ToClient, transfer: Transferable[] = []): void => port.postMessage(msg, transfer);

  const abort = (id: number, reason: unknown): void => {
    const s = served.get(id);
    if (!s) return;
    served.delete(id);
    s.abort.abort(reason);
    void s.reader?.cancel(reason).catch(() => {});
  };

  const run = async (msg: Extract<ToServer, { t: 'req' }>): Promise<void> => {
    const s: Served = { abort: new AbortController(), reader: null };
    served.set(msg.id, s);
    const live = (): boolean => served.get(msg.id) === s;
    try {
      const res = await fetchFn(msg.url, { method: msg.method, headers: msg.headers, body: msg.body, signal: s.abort.signal });
      if (!live()) {
        void res.body?.cancel().catch(() => {});
        return;
      }
      post({ t: 'res', id: msg.id, status: res.status, statusText: res.statusText, headers: [...res.headers], hasBody: res.body !== null });
      if (res.body) {
        const reader = res.body.getReader();
        s.reader = reader;
        for (;;) {
          const { done, value } = await reader.read();
          if (!live()) return;
          if (done) break;
          const chunk = ownBuffer(value);
          post({ t: 'chunk', id: msg.id, chunk }, [chunk]);
        }
      }
      if (live()) post({ t: 'end', id: msg.id });
    } catch (err) {
      if (live()) post({ t: 'error', id: msg.id, message: messageOf(err) });
    } finally {
      if (live()) served.delete(msg.id);
    }
  };

  const onMessage = (event: MessageEvent<unknown>): void => {
    const msg = event.data;
    if (!isToServer(msg)) return;
    if (msg.t === 'req') void run(msg);
    else if (msg.t === 'abort') abort(msg.id, new DOMException('The request was aborted.', 'AbortError'));
  };
  port.addEventListener('message', onMessage);
  port.start();
  return () => {
    port.removeEventListener('message', onMessage);
    for (const id of [...served.keys()]) {
      post({ t: 'error', id, message: 'The fetch server stopped.' });
      abort(id, new DOMException('The fetch server stopped.', 'AbortError'));
    }
  };
}

interface Waiting {
  resolve: ((res: Response) => void) | null; // null once answered
  readonly reject: (err: unknown) => void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  readonly done: () => void;
}

/** A fetch whose requests `serveFetch` answers at the other end of `port`. */
export function portFetch(port: MessagePort): typeof fetch {
  const waiting = new Map<number, Waiting>();
  let nextId = 1;

  const fail = (w: Waiting, reason: unknown): void => {
    w.done();
    if (w.resolve) w.reject(reason);
    else
      try {
        w.controller?.error(reason);
      } catch {
        // already errored or closed
      }
  };

  const giveUp = (id: number, reason: unknown): void => {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    port.postMessage({ t: 'abort', id } satisfies ToServer);
    fail(w, reason);
  };

  port.addEventListener('message', (event: MessageEvent<unknown>) => {
    const msg = event.data;
    if (!isToClient(msg)) return;
    const w = waiting.get(msg.id);
    if (!w) return; // aborted here; the server's messages for it were already on their way
    switch (msg.t) {
      case 'res': {
        if (!w.resolve) return;
        const resolve = w.resolve;
        w.resolve = null;
        const stream =
          msg.hasBody && !isNullBodyStatus(msg.status)
            ? new ReadableStream<Uint8Array>({
                start: (controller) => {
                  w.controller = controller;
                },
                cancel: (reason) => giveUp(msg.id, reason),
              })
            : null;
        let res: Response;
        try {
          res = new Response(stream, { status: msg.status, statusText: msg.statusText, headers: msg.headers });
        } catch (err) {
          waiting.delete(msg.id);
          port.postMessage({ t: 'abort', id: msg.id } satisfies ToServer);
          w.done();
          w.reject(new TypeError(`An unusable response: ${messageOf(err)}`));
          return;
        }
        resolve(res);
        return;
      }
      case 'chunk':
        w.controller?.enqueue(new Uint8Array(msg.chunk));
        return;
      case 'end':
        waiting.delete(msg.id);
        w.done();
        w.controller?.close();
        return;
      case 'error':
        waiting.delete(msg.id);
        fail(w, new TypeError(msg.message));
        return;
    }
  });
  port.start();

  return (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    if (typeof Request !== 'undefined' && input instanceof Request) {
      init = { method: input.method, headers: input.headers, signal: input.signal, body: input.body ? await input.arrayBuffer() : null, ...init };
      input = input.url;
    }
    const signal = init.signal ?? null;
    signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    let body: ArrayBuffer | null = null;
    if (init.body !== undefined && init.body !== null) {
      const wrapped = new Response(init.body);
      const type = wrapped.headers.get('content-type');
      if (type !== null && !headers.has('content-type')) headers.set('content-type', type);
      body = await wrapped.arrayBuffer();
      signal?.throwIfAborted();
    }
    const id = nextId++;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => giveUp(id, signal!.reason);
      waiting.set(id, { resolve, reject, controller: null, done: () => signal?.removeEventListener('abort', onAbort) });
      signal?.addEventListener('abort', onAbort, { once: true });
      const msg: ToServer = { t: 'req', id, url: String(input), method: (init.method ?? 'GET').toUpperCase(), headers: [...headers], body };
      port.postMessage(msg, body ? [body] : []);
    });
  }) as typeof fetch;
}
