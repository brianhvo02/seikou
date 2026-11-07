import { afterEach, describe, expect, it } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { portFetch, serveFetch } from './port-fetch';

const opened: Array<{ close(): void }> = [];
const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const port of opened.splice(0)) port.close();
});

/** A real MessageChannel: `fetchFn` served on one end, the port fetch on the other. */
function connect(fetchFn: typeof fetch): typeof fetch {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  stops.push(serveFetch(port1 as unknown as MessagePort, fetchFn));
  return portFetch(port2 as unknown as MessagePort);
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('fetch over a MessagePort', () => {
  it('streams a response body chunk by chunk, with status and headers', async () => {
    let seen: { url: string; method: string; headers: Record<string, string>; body: string } | null = null;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      seen = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : '',
      };
      let n = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (n === 3) return controller.close();
          controller.enqueue(new Uint8Array([n, n, n]));
          n++;
        },
      });
      return new Response(stream, { status: 206, headers: { 'Content-Range': 'bytes 0-8/9' } });
    }) as typeof fetch;
    const f = connect(fetchFn);
    const res = await f('https://nas.example/bluray/api/x?t=1', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello' });
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-8/9');
    const reader = res.body!.getReader();
    const chunks: number[][] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push([...value]);
    }
    expect(chunks.flat()).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(seen).toEqual({ url: 'https://nas.example/bluray/api/x?t=1', method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' });
  });

  it('answers json() and a status without a body', async () => {
    const f = connect((async (input: string | URL | Request) =>
      String(input).endsWith('/none') ? new Response(null, { status: 204 }) : Response.json({ ok: true })) as typeof fetch);
    expect(await (await f('/json')).json()).toEqual({ ok: true });
    const none = await f('/none');
    expect(none.status).toBe(204);
    expect(none.body).toBeNull();
  });

  it('carries an abort across the port to the served fetch', async () => {
    let served: AbortSignal | undefined;
    let cancelled = false;
    const f = connect((async (_input: string | URL | Request, init?: RequestInit) => {
      served = init?.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch);
    const controller = new AbortController();
    const res = await f('/x', { signal: controller.signal });
    const reader = res.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    controller.abort(new Error('seek'));
    await expect(reader.read()).rejects.toThrow('seek');
    await tick(20);
    expect(served?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it('aborts a request whose answer has not come', async () => {
    let served: AbortSignal | undefined;
    const f = connect(((_input: string | URL | Request, init?: RequestInit) => {
      served = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }) as typeof fetch);
    const controller = new AbortController();
    const pending = f('/x', { signal: controller.signal });
    await tick(10);
    controller.abort(new Error('gone'));
    await expect(pending).rejects.toThrow('gone');
    await tick(20);
    expect(served?.aborted).toBe(true);
  });

  it('carries a fetch failure across as a TypeError', async () => {
    const f = connect((async () => {
      throw new TypeError('NAS unreachable');
    }) as typeof fetch);
    const err = await f('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe('NAS unreachable');
  });

  it('carries a failure in the middle of a body across', async () => {
    const f = connect((async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.error(new Error('connection dropped'));
        },
      });
      return new Response(stream);
    }) as typeof fetch);
    const res = await f('/x');
    await expect(res.arrayBuffer()).rejects.toThrow('connection dropped');
  });

  it('aborts the served fetches when stopped', async () => {
    let served: AbortSignal | undefined;
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const stop = serveFetch(port1 as unknown as MessagePort, ((_input: string | URL | Request, init?: RequestInit) => {
      served = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as typeof fetch);
    const f = portFetch(port2 as unknown as MessagePort);
    const pending = f('/x');
    await tick(10);
    stop();
    expect(served?.aborted).toBe(true);
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe('The fetch server stopped.');
  });

  it('errors an open body when stopped', async () => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const stop = serveFetch(port1 as unknown as MessagePort, (async () =>
      new Response(new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new Uint8Array([1])) }))) as typeof fetch);
    const res = await portFetch(port2 as unknown as MessagePort)('/x');
    const reader = res.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    stop();
    await expect(reader.read()).rejects.toBeInstanceOf(TypeError);
  });

  it('ignores malformed messages on both ends', async () => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    stops.push(serveFetch(port1 as unknown as MessagePort, (async () => new Response('ok')) as typeof fetch));
    const f = portFetch(port2 as unknown as MessagePort);
    port2.postMessage({ t: 'req', id: 'x' });
    port2.postMessage(null);
    port1.postMessage({ t: 'res', id: 1, status: 'nope' });
    port1.postMessage(42);
    expect(await (await f('/x')).text()).toBe('ok');
  });
});
