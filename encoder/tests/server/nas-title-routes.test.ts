// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { titlesSignature, type EpisodeInfo } from '../../src/plan/episode-info';
import { startHelperServer, type AppContext, type HelperServer } from '../../src/server/server';
import { POSTER_PNG, startNasTestServer, type NasTestServer } from '../nas/nas-test-server';

const TOKEN = 'nas-title-token';
/**
 * Lantern Road (AniList 990001, one episode of 4 s) holds two of the stand-in's synthetic discs, the episode being
 * playlist 00001 of the first; the encodes folder holds its episode 1.
 */
const FOLDERS = { 'Anime/Lantern Road/Lantern Road Vol.1': 'disc1', 'Anime/Lantern Road/Lantern Road Vol.2': 'disc-subs' };

let nas: NasTestServer;
let server: HelperServer;
let app: AppContext;

beforeAll(async () => {
  nas = await startNasTestServer({ titles: true, titleDiscs: FOLDERS });
});
afterAll(() => nas.close());
beforeEach(async () => {
  app = { dataDir: mkdtempSync(join(tmpdir(), 'nas-titles-')), token: TOKEN, webDir: null, tools: null, sources: {} as AppContext['sources'], roots: [], nas: { client: null } };
  server = await startHelperServer(app);
});
afterEach(async () => {
  await server.close();
  rmSync(app.dataDir, { recursive: true, force: true });
});

async function get(path: string): Promise<{ status: number; body: any; raw: Buffer; type: string | null }> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
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

describe('the NAS catalogue routes', () => {
  it('answer 409 nas-not-paired until paired', async () => {
    for (const path of ['/api/nas/shows', '/api/nas/shows/anilist:990001', `/api/nas/art/${'a'.repeat(32)}`]) {
      const r = await get(path);
      expect([r.status, r.body.error]).toEqual([409, 'nas-not-paired']);
    }
  });

  it('list the shows with what is encoded, and the discs nothing filed', async () => {
    await pair();
    const r = await get('/api/nas/shows');
    expect(r.status).toBe(200);
    expect(r.body.reachable).toBe(true);
    const lantern = r.body.shows.find((s: { titleId: string }) => s.titleId === 'anilist:990001');
    expect(lantern).toMatchObject({ name: 'Lantern Road', kind: 'series', seasons: 1, films: 0, encoded: 1, toEncode: 0 });
    expect(lantern.poster).toMatch(/^\/api\/nas\/art\/[0-9a-f]{32}$/);
    const labels = r.body.unsorted.map((u: { label: string }) => u.label);
    expect(labels).toContain('disc2');
    expect(labels).not.toContain('Lantern Road Vol.1');
    for (const u of r.body.unsorted) expect(u.key).toMatch(/^[df]\./);
  });

  it('give a show its seasons, discs, playlists and episodes, encoded only for 990001-1', async () => {
    await pair();
    const r = await get('/api/nas/shows/anilist%3A990001');
    expect(r.status).toBe(200);
    expect(r.body.title).toMatchObject({ titleId: 'anilist:990001', name: 'Lantern Road', kind: 'series' });
    const season = r.body.seasons.find((s: { title: unknown }) => s.title !== null);
    expect(season.title).toEqual({ source: 'anilist', anilistId: 990001 });
    const discs = season.discs as { key: string; label: string; checked: boolean; playlists: { id: string; episodes: { number: number; name: string | null; encoded: boolean }[] }[] }[];
    expect(discs.map((d) => d.label)).toEqual(['Disc 1', 'Disc 2']);
    expect(discs[0]!.playlists).toEqual([{ id: '00001', episodes: [{ number: 1, name: null, encoded: true }] }]);
    expect(discs[1]!.playlists).toEqual([]);
    for (const d of discs) {
      expect(d.key).toMatch(/^[df]\./);
      expect(d.checked).toBe(false);
      for (const p of d.playlists) expect(p.id).toMatch(/^\d{5}$/);
    }
    expect((await get('/api/nas/shows/anilist%3A1')).status).toBe(404);
  });

  it('mark a disc checked while its playlists hold a mark for their titles and episode list', async () => {
    await pair();
    const before = (await get('/api/nas/shows/anilist%3A990001')).body;
    const disc = before.seasons[0].discs[0] as { key: string; playlists: { id: string }[] };
    const titles = { '1': { title: { source: 'anilist', anilistId: 990001 }, episode: 1, name: null } } as const;
    const writeInfo = (checked: EpisodeInfo['checked'], t: EpisodeInfo['titles']): void => {
      for (const p of disc.playlists) {
        mkdirSync(join(app.dataDir, 'chapters', disc.key), { recursive: true });
        writeFileSync(join(app.dataDir, 'chapters', disc.key, `${p.id}.json`), JSON.stringify({ chapterNames: {}, titles: t, ...(checked ? { checked } : {}), savedAt: '2026-11-10T00:00:00.000Z' }));
      }
    };
    const isChecked = async (): Promise<boolean> =>
      (await get('/api/nas/shows/anilist%3A990001')).body.seasons.flatMap((s: { discs: unknown[] }) => s.discs).find((d: { key: string }) => d.key === disc.key).checked;
    writeInfo({ episodeSpec: '1-', signature: titlesSignature(titles), at: '2026-11-10T01:00:00.000Z' }, titles);
    expect(await isChecked()).toBe(true);
    writeInfo({ episodeSpec: '1-', signature: titlesSignature(titles), at: '2026-11-10T01:00:00.000Z' }, { '1': { ...titles['1'], episode: 5 } });
    expect(await isChecked()).toBe(false);
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
      const one = await get('/api/nas/shows/anilist%3A990001');
      expect(one.body).toMatchObject({ reachable: false, stale: true });
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
