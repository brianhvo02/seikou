import { describe, expect, it } from 'vitest';
import { Pacer, RateLimited } from '@seikou/titles/pacer';
import { TooLargeArchive } from './archive';
import { NotFoundOnTosho, createTosho } from './tosho';

const BASES = { feed: 'https://feed.example', site: 'https://animetosho.net' };
const json = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { status: 200, ...init });
const make = (fetchFn: unknown) => createTosho(fetchFn as typeof fetch, new Pacer(100, 1000), 'ua', BASES);

const sub = (code: string, name: string): unknown => ({
  type: 'subtitle',
  info: { format: 'ASS', language_code: code, language: 'x', name, default: name === 'Full', forced: false },
  url: `https://storage.example/releases/1/subtitles/${name}.ass.xz`,
});
const TORRENT = {
  id: 628331,
  title: 'Starfall Wanderer 01',
  info_hash: 'abc123',
  status: 'complete',
  is_seadex: true,
  timestamp: 1700000000,
  files: [{ id: 41156, filename: 'ep1.mkv', size: 123, attachments: [sub('eng', 'Full'), { type: 'other', url: 'x' }, sub('jpn', 'Signs')] }],
};

describe('Anime Tosho', () => {
  it('reads tracks per file', async () => {
    const seen: string[] = [];
    const t = make(async (u: string) => (seen.push(u), json(TORRENT)));
    const r = await t.byHash('abc123');
    expect(seen[0]).toBe('https://feed.example/json?show=torrent&btih=abc123');
    expect(r?.isSeadex).toBe(true);
    expect(r?.date).toBe(1700000000);
    const f = r!.files[0]!;
    expect(f.id).toBe(41156);
    expect(f.name).toBe('ep1.mkv');
    expect(f.tracks.length).toBe(2);
    expect(f.tracks.map((x) => x.track)).toEqual([0, 1]);
    expect(f.tracks.map((x) => x.language)).toEqual(['eng', 'jpn']);
    expect(f.tracks[0]!.isDefault).toBe(true);
    expect(f.tracks[0]!.format).toBe('ASS');
  });

  it('byId asks by id', async () => {
    const seen: string[] = [];
    await make(async (u: string) => (seen.push(u), json(TORRENT))).byId(628331);
    expect(seen[0]).toBe('https://feed.example/json?show=torrent&id=628331');
  });

  it('feed error is null', async () => {
    const t = make(async () => json({ error: 'Requested torrent not found' }));
    expect(await t.byHash('zz')).toBeNull();
  });

  it('search returns releases without files', async () => {
    const seen: string[] = [];
    const t = make(async (u: string) => (seen.push(u), json([{ id: 1, title: 'A', info_hash: 'h', status: 'complete', timestamp: 5 }])));
    const r = await t.search('starfall wanderer');
    expect(seen[0]).toBe('https://feed.example/json?q=starfall%20wanderer');
    expect(r).toHaveLength(1);
    expect(r[0]!.files).toEqual([]);
    expect(r[0]!.infoHash).toBe('h');
  });

  it('fontPackUrl', () => {
    expect(make(async () => json({})).fontPackUrl(41156)).toBe('https://animetosho.net/download/file/41156/attachments');
  });

  it('download returns the bytes and 404 throws NotFoundOnTosho', async () => {
    const ok = make(async () => new Response(new Uint8Array([1, 2, 3])));
    expect([...(await ok.download('https://storage.animetosho.net/a.xz'))]).toEqual([1, 2, 3]);
    const missing = make(async () => new Response('no', { status: 404 }));
    await expect(missing.download('https://storage.animetosho.net/a.xz')).rejects.toBeInstanceOf(NotFoundOnTosho);
  });

  it('refuses a download past its cap, by Content-Length or by the bytes that arrive', async () => {
    let cancelled = false;
    const declared = make(async () => new Response(new ReadableStream({ cancel: () => { cancelled = true; } }), { headers: { 'Content-Length': '11' } }));
    await expect(declared.download('https://storage.animetosho.net/a.xz', undefined, 10)).rejects.toBeInstanceOf(TooLargeArchive);
    expect(cancelled).toBe(true);
    // an endless body with no Content-Length stops at the cap
    let pulled = 0;
    const streamed = make(async () => new Response(new ReadableStream({ pull: (c) => { pulled++; c.enqueue(new Uint8Array(6)); } })));
    await expect(streamed.download('https://storage.animetosho.net/a.xz', undefined, 10)).rejects.toBeInstanceOf(TooLargeArchive);
    expect(pulled).toBeLessThan(5);
    const fits = make(async () => new Response(new Uint8Array(10)));
    expect((await fits.download('https://storage.animetosho.net/a.xz', undefined, 10)).length).toBe(10);
  });

  it('fetches only https URLs of the configured hosts or animetosho.net, checked after every redirect', async () => {
    const seen: string[] = [];
    const hops: Record<string, string> = {
      'https://animetosho.net/download/file/1/attachments': 'https://storage.animetosho.net/attach/1.7z',
      'https://animetosho.net/bad': 'https://evil.example/x',
      'https://animetosho.net/r1': 'https://animetosho.net/r2',
      'https://animetosho.net/r2': 'https://animetosho.net/r3',
      'https://animetosho.net/r3': 'https://animetosho.net/r4',
      'https://animetosho.net/r4': 'https://animetosho.net/r5',
    };
    const t = make(async (u: string, init: RequestInit) => {
      seen.push(u);
      expect(init.redirect).toBe('manual');
      const to = hops[u];
      return to ? new Response(null, { status: 302, headers: { Location: to } }) : new Response(new Uint8Array([1]));
    });
    expect([...(await t.download('https://animetosho.net/download/file/1/attachments'))]).toEqual([1]);
    expect(seen).toEqual(['https://animetosho.net/download/file/1/attachments', 'https://storage.animetosho.net/attach/1.7z']);
    expect((await t.download('https://animetosho.net/r2')).length).toBe(1);
    for (const bad of ['http://storage.animetosho.net/a.xz', 'https://evil.example/a.xz', 'https://animetosho.net.evil.example/a.xz', 'http://127.0.0.1:4193/a.xz', 'https://animetosho.net/bad', 'https://animetosho.net/r1']) {
      seen.length = 0;
      await expect(t.download(bad)).rejects.toBeInstanceOf(NotFoundOnTosho);
      expect(seen.every((u) => !u.includes('evil.example') && !u.startsWith('http:'))).toBe(true);
    }
    // a loopback base (the test stand-in) lets loopback http through
    const local = createTosho((async () => new Response(new Uint8Array([2]))) as unknown as typeof fetch, new Pacer(100, 1000), 'ua', { feed: 'http://127.0.0.1:4193/feed', site: 'http://127.0.0.1:4193' });
    expect([...(await local.download('http://127.0.0.1:4193/files/a.xz'))]).toEqual([2]);
    await expect(local.download('http://example.com/a.xz')).rejects.toBeInstanceOf(NotFoundOnTosho);
  });

  it('429 throws RateLimited with retryAfterMs 3000', async () => {
    let n = 0;
    const pacer = { run: <T>(fn: () => Promise<T>) => (n++, fn()) } as unknown as Pacer;
    const t = createTosho((async () => new Response('', { status: 429, headers: { 'Retry-After': '3' } })) as unknown as typeof fetch, pacer, 'ua', BASES);
    const err = await t.byHash('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimited);
    expect((err as RateLimited).retryAfterMs).toBe(3000);
  });
});
