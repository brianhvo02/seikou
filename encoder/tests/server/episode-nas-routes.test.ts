// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TitleDetail } from '@seikou/nas/nas-api';
import { NasClient } from '../../src/nas/client';
import { pairWithNas } from '../../src/nas/pairing';
import { RecordStore } from '../../src/subs/record';
import { isChecked, type EpisodeInfo } from '../../src/plan/episode-info';
import { startHelperServer, type AppContext, type HelperServer } from '../../src/server/server';
import { startNasTestServer, type NasTestServer } from '../nas/nas-test-server';

const TOKEN = 'episode-nas-token';
/**
 * Lantern Road (AniList 990001): episode 1 is disc1, episode 2 is disc-vm (four chapters). disc3 is left in Unsorted.
 * Willow Lane is an AniList series of two entries: 990201 (season 1, on disc-subs) and its sequel 990202 (season 2, on
 * disc-menu, filed as its second disc).
 */
const FOLDERS = {
  'Anime/Lantern Road/Lantern Road Vol.1': 'disc1',
  'Anime/Lantern Road/Lantern Road Vol.2': 'disc-vm',
  'Anime/Lantern Road/Lantern Road Vol.2 (copy)': 'disc-vm',
  'Anime/Willow Lane/Willow Lane Vol.1': 'disc-subs',
  'Anime/Willow Lane Encore/Willow Lane Encore Vol.2': 'disc-menu',
};

let nas: NasTestServer;
let admin: NasClient;
let adminDir: string;
let ownId: string;
let server: HelperServer;
let app: AppContext;
let putChoices: string[] = [];

beforeAll(async () => {
  nas = await startNasTestServer({ titles: true, titleDiscs: FOLDERS });
  adminDir = mkdtempSync(join(tmpdir(), 'episode-nas-admin-'));
  await pairWithNas(adminDir, { code: await nas.ownerCode('Admin Owner'), base: nas.base }, 'Seikou encoder on test');
  admin = (await NasClient.load(adminDir))!;
  const made = await admin.request('admin/titles', { method: 'POST', body: JSON.stringify({ kind: 'series', name: 'Lantern Notes', seasons: 1 }), headers: { 'content-type': 'application/json' } });
  ownId = ((await made.json()) as { id: string }).id.slice('own:'.length);
});
afterAll(async () => {
  await nas.close();
  rmSync(adminDir, { recursive: true, force: true });
});
beforeEach(async () => {
  putChoices = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (init?.method === 'PUT' && /\/admin\/discs\/[^/]+\/choice/.test(String(input))) putChoices.push(String(init.body));
    return realFetch(input, init);
  });
  app = { dataDir: mkdtempSync(join(tmpdir(), 'episode-nas-')), token: TOKEN, webDir: null, tools: null, sources: {} as AppContext['sources'], roots: [], nas: { client: null } };
  server = await startHelperServer(app);
  const res = await fetch(`http://127.0.0.1:${server.port}/api/nas/pair`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ code: await nas.ownerCode('Mika Owner'), base: nas.base }),
  });
  expect(res.status).toBe(200);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
  rmSync(app.dataDir, { recursive: true, force: true });
});

interface Reply {
  status: number;
  body: any;
}
async function call(method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await globalThis.fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: JSON.parse(await res.text()) };
}
const infoPath = (key: string, pl = '00001'): string => `/api/discs/${encodeURIComponent(key)}/playlists/${pl}`;
async function discKey(titleId: string, index: number): Promise<string> {
  return (await call('GET', `/api/nas/shows/${encodeURIComponent(titleId)}`)).body.seasons[0].discs[index].key;
}
async function unsortedKey(label: string): Promise<string> {
  return (await call('GET', '/api/nas/shows')).body.unsorted.find((u: { label: string }) => u.label === label).key;
}
const anilist = (n: number, episode = 1) => ({ title: { source: 'anilist', anilistId: n }, episode, name: null });
const own = (episode: number) => ({ title: { source: 'own', ownId, season: 1 }, episode, name: null });
const save = (key: string, titles: Record<string, unknown>, pl?: string) => call('PUT', `${infoPath(key, pl)}/info`, { chapterNames: {}, titles });
const check = (key: string, episodeSpec: string, pl?: string) => call('POST', `${infoPath(key, pl)}/check`, { episodeSpec });
const lantern = async (): Promise<TitleDetail> => admin.json<TitleDetail>('titles/anilist%3A990001');

describe('the NAS prefill', () => {
  it("gives the NAS's episodes on the disc and playlist, its season's title and the even grouping", async () => {
    const key = await discKey('anilist:990001', 1);
    const r = await call('GET', `${infoPath(key)}/nas-prefill`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ episodes: [{ number: 2, name: null }], title: { source: 'anilist', anilistId: 990001 }, episodeSpec: '1-4' });
  });

  it('answers nothing for a disc the NAS has in Unsorted', async () => {
    const key = await unsortedKey('disc3');
    const playlists = (await call('GET', `/api/discs/${encodeURIComponent(key)}/playlists`)).body.playlists as { id: string }[];
    const r = await call('GET', `${infoPath(key, playlists[0]!.id)}/nas-prefill`);
    expect(r.body).toEqual({ episodes: [], title: null, episodeSpec: null });
  });
});

describe('check', () => {
  it('refuses with needs-title while an episode has no title', async () => {
    const key = await discKey('anilist:990001', 1);
    const r = await check(key, '1-2,3-4');
    expect([r.status, r.body.error]).toEqual([409, 'needs-title']);
    await save(key, { '1': anilist(990001, 2) });
    expect((await check(key, '1-2,3-4')).body.error).toBe('needs-title');
    expect(putChoices).toEqual([]);
  });

  it('leaves the NAS alone when the title is the one it files the disc under', async () => {
    const key = await discKey('anilist:990001', 1);
    await save(key, { '1': anilist(990001, 2) });
    const r = await check(key, '1-4');
    expect(r.status).toBe(200);
    expect(r.body.nasChoice).toBe('unchanged');
    expect(isChecked(r.body.info as EpisodeInfo, '1-', 4)).toBe(true);
    expect(putChoices).toEqual([]);
    expect((await call('GET', '/api/nas/shows/anilist%3A990001')).body.seasons[0].discs[1].checked).toBe(true);
  });

  it('answers mixed and writes nothing when the episodes span two shows', async () => {
    const key = await discKey('anilist:990001', 1);
    await save(key, { '1': anilist(990001, 2), '3': own(1) });
    const r = await check(key, '1-2,3-4');
    expect(r.status).toBe(200);
    expect(r.body.nasChoice).toBe('mixed');
    expect(r.body.info.checked).toBeDefined();
    expect(putChoices).toEqual([]);
  });

  it('files a disc from Unsorted, which has no match to equal', async () => {
    const key = await unsortedKey('disc3');
    const playlists = (await call('GET', `/api/discs/${encodeURIComponent(key)}/playlists`)).body.playlists as { id: string }[];
    const pl = playlists[0]!.id;
    await save(key, { '1': own(1) }, pl);
    const r = await check(key, '1-', pl);
    expect(r.body.nasChoice).toBe('saved');
    expect((await call('GET', '/api/nas/shows')).body.unsorted.map((u: { label: string }) => u.label)).not.toContain('disc3');
  });

  it('writes nothing for an AniList entry the NAS does not know, and says so', async () => {
    const key = await discKey('anilist:990001', 0);
    await save(key, { '1': anilist(990999, 1) });
    const r = await check(key, '1-');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      nasChoice: 'failed',
      message: "The NAS doesn't know this AniList entry yet, so it was left as it is. File it with “File differently…” in Seikou instead.",
    });
    expect(r.body.info.checked).toBeDefined();
    expect(putChoices).toEqual([]);
  });

  it('keeps the disc checked and says why when the NAS refuses the change', async () => {
    const key = await discKey('anilist:990001', 0);
    const unknown = { title: { source: 'own', ownId: '00000000-0000-4000-8000-000000000000', season: 1 }, episode: 1, name: null };
    await save(key, { '1': unknown });
    const r = await check(key, '1-');
    expect(r.status).toBe(200);
    expect(r.body.nasChoice).toBe('failed');
    expect(r.body.message).toMatch(/^The NAS refused the change: .*unknown title/);
    expect(r.body.info.checked).toBeDefined();
  });

  it('refuses with record-mismatch, writing nothing, when the saved subtitles were made for another grouping', async () => {
    const key = await discKey('anilist:990001', 1);
    await new RecordStore(app.dataDir).write({ disc: { key, label: 'Disc 2' }, playlist: '00001', episodeSpec: '1-3,4-', anilist: null, releases: [], fonts: [], episodes: [], savedAt: '2026-11-10T00:00:00Z' });
    await save(key, { '1': own(1), '3': own(2) });
    const r = await check(key, '1-2,3-4');
    expect([r.status, r.body.error]).toEqual([409, 'record-mismatch']);
    expect(r.body.message).toContain('grouped as 1-3,4-');
    expect(putChoices).toEqual([]);
    const info = (await call('GET', `${infoPath(key)}/info`)).body.info as EpisodeInfo;
    expect(info.checked).toBeUndefined();
    expect((await call('GET', '/api/nas/shows/anilist%3A990001')).body.seasons[0].discs[1].checked).toBe(false);
    // the same episodes written another way are the same list
    await save(key, { '1': anilist(990001, 2), '4': anilist(990001, 3) });
    expect((await check(key, '1-3,4-')).body.nasChoice).toBe('unchanged');
  });

  it('judges mixed across every playlist of the disc that has saved titles', async () => {
    const key = await discKey('anilist:990001', 1);
    await save(key, { '1': own(1) }, '00002');
    await save(key, { '1': anilist(990001, 2) });
    const r = await check(key, '1-');
    expect(r.body.nasChoice).toBe('mixed');
    expect(putChoices).toEqual([]);
  });

  it('files the disc on the NAS under the changed title, and the Library follows', async () => {
    const before = await call('GET', '/api/nas/shows');
    expect(before.body.shows.find((s: { titleId: string }) => s.titleId === 'anilist:990001')).toMatchObject({ toEncode: 1 });
    const key = await discKey('anilist:990001', 1);
    const copies = (await lantern()).seasons[0]!.discs[1]!.copies.length;
    expect(copies).toBeGreaterThan(1);
    await save(key, { '1': own(1), '3': own(2) });
    const r = await check(key, '1-2,3-4');
    expect(r.body).toMatchObject({ nasChoice: 'saved' });
    // every copy of the disc the NAS holds gets the choice
    expect(putChoices.length).toBeGreaterThanOrEqual(copies);
    expect(new Set(putChoices)).toEqual(new Set([JSON.stringify({ choice: { kind: 'title', titleId: `own:${ownId}`, season: 1, disc: null } })]));
    // the NAS's own title now lists the disc
    const detail = await admin.json<TitleDetail>(`titles/${encodeURIComponent(`own:${ownId}`)}`);
    expect(detail.seasons[0]!.discs.length).toBeGreaterThan(0);
    expect((await lantern()).seasons[0]!.discs).toHaveLength(1);
    // the kept details of both titles were read again, so the Library shows the change at once
    const after = await call('GET', '/api/nas/shows');
    expect(after.body.shows.find((s: { titleId: string }) => s.titleId === 'anilist:990001')).toMatchObject({ toEncode: 0 });
    expect((await call('GET', `/api/nas/shows/${encodeURIComponent(`own:${ownId}`)}`)).body.seasons[0].discs[0].key).toBe(key);
  });

  it('decides on the NAS as it is now, not on details it kept', async () => {
    // Lantern Road's second disc is under the own title (filed above): the encoder reads that, then another owner moves it back
    const ownDetail = await admin.json<TitleDetail>(`titles/${encodeURIComponent(`own:${ownId}`)}`);
    const slot = ownDetail.seasons[0]!.discs.find((d) => d.copies.some((c) => c.folder === 'Anime/Lantern Road/Lantern Road Vol.2'))!;
    const encoderDiscs = (await call('GET', `/api/nas/shows/${encodeURIComponent(`own:${ownId}`)}`)).body.seasons[0].discs as { key: string; discId: string }[];
    const key = encoderDiscs.find((d) => slot.copies.some((c) => c.discId === d.discId))!.key;
    expect((await call('GET', `${infoPath(key)}/nas-prefill`)).body.title).toEqual({ source: 'own', ownId, season: 1 });
    for (const c of slot.copies) {
      const moved = await admin.request(`admin/discs/${c.discId}/choice`, { method: 'PUT', body: JSON.stringify({ choice: { kind: 'title', titleId: 'anilist:990001', season: 1, disc: 2 } }), headers: { 'content-type': 'application/json' } });
      expect(moved.status).toBe(204);
    }
    // filed back under Lantern Road's season, not left in Unsorted
    expect((await lantern()).seasons[0]!.discs.map((d) => d.number)).toEqual([1, 2]);
    putChoices = [];
    await save(key, { '1': own(1) });
    expect((await check(key, '1-4')).body.nasChoice).toBe('saved');
    expect(putChoices.length).toBeGreaterThan(0);
  });

  it('files a disc under an AniList TV entry by its series and season, with no disc number', async () => {
    const willow = async (): Promise<TitleDetail> => admin.json<TitleDetail>('titles/anilist%3A990201');
    expect((await willow()).seasons.map((s) => [s.id, s.number])).toEqual([
      ['anilist:990201#season', 1],
      ['anilist:990202#season', 2],
    ]);
    const key = await discKey('anilist:990001', 0);
    await save(key, { '1': anilist(990202, 1) });
    const r = await check(key, '1-');
    expect(r.body).toMatchObject({ nasChoice: 'saved' });
    expect(new Set(putChoices)).toEqual(new Set([JSON.stringify({ choice: { kind: 'title', titleId: 'anilist:990201', season: 2, disc: null } })]));
    // the series lists the disc under its second season, beside the season's own disc 2 (the old slot's number doesn't apply there)
    const season2 = (await willow()).seasons.find((s) => s.id === 'anilist:990202#season')!;
    expect(season2.discs.map((d) => d.number)).toEqual([2, null]);
    expect((await call('GET', '/api/nas/shows')).body.unsorted.map((u: { key: string }) => u.key)).not.toContain(key);
    const shown = (await call('GET', `/api/nas/shows/${encodeURIComponent('anilist:990201')}`)).body.seasons[1].discs as { key: string | null }[];
    expect(shown.map((d) => d.key)).toContain(key);
  });
});
