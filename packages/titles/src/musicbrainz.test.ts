import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMusicBrainz } from './musicbrainz';
import { Pacer } from './pacer';
import { SourceUnavailable, lookupUserAgent } from './sources';

const fixture = (name: string): { releases?: { id: string; 'label-info': { 'catalog-number': string }[]; [k: string]: unknown }[]; [k: string]: unknown } =>
  JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', name), 'utf8'));

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function fakeFetch(search: unknown, release: unknown = fixture('musicbrainz-release.json')) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return call.url.includes('?query=') ? json(search) : json(release);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const pacer = (): Pacer => new Pacer(100, 1_000);
const only = (ids: string[]): unknown => {
  const f = fixture('musicbrainz-search.json');
  return { releases: f.releases!.filter((r) => ids.includes(r.id.slice(-1))) };
};

describe('createMusicBrainz', () => {
  it('accepts only an exact catalogue number', async () => {
    // The full answer holds a ZQCL-2469 hit by another artist: were it taken as a hit, the artists would disagree.
    const { fetch } = fakeFetch(fixture('musicbrainz-search.json'));
    expect((await createMusicBrainz(fetch, pacer()).byCatalogue('ZQCL-2468'))?.id).toBe('11111111-0000-4000-8000-000000000003');
  });

  it('ignores a result whose catalogue number differs', async () => {
    const { fetch, calls } = fakeFetch(only(['4']));
    expect(await createMusicBrainz(fetch, pacer()).byCatalogue('ZQCL-2468')).toBeNull();
    expect(calls).toHaveLength(1); // no detail lookup for a miss
  });

  it('ignores spaces and case in the stored number', async () => {
    const { fetch, calls } = fakeFetch(only(['3']));
    const r = await createMusicBrainz(fetch, pacer()).byCatalogue('ZQCL-2468');
    expect(r?.id).toBe('11111111-0000-4000-8000-000000000003');
    expect(calls[1]!.url).toContain('/release/11111111-0000-4000-8000-000000000003?inc=artist-credits+release-groups+media+aliases&fmt=json');
  });

  it('prefers a Blu-ray release, then JP, then the earliest', async () => {
    const { fetch, calls } = fakeFetch(only(['1', '2', '3']));
    await createMusicBrainz(fetch, pacer()).byCatalogue('ZQCL-2468');
    expect(calls[1]!.url).toContain('/release/11111111-0000-4000-8000-000000000003?');
  });

  it('treats several exact hits naming different artists as a miss', async () => {
    const f = fixture('musicbrainz-search.json');
    const releases = f.releases!.filter((r) => r.id.endsWith('1') || r.id.endsWith('4')).map((r) => ({ ...r, 'label-info': [{ 'catalog-number': 'ZQCL-2468' }] }));
    const { fetch, calls } = fakeFetch({ releases });
    expect(await createMusicBrainz(fetch, pacer()).byCatalogue('ZQCL-2468')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('maps the release', async () => {
    const { fetch } = fakeFetch(only(['3']));
    expect(await createMusicBrainz(fetch, pacer()).byCatalogue('ZQCL-2468')).toEqual({
      source: 'musicbrainz',
      id: '11111111-0000-4000-8000-000000000003',
      title: 'Lantern Parade Live',
      date: '2021-03-06',
      artists: [
        {
          id: 'aaaaaaaa-0000-4000-8000-000000000001',
          name: 'Aoi Hoshino',
          sortName: 'Hoshino, Aoi',
          aliases: [
            { name: '星野あおい', locale: 'ja', primary: true },
            { name: 'A. Hoshino', locale: null, primary: false },
          ],
        },
      ],
      primaryType: 'Album',
      secondaryTypes: ['Live'],
      live: true,
      cover: {
        small: 'https://coverartarchive.org/release/11111111-0000-4000-8000-000000000003/front-250',
        large: 'https://coverartarchive.org/release/11111111-0000-4000-8000-000000000003/front-500',
      },
    });
  });

  it('has no cover without a front image, and live false without the Live type', async () => {
    const release = { ...fixture('musicbrainz-release.json'), 'cover-art-archive': { front: false }, 'release-group': { 'primary-type': 'Single', 'secondary-types': [] } };
    const { fetch } = fakeFetch(only(['3']), release);
    expect(await createMusicBrainz(fetch, pacer()).byCatalogue('ZQCL-2468')).toMatchObject({ cover: null, live: false, primaryType: 'Single' });
  });

  it('sends the User-Agent and paces through the pacer', async () => {
    const { fetch, calls } = fakeFetch(only(['3']));
    let paced = 0;
    const p = pacer();
    const run = p.run.bind(p);
    p.run = ((fn, opts) => (paced++, run(fn, opts))) as typeof p.run;
    await createMusicBrainz(fetch, p).byCatalogue('ZQCL-2468');
    expect(paced).toBe(2);
    for (const c of calls) expect(new Headers(c.init?.headers).get('User-Agent')).toBe('seikou/1.0 (https://github.com/brianhvo02/seikou)');
    expect(calls[0]!.url).toBe('https://musicbrainz.org/ws/2/release?query=catno:%22ZQCL-2468%22&fmt=json&limit=25');
  });

  it('a 503 is a source failure, not a miss', async () => {
    const fetch = (async () => new Response('busy', { status: 503, headers: { 'Retry-After': '0' } })) as typeof globalThis.fetch;
    await expect(createMusicBrainz(fetch, new Pacer(100, 10)).byCatalogue('ZQCL-2468')).rejects.toBeInstanceOf(SourceUnavailable);
  });
  it('a 404 whose body fails to cancel is still a miss', async () => {
    const fetch = (async () => new Response(new ReadableStream({ cancel: () => { throw new Error('stream gone'); } }), { status: 404 })) as typeof globalThis.fetch;
    await expect(createMusicBrainz(fetch, new Pacer(100, 10)).byCatalogue('ZQCL-2468')).resolves.toBeNull();
  });

  it('sends the user agent with the contact when one is set', async () => {
    const { fetch, calls } = fakeFetch(fixture('musicbrainz-search.json'));
    await createMusicBrainz(fetch, pacer(), 'me@example.com').byCatalogue('ZQCL-2468');
    expect((calls[0]!.init!.headers as Record<string, string>)['User-Agent']).toBe('seikou/1.0 (https://github.com/brianhvo02/seikou; me@example.com)');
    const bare = fakeFetch(fixture('musicbrainz-search.json'));
    await createMusicBrainz(bare.fetch, pacer(), null).byCatalogue('ZQCL-2468');
    expect((bare.calls[0]!.init!.headers as Record<string, string>)['User-Agent']).toBe('seikou/1.0 (https://github.com/brianhvo02/seikou)');
  });
});

describe('lookupUserAgent', () => {
  it('adds the contact inside the parentheses', () => {
    expect(lookupUserAgent(null)).toBe('seikou/1.0 (https://github.com/brianhvo02/seikou)');
    expect(lookupUserAgent('me@example.com')).toBe('seikou/1.0 (https://github.com/brianhvo02/seikou; me@example.com)');
  });
});
