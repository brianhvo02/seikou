// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnsortedItem } from '@seikou/nas/nas-api';
import { retagged } from '../../../server/src/encodes/test-retag';
import { NasClient } from '../../src/nas/client';
import { pairWithNas } from '../../src/nas/pairing';
import { uploadEpisode } from '../../src/nas/upload';
import { titlesSignature, type EpisodeInfo } from '../../src/plan/episode-info';
import { startHelperServer, type AppContext, type HelperServer } from '../../src/server/server';
import { RecordStore } from '../../src/subs/record';
import { POSTER_PNG, startNasTestServer, type NasTestServer } from '../nas/nas-test-server';

const TOKEN = 'nas-title-token';
/**
 * Lantern Road (AniList 990001, two episodes of 4 s): episode 1 is playlist 00001 of disc1, episode 2 playlist 00001
 * of disc-vm (four chapters); the encodes folder holds episode 1. Paper Boats (TMDB series 990111, one season of one
 * episode) holds a second copy of disc1, with its episode encoded. An own title, Lantern Notes, is filed a disc through
 * the owner's choice and holds an encode of its episode 1 uploaded to the NAS.
 */
const FOLDERS = {
  'Anime/Lantern Road/Lantern Road Vol.1': 'disc1',
  'Anime/Lantern Road/Lantern Road Vol.2': 'disc-vm',
  'Anime/Paper Boats/Paper Boats Vol.1': 'disc1',
};
const NO_TAGS = { ANILIST_ID: null, ENCODER: null, SEIKOU_DISC_KEY: null, TITLE_NAME: null } as const;

let nas: NasTestServer;
let tmp: string;
let ownTitleId: string;
/** The NAS's id of Lantern Road's second disc, whose manifest `failManifest` can make fail. */
let vmDiscId: string;
let failManifest: string | null = null;
let server: HelperServer;
let app: AppContext;

beforeAll(async () => {
  nas = await startNasTestServer({
    titles: true,
    titleDiscs: FOLDERS,
    encodeFiles: { 'tv990111s1/1.mkv': retagged(1, { ...NO_TAGS, SEIKOU_TITLE: 'tmdb-tv:990111', SEASON: '1', EPISODE: '1' }) },
  });
  tmp = mkdtempSync(join(tmpdir(), 'nas-titles-admin-'));
  await pairWithNas(tmp, { code: await nas.ownerCode('Admin Owner'), base: nas.base }, 'Seikou encoder on test');
  const admin = (await NasClient.load(tmp))!;
  const post = (path: string, method: string, body: unknown): Promise<Response> =>
    admin.request(path, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  ownTitleId = ((await (await post('admin/titles', 'POST', { kind: 'series', name: 'Lantern Notes', seasons: 1 })).json()) as { id: string }).id;
  const unsorted = (await admin.json<{ items: UnsortedItem[] }>('admin/unsorted?limit=200')).items;
  const disc2 = unsorted.find((u) => u.path === 'syn/disc2')!;
  expect((await post(`admin/discs/${disc2.discId}/choice`, 'PUT', { choice: { kind: 'title', titleId: ownTitleId, season: 1, disc: 1 } })).status).toBe(204);
  const file = join(tmp, 'own.mkv');
  writeFileSync(file, retagged(1, { ...NO_TAGS, SEIKOU_TITLE: ownTitleId, SEASON: '1', EPISODE: '1' }));
  await uploadEpisode(admin, file, 'own-1.mkv', { id: null, sha256: null, size: 0, sent: 0 });
  const lantern = await admin.json<{ seasons: { discs: { copies: { discId: string }[] }[] }[] }>('titles/anilist%3A990001');
  vmDiscId = lantern.seasons[0]!.discs[1]!.copies[0]!.discId;
});
afterAll(async () => {
  await nas.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  failManifest = null;
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (failManifest !== null && String(input).includes(`/discs/${failManifest}/manifest`)) return new Response('{}', { status: 500 });
    return realFetch(input, init);
  });
  app = { dataDir: mkdtempSync(join(tmpdir(), 'nas-titles-')), token: TOKEN, webDir: null, tools: null, sources: {} as AppContext['sources'], roots: [], nas: { client: null } };
  server = await startHelperServer(app);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
  rmSync(app.dataDir, { recursive: true, force: true });
});

interface Reply {
  status: number;
  body: any;
  raw: Buffer;
  type: string | null;
}
async function get(path: string): Promise<Reply> {
  const res = await globalThis.fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const raw = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type');
  return { status: res.status, body: type?.includes('json') ? JSON.parse(raw.toString('utf8')) : null, raw, type };
}
async function pair(): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/nas/pair`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ code: await nas.ownerCode('Mika Owner'), base: nas.base }),
  });
  expect(res.status).toBe(200);
}
const show = (id: string): Promise<Reply> => get(`/api/nas/shows/${encodeURIComponent(id)}`);

describe('the NAS catalogue routes', () => {
  it('answer 409 nas-not-paired until paired', async () => {
    for (const path of ['/api/nas/shows', '/api/nas/shows/anilist:990001', `/api/nas/art/${'a'.repeat(32)}`]) {
      const r = await get(path);
      expect([r.status, r.body.error]).toEqual([409, 'nas-not-paired']);
    }
  });

  it('list the shows with their counts, and the discs nothing filed', async () => {
    await pair();
    const r = await get('/api/nas/shows');
    expect(r.status).toBe(200);
    expect(r.body.reachable).toBe(true);
    const by = (id: string): any => r.body.shows.find((s: { titleId: string }) => s.titleId === id);
    expect(by('anilist:990001')).toMatchObject({ name: 'Lantern Road', kind: 'series', seasons: 1, films: 0, encoded: 1, toEncode: 1 });
    expect(by('anilist:990001').poster).toMatch(/^\/api\/nas\/art\/[0-9a-f]{32}$/);
    expect(by('tmdb-tv:990111')).toMatchObject({ name: 'Paper Boats', seasons: 1, films: 0, encoded: 1, toEncode: 0 });
    // an own title has no episode list on the NAS, so nothing of it is counted
    expect(by(ownTitleId)).toMatchObject({ name: 'Lantern Notes', seasons: 1, encoded: 0, toEncode: 0 });
    const labels = r.body.unsorted.map((u: { label: string }) => u.label);
    expect(labels).toContain('disc3');
    expect(labels).not.toContain('disc2');
    expect(labels).not.toContain('Lantern Road Vol.1');
    for (const u of r.body.unsorted) expect(u.key).toMatch(/^[df]\./);
  });

  it('give a show its seasons, discs, playlists and episodes, encoded only where the Encodes library holds them', async () => {
    await pair();
    const r = await show('anilist:990001');
    expect(r.status).toBe(200);
    expect(r.body.title).toMatchObject({ titleId: 'anilist:990001', name: 'Lantern Road', kind: 'series' });
    const season = r.body.seasons[0];
    expect(season.title).toEqual({ source: 'anilist', anilistId: 990001 });
    expect(season.discs.map((d: { label: string; available: boolean; checked: boolean }) => [d.label, d.available, d.checked])).toEqual([
      ['Disc 1', true, false],
      ['Disc 2', true, false],
    ]);
    expect(season.discs[0].key).toMatch(/^[df]\./);
    expect(season.discs[0].playlists).toEqual([{ id: '00001', episodes: [{ number: 1, name: null, encoded: true }] }]);
    expect(season.discs[1].playlists).toEqual([{ id: '00001', episodes: [{ number: 2, name: null, encoded: false }] }]);
    expect((await show('anilist:1')).status).toBe(404);
  });

  it('give a TMDB season and an own title the title their encodes are tagged with', async () => {
    await pair();
    const tv = (await show('tmdb-tv:990111')).body.seasons[0];
    expect(tv.title).toEqual({ source: 'tmdb-tv', tmdbId: 990111, season: 1 });
    expect(tv.discs[0].playlists).toEqual([{ id: '00001', episodes: [{ number: 1, name: null, encoded: true }] }]);
    const own = (await show(ownTitleId)).body.seasons[0];
    expect(own.title).toEqual({ source: 'own', ownId: ownTitleId.slice('own:'.length), season: 1 });
    expect(own.discs).toHaveLength(1);
    expect(own.discs[0]).toMatchObject({ available: true, playlists: [], checked: false });
  });

  it('list a disc the encoder mirrors no copy of as unavailable, never checked', async () => {
    failManifest = vmDiscId;
    await pair();
    const disc = (await show('anilist:990001')).body.seasons[0].discs[1];
    expect(disc).toEqual({ key: null, discId: vmDiscId, label: 'Disc 2', available: false, playlists: [{ id: '00001', episodes: [{ number: 2, name: null, encoded: false }] }], checked: false });
  });

  describe('checked', () => {
    const titles = { '1': { title: { source: 'anilist', anilistId: 990001 }, episode: 2, name: null } } as const;
    let key: string;
    const mark = (spec: string, t: EpisodeInfo['titles'] = titles): EpisodeInfo['checked'] => ({ episodeSpec: spec, signature: titlesSignature(t), at: '2026-11-10T01:00:00.000Z' });
    const writeInfo = (checked: EpisodeInfo['checked'], t: EpisodeInfo['titles'] = titles): void => {
      mkdirSync(join(app.dataDir, 'chapters', key), { recursive: true });
      writeFileSync(join(app.dataDir, 'chapters', key, '00001.json'), JSON.stringify({ chapterNames: {}, titles: t, ...(checked ? { checked } : {}), savedAt: '2026-11-10T00:00:00.000Z' }));
    };
    const writeRecord = (episodeSpec: string): Promise<void> =>
      new RecordStore(app.dataDir).write({ disc: { key, label: 'Disc 2' }, playlist: '00001', episodeSpec, anilist: null, releases: [], fonts: [], episodes: [], savedAt: '2026-11-10T00:00:00Z' });
    const checked = async (): Promise<boolean> => (await show('anilist:990001')).body.seasons[0].discs[1].checked;

    beforeEach(async () => {
      await pair();
      key = (await show('anilist:990001')).body.seasons[0].discs[1].key;
    });

    it('holds while the mark, the titles and the grouping agree (the playlist has four chapters)', async () => {
      writeInfo(mark('1-2,3-4'));
      expect(await checked()).toBe(true);
    });

    it('holds when the record writes the same episodes another way', async () => {
      writeInfo(mark('1-2,3-4'));
      await writeRecord('1-2,3-');
      expect(await checked()).toBe(true);
    });

    it('clears when the record groups the chapters differently', async () => {
      writeInfo(mark('1-2,3-4'));
      await writeRecord('1-3,4-');
      expect(await checked()).toBe(false);
    });

    it('clears when an episode title changes', async () => {
      writeInfo(mark('1-2,3-4'), { '1': { ...titles['1'], episode: 3 } });
      expect(await checked()).toBe(false);
    });

    it('is false without a mark', async () => {
      writeInfo(undefined);
      expect(await checked()).toBe(false);
    });
  });

  it('serve the last answer with reachable false while the NAS is stopped', async () => {
    await pair();
    const live = await get('/api/nas/shows');
    expect(JSON.parse(readFileSync(join(app.dataDir, 'nas-titles.json'), 'utf8')).base).toBe(nas.base);
    await nas.pause();
    try {
      const r = await get('/api/nas/shows');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ reachable: false, stale: true });
      expect(r.body.shows).toEqual(live.body.shows);
      expect(r.body.unsorted).toEqual(live.body.unsorted);
      expect((await show('anilist:990001')).body).toMatchObject({ reachable: false, stale: true });
    } finally {
      await nas.resume();
    }
  });

  it('answer an empty list, not reachable, on a first load with the NAS down', async () => {
    await pair();
    rmSync(join(app.dataDir, 'nas-titles.json'), { force: true });
    await server.close();
    server = await startHelperServer(app);
    await nas.pause();
    try {
      const r = await get('/api/nas/shows');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ shows: [], reachable: false });
    } finally {
      await nas.resume();
    }
  });

  it('pass a poster through from the NAS, and refuse ids that are not art ids', async () => {
    await pair();
    const poster = (await get('/api/nas/shows')).body.shows.find((s: { titleId: string }) => s.titleId === 'anilist:990001').poster as string;
    const art = await get(poster);
    expect(art.status).toBe(200);
    expect(art.type).toBe('image/png');
    expect(art.raw.equals(POSTER_PNG)).toBe(true);
    expect((await get('/api/nas/art/not-an-id')).status).toBe(404);
    expect((await get(`/api/nas/art/${'0'.repeat(32)}`)).status).toBe(404);
  });
});
