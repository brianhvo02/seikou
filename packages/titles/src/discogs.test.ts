import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDiscogs } from './discogs';
import { Pacer } from './pacer';
import { SourceUnavailable } from './sources';

type Obj = { results?: { id: number; [k: string]: unknown }[]; [k: string]: unknown };
const fixture = (name: string): Obj => JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8'));

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function fakeFetch(search: unknown, release: unknown = fixture('discogs-release.json')) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return call.url.includes('/database/search') ? json(search) : json(release);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const pacer = (): Pacer => new Pacer(100, 1_000);
const only = (ids: number[]): unknown => ({ results: fixture('discogs-search.json').results!.filter((r) => ids.includes(r.id)) });
const TOKEN = 'tok-secret-123';

describe('createDiscogs', () => {
  it('maps an exact hit, preferring Blu-ray and stripping the (2) suffix', async () => {
    const { fetch, calls } = fakeFetch(only([9000001, 9000002, 9000003]));
    expect(await createDiscogs(fetch, pacer(), TOKEN).byCatalogue('ZQCL-2468')).toEqual({
      source: 'discogs',
      id: 'discogs:9000002',
      title: 'Lantern Parade Live',
      date: '2021-03-06',
      artists: [{ id: 'discogs-artist:777001', name: 'Aoi Hoshino', sortName: null, aliases: [] }],
      primaryType: null,
      secondaryTypes: [],
      live: true,
      cover: { small: 'https://img.example/primary-150.jpg', large: 'https://img.example/primary.jpg' },
    });
    expect(calls[0]!.url).toBe('https://api.discogs.com/database/search?catno=ZQCL-2468&type=release&per_page=25');
    expect(calls[1]!.url).toBe('https://api.discogs.com/releases/9000002');
  });

  it('sends the token and User-Agent', async () => {
    const { fetch, calls } = fakeFetch(only([9000002]));
    await createDiscogs(fetch, pacer(), TOKEN).byCatalogue('ZQCL-2468');
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const h = new Headers(c.init?.headers);
      expect(h.get('Authorization')).toBe(`Discogs token=${TOKEN}`);
      expect(h.get('User-Agent')).toBe('seikou/1.0 (https://github.com/brianhvo02/seikou)');
    }
  });

  it('a hit whose catno differs is a miss', async () => {
    const { fetch, calls } = fakeFetch(only([9000004]));
    expect(await createDiscogs(fetch, pacer(), TOKEN).byCatalogue('ZQCL-2468')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('hits naming different artists are a miss', async () => {
    const f = fixture('discogs-search.json');
    const results = f.results!.filter((r) => r.id === 9000001 || r.id === 9000004).map((r) => ({ ...r, catno: 'ZQCL-2468' }));
    const { fetch } = fakeFetch({ results });
    expect(await createDiscogs(fetch, pacer(), TOKEN).byCatalogue('ZQCL-2468')).toBeNull();
  });

  it('has no cover without images, live false without Live, and a partial date', async () => {
    const release = { ...fixture('discogs-release.json'), images: undefined, released: '2021-00-00', formats: [{ name: 'Blu-ray', descriptions: [] }] };
    const { fetch } = fakeFetch(only([9000002]), release);
    expect(await createDiscogs(fetch, pacer(), TOKEN).byCatalogue('ZQCL-2468')).toMatchObject({ cover: null, live: false, date: '2021' });
  });

  it.each([429, 500, 503])('a %i is a source failure and never names the token', async (status) => {
    const fetch = (async () => new Response('x', { status, headers: { 'Retry-After': '0' } })) as typeof globalThis.fetch;
    const err = await createDiscogs(fetch, new Pacer(100, 10), TOKEN).byCatalogue('ZQCL-2468').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailable);
    expect(String(err)).not.toContain(TOKEN);
  });

  it('a network error is a source failure without the token', async () => {
    const fetch = (async () => {
      throw new Error(`boom Discogs token=${TOKEN}`);
    }) as typeof globalThis.fetch;
    const err = await createDiscogs(fetch, pacer(), TOKEN).byCatalogue('ZQCL-2468').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceUnavailable);
    expect(String(err)).not.toContain(TOKEN);
  });
  it('a 404 whose body fails to cancel is still a miss', async () => {
    const fetch = (async () => new Response(new ReadableStream({ cancel: () => { throw new Error('stream gone'); } }), { status: 404 })) as typeof globalThis.fetch;
    await expect(createDiscogs(fetch, new Pacer(100, 10), TOKEN).byCatalogue('ZQCL-2468')).resolves.toBeNull();
  });
});
