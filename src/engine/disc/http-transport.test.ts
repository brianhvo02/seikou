import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeNas, FAKE_NAS_BASE } from '../../../tests/helpers/fake-nas';
import { DiscError } from '@seikou/bdmv/byte-source';
import { createByteSource } from './disc-spec';
import { HttpTransport, RemoteDiscError, TokenRelay } from './http-transport';

interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** A fetch that records each request and answers with `answer`. */
function recording(answer: (url: string, n: number) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)) });
    return answer(String(input), seen.length);
  };
  return { fetch: fake as typeof fetch, seen };
}

/** A fetch that never answers, rejecting with the reason once its signal aborts. */
function hanging(): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })) as typeof fetch;
}

const partial = (bytes: number[]): Response => new Response(new Uint8Array(bytes), { status: 206 });

afterEach(() => {
  vi.useRealTimers();
});

describe('HttpTransport', () => {
  it('asks for <base>files/<each segment encoded>?t=<token> with a single Range header and nothing else', async () => {
    const { fetch, seen } = recording(() => partial([1, 2, 3]));
    const t = new HttpTransport(FAKE_NAS_BASE, 'a+b/c', { fetch });
    expect(Array.from(await t.read('BDMV/STREAM/00001 #?%+鋼.M2TS', 192, 3))).toEqual([1, 2, 3]);
    expect(seen).toEqual([
      {
        url: `${FAKE_NAS_BASE}files/BDMV/STREAM/00001%20%23%3F%25%2B%E9%8B%BC.M2TS?t=a%2Bb%2Fc`,
        headers: { range: 'bytes=192-194' },
      },
    ]);
  });

  it('reads through the fake NAS, and answers an empty range at the end of the file', async () => {
    const nas = fakeNas(new Map([['BDMV/STREAM/00001.M2TS', new Uint8Array([9, 8, 7, 6])]]));
    const t = new HttpTransport(FAKE_NAS_BASE, 'tok', { fetch: nas.fetch });
    expect(Array.from(await t.read('BDMV/STREAM/00001.M2TS', 2, 10))).toEqual([7, 6]);
    expect((await t.read('BDMV/STREAM/00001.M2TS', 4, 10)).length).toBe(0);
  });

  it('on a 401 asks refreshToken once, retries with the new token, and the read succeeds (Review Focus 3)', async () => {
    const { fetch, seen } = recording((url) => (url.endsWith('?t=new') ? partial([5]) : Response.json({ error: 'unauthorized' }, { status: 401 })));
    const refreshToken = vi.fn(async () => 'new');
    const t = new HttpTransport(FAKE_NAS_BASE, 'old', { fetch, refreshToken });
    expect(Array.from(await t.read('BDMV/X', 0, 1))).toEqual([5]);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(seen.map((s) => s.url.split('?')[1])).toEqual(['t=old', 't=new']);
    // the new token stays
    expect(Array.from(await t.read('BDMV/X', 0, 1))).toEqual([5]);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('shares one refresh between reads that get 401 together', async () => {
    const { fetch } = recording((url) => (url.endsWith('?t=new') ? partial([5]) : new Response(null, { status: 401 })));
    const refreshToken = vi.fn(async () => 'new');
    const t = new HttpTransport(FAKE_NAS_BASE, 'old', { fetch, refreshToken });
    await Promise.all([t.read('A', 0, 1), t.read('B', 0, 1), t.read('C', 0, 1)]);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('a second 401 after the refresh rejects: this device is no longer paired', async () => {
    const { fetch } = recording(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
    const refreshToken = vi.fn(async () => 'new');
    const t = new HttpTransport(FAKE_NAS_BASE, 'old', { fetch, refreshToken });
    const err = await t.read('BDMV/X', 0, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscError);
    expect(err).toMatchObject({ code: 'read-failed', message: 'This device is no longer paired with the NAS.', reason: 'nas-unpaired' });
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('a refresh that fails, or none at all, is unpaired too', async () => {
    const { fetch } = recording(() => new Response(null, { status: 401 }));
    const failing = new HttpTransport(FAKE_NAS_BASE, 'old', { fetch, refreshToken: () => Promise.reject(new Error('timeout')) });
    await expect(failing.read('X', 0, 1)).rejects.toMatchObject({ message: 'This device is no longer paired with the NAS.' });
    const without = new HttpTransport(FAKE_NAS_BASE, 'old', { fetch });
    await expect(without.read('X', 0, 1)).rejects.toMatchObject({ message: 'This device is no longer paired with the NAS.' });
  });

  it('a 404 disc-changed rejects with source-changed and the copy (Review Focus 2)', async () => {
    const { fetch } = recording(() => Response.json({ error: 'disc-changed' }, { status: 404 }));
    const t = new HttpTransport(FAKE_NAS_BASE, 'tok', { fetch });
    const err = await t.read('BDMV/X', 0, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteDiscError);
    expect(err).toMatchObject({ code: 'source-changed', message: 'This disc changed on the NAS. Open its folder again.', reason: 'disc-changed' });
  });

  it('a network failure is a lost connection; other answers fail the read', async () => {
    const down = new HttpTransport(FAKE_NAS_BASE, 'tok', { fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch });
    await expect(down.read('X', 0, 1)).rejects.toMatchObject({ code: 'read-failed', message: 'Connection to the NAS lost.', reason: 'nas-lost' });
    const broken = new HttpTransport(FAKE_NAS_BASE, 'tok', { fetch: recording(() => new Response('oops', { status: 500 })).fetch });
    await expect(broken.read('X', 0, 1)).rejects.toMatchObject({ code: 'read-failed' });
  });

  it('rejects with the signal reason when the caller aborts', async () => {
    const t = new HttpTransport(FAKE_NAS_BASE, 'tok', { fetch: hanging() });
    const controller = new AbortController();
    const reading = t.read('X', 0, 1, controller.signal);
    const reason = new DOMException('seek', 'AbortError');
    controller.abort(reason);
    await expect(reading).rejects.toBe(reason);
  });

  it('appends the query after the token to every URL, and keeps it across a token refresh', async () => {
    const { fetch, seen } = recording((url) => (url.includes('t=new') ? partial([5]) : new Response(null, { status: 401 })));
    const t = new HttpTransport(FAKE_NAS_BASE, 'old', { fetch, query: 'level=l1&audio=2', refreshToken: async () => 'new' });
    await t.read('BDMV/X', 0, 1);
    await t.read('BDMV/Y', 0, 1);
    expect(seen.map((s) => s.url.split('?')[1])).toEqual(['t=old&level=l1&audio=2', 't=new&level=l1&audio=2', 't=new&level=l1&audio=2']);
  });

  it('a 503 with Retry-After: 1 is retried after 1 s with the same range, then succeeds', async () => {
    vi.useFakeTimers();
    const { fetch, seen } = recording((_url, n) => (n === 1 ? new Response(null, { status: 503, headers: { 'Retry-After': '1' } }) : partial([4])));
    const t = new HttpTransport(FAKE_NAS_BASE, 'tok', { fetch });
    const reading = t.read('BDMV/X', 10, 1);
    await vi.advanceTimersByTimeAsync(999);
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(Array.from(await reading)).toEqual([4]);
    expect(seen.map((s) => s.headers.range)).toEqual(['bytes=10-10', 'bytes=10-10']);
  });

  it('keeps retrying 503s until the 30 s request budget, measured from the first attempt, then fails as lost', async () => {
    vi.useFakeTimers();
    const { fetch, seen } = recording(() => new Response(null, { status: 503, headers: { 'Retry-After': '1' } }));
    const t = new HttpTransport(FAKE_NAS_BASE, 'tok', { fetch });
    const settled = t.read('BDMV/X', 0, 1).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await settled).toMatchObject({ code: 'read-failed', message: 'Connection to the NAS lost.', reason: 'nas-lost' });
    expect(seen.length).toBeGreaterThan(25);
  });

  it('a 503 without Retry-After is a refusal: no retry, the read fails with the NAS message', async () => {
    const { fetch, seen } = recording(() => Response.json({ error: 'busy', message: 'The NAS is busy.' }, { status: 503 }));
    const t = new HttpTransport(FAKE_NAS_BASE, 'tok', { fetch });
    await expect(t.read('BDMV/X', 0, 1)).rejects.toMatchObject({ code: 'read-failed', message: 'The NAS is busy.' });
    expect(seen).toHaveLength(1);
  });

  it('a 503 whose Retry-After is hidden (not CORS-exposed) but whose body says retry is retried after 1 s', async () => {
    vi.useFakeTimers();
    const { fetch, seen } = recording((_url, n) => (n === 1 ? Response.json({ error: 'retry' }, { status: 503 }) : partial([7])));
    const t = new HttpTransport(FAKE_NAS_BASE, 'tok', { fetch });
    const reading = t.read('BDMV/X', 3, 1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(Array.from(await reading)).toEqual([7]);
    expect(seen).toHaveLength(2);
  });

  it('an abort during the Retry-After wait rejects at once', async () => {
    vi.useFakeTimers();
    const { fetch } = recording(() => new Response(null, { status: 503, headers: { 'Retry-After': '1' } }));
    const t = new HttpTransport(FAKE_NAS_BASE, 'tok', { fetch });
    const controller = new AbortController();
    const reading = t.read('X', 0, 1, controller.signal);
    const settled = reading.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    const reason = new DOMException('seek', 'AbortError');
    controller.abort(reason);
    expect(await settled).toBe(reason);
  });
});

describe('createByteSource (remote)', () => {
  it('passes the spec query to every files request', async () => {
    const { fetch, seen } = recording(() => new Response(new Uint8Array(1), { status: 206 }));
    const spec = { kind: 'remote', base: FAKE_NAS_BASE, token: 'tok', query: 'level=l1&audio=0', manifest: { discId: 'd', name: 'D', files: [{ path: 'BDMV/STREAM/00001.M2TS', size: 10 }], inline: {} } } as const;
    const source = createByteSource(spec, { fetch, readAheadBytes: 0, onWaiting: () => undefined });
    await source.read('BDMV/STREAM/00001.M2TS', 0, 1);
    expect(seen.map((s) => s.url)).toEqual([`${FAKE_NAS_BASE}files/BDMV/STREAM/00001.M2TS?t=tok&level=l1&audio=0`]);
  });

  it('a first read that takes 3.5 s shows waiting at 3 s and clears it when it lands', async () => {
    vi.useFakeTimers();
    const nas = fakeNas(new Map([['BDMV/STREAM/00001.M2TS', new Uint8Array([1, 2, 3])]]));
    const slow = ((input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve) => setTimeout(() => resolve(nas.fetch(input, init)), 3_500))) as typeof fetch;
    const waiting: boolean[] = [];
    const source = createByteSource(nas.spec, { fetch: slow, readAheadBytes: 16 * 1024 * 1024, onWaiting: (w) => waiting.push(w) });
    const reading = source.read('BDMV/STREAM/00001.M2TS', 0, 3);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(waiting).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(waiting).toEqual([true]);
    await vi.advanceTimersByTimeAsync(500);
    expect(Array.from(await reading)).toEqual([1, 2, 3]);
    expect(waiting).toEqual([true, false]);
  });

  it('a read still pending at 30 s rejects: connection to the NAS lost', async () => {
    vi.useFakeTimers();
    const nas = fakeNas(new Map([['BDMV/STREAM/00001.M2TS', new Uint8Array(3)]]));
    const waiting: boolean[] = [];
    const source = createByteSource(nas.spec, { fetch: hanging(), readAheadBytes: 16 * 1024 * 1024, onWaiting: (w) => waiting.push(w) });
    const reading = source.read('BDMV/STREAM/00001.M2TS', 0, 3);
    const settled = reading.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(29_999);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toMatchObject({ code: 'read-failed', message: 'Connection to the NAS lost.' });
    expect(waiting).toEqual([true, false]);
  });

  it('serves inlined files from the manifest and the rest through the files route', async () => {
    const nas = fakeNas(new Map([['BDMV/index.bdmv', new Uint8Array([1])], ['BDMV/STREAM/00001.M2TS', new Uint8Array([2])]]));
    const source = createByteSource(nas.spec, { fetch: nas.fetch, readAheadBytes: 16 * 1024 * 1024, onWaiting: () => undefined });
    expect(Array.from(await source.read('BDMV/INDEX.BDMV', 0, 1))).toEqual([1]);
    expect(Array.from(await source.read('BDMV/STREAM/00001.M2TS', 0, 1))).toEqual([2]);
    expect(nas.requested).toEqual(['BDMV/STREAM/00001.M2TS']);
  });

  it('reads past 4 GiB: offsets and the Range header beyond 2^32, chunk-aligned, a mixed-case path asked as listed', async () => {
    const chunk = 2 * 1024 * 1024;
    const { fetch, seen } = recording((_url) => new Response(new Uint8Array(chunk).fill(7), { status: 206 }));
    const spec = {
      kind: 'remote',
      base: FAKE_NAS_BASE,
      token: 'tok',
      manifest: { discId: 'd1', name: 'Big', files: [{ path: 'BDMV/STREAM/00001.M2TS', size: 6_000_000_000 }], inline: {} },
    } as const;
    const source = createByteSource(spec, { fetch, readAheadBytes: 0, chunkBytes: chunk, onWaiting: () => undefined });
    expect(source.size('bdmv/stream/00001.m2ts')).toBe(6_000_000_000);
    const bytes = await source.read('bdmv/stream/00001.m2ts', 5_000_000_000, 4);
    expect(Array.from(bytes)).toEqual([7, 7, 7, 7]);
    const first = Math.floor(5_000_000_000 / chunk) * chunk;
    expect(seen).toEqual([{ url: `${FAKE_NAS_BASE}files/BDMV/STREAM/00001.M2TS?t=tok`, headers: { range: `bytes=${first}-${first + chunk - 1}` } }]);
  });
});

describe('TokenRelay', () => {
  it('asks once for every waiter and settles them with the next token', async () => {
    const ask = vi.fn();
    const relay = new TokenRelay(ask, (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    });
    const a = relay.request();
    const b = relay.request();
    expect(ask).toHaveBeenCalledTimes(1);
    relay.deliver('t2');
    expect(await Promise.all([a, b])).toEqual(['t2', 't2']);
  });

  it('gives up after 10 s', async () => {
    vi.useFakeTimers();
    const relay = new TokenRelay(() => undefined, (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    });
    const settled = relay.request().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await settled).toBeInstanceOf(Error);
  });
});
