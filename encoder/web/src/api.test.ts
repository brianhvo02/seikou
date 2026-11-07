// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ApiError, base64UrlJson, createApi, type FetchLike } from './api';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function recorder(answer: (call: Call) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body };
    calls.push(call);
    return answer(call);
  };
  return { fetch, calls };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('createApi', () => {
  it('sends the token as a bearer header and unwraps search answers', async () => {
    const { fetch, calls } = recorder(() => ok({ candidates: [{ alId: 900101, title: 'Lantern Harbor' }] }));
    const api = createApi('http://127.0.0.1:4195/', 'secret', fetch);
    const hits = await api.searchTitles('lantern harbor');
    expect(hits[0]!.alId).toBe(900101);
    expect(calls[0]!.url).toBe('http://127.0.0.1:4195/api/titles/search?q=lantern+harbor');
    expect(calls[0]!.headers.Authorization).toBe('Bearer secret');
  });

  it('posts a fetch with its offset and body', async () => {
    const { fetch, calls } = recorder(() => ok({ key: 'tosho-7' }));
    await createApi('', 'secret', fetch).fetchRelease(7, 2);
    expect(calls[0]).toMatchObject({ url: '/api/fansubs/fetch?offset=2', method: 'POST', body: '{"toshoId":7}' });
  });

  it('uploads each file into one batch, then commits it', async () => {
    const { fetch, calls } = recorder((c) => (c.url.includes('/commit') ? ok({ key: 'local-0123456789abcdef' }) : ok({})));
    const files = [new File(['a'], 'Lantern Harbor 01.ass'), new File(['b'], 'Harbor.ttf')];
    const answer = await createApi('', 'secret', fetch).upload(files, 0);
    expect(answer.key).toBe('local-0123456789abcdef');
    const batch = /^\/api\/uploads\/([0-9a-f]{16})\//.exec(calls[0]!.url)?.[1];
    expect(batch).toBeDefined();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PUT /api/uploads/${batch}/Lantern%20Harbor%2001.ass`,
      `PUT /api/uploads/${batch}/Harbor.ttf`,
      `POST /api/uploads/${batch}/commit?offset=0`,
    ]);
  });

  it('builds subtitle URLs with the file id, the timing and the token', () => {
    const api = createApi('', 'secret', async () => ok({}));
    const timing = { kind: 'offset', offsetMs: 1200, confidence: 0.9 } as const;
    const url = new URL(api.subtitleUrl(1, 'tosho-7', '11', 't1', timing), 'http://x');
    expect(url.pathname).toBe('/api/episodes/1/subtitle');
    expect(Object.fromEntries(url.searchParams)).toEqual({ release: 'tosho-7', file: '11', track: 't1', timing: base64UrlJson(timing), t: 'secret' });
    const original = new URL(api.subtitleUrl(1, 'tosho-7', '11', 't1', { kind: 'original' }), 'http://x');
    expect(original.searchParams.has('timing')).toBe(false);
    expect(api.fontUrl('tosho-7', 'Harbor Sans.ttf')).toBe('/api/releases/tosho-7/fonts/Harbor%20Sans.ttf?t=secret');
  });

  it('encodes timing as unpadded base64url JSON', () => {
    const text = base64UrlJson({ kind: 'split', parts: [{ fromMs: 0, offsetMs: -500 }], confidence: 0.5 });
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(atob(text.replace(/-/g, '+').replace(/_/g, '/')))).toEqual({ kind: 'split', parts: [{ fromMs: 0, offsetMs: -500 }], confidence: 0.5 });
  });

  it('turns an error answer into an ApiError with its code and details', async () => {
    const { fetch } = recorder(() => new Response(JSON.stringify({ error: 'source-unavailable', source: 'seadex' }), { status: 503 }));
    const err = await createApi('', 'secret', fetch).seadex(900101).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503, code: 'source-unavailable', details: { source: 'seadex' } });
    expect((err as ApiError).message).toBe('The service is not answering. Try again in a moment.');
  });

  it('reports an unreachable backend as a network error', async () => {
    const err = await createApi('', 'secret', async () => Promise.reject(new TypeError('fetch failed'))).session().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: 'network' });
  });
});
