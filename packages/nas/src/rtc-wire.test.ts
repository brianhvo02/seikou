import { describe, expect, it } from 'vitest';
import { HIGH_WATER, LOW_WATER, MAX_CHUNK, MAX_QUEUED_BODY_BYTES, MAX_REQUESTS, WireClient, WireServer, type WireChannel, type WireRequest, type WireResponse } from './rtc-wire';

/** One end of an in-memory ordered channel. With `manual`, sent bytes stay buffered until `drain()`. */
class MemChannel implements WireChannel {
  peer!: MemChannel;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onbufferedamountlow: (() => void) | null = null;
  onmessage: ((data: string | Uint8Array) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Array<string | Uint8Array> = [];
  closed = false;
  manual = false;

  send(data: string | Uint8Array): void {
    if (this.closed) throw new Error('InvalidStateError: closed');
    const copy = typeof data === 'string' ? data : data.slice();
    this.sent.push(copy);
    if (this.manual) this.bufferedAmount += typeof copy === 'string' ? copy.length : copy.byteLength;
    const peer = this.peer;
    queueMicrotask(() => {
      if (!peer.closed) peer.onmessage?.(copy);
    });
  }

  drain(): void {
    const was = this.bufferedAmount;
    this.bufferedAmount = 0;
    if (was > this.bufferedAmountLowThreshold) this.onbufferedamountlow?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = this.peer.closed = true;
    setTimeout(() => {
      this.onclose?.();
      this.peer.onclose?.();
    });
  }
}

function pair(): { client: MemChannel; server: MemChannel } {
  const client = new MemChannel();
  const server = new MemChannel();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pattern(n: number, seed = 0): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of body) parts.push(part);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const idOf = (frame: Uint8Array): number => new DataView(frame.buffer, frame.byteOffset).getUint32(0);
const binaryFrames = (frames: Array<string | Uint8Array>): Uint8Array[] => frames.filter((f): f is Uint8Array => typeof f !== 'string');
const textFrames = (frames: Array<string | Uint8Array>): Array<Record<string, unknown>> =>
  frames.filter((f): f is string => typeof f === 'string').map((f) => JSON.parse(f) as Record<string, unknown>);

function setup(handle: (req: WireRequest) => Promise<WireResponse>): { channels: ReturnType<typeof pair>; client: WireClient; server: WireServer } {
  const channels = pair();
  const server = new WireServer(channels.server, handle);
  const client = new WireClient(channels.client);
  return { channels, client, server };
}

describe('WireClient and WireServer', () => {
  it('sets the low-water threshold on both ends', () => {
    const { channels } = setup(async () => ({ status: 204, headers: {}, body: null }));
    expect(channels.client.bufferedAmountLowThreshold).toBe(LOW_WATER);
    expect(channels.server.bufferedAmountLowThreshold).toBe(LOW_WATER);
  });

  it('delivers a 200 KB GET byte-exact in chunks of at most 64 KB', async () => {
    const data = pattern(200 * 1024);
    let seen: WireRequest | null = null;
    const { channels, client } = setup(async (req) => {
      seen = req;
      return { status: 200, headers: { 'content-type': 'application/octet-stream', 'x-n': '1' }, body: data };
    });
    const res = await client.fetch('https://nas.example/bluray/api/discs/a/files/BDMV/x?t=tok', { headers: { Range: 'bytes=0-1' } });
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-n')).toBe('1');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
    expect(seen!.method).toBe('GET');
    expect(seen!.path).toBe('/bluray/api/discs/a/files/BDMV/x?t=tok');
    expect(seen!.headers).toEqual({ range: 'bytes=0-1' });
    const chunks = binaryFrames(channels.server.sent);
    expect(chunks).toHaveLength(4);
    for (const c of chunks) expect(c.byteLength).toBeLessThanOrEqual(MAX_CHUNK);
  });

  it('answers json() and text bodies', async () => {
    const { client } = setup(async (req) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: req.path }) }));
    expect(await (await client.fetch('/api/me')).json()).toEqual({ path: '/api/me' });
  });

  it('answers a status without a body', async () => {
    const { client } = setup(async () => ({ status: 204, headers: {}, body: null }));
    const res = await client.fetch('/api/x', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    // the id is finished: the next request works
    expect((await client.fetch('/api/y', { method: 'DELETE' })).status).toBe(204);
  });

  it('brings a 100 KB PUT body to the handler intact', async () => {
    const data = pattern(100 * 1024, 7);
    const { client } = setup(async (req) => {
      const got = await collect(req.body);
      return { status: 200, headers: {}, body: JSON.stringify({ method: req.method, ct: req.headers['content-type'], ok: got.byteLength === data.byteLength && got.every((b, i) => b === data[i]) }) };
    });
    const res = await client.fetch('/api/bdj-store/x', { method: 'PUT', headers: { 'Content-Type': 'application/x-tar' }, body: data });
    expect(await res.json()).toEqual({ method: 'PUT', ct: 'application/x-tar', ok: true });
  });

  it('finishes the upload after an early answer, so the server can forget the request', async () => {
    const data = pattern(3 * MAX_CHUNK);
    const { channels, client } = setup(async () => ({ status: 413, headers: {}, body: 'too big' }));
    const res = await client.fetch('/api/bdj-store/x', { method: 'PUT', body: data });
    expect(res.status).toBe(413);
    expect(await res.text()).toBe('too big');
    await tick(10);
    expect(textFrames(channels.client.sent).filter((f) => f.t === 'body-end')).toEqual([{ t: 'body-end', id: 1 }]);
    expect(channels.server.closed).toBe(false);
    expect((await client.fetch('/again', { method: 'PUT', body: 'x' })).status).toBe(413);
  });

  it('forgets a request cancelled after its response went out', async () => {
    const { channels } = setup(async () => ({ status: 200, headers: {}, body: 'done' }));
    channels.client.onmessage = null; // frames are written by hand here
    channels.server.onmessage!(JSON.stringify({ t: 'req', id: 1, method: 'PUT', path: '/x', headers: {} }));
    await tick(10);
    expect(textFrames(channels.server.sent).map((f) => f.t)).toEqual(['res', 'end']);
    channels.server.onmessage!(JSON.stringify({ t: 'cancel', id: 1 }));
    expect(channels.server.closed).toBe(false);
    expect(textFrames(channels.server.sent).map((f) => f.t)).toEqual(['res', 'end']);
    // id 1 is free again: a retained request would make this a duplicate
    channels.server.onmessage!(JSON.stringify({ t: 'req', id: 1, method: 'GET', path: '/y', headers: {} }));
    expect(channels.server.closed).toBe(false);
  });

  it('sends a string body with its content type', async () => {
    const { client } = setup(async (req) => ({ status: 200, headers: {}, body: JSON.stringify({ ct: req.headers['content-type'], text: new TextDecoder().decode(await collect(req.body)) }) }));
    const res = await client.fetch('/api/pair/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
    expect(await res.json()).toEqual({ ct: 'application/json', text: '{"a":1}' });
  });

  it('interleaves two concurrent responses, each body correct', async () => {
    const a = pattern(5 * MAX_CHUNK, 1);
    const b = pattern(5 * MAX_CHUNK, 2);
    const { channels, client } = setup(async (req) => {
      const data = req.path === '/a' ? a : b;
      async function* body(): AsyncGenerator<Uint8Array> {
        for (let at = 0; at < data.byteLength; at += 16384) {
          yield data.subarray(at, at + 16384);
          await tick();
        }
      }
      return { status: 200, headers: {}, body: body() };
    });
    const [ra, rb] = await Promise.all([client.fetch('/a'), client.fetch('/b')]);
    const [ba, bb] = await Promise.all([ra.arrayBuffer(), rb.arrayBuffer()]);
    expect(new Uint8Array(ba)).toEqual(a);
    expect(new Uint8Array(bb)).toEqual(b);
    const ids = binaryFrames(channels.server.sent).map(idOf);
    let switches = 0;
    for (let i = 1; i < ids.length; i++) if (ids[i] !== ids[i - 1]) switches++;
    expect(switches).toBeGreaterThan(2);
  });

  it('cancels on abort mid-body: the handler signal aborts, no more chunks, the channel stays usable', async () => {
    let signal: AbortSignal | null = null;
    let chunksAfterAbort = 0;
    let aborted = false;
    const { channels, client } = setup(async (req) => {
      if (req.path === '/ok') return { status: 200, headers: {}, body: 'fine' };
      signal = req.signal;
      async function* body(): AsyncGenerator<Uint8Array> {
        for (;;) {
          if (aborted) chunksAfterAbort++;
          yield pattern(1000);
          await tick(1);
        }
      }
      return { status: 200, headers: {}, body: body() };
    });
    const controller = new AbortController();
    const res = await client.fetch('/stream', { signal: controller.signal });
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    aborted = true;
    const sentBefore = channels.server.sent.length;
    await expect(reader.read()).rejects.toThrow();
    await tick(20);
    expect(textFrames(channels.client.sent).some((f) => f.t === 'cancel')).toBe(true);
    expect(signal!.aborted).toBe(true);
    // after the cancel, only the closing error frame; the generator was stopped
    const later = channels.server.sent.slice(sentBefore);
    expect(binaryFrames(later).length).toBeLessThanOrEqual(1);
    expect(textFrames(later).filter((f) => f.t === 'error')).toHaveLength(1);
    expect(chunksAfterAbort).toBeLessThanOrEqual(1);
    expect(channels.client.closed).toBe(false);
    expect(await (await client.fetch('/ok')).text()).toBe('fine');
  });

  it('absorbs chunks still in flight after a cancel, and the next request reads exact', async () => {
    const big = pattern(40 * MAX_CHUNK, 3);
    const next = pattern(3 * MAX_CHUNK, 9);
    const { channels, client } = setup(async (req) => ({ status: 200, headers: {}, body: req.path === '/big' ? big : next }));
    const controller = new AbortController();
    const res = await client.fetch('/big', { signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    const following = client.fetch('/next'); // at once, while /big's chunks are still arriving
    await expect(reader.read()).rejects.toThrow();
    expect(Buffer.from(await (await following).arrayBuffer()).equals(next)).toBe(true);
    await tick(10);
    expect(channels.client.closed).toBe(false);
    // the server really had chunks of /big on the way after the cancel
    const cancelAt = channels.client.sent.findIndex((f) => typeof f === 'string' && JSON.parse(f).t === 'cancel');
    expect(cancelAt).toBeGreaterThanOrEqual(0);
    expect(binaryFrames(channels.server.sent).filter((f) => idOf(f) === 1).length).toBeGreaterThan(2);
  });

  it('closes a response body it will not read when the request was cancelled while the handler ran', async () => {
    let returned = 0;
    let answer: ((res: WireResponse) => void) | null = null;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: pattern(10) }),
        return: async () => {
          returned++;
          return { done: true, value: undefined };
        },
      }),
    };
    const { client } = setup(() => new Promise((resolve) => (answer = resolve)));
    const controller = new AbortController();
    const pending = client.fetch('/x', { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(pending).rejects.toThrow();
    await tick();
    answer!({ status: 200, headers: {}, body });
    await tick();
    expect(returned).toBe(1);
  });

  it('closes a response body it will not read for HEAD, a null-body status or an invalid head', async () => {
    let returned = 0;
    const body = (): AsyncIterable<Uint8Array> => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: pattern(10) }),
        return: async () => {
          returned++;
          return { done: true, value: undefined };
        },
      }),
    });
    const { client } = setup(async (req) =>
      req.path === '/head' ? { status: 200, headers: {}, body: body() } : req.path === '/204' ? { status: 204, headers: {}, body: body() } : { status: 42, headers: {}, body: body() },
    );
    expect((await client.fetch('/head', { method: 'HEAD' })).body).toBeNull();
    expect((await client.fetch('/204')).status).toBe(204);
    await expect(client.fetch('/bad')).rejects.toBeInstanceOf(TypeError);
    await tick();
    expect(returned).toBe(3);
  });

  it(`answers a request beyond ${MAX_REQUESTS} at once with "too many requests"`, async () => {
    let answers: Array<() => void> = [];
    const { channels, client } = setup(
      () => new Promise((resolve) => answers.push(() => resolve({ status: 200, headers: {}, body: 'ok' }))),
    );
    const held = Array.from({ length: MAX_REQUESTS }, (_, i) => client.fetch(`/r${i}`));
    await tick();
    const over = await client.fetch('/over').catch((e: unknown) => e);
    expect(over).toBeInstanceOf(TypeError);
    expect((over as Error).message).toBe('too many requests');
    expect(channels.server.closed).toBe(false);
    for (const a of answers) a();
    answers = [];
    expect((await Promise.all(held)).every((r) => r.status === 200)).toBe(true);
    await tick();
    const after = client.fetch('/after');
    await tick();
    answers[0]!();
    expect((await after).status).toBe(200);
  });

  it('closes the channel when one request holds more than 16 MB of unread body', async () => {
    const { channels, client } = setup(() => new Promise(() => {})); // never reads the body
    const sent = client.fetch('/put', { method: 'PUT', body: new Uint8Array(MAX_QUEUED_BODY_BYTES + MAX_CHUNK) });
    await expect(sent).rejects.toBeInstanceOf(TypeError);
    expect(channels.server.closed).toBe(true);
  });

  it('stops an upload that outlived its error response when the request is aborted later', async () => {
    let pulls = 0;
    let cancelled = false;
    const upload = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls++;
        await tick(5);
        controller.enqueue(pattern(1000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { channels, client } = setup(async () => {
      throw new Error('no');
    });
    const controller = new AbortController();
    const err = await client
      .fetch('/put', { method: 'PUT', body: upload, signal: controller.signal, duplex: 'half' } as RequestInit)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    await tick(20);
    expect(pulls).toBeGreaterThan(1); // still uploading after the error
    controller.abort();
    await tick(20);
    const pullsAfter = pulls;
    await tick(30);
    expect(pulls).toBe(pullsAfter);
    expect(cancelled).toBe(true);
    const heads = textFrames(channels.client.sent);
    expect(heads.some((f) => f.t === 'cancel' && f.id === 1)).toBe(true);
    expect(heads.some((f) => f.t === 'body-end')).toBe(false);
    expect(channels.server.closed).toBe(false);
    expect((await client.fetch('/next').catch((e: unknown) => e)) as Error).toBeInstanceOf(TypeError); // the handler still says no, the channel works
  });

  it('rejects at once when the signal is already aborted, sending nothing', async () => {
    const { channels, client } = setup(async () => ({ status: 200, headers: {}, body: null }));
    const controller = new AbortController();
    controller.abort();
    await expect(client.fetch('/x', { signal: controller.signal })).rejects.toThrow();
    expect(channels.client.sent).toHaveLength(0);
  });

  it('cancels a request that has no answer yet', async () => {
    let signal: AbortSignal | null = null;
    const { client } = setup((req) => {
      signal = req.signal;
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const pending = client.fetch('/slow', { signal: controller.signal });
    await tick();
    controller.abort(new Error('seek'));
    await expect(pending).rejects.toThrow('seek');
    await tick();
    expect(signal!.aborted).toBe(true);
  });

  it('rejects a fetch when the handler throws', async () => {
    const { client } = setup(async () => {
      throw new Error('handler broke');
    });
    await expect(client.fetch('/x')).rejects.toBeInstanceOf(TypeError);
    expect(((await client.fetch('/x').catch((e: unknown) => e)) as Error).message).toContain('handler broke');
  });

  it('errors the body when the handler body throws midway', async () => {
    const { client } = setup(async () => {
      async function* body(): AsyncGenerator<Uint8Array> {
        yield pattern(10);
        throw new Error('disk gone');
      }
      return { status: 200, headers: {}, body: body() };
    });
    const res = await client.fetch('/x');
    await expect(res.arrayBuffer()).rejects.toThrow();
  });

  it('rejects pending fetches and errors open bodies when the channel closes', async () => {
    const { channels, client } = setup(async (req) => {
      if (req.path === '/never') return new Promise(() => {});
      async function* body(): AsyncGenerator<Uint8Array> {
        yield pattern(10);
        await new Promise(() => {});
      }
      return { status: 200, headers: {}, body: body() };
    });
    const open = await client.fetch('/open');
    const reader = open.body!.getReader();
    await reader.read();
    const pending = client.fetch('/never');
    await tick();
    channels.server.close();
    await expect(pending).rejects.toBeInstanceOf(TypeError);
    await expect(reader.read()).rejects.toBeInstanceOf(TypeError);
    await expect(client.fetch('/after')).rejects.toBeInstanceOf(TypeError);
  });

  it('closes with a reason: pending fetches reject with it', async () => {
    const { channels, client } = setup(() => new Promise(() => {}));
    const pending = client.fetch('/x');
    const reason = new Error('route changed');
    client.close(reason);
    await expect(pending).rejects.toBe(reason);
    expect(channels.client.closed).toBe(true);
  });

  it('aborts the handlers when the server closes', async () => {
    let signal: AbortSignal | null = null;
    const { channels, client, server } = setup((req) => {
      signal = req.signal;
      return new Promise(() => {});
    });
    const pending = client.fetch('/x');
    await tick();
    server.close();
    expect(signal!.aborted).toBe(true);
    expect(channels.server.closed).toBe(true);
    await expect(pending).rejects.toThrow();
  });

  describe('garbage closes the channel', () => {
    const cases: Array<[string, () => string | Uint8Array]> = [
      ['a head over 16 KB', () => JSON.stringify({ t: 'req', id: 1, method: 'GET', path: '/x', headers: { a: 'x'.repeat(17000) } })],
      ['invalid JSON', () => '{nope'],
      ['a binary frame for an unknown id', () => new Uint8Array([0, 0, 0, 9, 1, 2, 3])],
      ['a short binary frame', () => new Uint8Array([0, 0])],
      ['an unknown frame type', () => JSON.stringify({ t: 'what', id: 1 })],
      ['a request without a path', () => JSON.stringify({ t: 'req', id: 1, method: 'GET', headers: {} })],
      ['a request with a non-string header', () => JSON.stringify({ t: 'req', id: 1, method: 'GET', path: '/x', headers: { a: 1 } })],
    ];
    for (const [name, frame] of cases) {
      it(`on the server: ${name}`, async () => {
        const { channels } = setup(async () => ({ status: 200, headers: {}, body: null }));
        expect(() => channels.server.onmessage!(frame())).not.toThrow();
        await tick();
        expect(channels.server.closed).toBe(true);
      });
    }

    it('on the server: a duplicate request id', async () => {
      const { channels } = setup(() => new Promise(() => {}));
      const req = JSON.stringify({ t: 'req', id: 1, method: 'GET', path: '/x', headers: {} });
      channels.server.onmessage!(req);
      expect(() => channels.server.onmessage!(req)).not.toThrow();
      expect(channels.server.closed).toBe(true);
    });

    it('on the client: a binary frame for an unknown id rejects pending fetches', async () => {
      const { channels, client } = setup(() => new Promise(() => {}));
      const pending = client.fetch('/x');
      await tick();
      expect(() => channels.client.onmessage!(new Uint8Array([0, 0, 0, 77, 1]))).not.toThrow();
      expect(channels.client.closed).toBe(true);
      await expect(pending).rejects.toBeInstanceOf(TypeError);
    });

    it('on the client: a response with an impossible status', async () => {
      const { channels, client } = setup(() => new Promise(() => {}));
      const pending = client.fetch('/x');
      await tick();
      expect(() => channels.client.onmessage!(JSON.stringify({ t: 'res', id: 1, status: 99, headers: {} }))).not.toThrow();
      expect(channels.client.closed).toBe(true);
      await expect(pending).rejects.toBeInstanceOf(TypeError);
    });
  });

  it('stops sending above the high-water mark and resumes when the buffer drains', async () => {
    const data = pattern(6 << 20);
    const { channels, client } = setup(async () => ({ status: 200, headers: {}, body: data }));
    channels.server.manual = true;
    const res = await client.fetch('/big');
    const done = res.arrayBuffer();
    await tick(10);
    const firstBurst = binaryFrames(channels.server.sent).length;
    expect(channels.server.bufferedAmount).toBeGreaterThan(HIGH_WATER);
    expect(channels.server.bufferedAmount).toBeLessThanOrEqual(HIGH_WATER + MAX_CHUNK + 1024);
    await tick(10);
    expect(binaryFrames(channels.server.sent).length).toBe(firstBurst);
    channels.server.drain();
    await tick(10);
    channels.server.drain();
    expect(Buffer.from(await done).equals(data)).toBe(true);
    expect(binaryFrames(channels.server.sent).length).toBeGreaterThan(firstBurst);
  });
});
