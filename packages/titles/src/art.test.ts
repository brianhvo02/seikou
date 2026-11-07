import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtCache } from './art';

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'art-')), 'art');
});
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

const ID1 = 'a'.repeat(32);
const ID2 = 'b'.repeat(32);
const ID3 = 'c'.repeat(32);

/** A fetch answering `bytes` bytes of image/jpeg for every URL, recording the URLs. */
function fetcher(bytes = 10): typeof globalThis.fetch & { urls: string[] } {
  const urls: string[] = [];
  const f = vi.fn(async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(new Uint8Array(bytes).fill(7), { headers: { 'content-type': 'image/jpeg' } });
  });
  return Object.assign(f as unknown as typeof globalThis.fetch, { urls });
}

describe('ArtCache', () => {
  it('M4: fetches only https images from AniList and TMDB image hosts', async () => {
    const fetch = fetcher();
    const art = new ArtCache(dir, fetch);
    for (const url of ['http://s4.anilist.co/a.jpg', 'https://evil.example/a.jpg', 'https://s4.anilist.co.evil.example/a.jpg', 'https://user@evil.example/a.jpg', 'file:///etc/passwd', 'not a url']) {
      expect(await art.get(ID1, 'small', url), url).toBeNull();
    }
    expect(fetch.urls).toEqual([]);
    expect(await art.get(ID1, 'small', 'https://image.tmdb.org/t/p/w185/a.jpg')).not.toBeNull();
    expect(await art.get(ID2, 'small', 'https://s4.anilist.co/file/a.jpg')).not.toBeNull();
  });

  it('stores a fetched image under art/<artId>-<size> with its content type', async () => {
    const fetch = fetcher();
    const art = new ArtCache(dir, fetch);
    const got = await art.get(ID1, 'large', 'https://s4.anilist.co/l/1.jpg');
    expect(got).toEqual({ path: join(dir, `${ID1}-large`), type: 'image/jpeg' });
    expect(readFileSync(got!.path)).toEqual(Buffer.from(new Uint8Array(10).fill(7)));
    expect(fetch.urls).toEqual(['https://s4.anilist.co/l/1.jpg']);
    // and a new cache on the same dir knows its type
    expect(await new ArtCache(dir, fetcher()).get(ID1, 'large', 'https://s4.anilist.co/l/1.jpg')).toEqual(got);
  });

  it('does not fetch an image it has', async () => {
    const fetch = fetcher();
    const art = new ArtCache(dir, fetch);
    await art.get(ID1, 'small', 'https://s4.anilist.co/s/1.jpg');
    await art.get(ID1, 'small', 'https://s4.anilist.co/s/1.jpg');
    expect(fetch.urls.length).toBe(1);
  });

  it('deletes the least recently used files past its budget', async () => {
    let t = 0;
    const art = new ArtCache(dir, fetcher(10), 25, { now: () => ++t });
    await art.get(ID1, 'small', 'https://s4.anilist.co/1');
    await art.get(ID2, 'small', 'https://s4.anilist.co/2');
    await art.get(ID1, 'small', 'https://s4.anilist.co/1'); // ID1 is now the more recently used
    await art.get(ID3, 'small', 'https://s4.anilist.co/3');
    expect(existsSync(join(dir, `${ID1}-small`))).toBe(true);
    expect(existsSync(join(dir, `${ID2}-small`))).toBe(false);
    expect(existsSync(join(dir, `${ID3}-small`))).toBe(true);
  });

  it('returns null when the fetch fails', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('network');
    }) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, failing).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
    const notFound = vi.fn(async () => new Response('no', { status: 404 })) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, notFound).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
    const notImage = vi.fn(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, notImage).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
    expect(existsSync(join(dir, `${ID1}-small`))).toBe(false);
  });

  it('stores only jpeg, png, webp and gif, and only the two sizes (T8f)', async () => {
    const typed = (type: string) => vi.fn(async () => new Response('x', { headers: { 'content-type': type } })) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, typed('image/svg+xml')).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
    expect(await new ArtCache(dir, typed('image/avif')).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      expect(await new ArtCache(dir, typed(type)).get(ID2, 'large', `https://s4.anilist.co/${type}`)).toMatchObject({ type });
      rmSync(dir, { recursive: true });
    }
    const fetch = fetcher();
    expect(await new ArtCache(dir, fetch).get(ID1, 'huge' as 'small', 'https://s4.anilist.co/1')).toBeNull();
    expect(fetch.urls).toEqual([]);
  });

  it('gives up on a body past its cap, streaming, and on a fetch that takes too long (T8f)', async () => {
    let pulled = 0;
    const endless = vi.fn(async () => new Response(new ReadableStream({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(4));
      },
    }), { headers: { 'content-type': 'image/png' } })) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, endless, undefined, { maxBytes: 10 }).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
    expect(pulled).toBeLessThan(10);
    expect(existsSync(join(dir, `${ID1}-small`))).toBe(false);

    const hanging = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, hanging, undefined, { timeoutMs: 20 }).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
  });

  it('caps the body at 5 MB and times out after 15 s by default', async () => {
    const big = vi.fn(async () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } })) as unknown as typeof globalThis.fetch;
    expect(await new ArtCache(dir, big).get(ID1, 'small', 'https://s4.anilist.co/1')).toBeNull();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await new ArtCache(dir, fetcher()).get(ID2, 'small', 'https://s4.anilist.co/2');
    expect(timeout).toHaveBeenCalledWith(15_000);
    timeout.mockRestore();
  });

  it('saves hit times soon after a hit, so a restarted cache evicts by them (T8f)', async () => {
    let t = 0;
    const now = (): number => ++t;
    const art = new ArtCache(dir, fetcher(10), 25, { now, saveDelayMs: 5 });
    await art.get(ID1, 'small', 'https://s4.anilist.co/1');
    await art.get(ID2, 'small', 'https://s4.anilist.co/2');
    await art.get(ID1, 'small', 'https://s4.anilist.co/1');
    // 10 s, not vi.waitFor's 1 s default: a loaded CI runner can miss the debounced save by more than a second
    await vi.waitFor(() => expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))[`${ID1}-small`].usedAt).toBe(3), { timeout: 10_000 });
    const restarted = new ArtCache(dir, fetcher(10), 25, { now });
    await restarted.get(ID3, 'small', 'https://s4.anilist.co/3');
    expect(existsSync(join(dir, `${ID1}-small`))).toBe(true);
    expect(existsSync(join(dir, `${ID2}-small`))).toBe(false);
  });

  it('counts files missing from its index against the budget at startup (T8f)', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ID2}-small`), new Uint8Array(20));
    const art = new ArtCache(dir, fetcher(10), 25);
    await art.get(ID1, 'small', 'https://s4.anilist.co/1');
    expect(existsSync(join(dir, `${ID2}-small`))).toBe(false);
    expect(existsSync(join(dir, `${ID1}-small`))).toBe(true);
  });

  describe('Cover Art Archive redirects and local files', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

    function redirecting(to: string): typeof globalThis.fetch & { urls: string[] } {
      const urls: string[] = [];
      const f = vi.fn(async (url: string | URL | Request) => {
        urls.push(String(url));
        if (String(url).startsWith('https://coverartarchive.org/')) return new Response(null, { status: 307, headers: { location: to } });
        return new Response(new Uint8Array(10).fill(7), { headers: { 'content-type': 'image/jpeg' } });
      });
      return Object.assign(f as unknown as typeof globalThis.fetch, { urls });
    }

    it('follows a redirect to an archive.org host', async () => {
      const fetch = redirecting('https://ia800000.us.archive.org/1/items/x/front-250.jpg');
      const got = await new ArtCache(dir, fetch).get(ID1, 'small', 'https://coverartarchive.org/release/abc/front-250');
      expect(got).not.toBeNull();
      expect(fetch.urls).toEqual(['https://coverartarchive.org/release/abc/front-250', 'https://ia800000.us.archive.org/1/items/x/front-250.jpg']);
    });

    it('follows the real chain: coverartarchive.org, then archive.org itself, then a data node', async () => {
      const urls: string[] = [];
      const fetch = vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        urls.push(u);
        if (u.startsWith('https://coverartarchive.org/')) return new Response(null, { status: 307, headers: { location: 'https://archive.org/download/mbid-abc/mbid-abc-1_thumb250.jpg' } });
        if (u.startsWith('https://archive.org/')) return new Response(null, { status: 302, headers: { location: 'https://dn711103.ca.archive.org/0/items/mbid-abc/mbid-abc-1_thumb250.jpg' } });
        return new Response(new Uint8Array(10).fill(7), { headers: { 'content-type': 'image/jpeg' } });
      });
      const got = await new ArtCache(dir, fetch as unknown as typeof globalThis.fetch).get(ID1, 'small', 'https://coverartarchive.org/release/abc/front-250');
      expect(got).not.toBeNull();
      expect(urls).toEqual([
        'https://coverartarchive.org/release/abc/front-250',
        'https://archive.org/download/mbid-abc/mbid-abc-1_thumb250.jpg',
        'https://dn711103.ca.archive.org/0/items/mbid-abc/mbid-abc-1_thumb250.jpg',
      ]);
    });

    it('refuses hosts that only look like archive.org', async () => {
      for (const to of ['https://evilarchive.org/a.jpg', 'https://archive.org.evil.example/a.jpg', 'http://archive.org/a.jpg', 'https://archive.org:8443/a.jpg', 'https://u:p@archive.org/a.jpg']) {
        const fetch = redirecting(to);
        expect(await new ArtCache(dir, fetch).get(ID1, 'small', 'https://coverartarchive.org/release/abc/front-250')).toBeNull();
        expect(fetch.urls).toEqual(['https://coverartarchive.org/release/abc/front-250']);
      }
    });

    it('cancels each redirect\'s body before following it', async () => {
      const cancelled: string[] = [];
      const fetch = vi.fn(async (url: string | URL | Request) => {
        if (String(url).startsWith('https://coverartarchive.org/')) {
          const body = new ReadableStream({ cancel: () => { cancelled.push(String(url)); } });
          return new Response(body, { status: 307, headers: { location: 'https://ia800000.us.archive.org/1/items/x/front-250.jpg' } });
        }
        return new Response(new Uint8Array(10).fill(7), { headers: { 'content-type': 'image/jpeg' } });
      });
      expect(await new ArtCache(dir, fetch as unknown as typeof globalThis.fetch).get(ID1, 'small', 'https://coverartarchive.org/release/abc/front-250')).not.toBeNull();
      expect(cancelled).toEqual(['https://coverartarchive.org/release/abc/front-250']);
    });

    it('refuses a redirect to another host', async () => {
      const fetch = redirecting('https://evil.example/a.jpg');
      expect(await new ArtCache(dir, fetch).get(ID1, 'small', 'https://coverartarchive.org/release/abc/front-250')).toBeNull();
      expect(fetch.urls).toEqual(['https://coverartarchive.org/release/abc/front-250']);
    });

    it('allows Discogs images', async () => {
      expect(await new ArtCache(dir, fetcher()).get(ID1, 'small', 'https://i.discogs.com/a.jpg')).not.toBeNull();
    });

    it('serves a local PNG with the type from its bytes, whatever its name', async () => {
      const file = join(dir, '..', 'cover.jpg');
      writeFileSync(file, png);
      const fetch = fetcher();
      const got = await new ArtCache(dir, fetch).get(ID1, 'large', { file });
      expect(got).toEqual({ path: join(dir, `${ID1}-large`), type: 'image/png' });
      expect(readFileSync(got!.path)).toEqual(png);
      expect(fetch.urls).toEqual([]);
    });

    it('serves JPEG and WebP by magic, and refuses SVG, text, missing and oversized files', async () => {
      const art = new ArtCache(dir, fetcher(), undefined, { maxBytes: 100 });
      const put = (name: string, b: Buffer) => {
        const f = join(dir, '..', name);
        writeFileSync(f, b);
        return f;
      };
      const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
      expect((await art.get(ID1, 'small', { file: put('a.bin', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1])) }))?.type).toBe('image/jpeg');
      expect((await art.get(ID2, 'small', { file: put('b.bin', webp) }))?.type).toBe('image/webp');
      expect(await art.get(ID3, 'small', { file: put('c.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')) })).toBeNull();
      expect(await art.get('d'.repeat(32), 'small', { file: put('d.png', Buffer.from('hello world')) })).toBeNull();
      expect(await art.get('e'.repeat(32), 'small', { file: join(dir, '..', 'missing.png') })).toBeNull();
      expect(await art.get('f'.repeat(32), 'small', { file: put('f.png', Buffer.concat([png, Buffer.alloc(200)])) })).toBeNull();
    });
  });
});
