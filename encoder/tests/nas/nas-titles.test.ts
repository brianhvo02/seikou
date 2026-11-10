// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NasClient } from '../../src/nas/client';
import type { TitleDetail, TitleSummary } from '@seikou/nas/nas-api';
import { anilistPlace, DETAIL_TTL_MS, NasTitles, seasonTitle } from '../../src/nas/nas-titles';
import { pairWithNas } from '../../src/nas/pairing';
import type { AppContext } from '../../src/server/http';
import { startNasTestServer, type NasTestServer } from './nas-test-server';

const UUID = '3f2a9c1e-7b4d-4e58-9a61-0c5d8e2f7b13';

describe('seasonTitle', () => {
  it('names the title of every season id the catalogue makes', () => {
    expect(seasonTitle('anilist:990001#season')).toEqual({ source: 'anilist', anilistId: 990001 });
    expect(seasonTitle('anilist:990001#discs')).toEqual({ source: 'anilist', anilistId: 990001 });
    expect(seasonTitle('tmdb-tv:990101#s2')).toEqual({ source: 'tmdb-tv', tmdbId: 990101, season: 2 });
    expect(seasonTitle('tmdb-movie:990103#discs')).toEqual({ source: 'tmdb-movie', tmdbId: 990103 });
    expect(seasonTitle(`own:${UUID}#s3`)).toEqual({ source: 'own', ownId: UUID, season: 3 });
    expect(seasonTitle(`own:${UUID}#discs`)).toEqual({ source: 'own', ownId: UUID, season: null });
  });

  it('answers null for a season the NAS has no title for yet, and for anything else', () => {
    expect(seasonTitle('anilist:990001#s2')).toBeNull();
    expect(seasonTitle('tmdb-tv:990101#discs')).toBeNull();
    expect(seasonTitle('tmdb-tv:990101#s0')).toBeNull();
    expect(seasonTitle('tmdb-movie:990103#s1')).toBeNull();
    expect(seasonTitle(`own:${UUID.toUpperCase()}#s1`)).toBeNull();
    expect(seasonTitle('music:x#discs')).toBeNull();
    expect(seasonTitle('')).toBeNull();
  });
});

describe('anilistPlace', () => {
  const summary = (id: string, kind: 'series' | 'movie'): TitleSummary =>
    ({ id, kind, names: { english: id, romaji: null, native: null, synonyms: [], display: null }, poster: null, year: null, seasons: 0, discs: 0, addedAt: 0, own: false }) as TitleSummary;
  const detail = (t: TitleSummary, seasons: [string, number | null][]): TitleDetail => ({
    title: t,
    banner: null,
    related: [],
    extras: [],
    seasons: seasons.map(([id, number]) => ({ id, label: id, number, discs: [], episodes: null, extras: [] })),
  });
  const series = summary('anilist:990201', 'series');
  const film = summary('anilist:990301', 'movie');
  const ova = summary('anilist:990401', 'series');
  const titles = [series, film, ova];
  const details = {
    [series.id]: detail(series, [
      ['anilist:990201#season', 1],
      ['anilist:990202#season', 2],
      ['anilist:990201#s3', 3],
    ]),
    [film.id]: detail(film, [['anilist:990301#discs', null]]),
    [ova.id]: detail(ova, [['anilist:990401#discs', null]]),
  };

  it("gives a series member its series and its season's number", () => {
    expect(anilistPlace(titles, details, 990201)).toEqual({ titleId: 'anilist:990201', season: 1 });
    expect(anilistPlace(titles, details, 990202)).toEqual({ titleId: 'anilist:990201', season: 2 });
  });

  it('gives an entry of its own (a film, a non-TV entry) its title and no season', () => {
    expect(anilistPlace(titles, details, 990301)).toEqual({ titleId: 'anilist:990301', season: null });
    expect(anilistPlace(titles, details, 990401)).toEqual({ titleId: 'anilist:990401', season: null });
    expect(anilistPlace([film], {}, 990301)).toEqual({ titleId: 'anilist:990301', season: null });
  });

  it('answers null for an entry the catalogue does not hold', () => {
    expect(anilistPlace(titles, details, 990999)).toBeNull();
    expect(anilistPlace(titles, details, 990203)).toBeNull();
  });
});

describe('NasTitles reading the NAS', () => {
  let nas: NasTestServer;
  let dir: string;
  let app: AppContext;
  let titles: NasTitles;
  let clock = 0;
  /** The NAS requests of the title routes, `titles`, `titles/<id>` and `encodes/ids`. */
  let requests: string[];

  beforeAll(async () => {
    nas = await startNasTestServer({
      titles: true,
      titleDiscs: { 'Anime/Lantern Road/Lantern Road Vol.1': 'disc1', 'Anime/Paper Boats/Paper Boats Vol.1': 'disc-vm' },
    });
  });
  afterAll(() => nas.close());
  beforeEach(async () => {
    requests = [];
    clock = 1_000_000;
    dir = mkdtempSync(join(tmpdir(), 'nas-titles-unit-'));
    await pairWithNas(dir, { code: await nas.ownerCode(), base: nas.base }, 'Seikou encoder on test');
    const client = (await NasClient.load(dir, (input, init) => {
      const path = new URL(String(input)).pathname.replace(/^\/api\//, '');
      if (path === 'titles' || path.startsWith('titles/') || path === 'encodes/ids') requests.push(decodeURIComponent(path));
      return fetch(input, init);
    }))!;
    app = { dataDir: dir, token: 't', webDir: null, tools: null, sources: {} as AppContext['sources'], roots: [], nas: { client } };
    titles = new NasTitles(app, () => clock);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const details = (): string[] => requests.filter((r) => r.startsWith('titles/'));
  const file = (): string => join(dir, 'nas-titles.json');

  it('reads the list and the encoded ids every time, and each title detail once within ten minutes', async () => {
    await titles.shows(app.nas.client!);
    expect(requests.filter((r) => r === 'titles')).toHaveLength(1);
    expect(details().sort()).toEqual(['titles/anilist:990001', 'titles/tmdb-tv:990111']);
    requests = [];
    clock += DETAIL_TTL_MS - 1;
    await titles.shows(app.nas.client!);
    expect(requests.sort()).toEqual(['encodes/ids', 'titles']);
  });

  it('reads the details again after ten minutes, and on refresh', async () => {
    await titles.shows(app.nas.client!);
    requests = [];
    clock += DETAIL_TTL_MS;
    await titles.shows(app.nas.client!);
    expect(details()).toHaveLength(2);
    requests = [];
    await titles.shows(app.nas.client!);
    expect(details()).toHaveLength(0);
    await titles.shows(app.nas.client!, { refresh: true });
    expect(details()).toHaveLength(2);
  });

  it('always reads the one show asked for, and keeps the other shows\' details', async () => {
    await titles.shows(app.nas.client!);
    requests = [];
    await titles.show(app.nas.client!, 'anilist:990001');
    expect(details()).toEqual(['titles/anilist:990001']);
    expect(Object.keys(JSON.parse(readFileSync(file(), 'utf8')).details).sort()).toEqual(['anilist:990001', 'tmdb-tv:990111']);
    requests = [];
    await titles.shows(app.nas.client!);
    expect(details()).toHaveLength(0);
  });

  it('writes nas-titles.json only when its content changed', async () => {
    await titles.shows(app.nas.client!);
    const first = statSync(file()).ino;
    await titles.shows(app.nas.client!);
    expect(statSync(file()).ino).toBe(first);
    clock += DETAIL_TTL_MS;
    await titles.shows(app.nas.client!);
    expect(statSync(file()).ino).not.toBe(first);
  });
});
