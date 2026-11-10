// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { SubtitleRecord } from './api-types';
import { ApiError, base64UrlJson, createApi, helperSessionId, type FetchLike } from './api';

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

/** The helper session the client talks to. */
const SID = '0123456789abcdef';
/** The session's API path. */
const S = `/api/sessions/${SID}`;

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('createApi', () => {
  it('sends the token as a bearer header and unwraps search answers', async () => {
    const { fetch, calls } = recorder(() => ok({ candidates: [{ alId: 900101, title: 'Lantern Harbor' }] }));
    const api = createApi('http://127.0.0.1:4195/', 'secret', SID, fetch);
    const hits = await api.searchTitles('lantern harbor');
    expect(hits[0]!.alId).toBe(900101);
    expect(calls[0]!.url).toBe(`http://127.0.0.1:4195${S}/titles/search?q=lantern+harbor`);
    expect(calls[0]!.headers.Authorization).toBe('Bearer secret');
  });

  it('turns a cover path into a URL of the backend with the token', async () => {
    const { fetch } = recorder(() => ok({ candidates: [{ alId: 900101, poster: `${S}/titles/900101/cover` }, { alId: 2, poster: null }] }));
    const hits = await createApi('http://127.0.0.1:4195/', 'secret', SID, fetch).searchTitles('lantern');
    expect(hits.map((h) => h.poster)).toEqual([`http://127.0.0.1:4195${S}/titles/900101/cover?t=secret`, null]);
  });

  it('posts a fetch with its offset and body', async () => {
    const { fetch, calls } = recorder(() => ok({ key: 'tosho-7' }));
    await createApi('', 'secret', SID, fetch).fetchRelease(7, 2);
    expect(calls[0]).toMatchObject({ url: `${S}/fansubs/fetch?offset=2`, method: 'POST', body: '{"toshoId":7}' });
  });

  it('uploads each file into one batch, then commits it', async () => {
    const { fetch, calls } = recorder((c) => (c.url.includes('/commit') ? ok({ key: 'local-0123456789abcdef' }) : ok({})));
    const files = [new File(['a'], 'Lantern Harbor 01.ass'), new File(['b'], 'Harbor.ttf')];
    const answer = await createApi('', 'secret', SID, fetch).upload(files, 0);
    expect(answer.key).toBe('local-0123456789abcdef');
    const batch = new RegExp(`^${S}/uploads/([0-9a-f]{16})/`).exec(calls[0]!.url)?.[1];
    expect(batch).toBeDefined();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PUT ${S}/uploads/${batch}/Lantern%20Harbor%2001.ass`,
      `PUT ${S}/uploads/${batch}/Harbor.ttf`,
      `POST ${S}/uploads/${batch}/commit?offset=0`,
    ]);
  });

  it('builds subtitle URLs with the file id, the timing and the token', () => {
    const api = createApi('', 'secret', SID, async () => ok({}));
    const timing = { kind: 'offset', offsetMs: 1200, confidence: 0.9 } as const;
    const url = new URL(api.subtitleUrl(1, 'tosho-7', '11', 't1', timing), 'http://x');
    expect(url.pathname).toBe(`${S}/episodes/1/subtitle`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ release: 'tosho-7', file: '11', track: 't1', timing: base64UrlJson(timing), t: 'secret' });
    const original = new URL(api.subtitleUrl(1, 'tosho-7', '11', 't1', { kind: 'original' }), 'http://x');
    expect(original.searchParams.has('timing')).toBe(false);
    expect(api.fontUrl('tosho-7', 'Harbor Sans.ttf')).toBe(`${S}/releases/tosho-7/fonts/Harbor%20Sans.ttf?t=secret`);
  });

  it("describes the disc for the engine: an absolute base, the token and the manifest", async () => {
    const manifest = { discId: 'x', name: 'HARBOR_1', files: [], inline: {} };
    const { fetch, calls } = recorder(() => ok(manifest));
    const spec = await createApi('http://127.0.0.1:4195', 'secret', SID, fetch).remoteDisc('f.ab/c');
    expect(calls[0]!.url).toBe('http://127.0.0.1:4195/api/discs/f.ab%2Fc/manifest');
    expect(spec).toEqual({ kind: 'remote', base: 'http://127.0.0.1:4195/api/discs/f.ab%2Fc/', token: 'secret', manifest });
  });

  it('asks the session itself, its episodes and its record under the session, and the disc outside it', async () => {
    const { fetch, calls } = recorder(() => ok({}));
    const api = createApi('', 'secret', SID, fetch);
    await api.session();
    await api.episodes();
    await api.record();
    await api.remoteDisc('f.ab').catch(() => undefined);
    expect(calls.map((c) => c.url)).toEqual([S, `${S}/episodes`, `${S}/record`, '/api/discs/f.ab/manifest']);
  });

  it('asks to replace a record of another episode list only when told to', async () => {
    const { fetch, calls } = recorder(() => ok({}));
    const api = createApi('', 'secret', SID, fetch);
    const rec = { episodeSpec: '1-5' } as unknown as SubtitleRecord;
    await api.saveRecord(rec);
    await api.saveRecord(rec, true);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`PUT ${S}/record`, `PUT ${S}/record?replace=1`]);
  });

  it('reads and saves the episode info of the disc playlist it is given, outside the session', async () => {
    const info = { chapterNames: { '2': 'Opening' }, titles: {}, savedAt: '2026-11-09T10:00:00.000Z' };
    const { fetch, calls } = recorder(() => ok({ info }));
    const api = createApi('', 'secret', SID, fetch);
    expect(await api.episodeInfo('f.ab', '00800')).toEqual(info);
    expect(await api.saveEpisodeInfo('f.ab', '00800', info)).toEqual(info);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/discs/f.ab/playlists/00800/info', 'PUT /api/discs/f.ab/playlists/00800/info']);
    // only the two maps are sent; the backend stamps savedAt
    expect(JSON.parse(calls[1]!.body as string)).toEqual({ chapterNames: { '2': 'Opening' }, titles: {} });
  });

  it('encodes timing as unpadded base64url JSON', () => {
    const text = base64UrlJson({ kind: 'split', parts: [{ fromMs: 0, offsetMs: -500 }], confidence: 0.5 });
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(atob(text.replace(/-/g, '+').replace(/_/g, '/')))).toEqual({ kind: 'split', parts: [{ fromMs: 0, offsetMs: -500 }], confidence: 0.5 });
  });

  it('turns an error answer into an ApiError with its code and details', async () => {
    const { fetch } = recorder(() => new Response(JSON.stringify({ error: 'source-unavailable', source: 'seadex' }), { status: 503 }));
    const err = await createApi('', 'secret', SID, fetch).seadex(900101).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503, code: 'source-unavailable', details: { source: 'seadex' } });
    expect((err as ApiError).message).toBe('The service is not answering. Try again in a moment.');
  });

  it('reports an unreachable backend as a network error', async () => {
    const err = await createApi('', 'secret', SID, async () => Promise.reject(new TypeError('fetch failed'))).session().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: 'network' });
  });
});

describe('helperSessionId', () => {
  it('reads the session id from the helper page path', () => {
    expect(helperSessionId('/helper/0123456789abcdef')).toBe('0123456789abcdef');
    expect(helperSessionId('/helper/0123456789abcdef/')).toBe('0123456789abcdef');
    for (const path of ['/', '/helper', '/helper/', '/helper/xyz', '/helper/0123456789abcdef/more', '/queue']) {
      expect(helperSessionId(path), path).toBeNull();
    }
  });
});
