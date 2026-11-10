import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeTitle } from '@seikou/nas/title-text';
import type { OwnTitle, TitleDetail, TitleSummary } from '@seikou/nas/nas-api';
import { appHandlers } from '../app';
import { Auth } from '../auth';
import { BdjStore } from '../bdj-store';
import { createServer } from '../http';
import { Library } from '../library';
import { RelayState } from '../rtc/relay';
import { Store } from '../store';
import { ArtCache } from '@seikou/titles/art';
import { artIdOf } from '@seikou/titles/catalogue';
import type { FolderCover } from '@seikou/titles/catalogue';
import type { DiscEvidence } from '../titles/evidence';
import { OwnerStore } from '@seikou/titles/owner-store';
import { TitleService } from '../titles/service';
import { SourceUnavailable } from '@seikou/titles/sources';
import type { Entry, EntryNames, MetadataSource } from '@seikou/titles/sources';

// Every title and path here is made up (ruling R4).

function entry(id: string, names: Partial<EntryNames>, more: Partial<Entry> = {}): Entry {
  const source = id.startsWith('anilist:') ? 'anilist' : 'tmdb';
  return {
    source, id, kind: id.startsWith('tmdb-movie:') ? 'movie' : 'series', format: source === 'anilist' ? 'TV' : null,
    names: { english: null, romaji: null, native: null, synonyms: [], ...names },
    animation: source === 'anilist' ? true : null, year: 2022, episodes: 12, runtimeMin: null, seasons: [], relations: [],
    poster: null, banner: null, ...more,
  };
}

function ev(path: string, titles: Record<string, string> = {}, fingerprint: string | null = null): DiscEvidence {
  return {
    discId: `id:${path}`, path, fingerprint, discTitles: Object.entries(titles).map(([lang, name]) => ({ lang, name })),
    segments: path.split('/').slice(1), catalogueNumbers: [], playlists: [],
  };
}

const POSTER = { small: 'https://s4.anilist.co/ember-s.jpg', large: 'https://s4.anilist.co/ember-l.jpg' };
const EMBER = entry('anilist:100', { english: 'Ember Blade', romaji: 'Hinokiri no Ken', native: '火斬りの剣' }, { poster: POSTER });
const A = ev('media1/Anime/火斬りの剣/[BDMV][220629][火斬りの剣][Vol.1]', { jpn: '火斬りの剣' }, 'FA');
// a box of three unnumbered-by-name discs, listed out of order
const BOX = ['media1/Misc/Quiet Harbor/Quiet Harbor Disc 3', 'media1/Misc/Quiet Harbor/Quiet Harbor Disc 1', 'media1/Misc/Quiet Harbor/Quiet Harbor Disc 2'].map((p, i) => ev(p, {}, `FB${i}`));
const COPY = ev('media2/Downloads/Quiet.Harbor.D1', {}, 'FB1');
// Tide Bell: an AniList series of two TV entries, a film and a lone TV entry, none of them on any disc
const rel = (type: string, id: string, format: string, startDate: number) => ({ type, id, format, startDate });
const TIDE_1 = entry('anilist:990301', { english: 'Tide Bell', romaji: 'Shiokane' }, { relations: [rel('SEQUEL', 'anilist:990302', 'TV', 20230401)] });
const TIDE_2 = entry('anilist:990302', { english: 'Tide Bell Second', romaji: 'Shiokane Ni' }, { year: 2023, relations: [rel('PREQUEL', 'anilist:990301', 'TV', 20220401)] });
const TIDE_FILM = entry('anilist:990303', { english: null, romaji: 'Shiokane Gekijouban' }, { format: 'MOVIE', relations: [rel('PREQUEL', 'anilist:990302', 'TV', 20230401)] });
const LONE = entry('anilist:990304', { english: 'Lone Gull' });
// a sequel whose prequel AniList doesn't give, so its season can't be counted
const ORPHAN = entry('anilist:990305', { english: 'Gull Return' }, { relations: [rel('PREQUEL', 'anilist:990398', 'TV', 20210401)] });
// a series that forks: two TV sequels of one first season, both its second
const FORK = entry('anilist:990310', { english: 'Fork Road' }, { relations: [rel('SEQUEL', 'anilist:990311', 'TV', 20230101), rel('SEQUEL', 'anilist:990312', 'TV', 20230701)] });
const FORK_A = entry('anilist:990311', { english: 'Fork Road East' }, { year: 2023, relations: [rel('PREQUEL', 'anilist:990310', 'TV', 20220101)] });
const FORK_B = entry('anilist:990312', { english: 'Fork Road West' }, { year: 2023, relations: [rel('PREQUEL', 'anilist:990310', 'TV', 20220101)] });

type SearchOpts = Parameters<MetadataSource['search']>[1];

function fakeSource(results: Record<string, Entry[]>): MetadataSource & { down: boolean; hold: Promise<void> | null; searches: { query: string; opts: SearchOpts }[]; extra: Entry[]; entries: string[] } {
  const byKey = new Map(Object.entries(results).map(([q, es]) => [normalizeTitle(q), es]));
  const byId = new Map(Object.values(results).flat().map((en) => [en.id, en]));
  const src = {
    down: false,
    hold: null as Promise<void> | null,
    searches: [] as { query: string; opts: SearchOpts }[],
    extra: [] as Entry[],
    entries: [] as string[],
    async search(query: string, opts?: SearchOpts): Promise<Entry[]> {
      src.searches.push({ query, opts });
      if (src.hold) await src.hold;
      if (src.down) throw new SourceUnavailable('down');
      return [...(byKey.get(normalizeTitle(query)) ?? []), ...(normalizeTitle(query) === 'many' ? src.extra : [])];
    },
    async entry(id: string): Promise<Entry | null> {
      src.entries.push(id);
      if (src.hold) await src.hold;
      if (src.down) throw new SourceUnavailable('down');
      return byId.get(id) ?? null;
    },
  };
  return src;
}

/** A code for a new guest, or for the first owner person. */
function mint(auth: Auth, owner: boolean) {
  return auth.createCode(owner ? { personId: auth.firstOwnerPerson().id } : { newPerson: { name: 'Guest', owner: false } });
}

let tmp: string;
let clock: number;
let base = '';
let close: (() => void) | undefined;
let auth: Auth;
let relay: RelayState;
let owner: OwnerStore;
let service: TitleService;
let anilist: ReturnType<typeof fakeSource>;
let evidence: DiscEvidence[];
let artFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'title-routes-'));
  clock = 1_800_000_000_000;
});
afterEach(() => {
  close?.();
  service?.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function start(opts: { gate?: 'owners' | 'everyone'; lookupTimeoutMs?: number; nasId?: string | null; more?: DiscEvidence[]; folderCover?: (dir: string) => Promise<FolderCover | null> } = {}): Promise<void> {
  const data = join(tmp, 'data');
  auth = new Auth(new Store(data), () => clock);
  relay = new RelayState(data, () => clock);
  const library = new Library([], join(data, 'library.json'), { scanPauseMs: 0 });
  evidence = [A, ...BOX, COPY, ...(opts.more ?? [])];
  vi.spyOn(library, 'evidence').mockImplementation(() => evidence);
  owner = new OwnerStore(data);
  anilist = fakeSource({ 火斬りの剣: [EMBER], 'Ember Blade': [EMBER], 'Tide Bell': [TIDE_1, TIDE_2, TIDE_FILM, LONE, ORPHAN, FORK, FORK_A, FORK_B] });
  artFetch = vi.fn(async () => new Response(Buffer.from('PNGDATA'), { headers: { 'Content-Type': 'image/png' } }));
  service = new TitleService({
    library, owner, dataDir: data, anilist, tmdb: null, discdb: { lookup: () => null }, musicbrainz: null, discogs: null,
    folderCover: opts.folderCover ?? (async () => null), locateRelease: (_id, group) => join(tmp, 'mnt', group),
    art: new ArtCache(join(data, 'art'), artFetch as unknown as typeof fetch), titleLibrary: opts.gate ?? 'owners',
    now: () => clock, setTimer: () => () => {},
  });
  await service.runNow();
  const server = createServer(appHandlers({ auth, library, bdjStore: new BdjStore(data), now: () => clock, publicBase: 'https://nas.example/bluray/api/', titles: { service, owner }, relay, lookupTimeoutMs: opts.lookupTimeoutMs, nasId: opts.nasId }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.close();
    server.closeAllConnections();
  };
}

async function token(isOwner: boolean): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const { code } = mint(auth, isOwner);
  const device = auth.redeem(code, isOwner ? 'Mac' : 'Phone', jwk)!;
  const challenge = auth.challenge(device.id)!;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(challenge));
  return auth.startSession(device.id, challenge, Buffer.from(sig).toString('base64url'))!.token;
}

const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
const get = (path: string, t: string): Promise<Response> => fetch(`${base}${path}`, { headers: bearer(t) });
const send = (method: string, path: string, t: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method, headers: { ...bearer(t), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const artId = artIdOf(POSTER);

describe('title routes', () => {
  it('hides titles, detail and art from a guest with 404 while the gate is owners, and serves an owner', async () => {
    await start();
    const guest = await token(false);
    const own = await token(true);
    for (const path of ['/api/titles', '/api/titles/anilist%3A100', `/api/art/${artId}`]) {
      const res = await get(path, guest);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
      expect((await get(path, own)).status, path).toBe(200);
    }
    expect((await fetch(`${base}/api/titles`)).status).toBe(401);
  });

  it('serves a guest once the gate is everyone, set by the owner', async () => {
    await start();
    const guest = await token(false);
    const own = await token(true);
    expect((await send('PUT', '/api/admin/settings/title-library', own, { gate: 'everyone' })).status).toBe(204);
    const res = await get('/api/titles', guest);
    expect(res.status).toBe(200);
    const { titles } = (await res.json()) as { titles: TitleSummary[] };
    expect(titles.map((t) => t.id)).toContain('anilist:100');
    const detail = (await (await get('/api/titles/anilist%3A100', guest)).json()) as TitleDetail;
    expect(detail.title.poster).toBe(artId);
    expect((await get('/api/titles/anilist%3A999', guest)).status).toBe(404);
  });

  it("reports the effective gate in the matching status, and the owner's change to it", async () => {
    await start();
    const own = await token(true);
    expect(await (await get('/api/admin/metadata/status', own)).json()).toMatchObject({ gate: 'owners' });
    expect((await send('PUT', '/api/admin/settings/title-library', own, { gate: 'everyone' })).status).toBe(204);
    expect(await (await get('/api/admin/metadata/status', own)).json()).toMatchObject({ gate: 'everyone' });
  });

  it('serves a guest with the env gate at everyone', async () => {
    await start({ gate: 'everyone' });
    expect((await get('/api/titles', await token(false))).status).toBe(200);
  });

  it('serves art by query token with the stored type and immutable caching, and only catalogue ids', async () => {
    await start({ gate: 'everyone' });
    const t = await token(false);
    const res = await fetch(`${base}/api/art/${artId}?size=large&t=${encodeURIComponent(t)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=2592000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('PNGDATA');
    expect(artFetch).toHaveBeenCalledWith(POSTER.large, expect.anything());
    for (const path of [`/api/art/${'0'.repeat(32)}`, '/api/art/..%2Fowner.json', `/api/art/${artId.toUpperCase()}`, `/api/art/${artId}?size=huge`]) {
      expect((await get(path, t)).status, path).toBe(404);
    }
    expect(artFetch).toHaveBeenCalledTimes(1);
  });

  it('serves a music release\'s folder cover from the file the catalogue found', async () => {
    const group = 'Music/Lantern Parade - Night Lights';
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const dir = join(tmp, 'mnt', group);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cover.png'), png);
    await start({ gate: 'everyone', more: [ev(`media1/${group}/BD`)], folderCover: async (d) => ({ path: join(d, 'cover.png'), size: png.length, mtimeMs: 1 }) });
    const t = await token(false);
    const res = await get('/api/titles', t);
    const music = ((await res.json()) as { titles: TitleSummary[] }).titles.find((x) => x.kind === 'music')!;
    expect(music.poster).toMatch(/^[0-9a-f]{32}$/);
    const art = await get(`/api/art/${music.poster}?size=large`, t);
    expect(art.status).toBe(200);
    expect(art.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await art.arrayBuffer())).toEqual(png);
    expect(artFetch).not.toHaveBeenCalled();
  });

  it('reports both flags and the person on GET /api/me', async () => {
    await start();
    const person = expect.any(String);
    expect(await (await get('/api/me', await token(false))).json()).toEqual({ owner: false, titleLibrary: false, personId: person, personName: 'Guest', relay: null, nasId: null, levels: false });
    expect(await (await get('/api/me', await token(true))).json()).toEqual({ owner: true, titleLibrary: true, personId: auth.firstOwnerPerson().id, personName: 'Owner', relay: null, nasId: null, levels: false });
    owner.setGate('everyone');
    expect(await (await get('/api/me', await token(false))).json()).toEqual({ owner: false, titleLibrary: true, personId: person, personName: 'Guest', relay: null, nasId: null, levels: false });
    expect((await fetch(`${base}/api/me`)).status).toBe(401);
  });

  it("gives the NAS's rendezvous id in GET /api/me, so a pairing made before WebRTC can learn it", async () => {
    await start({ nasId: 'N'.repeat(43) });
    const me = (await (await get('/api/me', await token(false))).json()) as { nasId: unknown };
    expect(me.nasId).toBe('N'.repeat(43));
  });

  it("adds the relay's usage to GET /api/me while the relay is on", async () => {
    await start();
    relay.set({ enabled: true });
    relay.addBytes(412e9);
    const me = (await (await get('/api/me', await token(false))).json()) as { relay: unknown };
    expect(me.relay).toEqual({ usedBytes: 412e9, freeBytes: 1e12, resetsOn: expect.stringMatching(/^\d{4}-\d{2}-01$/) });
  });
});

describe('owner title routes', () => {
  it('answers 403 to a guest on every new admin route', async () => {
    await start({ gate: 'everyone' });
    const guest = await token(false);
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/admin/unsorted'],
      ['GET', '/api/admin/hidden'],
      ['GET', '/api/admin/lookup?q=x&source=own'],
      ['GET', '/api/admin/anilist-place/990302'],
      ['PUT', `/api/admin/discs/${encodeURIComponent(A.discId)}/choice`, { choice: { kind: 'hidden' } }],
      ['DELETE', `/api/admin/discs/${encodeURIComponent(A.discId)}/choice`],
      ['PUT', `/api/admin/names/${encodeURIComponent(A.discId)}`, { name: 'x' }],
      ['PUT', '/api/admin/music/music:x', { artist: 'x' }],
      ['POST', '/api/admin/titles', { kind: 'movie', name: 'x' }],
      ['PATCH', '/api/admin/titles/own:x', { name: 'x' }],
      ['DELETE', '/api/admin/titles/own:x'],
      ['PUT', '/api/admin/settings/title-library', { gate: 'everyone' }],
      ['GET', '/api/admin/metadata/status'],
    ];
    for (const [method, path, body] of calls) expect((await send(method, path, guest, body)).status, `${method} ${path}`).toBe(403);
    expect(owner.snapshot().gate).toBeNull();
    expect(owner.snapshot().choices.size).toBe(0);
  });

  it('files the rest of a group in parsed order with applyToGroup, skipping discs with their own choice', async () => {
    await start();
    const t = await token(true);
    const title = (await (await send('POST', '/api/admin/titles', t, { kind: 'series', name: 'Quiet Harbor', seasons: 1 })).json()) as OwnTitle;
    expect(title).toMatchObject({ kind: 'series', name: 'Quiet Harbor', seasons: 1 });
    const [d3, d1, d2] = BOX as [DiscEvidence, DiscEvidence, DiscEvidence];
    const choice = { kind: 'title', titleId: title.id, season: 1, disc: 1 };
    const res = await send('PUT', `/api/admin/discs/${encodeURIComponent(d1.discId)}/choice`, t, { choice, applyToGroup: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: [] });
    const { choices } = owner.snapshot();
    expect(choices.get(d1.discId)).toEqual(choice);
    expect(choices.get(d2.discId)).toEqual({ ...choice, disc: 2 });
    expect(choices.get(d3.discId)).toEqual({ ...choice, disc: 3 });
    expect(choices.has(A.discId)).toBe(false);
    // rebuilt at once: the next GET lists the title with its three discs
    const { titles } = (await (await get('/api/titles', t)).json()) as { titles: TitleSummary[] };
    expect(titles.find((x) => x.id === title.id)?.discs).toBe(3);

    // a disc with a direct choice of its own keeps it
    owner.clearChoice(d1.discId);
    owner.setChoice(d3.discId, d3.fingerprint, { kind: 'hidden' });
    await send('PUT', `/api/admin/discs/${encodeURIComponent(d2.discId)}/choice`, t, { choice: { ...choice, disc: 5 }, applyToGroup: true });
    expect(owner.snapshot().choices.get(d1.discId)).toEqual({ ...choice, disc: 4 });
    expect(owner.snapshot().choices.get(d3.discId)).toEqual({ kind: 'hidden' });
    const hidden = (await (await get('/api/admin/hidden', t)).json()) as { discs: { discId: string }[] };
    expect(hidden.discs.map((d) => d.discId)).toEqual([d3.discId]);
  });

  it('starts a run when a choice names an entry that is not loaded, without waiting for it', async () => {
    await start();
    const t = await token(true);
    const run = vi.spyOn(service, 'runNow');
    const disc = BOX[1]!;
    await send('PUT', `/api/admin/discs/${encodeURIComponent(disc.discId)}/choice`, t, { choice: { kind: 'hidden' } });
    expect(run).not.toHaveBeenCalled();
    await send('PUT', `/api/admin/discs/${encodeURIComponent(disc.discId)}/choice`, t, { choice: { kind: 'title', titleId: 'anilist:777', season: 1, disc: 1 } });
    expect(run).toHaveBeenCalledOnce();
  });

  it('starts a run when the owner files a disc as Music, so its lookups and cover follow', async () => {
    await start();
    const t = await token(true);
    const run = vi.spyOn(service, 'runNow');
    await send('PUT', `/api/admin/discs/${encodeURIComponent(BOX[1]!.discId)}/choice`, t, { choice: { kind: 'music', name: null } });
    expect(run).toHaveBeenCalledOnce();
  });

  it('answers 409 when clearing a choice a copy follows from its source, and clears a direct one', async () => {
    await start();
    const t = await token(true);
    const d1 = BOX[1]!;
    owner.setChoice(d1.discId, d1.fingerprint, { kind: 'hidden' });
    owner.reattach(evidence.map((e) => ({ id: e.discId, fingerprint: e.fingerprint })));
    expect(owner.snapshot().choices.get(COPY.discId)).toEqual({ kind: 'hidden' });
    const res = await send('DELETE', `/api/admin/discs/${encodeURIComponent(COPY.discId)}/choice`, t);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'copy-follows-source', source: d1.discId });
    expect((await send('DELETE', `/api/admin/discs/${encodeURIComponent(d1.discId)}/choice`, t)).status).toBe(204);
    expect(owner.snapshot().choices.has(d1.discId)).toBe(false);
  });

  it('looks up AniList through its source, own titles by name, and TMDB with no key as no titles', async () => {
    await start();
    const t = await token(true);
    const tmdb = await get('/api/admin/lookup?q=Ember&source=tmdb', t);
    expect(tmdb.status).toBe(200);
    expect(await tmdb.json()).toEqual({ titles: [] });
    const found = (await (await get('/api/admin/lookup?q=Ember%20Blade&source=anilist', t)).json()) as { titles: TitleSummary[] };
    expect(found.titles.map((x) => x.id)).toEqual(['anilist:100']);
    expect(found.titles[0]!.poster).toBe(artId);
    owner.createTitle('movie', 'Paper Lanterns', null);
    const own = (await (await get('/api/admin/lookup?q=paper&source=own', t)).json()) as { titles: TitleSummary[] };
    expect(own.titles.map((x) => x.names.display)).toEqual(['Paper Lanterns']);
    anilist.down = true;
    const down = await get('/api/admin/lookup?q=Other&source=anilist', t);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: 'source-unreachable' });
  });

  it('answers 400 with a fixed error to a bad body or query', async () => {
    await start();
    const t = await token(true);
    const disc = `/api/admin/discs/${encodeURIComponent(A.discId)}/choice`;
    const bad: [string, string, unknown, string][] = [
      ['PUT', disc, { choice: { kind: 'title', titleId: 'anilist:1', season: 0, disc: 1 } }, 'bad choice'],
      ['PUT', disc, { choice: { kind: 'title', titleId: 'https://evil.example', season: 1, disc: 1 } }, 'bad choice'],
      ['PUT', disc, { choice: { kind: 'hidden', extra: 1 } }, 'bad choice'],
      ['PUT', disc, { choice: { kind: 'hidden' }, applyToGroup: 'yes' }, 'bad choice'],
      ['PUT', disc, { choice: { kind: 'title', titleId: 'own:00000000-0000-0000-0000-000000000000', season: null, disc: null } }, 'unknown title'],
      ['PUT', `/api/admin/names/${encodeURIComponent(A.discId)}`, { name: 'x'.repeat(201) }, 'bad name'],
      ['PUT', `/api/admin/names/${encodeURIComponent(A.discId)}`, { name: '  ' }, 'bad name'],
      ['POST', '/api/admin/titles', { kind: 'show', name: 'x' }, 'bad title'],
      ['POST', '/api/admin/titles', { kind: 'movie', name: 'x', seasons: 2 }, 'bad title'],
      ['PUT', '/api/admin/settings/title-library', { gate: 'all' }, 'bad gate'],
    ];
    for (const [method, path, body, error] of bad) {
      const res = await send(method, path, t, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    for (const q of ['q=&source=own', `q=${'x'.repeat(201)}&source=own`, 'q=x&source=web']) {
      const res = await get(`/api/admin/lookup?${q}`, t);
      expect(res.status, q).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad query' });
    }
    expect(await (await get('/api/admin/unsorted?limit=-1', t)).json()).toEqual({ error: 'bad paging' });
    expect(owner.snapshot().choices.size).toBe(0);
  });

  it('pages Unsorted, renames, edits and deletes own titles, sets display names and reports status', async () => {
    await start();
    const t = await token(true);
    const page = (await (await get('/api/admin/unsorted?offset=1&limit=2', t)).json()) as { items: { discId: string }[]; total: number };
    expect(page.total).toBe(4);
    expect(page.items).toHaveLength(2);

    const created = (await (await send('POST', '/api/admin/titles', t, { kind: 'movie', name: ' Paper Lanterns ' })).json()) as OwnTitle;
    expect(created.name).toBe('Paper Lanterns');
    const patched = await send('PATCH', `/api/admin/titles/${encodeURIComponent(created.id)}`, t, { name: 'Paper Lanterns (Remaster)' });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as OwnTitle).name).toBe('Paper Lanterns (Remaster)');
    expect((await send('PATCH', '/api/admin/titles/own%3Anope', t, { name: 'x' })).status).toBe(404);
    expect((await send('DELETE', `/api/admin/titles/${encodeURIComponent(created.id)}`, t)).status).toBe(204);
    expect(owner.snapshot().ownTitles).toEqual([]);

    expect((await send('PUT', `/api/admin/names/${encodeURIComponent(A.discId)}`, t, { name: 'Volume One' })).status).toBe(204);
    expect(owner.snapshot().displayNames.get(A.discId)).toBe('Volume One');
    expect((await send('PUT', `/api/admin/names/${encodeURIComponent(A.discId)}`, t, { name: null })).status).toBe(204);
    expect(owner.snapshot().displayNames.has(A.discId)).toBe(false);
    expect((await send('PUT', '/api/admin/names/nope', t, { name: 'x' })).status).toBe(404);

    const status = await (await get('/api/admin/metadata/status', t)).json();
    expect(status).toMatchObject({ running: false, filed: 1, unsorted: 4, tmdb: false });
  });
});

describe('task 9 review', () => {
  const ADMIN_ROUTES: [string, string, unknown?][] = [
    ['GET', '/api/admin/unsorted'],
    ['GET', '/api/admin/hidden'],
    ['GET', '/api/admin/lookup?q=x&source=own'],
    ['PUT', `/api/admin/discs/${encodeURIComponent(A.discId)}/choice`, { choice: { kind: 'hidden' } }],
    ['DELETE', `/api/admin/discs/${encodeURIComponent(A.discId)}/choice`],
    ['PUT', `/api/admin/names/${encodeURIComponent(A.discId)}`, { name: 'x' }],
    ['POST', '/api/admin/titles', { kind: 'movie', name: 'x' }],
    ['PATCH', '/api/admin/titles/own:x', { name: 'x' }],
    ['DELETE', '/api/admin/titles/own:x'],
    ['PUT', '/api/admin/settings/title-library', { gate: 'everyone' }],
    ['GET', '/api/admin/metadata/status'],
  ];

  it('answers 401 on every new admin route with no token, and with an owner token sent as ?t=', async () => {
    await start();
    const t = await token(true);
    for (const [method, path, body] of ADMIN_ROUTES) {
      const init = { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) };
      expect((await fetch(`${base}${path}`, init)).status, `${method} ${path}`).toBe(401);
      const sep = path.includes('?') ? '&' : '?';
      expect((await fetch(`${base}${path}${sep}t=${encodeURIComponent(t)}`, init)).status, `${method} ${path} ?t=`).toBe(401);
    }
    expect(owner.snapshot().gate).toBeNull();
  });

  it('serves the art of lookup results to an owner, from a registry of at most 500 (ruling T9e)', async () => {
    await start({ gate: 'everyone' });
    const t = await token(true);
    const guest = await token(false);
    anilist.extra = Array.from({ length: 501 }, (_, i) =>
      entry(`anilist:${5000 + i}`, { english: `Lantern ${i}` }, { poster: { small: `https://s4.anilist.co/l${i}-s.jpg`, large: `https://s4.anilist.co/l${i}-l.jpg` } }));
    const { titles } = (await (await get('/api/admin/lookup?q=many&source=anilist', t)).json()) as { titles: TitleSummary[] };
    expect(titles).toHaveLength(501);
    const first = titles[0]!.poster!;
    const last = titles[500]!.poster!;
    expect(last).toBe(artIdOf(anilist.extra[500]!.poster!));
    const res = await get(`/api/art/${last}?size=large`, t);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=2592000, immutable');
    expect(artFetch).toHaveBeenLastCalledWith('https://s4.anilist.co/l500-l.jpg', expect.anything());
    expect((await get(`/api/art/${last}`, guest)).status).toBe(404);
    expect((await get(`/api/art/${first}`, t)).status).toBe(404);
    // the catalogue's own art still serves everyone
    expect((await get(`/api/art/${artId}`, guest)).status).toBe(200);
  });

  it('lets a later applyToGroup correct group-filed discs, but not discs filed one by one (ruling T9f)', async () => {
    await start();
    const t = await token(true);
    const mk = async (n: string): Promise<OwnTitle> => (await (await send('POST', '/api/admin/titles', t, { kind: 'series', name: n, seasons: 1 })).json()) as OwnTitle;
    const wrong = await mk('Wrong Harbor');
    const right = await mk('Quiet Harbor');
    const [d3, d1, d2] = BOX as [DiscEvidence, DiscEvidence, DiscEvidence];
    const choice = (id: string, disc: number): unknown => ({ choice: { kind: 'title', titleId: id, season: 1, disc }, applyToGroup: true });
    const filed = (id: string, disc: number): unknown => ({ kind: 'title', titleId: id, season: 1, disc });
    const at = (d: DiscEvidence): unknown => owner.snapshot().choices.get(d.discId);
    await send('PUT', `/api/admin/discs/${encodeURIComponent(d1.discId)}/choice`, t, choice(wrong.id, 1));
    // applied again, from the same disc: the group-filed siblings follow
    await send('PUT', `/api/admin/discs/${encodeURIComponent(d1.discId)}/choice`, t, choice(right.id, 1));
    expect([d1, d2, d3].map(at)).toEqual([filed(right.id, 1), filed(right.id, 2), filed(right.id, 3)]);
    // a disc the owner filed one by one keeps its choice
    await send('PUT', `/api/admin/discs/${encodeURIComponent(d3.discId)}/choice`, t, { choice: { kind: 'hidden' } });
    await send('PUT', `/api/admin/discs/${encodeURIComponent(d1.discId)}/choice`, t, choice(wrong.id, 1));
    expect([d1, d2, d3].map(at)).toEqual([filed(wrong.id, 1), filed(wrong.id, 2), { kind: 'hidden' }]);
    // a disc the owner acted on with applyToGroup is direct too
    await send('PUT', `/api/admin/discs/${encodeURIComponent(d2.discId)}/choice`, t, choice(right.id, 2));
    expect(at(d1)).toEqual(filed(wrong.id, 1));
  });

  it('applies a choice to the copies at once (ruling T9g)', async () => {
    await start();
    const t = await token(true);
    await send('PUT', `/api/admin/discs/${encodeURIComponent(BOX[1]!.discId)}/choice`, t, { choice: { kind: 'hidden' } });
    const hidden = (await (await get('/api/admin/hidden', t)).json()) as { discs: { discId: string }[] };
    expect(hidden.discs.map((d) => d.discId).sort()).toEqual([BOX[1]!.discId, COPY.discId].sort());
  });

  it('clears a copy whose source is gone, with no 409', async () => {
    await start();
    const t = await token(true);
    const d1 = BOX[1]!;
    owner.setChoice(d1.discId, d1.fingerprint, { kind: 'hidden' });
    owner.reattach(evidence.map((e) => ({ id: e.discId, fingerprint: e.fingerprint })));
    owner.clearChoice(d1.discId);
    expect((await send('DELETE', `/api/admin/discs/${encodeURIComponent(COPY.discId)}/choice`, t)).status).toBe(204);
    expect(owner.snapshot().choices.has(COPY.discId)).toBe(false);
  });

  it('finds no own titles for a query that normalises to nothing', async () => {
    await start();
    const t = await token(true);
    owner.createTitle('movie', 'Paper Lanterns', null);
    expect(await (await get('/api/admin/lookup?q=!!!&source=own', t)).json()).toEqual({ titles: [] });
  });

  it('looks up ahead of background matching, one at a time and 20 a minute per device (ruling T9h)', async () => {
    await start();
    const t = await token(true);
    const other = await token(true);
    anilist.searches.length = 0; // the start's matching run
    let release!: () => void;
    anilist.hold = new Promise((r) => (release = r));
    const busy = get('/api/admin/lookup?q=Ember%20Blade&source=anilist', t);
    await vi.waitFor(() => expect(anilist.searches).toHaveLength(1));
    expect(anilist.searches[0]!.opts).toMatchObject({ urgent: true });
    expect(anilist.searches[0]!.opts?.signal).toBeInstanceOf(AbortSignal);
    const second = await get('/api/admin/lookup?q=Ember%20Blade&source=anilist', t);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: 'lookup-busy' });
    release();
    expect((await busy).status).toBe(200);
    anilist.hold = null;
    for (let i = 1; i < 20; i++) expect((await get('/api/admin/lookup?q=Ember&source=anilist', t)).status, `lookup ${i}`).toBe(200);
    clock += 30_000;
    const over = await get('/api/admin/lookup?q=Ember&source=anilist', t);
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe('30');
    expect(await over.json()).toEqual({ error: 'too-many-lookups' });
    expect((await get('/api/admin/lookup?q=Ember&source=anilist', other)).status).toBe(200);
    clock += 30_000;
    expect((await get('/api/admin/lookup?q=Ember&source=anilist', t)).status).toBe(200);
  });

  it('skips siblings that are copies of a disc with a choice, and reports what it skipped (ruling T9i)', async () => {
    await start();
    const t = await token(true);
    const [d3, d1, d2] = BOX as [DiscEvidence, DiscEvidence, DiscEvidence];
    // a copy of A sits in the box's group
    const copyOfA = ev('media1/Misc/Quiet Harbor/Quiet Harbor Disc 4', {}, A.fingerprint);
    evidence = [...evidence, copyOfA];
    owner.setChoice(A.discId, A.fingerprint, { kind: 'hidden' });
    owner.reattach(evidence.map((e) => ({ id: e.discId, fingerprint: e.fingerprint })));
    owner.setChoice(d3.discId, d3.fingerprint, { kind: 'hidden' });
    const title = (await (await send('POST', '/api/admin/titles', t, { kind: 'series', name: 'Quiet Harbor', seasons: 1 })).json()) as OwnTitle;
    const res = await send('PUT', `/api/admin/discs/${encodeURIComponent(d1.discId)}/choice`, t, {
      choice: { kind: 'title', titleId: title.id, season: 1, disc: 1 }, applyToGroup: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: [{ discId: d3.discId, reason: 'direct' }, { discId: copyOfA.discId, reason: 'copy' }] });
    expect(owner.choiceOrigin(copyOfA.discId)).toEqual({ kind: 'copy', source: A.discId });
    expect(owner.snapshot().choices.get(d2.discId)).toEqual({ kind: 'title', titleId: title.id, season: 1, disc: 2 });
    // without applyToGroup: 204 as before
    expect((await send('PUT', `/api/admin/discs/${encodeURIComponent(d2.discId)}/choice`, t, { choice: { kind: 'hidden' } })).status).toBe(204);
  });

  it('does not count own-title lookups against the per-device limits', async () => {
    await start();
    const t = await token(true);
    owner.createTitle('movie', 'Paper Lanterns', null);
    for (let i = 0; i < 25; i++) expect((await get('/api/admin/lookup?q=paper&source=own', t)).status, `own ${i}`).toBe(200);
    expect((await get('/api/admin/lookup?q=Ember&source=anilist', t)).status).toBe(200);
  });

  it('gives up on a lookup after its timeout with 503 source-unreachable', async () => {
    await start({ lookupTimeoutMs: 50 });
    const t = await token(true);
    anilist.searches.length = 0; // the start's matching run
    anilist.hold = new Promise(() => {});
    const res = await get('/api/admin/lookup?q=Ember&source=anilist', t);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'source-unreachable' });
    expect(anilist.searches[0]!.opts?.signal?.aborted).toBe(true);
    // the device may look up again
    anilist.hold = null;
    expect((await get('/api/admin/lookup?q=Ember&source=anilist', t)).status).toBe(200);
  });
});

describe('final review', () => {
  const put = (t: string, d: DiscEvidence, body: unknown): Promise<Response> => send('PUT', `/api/admin/discs/${encodeURIComponent(d.discId)}/choice`, t, body);
  const series = async (t: string, name: string): Promise<OwnTitle> => (await (await send('POST', '/api/admin/titles', t, { kind: 'series', name, seasons: 1 })).json()) as OwnTitle;

  it('I3: numbers the other discs of a folder by their own numbers, so a missing volume leaves a gap', async () => {
    await start();
    const t = await token(true);
    const [v1, v2, v4] = ['Vol.1', 'Vol.2', 'Vol.4'].map((v) => ev(`media1/Misc/Quiet Reel/Quiet Reel ${v}`)) as [DiscEvidence, DiscEvidence, DiscEvidence];
    evidence = [v4, v1, v2];
    const title = await series(t, 'Quiet Reel');
    const choice = (disc: number): unknown => ({ choice: { kind: 'title', titleId: title.id, season: 1, disc }, applyToGroup: true });
    const discOf = (d: DiscEvidence): number | null | undefined => {
      const c = owner.snapshot().choices.get(d.discId);
      return c?.kind === 'title' ? c.disc : undefined;
    };
    expect((await put(t, v1, choice(1))).status).toBe(200);
    expect([v1, v2, v4].map(discOf)).toEqual([1, 2, 4]);
    const clear = (): void => [v1, v2, v4].forEach((d) => owner.clearChoice(d.discId));
    // filing the last one first numbers the others the same way
    clear();
    await put(t, v4, choice(4));
    expect([v1, v2, v4].map(discOf)).toEqual([1, 2, 4]);
    // the owner's number may differ from the folder's: the others keep their distance from it
    clear();
    await put(t, v4, choice(6));
    expect([v1, v2, v4].map(discOf)).toEqual([3, 4, 6]);
  });

  it('I3: skips the discs without a number when others in the folder have one, and numbers by position when none has', async () => {
    await start();
    const t = await token(true);
    const [v1, v2, bonus] = ['Quiet Reel Vol.1', 'Quiet Reel Vol.2', 'Quiet Reel Making Of'].map((n) => ev(`media1/Misc/Quiet Reel/${n}`)) as [DiscEvidence, DiscEvidence, DiscEvidence];
    const plain = ['AAA', 'BBB', 'CCC'].map((n) => ev(`media1/Misc/Plain Reel/${n}`)) as [DiscEvidence, DiscEvidence, DiscEvidence];
    evidence = [v1, v2, bonus, ...plain];
    const title = await series(t, 'Quiet Reel');
    const res = await put(t, v1, { choice: { kind: 'title', titleId: title.id, season: 1, disc: 1 }, applyToGroup: true });
    expect(await res.json()).toEqual({ skipped: [{ discId: bonus.discId, reason: 'no-number' }] });
    expect(owner.snapshot().choices.has(bonus.discId)).toBe(false);
    expect(owner.snapshot().choices.get(v2.discId)).toMatchObject({ disc: 2 });

    const other = await series(t, 'Plain Reel');
    await put(t, plain[1], { choice: { kind: 'title', titleId: other.id, season: 1, disc: 5 }, applyToGroup: true });
    expect(plain.map((d) => owner.snapshot().choices.get(d.discId))).toEqual([4, 5, 6].map((disc) => ({ kind: 'title', titleId: other.id, season: 1, disc })));
  });

  it("N3: filing an unnumbered disc keeps the others' own numbers, and skips one whose number clashes or that has none", async () => {
    await start();
    const t = await token(true);
    const [v1, v2, v3, interviews, making] = ['Quiet Reel Vol.1', 'Quiet Reel Vol.2', 'Quiet Reel Vol.3', 'Quiet Reel Interviews', 'Quiet Reel Making Of']
      .map((n) => ev(`media1/Misc/Quiet Reel/${n}`)) as [DiscEvidence, DiscEvidence, DiscEvidence, DiscEvidence, DiscEvidence];
    evidence = [making, v3, interviews, v1, v2];
    const title = await series(t, 'Quiet Reel');
    const res = await put(t, making, { choice: { kind: 'title', titleId: title.id, season: 1, disc: 3 }, applyToGroup: true });
    expect(await res.json()).toEqual({ skipped: [{ discId: v3.discId, reason: 'conflict' }, { discId: interviews.discId, reason: 'no-number' }] });
    const choices = owner.snapshot().choices;
    expect([v1, v2].map((d) => choices.get(d.discId))).toEqual([1, 2].map((disc) => ({ kind: 'title', titleId: title.id, season: 1, disc })));
    expect(choices.has(v3.discId)).toBe(false);
    expect(choices.has(interviews.discId)).toBe(false);
  });

  it('M12: refuses to apply a title choice to the folder without a disc number', async () => {
    await start();
    const t = await token(true);
    const title = await series(t, 'Quiet Harbor');
    const res = await put(t, BOX[1]!, { choice: { kind: 'title', titleId: title.id, season: 1, disc: null }, applyToGroup: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'disc-required' });
    expect(owner.snapshot().choices.size).toBe(0);
  });

  it("M8: a music title's new name is kept in its discs' choices, so it survives a move", async () => {
    await start();
    const t = await token(true);
    const discs = ['DISC1', 'DISC2'].map((n, i) => ev(`media1/Music/Lumen Choir - First Light/${n}`, {}, `FM${i}`));
    evidence = [...evidence, ...discs];
    await service.runNow();
    const music = service.catalogue().titles.find((x) => x.kind === 'music')!;
    expect((await send('PUT', `/api/admin/names/${encodeURIComponent(music.id)}`, t, { name: 'First Light Live' })).status).toBe(204);
    for (const d of discs) expect(owner.snapshot().choices.get(d.discId)).toEqual({ kind: 'music', name: 'First Light Live' });
    // the release folder is tidied: new paths, same discs
    evidence = [...evidence.filter((e) => !discs.includes(e)), ...discs.map((d, i) => ev(`media1/Music/Lumen Choir/First Light/BD${i + 1}`, {}, d.fingerprint))];
    clock += 60_000;
    await service.runNow();
    expect(service.catalogue().titles.filter((x) => x.kind === 'music').map((x) => x.names.display)).toEqual(['First Light Live']);
  });

  it("sets a music release's artist and rejectMatch on every disc, keeping its name", async () => {
    await start();
    const t = await token(true);
    const discs = ['DISC1', 'DISC2'].map((n, i) => ev(`media1/Music/Lumen Choir - First Light/${n}`, {}, `FA${i}`));
    evidence = [...evidence, ...discs];
    await service.runNow();
    const music = service.catalogue().titles.find((x) => x.kind === 'music')!;
    const id = encodeURIComponent(music.id);
    await send('PUT', `/api/admin/names/${id}`, t, { name: 'First Light Live' });
    expect((await send('PUT', `/api/admin/music/${id}`, t, { artist: 'Aoi Hoshino', rejectMatch: true })).status).toBe(204);
    for (const d of discs) expect(owner.snapshot().choices.get(d.discId)).toEqual({ kind: 'music', name: 'First Light Live', artist: 'Aoi Hoshino', rejectMatch: true });
    // writing one field keeps the other; null clears the artist, false clears rejectMatch
    expect((await send('PUT', `/api/admin/music/${id}`, t, { artist: null })).status).toBe(204);
    for (const d of discs) expect(owner.snapshot().choices.get(d.discId)).toEqual({ kind: 'music', name: 'First Light Live', artist: null, rejectMatch: true });
    expect((await send('PUT', `/api/admin/music/${id}`, t, { rejectMatch: false })).status).toBe(204);
    for (const d of discs) expect(owner.snapshot().choices.get(d.discId)).toEqual({ kind: 'music', name: 'First Light Live', artist: null });
  });

  it('refuses a bad music correction and an unknown id', async () => {
    await start();
    const t = await token(true);
    const discs = ['DISC1'].map((n, i) => ev(`media1/Music/Lumen Choir - First Light/${n}`, {}, `FB${i}`));
    evidence = [...evidence, ...discs];
    await service.runNow();
    const id = encodeURIComponent(service.catalogue().titles.find((x) => x.kind === 'music')!.id);
    for (const body of [{}, { artist: '  ' }, { artist: 'x'.repeat(201) }, { artist: 3 }, { rejectMatch: 'yes' }, { other: 1 }]) {
      expect((await send('PUT', `/api/admin/music/${id}`, t, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await send('PUT', '/api/admin/music/nope', t, { artist: 'x' })).status).toBe(404);
    expect((await send('PUT', `/api/admin/music/${encodeURIComponent(A.discId)}`, t, { artist: 'x' })).status).toBe(404);
  });

  it('keeps artist and rejectMatch when a release is renamed, and when its name goes back to the folder', async () => {
    await start();
    const t = await token(true);
    const discs = ['DISC1', 'DISC2'].map((n, i) => ev(`media1/Music/Lumen Choir - First Light/${n}`, {}, `FC${i}`));
    evidence = [...evidence, ...discs];
    await service.runNow();
    const id = encodeURIComponent(service.catalogue().titles.find((x) => x.kind === 'music')!.id);
    await send('PUT', `/api/admin/music/${id}`, t, { artist: 'Aoi Hoshino', rejectMatch: true });
    await send('PUT', `/api/admin/names/${id}`, t, { name: 'First Light Live' });
    for (const d of discs) expect(owner.snapshot().choices.get(d.discId)).toEqual({ kind: 'music', name: 'First Light Live', artist: 'Aoi Hoshino', rejectMatch: true });
    await send('PUT', `/api/admin/names/${id}`, t, { name: null });
    for (const d of discs) expect(owner.snapshot().choices.get(d.discId)).toEqual({ kind: 'music', name: null, artist: 'Aoi Hoshino', rejectMatch: true });
  });

  it('writes no empty music choice for a correction that carries nothing', async () => {
    await start();
    const t = await token(true);
    const discs = ['DISC1'].map((n, i) => ev(`media1/Music/Lumen Choir - First Light/${n}`, {}, `FD${i}`));
    evidence = [...evidence, ...discs];
    await service.runNow();
    const id = encodeURIComponent(service.catalogue().titles.find((x) => x.kind === 'music')!.id);
    expect((await send('PUT', `/api/admin/music/${id}`, t, { rejectMatch: false })).status).toBe(204);
    expect((await send('PUT', `/api/admin/music/${id}`, t, { artist: null })).status).toBe(204);
    expect(owner.snapshot().choices.has(discs[0]!.discId)).toBe(false);
  });
});

describe('GET admin/anilist-place', () => {
  const place = async (t: string, id: string | number): Promise<Response> => get(`/api/admin/anilist-place/${id}`, t);
  const file = async (t: string, d: DiscEvidence, answer: { titleId: string; season: number | null }): Promise<void> => {
    const res = await send('PUT', `/api/admin/discs/${encodeURIComponent(d.discId)}/choice`, t, { choice: { kind: 'title', titleId: answer.titleId, season: answer.season, disc: null } });
    expect(res.status).toBe(204);
  };
  const detail = async (t: string, id: string): Promise<TitleDetail> => (await get(`/api/titles/${encodeURIComponent(id)}`, t)).json() as Promise<TitleDetail>;

  it("answers a sequel's series and season though the NAS holds no disc of it, and a choice from it lists the disc there", async () => {
    await start();
    const t = await token(true);
    expect(service.catalogue().titles.some((x) => x.id === 'anilist:990301')).toBe(false);
    const res = await place(t, 990302);
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { titleId: string; season: number | null; name: string };
    expect(answer).toEqual({ titleId: 'anilist:990301', season: 2, name: 'Tide Bell Second' });
    // both entries of the chain were fetched, urgent, ahead of matching
    expect(new Set(anilist.entries)).toEqual(new Set(['anilist:990302', 'anilist:990301']));
    await file(t, A, answer);
    const shown = await detail(t, 'anilist:990301');
    expect(shown.seasons.map((s) => [s.id, s.number, s.label])).toEqual([['anilist:990302#season', 2, 'Tide Bell Second']]);
    expect(shown.seasons[0]!.discs.flatMap((d) => d.copies.map((c) => c.discId))).toEqual([A.discId]);
    // and it stays there once matching has run again
    await service.runNow();
    expect((await detail(t, 'anilist:990301')).seasons.map((s) => s.id)).toEqual(['anilist:990302#season']);
    expect(service.catalogue().unsorted.map((u) => u.discId)).not.toContain(A.discId);
  });

  it('keeps the chain it answered from with the filed entries, so the choice files the disc at once though the entries were only loaded for the encodes', async () => {
    await start();
    const t = await token(true);
    service.entriesFor([990302]);
    await service.encodeEntriesIdle();
    anilist.entries.length = 0;
    expect(await (await place(t, 990302)).json()).toEqual({ titleId: 'anilist:990301', season: 2, name: 'Tide Bell Second' });
    expect(anilist.entries).toEqual([]);
    // a run started now would wait on AniList: the disc must be filed without one
    let release!: () => void;
    anilist.hold = new Promise((r) => (release = r));
    await file(t, A, { titleId: 'anilist:990301', season: 2 });
    const shown = await detail(t, 'anilist:990301');
    expect(shown.seasons.map((s) => s.id)).toEqual(['anilist:990302#season']);
    expect(shown.seasons[0]!.discs.flatMap((d) => d.copies.map((c) => c.discId))).toEqual([A.discId]);
    release();
    anilist.hold = null;
  });

  it("answers a first season as its series' season 1, and asks AniList nothing for entries it holds", async () => {
    await start();
    const t = await token(true);
    expect(await (await place(t, 990301)).json()).toEqual({ titleId: 'anilist:990301', season: 1, name: 'Tide Bell' });
    anilist.entries.length = 0;
    expect(await (await place(t, 990302)).json()).toEqual({ titleId: 'anilist:990301', season: 2, name: 'Tide Bell Second' });
    expect(anilist.entries).toEqual([]);
  });

  it('answers a film as a title of its own with no season, and a lone TV entry as a series of one season', async () => {
    await start();
    const t = await token(true);
    const film = (await (await place(t, 990303)).json()) as { titleId: string; season: number | null };
    expect(film).toEqual({ titleId: 'anilist:990303', season: null, name: 'Shiokane Gekijouban' });
    await file(t, A, film);
    expect((await detail(t, 'anilist:990303')).seasons.flatMap((s) => s.discs.flatMap((d) => d.copies.map((c) => c.discId)))).toEqual([A.discId]);
    const lone = (await (await place(t, 990304)).json()) as { titleId: string; season: number | null };
    expect(lone).toEqual({ titleId: 'anilist:990304', season: 1, name: 'Lone Gull' });
    await file(t, BOX[1]!, lone);
    const shown = await detail(t, 'anilist:990304');
    expect(shown.seasons.map((s) => [s.id, s.number])).toEqual([['anilist:990304#season', 1]]);
    expect(shown.seasons[0]!.discs.flatMap((d) => d.copies.map((c) => c.discId))).toContain(BOX[1]!.discId);
  });

  it('answers 404 not-found for an entry AniList does not know, 400 for a malformed id and 409 no-season for an uncounted sequel', async () => {
    await start();
    const t = await token(true);
    const res = await place(t, 990399);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not-found' });
    for (const bad of ['abc', '0', '12345678901', '-1', 'anilist%3A990301']) expect((await place(t, bad)).status, bad).toBe(400);
    const orphan = await place(t, 990305);
    expect(orphan.status).toBe(409);
    expect(await orphan.json()).toEqual({ error: 'no-season' });
    // two sequels that would both be season 2: a choice by number would file into one of them, so neither is answered
    const fork = await place(t, 990311);
    expect(fork.status).toBe(409);
    expect(await fork.json()).toEqual({ error: 'no-season' });
    expect(await (await place(t, 990310)).json()).toEqual({ titleId: 'anilist:990310', season: 1, name: 'Fork Road' });
  });

  it('answers 503 source-unreachable when AniList is down or slow, and shares the lookup limits', async () => {
    await start({ lookupTimeoutMs: 50 });
    const t = await token(true);
    anilist.down = true;
    const down = await place(t, 990302);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: 'source-unreachable' });
    anilist.down = false;
    anilist.hold = new Promise(() => {});
    const slow = await place(t, 990302);
    expect(slow.status).toBe(503);
    expect(await slow.json()).toEqual({ error: 'source-unreachable' });
    anilist.hold = null;
    // the same device's lookups count: 2 so far plus 18 more is the minute's 20
    for (let i = 0; i < 18; i++) expect((await get('/api/admin/lookup?q=Ember&source=anilist', t)).status, `lookup ${i}`).toBe(200);
    const over = await place(t, 990302);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: 'too-many-lookups' });
  });

  it('answers lookup-busy while a lookup of the same device is in flight', async () => {
    await start();
    const t = await token(true);
    anilist.searches.length = 0; // the start's matching run
    let release!: () => void;
    anilist.hold = new Promise((r) => (release = r));
    const busy = get('/api/admin/lookup?q=Ember%20Blade&source=anilist', t);
    await vi.waitFor(() => expect(anilist.searches).toHaveLength(1));
    const second = await place(t, 990302);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({ error: 'lookup-busy' });
    release();
    anilist.hold = null;
    expect((await busy).status).toBe(200);
    expect((await place(t, 990302)).status).toBe(200);
  });
});
