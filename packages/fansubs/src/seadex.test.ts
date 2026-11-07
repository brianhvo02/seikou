import { describe, expect, it } from 'vitest';
import { Pacer } from '@seikou/titles/pacer';
import { SourceUnavailable } from '@seikou/titles/sources';
import { createSeaDex } from './seadex';

const BASE = 'https://seadex.example';
const json = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { status: 200, ...init });

const ENTRY = {
  page: 1,
  perPage: 30,
  totalItems: 1,
  items: [
    {
      alID: 20954,
      incomplete: false,
      notes: 'made up',
      expand: {
        trs: [
          {
            tracker: 'Nyaa',
            releaseGroup: 'GroupA',
            isBest: true,
            dualAudio: false,
            tags: ['BD'],
            url: 'https://nyaa.example/view/1',
            infoHash: '7A2C00000000000000000000000000000000AbCd',
            files: [{ name: '[GroupA] Starfall Wanderer 01.mkv', length: 9637755340 }],
          },
          { tracker: 'AB', releaseGroup: 'GroupB', isBest: false, dualAudio: true, url: '/torrents.php?id=1', infoHash: '<redacted>', files: [] },
        ],
      },
    },
  ],
};

describe('SeaDex', () => {
  it('parses an entry with a redacted private release', async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string) => (seen.push(url), json(ENTRY))) as unknown as typeof fetch;
    const entry = await createSeaDex(fetchFn, new Pacer(100, 1000), 'ua', BASE).entry(20954);
    expect(seen[0]).toBe(`${BASE}/api/collections/entries/records?filter=alID=20954&expand=trs`);
    expect(entry?.alId).toBe(20954);
    expect(entry?.incomplete).toBe(false);
    expect(entry?.releases[0]!.isBest).toBe(true);
    expect(entry?.releases[0]!.group).toBe('GroupA');
    expect(entry?.releases[0]!.files[0]!.name).toBe('[GroupA] Starfall Wanderer 01.mkv');
    expect(entry?.releases[0]!.infoHash).toBe('7a2c00000000000000000000000000000000abcd');
    expect(entry?.releases[1]!.infoHash).toBeNull();
    expect(entry?.releases[1]!.tags).toEqual([]);
  });

  it('answers null for an unknown id', async () => {
    const fetchFn = (async () => json({ page: 1, items: [], totalItems: 0 })) as unknown as typeof fetch;
    expect(await createSeaDex(fetchFn, new Pacer(100, 1000), 'ua', BASE).entry(1)).toBeNull();
  });

  it('sends the User-Agent and paces', async () => {
    let calls = 0;
    let ua: string | null = null;
    const pacer = { run: <T>(fn: () => Promise<T>) => (calls++, fn()) } as unknown as Pacer;
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      ua = new Headers(init?.headers).get('User-Agent');
      return json(ENTRY);
    }) as unknown as typeof fetch;
    await createSeaDex(fetchFn, pacer, 'my-agent', BASE).entry(20954);
    expect(calls).toBe(1);
    expect(ua).toBe('my-agent');
  });

  it('HTML is SourceUnavailable', async () => {
    const fetchFn = (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch;
    await expect(createSeaDex(fetchFn, new Pacer(100, 1000), 'ua', BASE).entry(1)).rejects.toBeInstanceOf(SourceUnavailable);
  });

  it('entry carries notes and comparison', async () => {
    const item = { alID: 1, notes: 'Best video; GroupB for signs', comparison: 'https://slow.pics/c/x', expand: { trs: [] } };
    const fetchFn = (async () => json({ items: [item] })) as unknown as typeof fetch;
    const entry = await createSeaDex(fetchFn, new Pacer(100, 1000), 'ua', BASE).entry(1);
    expect(entry).toMatchObject({ notes: 'Best video; GroupB for signs', comparison: 'https://slow.pics/c/x' });
    const bare = (async () => json({ items: [{ alID: 2, expand: { trs: [] } }] })) as unknown as typeof fetch;
    expect(await createSeaDex(bare, new Pacer(100, 1000), 'ua', BASE).entry(2)).toMatchObject({ notes: '', comparison: '' });
  });
});
