import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeStrict, normalizeTitle } from '@seikou/nas/title-text';
import { ArtCache } from '@seikou/titles/art';
import type { DiscEvidence } from './evidence';
import { OwnerStore } from '@seikou/titles/owner-store';
import { MATCH_RULES_VERSION } from '@seikou/titles/match';
import type { FolderCover } from '@seikou/titles/catalogue';
import type { MusicRelease, MusicSource } from '@seikou/titles/music-sources';
import { downloadRootNames, fixtureSources, loadDiscDbOrNone, releaseFolderOf, TitleService } from './service';
import { SourceUnavailable } from '@seikou/titles/sources';
import type { Entry, EntryNames, MetadataSource } from '@seikou/titles/sources';

// Every title and path here is made up (ruling R4).

const DAY = 86_400_000;

function entry(id: string, names: Partial<EntryNames>, more: Partial<Entry> = {}): Entry {
  const source = id.startsWith('anilist:') ? 'anilist' : 'tmdb';
  return {
    source,
    id,
    kind: id.startsWith('tmdb-movie:') ? 'movie' : 'series',
    format: source === 'anilist' ? 'TV' : null,
    names: { english: null, romaji: null, native: null, synonyms: [], ...names },
    animation: source === 'anilist' ? true : null,
    year: null,
    episodes: null,
    runtimeMin: null,
    seasons: [],
    relations: [],
    poster: null,
    banner: null,
    ...more,
  };
}

/** TMDB's search answers carry no seasons; only the entry by id has them. */
const searchShape = (en: Entry): Entry => (en.source === 'tmdb' && en.kind === 'series' ? { ...en, seasons: [] } : en);

/**
 * A source answering fixed entries per normalised query (TMDB series as search shows them) and by id, counting calls;
 * `down` makes every call throw.
 */
function fake(results: Record<string, Entry[]>, more: readonly Entry[] = []): MetadataSource & { calls: string[]; down: boolean; failIds: Set<string>; byId: Map<string, Entry> } {
  const byKey = new Map(Object.entries(results).map(([q, es]) => [normalizeTitle(q), es]));
  const byId = new Map([...Object.values(results).flat(), ...more].map((en) => [en.id, en]));
  const src = {
    calls: [] as string[],
    down: false,
    failIds: new Set<string>(),
    byId,
    async search(query: string): Promise<Entry[]> {
      src.calls.push(`search:${normalizeTitle(query)}`);
      if (src.down) throw new SourceUnavailable('down');
      return (byKey.get(normalizeTitle(query)) ?? []).map(searchShape);
    },
    async entry(id: string): Promise<Entry | null> {
      src.calls.push(`entry:${id}`);
      if (src.down || src.failIds.has(id)) throw new SourceUnavailable('down');
      return byId.get(id) ?? null;
    },
  };
  return src;
}

function ev(path: string, titles: Record<string, string> = {}, fingerprint: string | null = null): DiscEvidence {
  return {
    discId: `id:${path}`,
    path,
    fingerprint,
    discTitles: Object.entries(titles).map(([lang, name]) => ({ lang, name })),
    segments: path.split('/').slice(1),
    catalogueNumbers: [],
    playlists: [],
  };
}

const EMBER = entry('anilist:100', { english: 'Ember Blade', romaji: 'Hinokiri no Ken', native: '火斬りの剣' }, { episodes: 12 });
const STARFALL = entry('anilist:400', { english: 'Starfall Traveler' }, { episodes: 12 });
const A = ev('media1/Anime/火斬りの剣/[BDMV][220629][火斬りの剣][Vol.1]', { jpn: '火斬りの剣' });
const A2 = ev('media1/Anime/火斬りの剣/[BDMV][220629][火斬りの剣][Vol.2]', { eng: 'Hinokiri no Ken' });
const B = ev('media1/Anime/Starfall Traveler/[BDMV] Starfall Traveler Vol.1', { eng: 'Starfall Traveler' });
const UNKNOWN = ev('media1/Misc/[BDMV] Nothing Like It', { eng: 'Nothing Like It' });

let dir: string;
let clock: number;
let timers: { fn: () => void; ms: number }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'title-service-'));
  clock = 1_000;
  timers = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function service(opts: {
  evidence: () => readonly DiscEvidence[]; anilist: MetadataSource; tmdb?: MetadataSource | null; owner?: OwnerStore; downloadRoots?: string[];
  musicbrainz?: MusicSource | null; discogs?: MusicSource | null; folderCover?: (dir: string) => Promise<FolderCover | null>; locateRelease?: (discId: string, group: string) => string | null;
}): TitleService {
  return new TitleService({
    musicbrainz: opts.musicbrainz ?? null,
    discogs: opts.discogs ?? null,
    folderCover: opts.folderCover ?? (async () => null),
    locateRelease: opts.locateRelease ?? (() => null),
    library: { evidence: opts.evidence },
    owner: opts.owner ?? new OwnerStore(dir),
    dataDir: dir,
    anilist: opts.anilist,
    tmdb: opts.tmdb ?? null,
    discdb: { lookup: () => null },
    art: new ArtCache(join(dir, 'art'), vi.fn()),
    downloadRoots: new Set(opts.downloadRoots ?? []),
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return () => timers.splice(timers.indexOf(t), 1);
    },
  });
}

interface File { cache: Record<string, { at: number; value: unknown[] }>; pool: Record<string, Entry>; entries: Record<string, { at: number; value: Entry }>; lastRunAt: number | null }
const metadata = (): File => JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')) as File;
const discsOf = (s: TitleService, id: string): number | undefined => s.catalogue().titles.find((t) => t.id === id)?.discs;
const reasonOf = (s: TitleService, d: DiscEvidence): string | undefined => s.catalogue().unsorted.find((u) => u.discId === d.discId)?.reason;

describe('TitleService', () => {
  it('builds the catalogue after a run and keeps it in metadata.json', async () => {
    const s = service({ evidence: () => [A], anilist: fake({ 火斬りの剣: [EMBER] }) });
    expect(s.catalogue().titles).toEqual([]);
    await s.runNow();
    expect(s.catalogue().titles.map((t) => t.id)).toEqual(['anilist:100']);
    expect(discsOf(s, 'anilist:100')).toBe(1);
    expect(existsSync(join(dir, 'metadata.json'))).toBe(true);
  });

  it('serves the last catalogue after a restart, before any run and with no source calls', async () => {
    await service({ evidence: () => [A], anilist: fake({ 火斬りの剣: [EMBER] }) }).runNow();
    const anilist = fake({ 火斬りの剣: [EMBER] });
    const s = service({ evidence: () => [A], anilist });
    expect(s.catalogue().titles.map((t) => t.id)).toEqual(['anilist:100']);
    await s.runNow();
    expect(anilist.calls).toEqual([]);
  });

  it('asks for posters stored before the sizes went up at the new sizes after a restart, with no source calls', async () => {
    const cover = 'https://s4.anilist.co/file/anilistcdn/media/anime/cover';
    const old = { small: `${cover}/small/bx100-Ab.jpg`, large: `${cover}/medium/bx100-Ab.jpg` };
    await service({ evidence: () => [A], anilist: fake({ 火斬りの剣: [{ ...EMBER, poster: old }] }) }).runNow();
    const anilist = fake({ 火斬りの剣: [EMBER] });
    const s = service({ evidence: () => [A], anilist });
    const poster = s.catalogue().titles[0]!.poster!;
    expect(s.catalogue().art(poster)).toEqual({ small: `${cover}/medium/bx100-Ab.jpg`, large: `${cover}/large/bx100-Ab.jpg` });
    expect(anilist.calls).toEqual([]);
  });

  it('makes no source calls when a run finds the evidence unchanged', async () => {
    const anilist = fake({ 火斬りの剣: [EMBER] });
    const s = service({ evidence: () => [A], anilist });
    await s.runNow();
    expect(anilist.calls.length).toBeGreaterThan(0);
    anilist.calls.length = 0;
    clock += DAY;
    await s.runNow();
    expect(anilist.calls).toEqual([]);
  });

  describe('matching rules version', () => {
    // entries as the sources give them now, with a start date field (null: unknown), so a rules bump has nothing to refresh
    const dated = { ...EMBER, startDate: null };
    const sources = () => fake({ 火斬りの剣: [dated], 'Hinokiri no Ken': [dated], 'Starfall Traveler': [{ ...STARFALL, startDate: null }] });
    const rewrite = (change: (data: Record<string, unknown>) => void): void => {
      const data = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')) as Record<string, unknown>;
      change(data);
      writeFileSync(join(dir, 'metadata.json'), JSON.stringify(data));
    };
    const evidence = () => [A, A2, B];

    it('on a rules bump, re-fetches once each cached entry a disc names that lacks a start date, before matching', async () => {
      // the first run's entries come from before start dates: EMBER has no field; STARFALL has one
      const old = fake({ 火斬りの剣: [EMBER], 'Hinokiri no Ken': [EMBER], 'Starfall Traveler': [{ ...STARFALL, startDate: 20190405 }] });
      await service({ evidence, anilist: old }).runNow();
      rewrite((d) => { d.rulesVersion = MATCH_RULES_VERSION - 1; });
      const fresh = { ...EMBER, startDate: 20220110 };
      const anilist = fake({ 火斬りの剣: [EMBER], 'Hinokiri no Ken': [EMBER], 'Starfall Traveler': [STARFALL] }, [fresh]);
      anilist.byId.set('anilist:100', fresh);
      const s = service({ evidence, anilist });
      clock += DAY;
      await s.runNow();
      expect(anilist.calls.filter((c) => c === 'entry:anilist:100')).toHaveLength(1);
      expect(anilist.calls.filter((c) => c === 'entry:anilist:400')).toHaveLength(0);
      expect(anilist.calls.filter((c) => c.startsWith('search:'))).toEqual([]);
      expect(metadata().pool['anilist:100']!.startDate).toBe(20220110);
      // the search results the matcher reads carry the refreshed entry too
      expect(Object.values(metadata().cache).some((d) => d.value.includes('anilist:100'))).toBe(true);
      // the next run refreshes nothing
      anilist.calls.length = 0;
      clock += DAY;
      await s.runNow();
      expect(anilist.calls).toEqual([]);
    });

    it('keeps an entry whose re-fetch fails, and still matches', async () => {
      await service({ evidence, anilist: fake({ 火斬りの剣: [EMBER], 'Hinokiri no Ken': [EMBER], 'Starfall Traveler': [STARFALL] }) }).runNow();
      rewrite((d) => { d.rulesVersion = MATCH_RULES_VERSION - 1; });
      const anilist = fake({ 火斬りの剣: [EMBER], 'Hinokiri no Ken': [EMBER], 'Starfall Traveler': [STARFALL] });
      anilist.failIds.add('anilist:100');
      const s = service({ evidence, anilist });
      clock += DAY;
      await s.runNow();
      expect(anilist.calls.filter((c) => c === 'entry:anilist:100').length).toBeGreaterThan(0);
      expect(metadata().pool['anilist:100']).toBeDefined();
      expect(s.catalogue().titles.map((t) => t.id).sort()).toEqual(['anilist:100', 'anilist:400']);
    });

    it('stores the rules version, and an unchanged one re-matches nothing', async () => {
      expect(Number.isSafeInteger(MATCH_RULES_VERSION)).toBe(true);
      await service({ evidence, anilist: sources() }).runNow();
      expect((metadata() as unknown as { rulesVersion: unknown }).rulesVersion).toBe(MATCH_RULES_VERSION);
      expect((metadata() as unknown as { version: unknown }).version).toBe(2);
      const anilist = sources();
      const s = service({ evidence, anilist });
      clock += DAY;
      await s.runNow();
      expect(s.status().groupsTotal).toBe(0);
      expect(anilist.calls).toEqual([]);
    });

    it('re-matches every disc when the stored version differs or is missing, from the cache, with no new source calls', async () => {
      for (const change of [(d: Record<string, unknown>) => { d.rulesVersion = MATCH_RULES_VERSION - 1; }, (d: Record<string, unknown>) => { delete d.rulesVersion; }]) {
        await service({ evidence, anilist: sources() }).runNow();
        rewrite(change);
        const anilist = sources();
        const s = service({ evidence, anilist });
        // the older file loads, it isn't set aside
        expect(readdirSync(dir).filter((f) => f.includes('corrupt'))).toEqual([]);
        expect(s.catalogue().titles.map((t) => t.id).sort()).toEqual(['anilist:100', 'anilist:400']);
        clock += DAY;
        await s.runNow();
        expect(s.status().groupsTotal).toBe(2);
        expect(s.status().groupsDone).toBe(2);
        expect(anilist.calls).toEqual([]);
        expect((metadata() as unknown as { rulesVersion: unknown }).rulesVersion).toBe(MATCH_RULES_VERSION);
        // and the next run is back to nothing
        await s.runNow();
        expect(s.status().groupsTotal).toBe(0);
        rmSync(join(dir, 'metadata.json'));
      }
    });
  });

  it('keeps filed discs filed when the source is unreachable, marks the new groups and retries them next run (Review Focus 2)', async () => {
    const anilist = fake({ 火斬りの剣: [EMBER], 'Hinokiri no Ken': [EMBER], 'Starfall Traveler': [STARFALL] });
    let evidence: DiscEvidence[] = [A];
    const s = service({ evidence: () => evidence, anilist });
    await s.runNow();
    expect(discsOf(s, 'anilist:100')).toBe(1);

    // A2 joins A's group (so the group is matched again), B is a new group, and the source is down
    evidence = [A, A2, B];
    anilist.down = true;
    clock += 60_000;
    await s.runNow();
    expect(discsOf(s, 'anilist:100')).toBe(1);
    expect(reasonOf(s, A)).toBeUndefined();
    expect(reasonOf(s, A2)).toBe('source-unreachable');
    expect(reasonOf(s, B)).toBe('source-unreachable');

    anilist.down = false;
    anilist.calls.length = 0;
    clock += 60_000;
    await s.runNow();
    expect(anilist.calls).toContain(`search:${normalizeTitle('Hinokiri no Ken')}`);
    expect(anilist.calls).toContain(`search:${normalizeTitle('Starfall Traveler')}`);
    expect(discsOf(s, 'anilist:100')).toBe(2);
    expect(discsOf(s, 'anilist:400')).toBe(1);
    expect(s.catalogue().unsorted).toEqual([]);
  });

  it('counts groups in its status during a run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = fake({ 火斬りの剣: [EMBER], 'Starfall Traveler': [STARFALL] });
    const anilist: MetadataSource = {
      search: async (q, o) => {
        await gate;
        return inner.search(q, o);
      },
      entry: (id) => inner.entry(id),
    };
    const s = service({ evidence: () => [A, B], anilist });
    expect(s.status()).toEqual({ running: false, groupsDone: 0, groupsTotal: 0, filed: 0, unsorted: 0, music: 0, lastRunAt: null, tmdb: false, gate: 'owners' });
    const run = s.runNow();
    await Promise.resolve();
    expect(s.status()).toMatchObject({ running: true, groupsDone: 0, groupsTotal: 2 });
    release();
    await run;
    expect(s.status()).toEqual({ running: false, groupsDone: 2, groupsTotal: 2, filed: 2, unsorted: 0, music: 0, lastRunAt: clock, tmdb: false, gate: 'owners' });
  });

  it("dates a disc's addedAt at its first sighting, unchanged by later runs", async () => {
    let evidence: DiscEvidence[] = [A];
    const anilist = fake({ 火斬りの剣: [EMBER], 'Starfall Traveler': [STARFALL] });
    const s = service({ evidence: () => evidence, anilist });
    clock = 5_000;
    await s.runNow();
    evidence = [{ ...A, catalogueNumbers: ['ABCD-12345'] }, B]; // A changed, so it is matched again
    clock = 9_000;
    await s.runNow();
    const added = (id: string): number | undefined => s.catalogue().titles.find((t) => t.id === id)?.addedAt;
    expect(added('anilist:100')).toBe(5_000);
    expect(added('anilist:400')).toBe(9_000);
    expect(service({ evidence: () => evidence, anilist }).catalogue().titles.find((t) => t.id === 'anilist:100')?.addedAt).toBe(5_000);
  });

  it('orders copies on the Downloads roots it is given last (C1)', async () => {
    const dl = ev('media0-dl/Anime/火斬りの剣/[BDMV][220629][火斬りの剣][Vol.1]', { jpn: '火斬りの剣' });
    const s = service({ evidence: () => [dl, A], anilist: fake({ 火斬りの剣: [EMBER] }), downloadRoots: ['media0-dl'] });
    await s.runNow();
    const copies = s.catalogue().detail('anilist:100')!.seasons[0]!.discs[0]!.copies;
    expect(copies.map((c) => c.root)).toEqual(['media1', 'media0-dl']);
  });

  it('names the roots in the Downloads group', () => {
    expect([...downloadRootNames([{ name: 'media1', dir: '/a' }, { name: 'media1-dl', dir: '/b', group: 'Downloads' }, { name: 'x', dir: '/c', group: 'Other' }])]).toEqual(['media1-dl']);
  });

  it('loads the whole PREQUEL/SEQUEL chain of a filed entry, so its series is not provisional (C2)', async () => {
    const s1 = entry('anilist:300', { english: 'Ember Blade' }, { year: 2019, relations: [{ type: 'SEQUEL', id: 'anilist:120', format: 'TV', startDate: 20210407 }] });
    const s2 = entry('anilist:120', { english: 'Ember Blade Season 2' }, {
      year: 2021, episodes: 12,
      relations: [
        { type: 'PREQUEL', id: 'anilist:300', format: 'TV', startDate: 20190405 },
        { type: 'SEQUEL', id: 'anilist:450', format: 'TV', startDate: 20230701 },
      ],
    });
    const s3 = entry('anilist:450', { english: 'Ember Blade Season 3' }, { year: 2023, relations: [{ type: 'PREQUEL', id: 'anilist:120', format: 'TV', startDate: 20210407 }] });
    const disc = ev('media1/Anime/[BDMV] Ember Blade Season 2 Vol.1', { eng: 'Ember Blade Season 2' });
    const anilist = fake({ 'Ember Blade': [s2] }, [s1, s3]);
    const s = service({ evidence: () => [disc], anilist });
    await s.runNow();
    expect(s.catalogue().titles.map((t) => t.id)).toEqual(['anilist:300']);
    expect(s.catalogue().provisional).toEqual([]);
    expect(Object.keys(metadata().entries).sort()).toEqual(['anilist:120', 'anilist:300', 'anilist:450']);
  });

  it('loads at most 30 entries of one chain', async () => {
    const chain = Array.from({ length: 40 }, (_, i) => entry(`anilist:${1000 + i}`, { english: i === 0 ? 'Long Saga' : `Long Saga Part ${i + 1}` }, {
      year: 2000 + i, episodes: 12,
      relations: i < 39 ? [{ type: 'SEQUEL', id: `anilist:${1001 + i}`, format: 'TV', startDate: (2001 + i) * 10000 + 101 }] : [],
    }));
    const disc = ev('media1/Anime/[BDMV] Long Saga Vol.1', { eng: 'Long Saga' });
    const anilist = fake({ 'Long Saga': [chain[0]!] }, chain);
    const s = service({ evidence: () => [disc], anilist });
    await s.runNow();
    expect(discsOf(s, 'anilist:1000')).toBe(1);
    expect(Object.keys(metadata().entries).length).toBe(30);
  });

  it('keeps a filed disc when loading its chain fails, and loads the rest next run (C2, C5)', async () => {
    const s1 = entry('anilist:300', { english: 'Ember Blade' }, { year: 2019, episodes: 12, relations: [{ type: 'SEQUEL', id: 'anilist:120', format: 'TV', startDate: 20210407 }] });
    const s2 = entry('anilist:120', { english: 'Ember Blade Season 2' }, { year: 2021, relations: [{ type: 'PREQUEL', id: 'anilist:300', format: 'TV', startDate: 20190405 }] });
    const disc = ev('media1/Anime/[BDMV] Ember Blade Vol.1', { eng: 'Ember Blade' });
    const anilist = fake({ 'Ember Blade': [s1] }, [s2]);
    anilist.failIds.add('anilist:120');
    const s = service({ evidence: () => [disc], anilist });
    await s.runNow();
    expect(discsOf(s, 'anilist:300')).toBe(1);
    expect(Object.keys(metadata().entries)).toEqual(['anilist:300']);

    anilist.failIds.clear();
    clock += 60_000;
    await s.runNow();
    expect(discsOf(s, 'anilist:300')).toBe(1);
    expect(Object.keys(metadata().entries).sort()).toEqual(['anilist:120', 'anilist:300']);
  });

  it('loads the entries owner choices name, so those discs leave Unsorted (C3)', async () => {
    const owner = new OwnerStore(dir);
    owner.setChoice(UNKNOWN.discId, null, { kind: 'title', titleId: 'tmdb-movie:77', season: null, disc: null });
    const tmdb = fake({}, [entry('tmdb-movie:77', { english: 'Nothing Like It' }, { year: 2020 })]);
    const s = service({ evidence: () => [UNKNOWN], anilist: fake({}), tmdb, owner });
    await s.runNow();
    expect(tmdb.calls).toContain('entry:tmdb-movie:77');
    expect(discsOf(s, 'tmdb-movie:77')).toBe(1);
    expect(s.catalogue().unsorted).toEqual([]);
  });

  it('reattaches owner choices to the present discs before building (C4)', async () => {
    const owner = new OwnerStore(dir);
    owner.setChoice('id:old-place', 'FP1', { kind: 'hidden' });
    const moved = ev('media1/Misc/[BDMV] Nothing Like It', {}, 'FP1');
    const reattach = vi.spyOn(owner, 'reattach');
    const s = service({ evidence: () => [moved], anilist: fake({}), owner });
    await s.runNow();
    expect(reattach).toHaveBeenCalledWith([{ id: moved.discId, fingerprint: 'FP1' }]);
    expect(s.catalogue().hidden.map((d) => d.discId)).toEqual([moved.discId]);
  });

  it('rebuilds the catalogue after a choice change with no source calls (C6)', async () => {
    const owner = new OwnerStore(dir);
    const anilist = fake({ 火斬りの剣: [EMBER] });
    const s = service({ evidence: () => [A], anilist, owner });
    await s.runNow();
    anilist.calls.length = 0;
    owner.setChoice(A.discId, null, { kind: 'hidden' });
    s.rebuild();
    expect(s.catalogue().titles).toEqual([]);
    expect(s.catalogue().hidden.map((d) => d.discId)).toEqual([A.discId]);
    expect(anilist.calls).toEqual([]);
  });

  it('retries Unsorted weekly', async () => {
    const anilist = fake({});
    const s = service({ evidence: () => [UNKNOWN], anilist });
    await s.runNow();
    expect(reasonOf(s, UNKNOWN)).toBe('no-title');
    anilist.calls.length = 0;
    clock += 6 * DAY;
    await s.runNow();
    expect(anilist.calls).toEqual([]);
    clock += 2 * DAY;
    await s.runNow();
    expect(anilist.calls).toContain(`search:${normalizeTitle('Nothing Like It')}`);
  });

  it('runs on its timer when the weekly retry is due', async () => {
    const anilist = fake({});
    const s = service({ evidence: () => [UNKNOWN], anilist });
    await s.runNow();
    anilist.calls.length = 0;
    expect(timers.length).toBe(1);
    expect(timers[0]!.ms).toBeLessThanOrEqual(DAY);
    clock += DAY;
    timers[0]!.fn();
    await Promise.resolve();
    expect(anilist.calls).toEqual([]);
    clock += 7 * DAY;
    timers[timers.length - 1]!.fn();
    await vi.waitFor(() => expect(anilist.calls.length).toBeGreaterThan(0));
    s.close();
  });

  it('refreshes entries older than 30 days monthly, and drops search results older than 30 days from metadata.json', async () => {
    const anilist = fake({ 火斬りの剣: [EMBER] });
    const s = service({ evidence: () => [A], anilist });
    await s.runNow();
    expect(Object.keys(metadata().cache)).toContain(`anilist:${normalizeStrict('火斬りの剣')}`);
    anilist.byId.set('anilist:100', { ...EMBER, names: { ...EMBER.names, english: 'Ember Blade (renamed)' } });
    anilist.calls.length = 0;
    clock += 31 * DAY;
    await s.runNow();
    expect(anilist.calls).toEqual(['entry:anilist:100']);
    expect(s.catalogue().titles[0]!.names.english).toBe('Ember Blade (renamed)');
    expect(Object.keys(metadata().cache).filter((k) => !k.includes('-entry:'))).toEqual([]);
    anilist.calls.length = 0;
    clock += DAY;
    await s.runNow();
    expect(anilist.calls).toEqual([]);
  });

  it('matches a box family together, so an added Box 2 is numbered after an unchanged Box 1 (T8b)', async () => {
    const tmdb = fake({ Brasswick: [entry('tmdb-tv:7', { english: 'Brasswick' }, { seasons: [{ number: 1, episodes: 12, runtimeMin: 24 }] })] });
    const box1 = [ev('media1/TV/Brasswick/Brasswick BOX 1/DISC1'), ev('media1/TV/Brasswick/Brasswick BOX 1/DISC2')];
    const box2 = ev('media1/TV/Brasswick/Brasswick BOX 2/DISC1');
    let evidence = [...box1];
    const s = service({ evidence: () => evidence, anilist: fake({}), tmdb });
    await s.runNow();
    expect(discsOf(s, 'tmdb-tv:7')).toBe(2);
    evidence = [...box1, box2];
    clock += 60_000;
    await s.runNow();
    expect(s.catalogue().unsorted).toEqual([]);
    const slots = s.catalogue().detail('tmdb-tv:7')!.seasons[0]!.discs;
    expect(slots.map((d) => [d.number, d.copies[0]!.discId])).toEqual([[1, box1[0]!.discId], [2, box1[1]!.discId], [3, box2.discId]]);
  });

  it('caches an entry lookup that found nothing, and asks again only on the weekly retry (T8c)', async () => {
    const s1 = entry('anilist:300', { english: 'Ember Blade' }, { year: 2019, episodes: 12, relations: [{ type: 'SEQUEL', id: 'anilist:999', format: 'TV', startDate: 20210407 }] });
    const disc = ev('media1/Anime/[BDMV] Ember Blade Vol.1', { eng: 'Ember Blade' });
    const anilist = fake({ 'Ember Blade': [s1] });
    const s = service({ evidence: () => [disc], anilist });
    await s.runNow();
    expect(anilist.calls).toContain('entry:anilist:999');
    anilist.calls.length = 0;
    clock += DAY;
    await s.runNow();
    expect(anilist.calls).toEqual([]);
    expect(service({ evidence: () => [disc], anilist }).catalogue().titles.map((t) => t.id)).toEqual(['anilist:300']);
    clock += 7 * DAY;
    await s.runNow();
    expect(anilist.calls).toEqual(['entry:anilist:999']);
  });

  it('keeps a filed disc whose evidence changed during an outage filed until a re-match succeeds (T8d)', async () => {
    const anilist = fake({ 火斬りの剣: [EMBER], 'Hinokiri no Ken': [EMBER] });
    let evidence: DiscEvidence[] = [A];
    const s = service({ evidence: () => evidence, anilist });
    await s.runNow();
    const changed = { ...A, discTitles: [...A.discTitles, { lang: 'eng', name: 'Hinokiri no Ken' }] };
    evidence = [changed];
    anilist.down = true;
    clock += 60_000;
    await s.runNow();
    expect(discsOf(s, 'anilist:100')).toBe(1);
    expect(s.catalogue().unsorted).toEqual([]);
    anilist.down = false;
    anilist.calls.length = 0;
    clock += 60_000;
    await s.runNow();
    expect(anilist.calls).toContain(`search:${normalizeTitle('Hinokiri no Ken')}`);
    expect(discsOf(s, 'anilist:100')).toBe(1);
    anilist.calls.length = 0;
    clock += 60_000;
    await s.runNow();
    expect(anilist.calls).toEqual([]);
  });

  it('logs a failed run and still makes the run queued during it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = fake({ 火斬りの剣: [EMBER] });
    let first = true;
    const anilist: MetadataSource = {
      search: async (q, o) => {
        if (first) {
          first = false;
          await gate;
          throw new Error('boom');
        }
        return inner.search(q, o);
      },
      entry: (id) => inner.entry(id),
    };
    const s = service({ evidence: () => [A], anilist });
    const run = s.runNow();
    void s.runNow(); // a scan finishing during the run
    release();
    await run;
    expect(error).toHaveBeenCalledWith('title matching failed', expect.any(Error));
    expect(discsOf(s, 'anilist:100')).toBe(1);
    error.mockRestore();
  });

  it.each([
    ['not JSON', '{'],
    ['the wrong shape', JSON.stringify({ version: 1, matches: 'x' })],
    ['a bad entry', JSON.stringify({ version: 2, matches: [], entries: { a: { at: 1 } }, cache: {}, pool: {}, discs: {}, firstSeen: {}, lastRunAt: null, lastRetryAt: null, lastRefreshAt: null })],
    ['a cache naming an entry the pool lacks', JSON.stringify({ version: 2, matches: [], entries: {}, cache: { 'anilist:x': { at: 1, value: ['anilist:1'] } }, pool: {}, discs: {}, firstSeen: {}, lastRunAt: null, lastRetryAt: null, lastRefreshAt: null })],
  ])('sets a metadata.json that is %s aside and starts afresh (T8e)', async (_, text) => {
    writeFileSync(join(dir, 'metadata.json'), text);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const anilist = fake({ 火斬りの剣: [EMBER] });
    const s = service({ evidence: () => [A], anilist });
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
    expect(s.catalogue().titles).toEqual([]);
    expect(readdirSync(dir)).toContain(`metadata.json.corrupt-${clock}`);
    expect(existsSync(join(dir, 'metadata.json'))).toBe(false);
    await s.runNow();
    expect(discsOf(s, 'anilist:100')).toBe(1);
  });

  it('takes the gate from the owner, else the config', () => {
    const owner = new OwnerStore(dir);
    const s = new TitleService({
      library: { evidence: () => [] }, owner, dataDir: dir, anilist: fake({}), tmdb: null, discdb: { lookup: () => null },
      musicbrainz: null, discogs: null, folderCover: async () => null, locateRelease: () => null,
      art: new ArtCache(join(dir, 'art'), vi.fn()), titleLibrary: 'everyone', setTimer: () => () => {},
    });
    expect(s.gate()).toBe('everyone');
    owner.setGate('owners');
    expect(s.gate()).toBe('owners');
  });
});

describe('TitleService final review', () => {
  /** Made-up titles, one group each. */
  const reels = (n: number): { entries: Entry[]; discs: DiscEvidence[]; names: string[] } => {
    const names = Array.from({ length: n }, (_, i) => `Reel ${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`);
    return {
      names,
      entries: names.map((name, i) => entry(`anilist:${5000 + i}`, { english: name }, { episodes: 12 })),
      discs: names.map((name) => ev(`media1/Anime/${name}/[BDMV] ${name} Vol.1`, { eng: name })),
    };
  };
  const results = (es: Entry[]): Record<string, Entry[]> => Object.fromEntries(es.map((en) => [en.names.english!, [en]]));

  it('I1: keeps the full TMDB entry, with its seasons, for a suggestion the matcher did not fetch', async () => {
    const tmdb = fake({
      Brasswick: [entry('tmdb-tv:7', { english: 'Brasswick' }, { seasons: [1, 2, 3].map((number) => ({ number, episodes: 12, runtimeMin: 24 })), year: 2019 })],
      'Lantern Coast': [entry('tmdb-tv:8', { english: 'Lantern Coast' }, { seasons: [{ number: 1, episodes: 10, runtimeMin: 45 }], year: 2005 })],
    });
    const disc = ev('media1/TV/Brasswick (2019) S02/DISC2', { eng: 'Lantern Coast' });
    const s = service({ evidence: () => [disc], anilist: fake({}), tmdb });
    await s.runNow();
    expect(reasonOf(s, disc)).toBe('sources-disagree');
    expect(s.catalogue().unsorted[0]!.suggestions.map((t) => t.id)).toContain('tmdb-tv:8');
    expect(metadata().entries['tmdb-tv:8']!.value.seasons).toHaveLength(1);
    expect(s.catalogue().unsorted[0]!.suggestions.find((t) => t.id === 'tmdb-tv:8')!.seasons).toBe(1);
  });

  it('I5: saves progress every 25 groups, publishes it, and a restarted run resumes without repeating lookups', async () => {
    const { entries, discs, names } = reels(30);
    const anilist = fake(results(entries));
    const crashAt = normalizeTitle(names[27]!);
    const crashing: MetadataSource = {
      search: async (q, o) => {
        if (normalizeTitle(q) === crashAt) throw new Error('process killed');
        return anilist.search(q, o);
      },
      entry: (id) => anilist.entry(id),
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = service({ evidence: () => discs, anilist: crashing });
    await s.runNow();
    expect(error).toHaveBeenCalledWith('title matching failed', expect.any(Error));
    error.mockRestore();
    expect(s.catalogue().titles).toHaveLength(25);

    const restarted = service({ evidence: () => discs, anilist });
    expect(restarted.catalogue().titles).toHaveLength(25);
    anilist.calls.length = 0;
    await restarted.runNow();
    expect(restarted.catalogue().titles).toHaveLength(30);
    for (const name of names.slice(0, 25)) expect(anilist.calls).not.toContain(`search:${normalizeTitle(name)}`);
    expect(anilist.calls).toContain(`search:${normalizeTitle(names[29]!)}`);
  });

  it('I5: saves progress every 3 minutes when groups are slow', async () => {
    const { entries, discs, names } = reels(4);
    const anilist = fake(results(entries));
    const crashAt = normalizeTitle(names[2]!);
    const slow: MetadataSource = {
      search: async (q, o) => {
        clock += 200_000;
        if (normalizeTitle(q) === crashAt) throw new Error('process killed');
        return anilist.search(q, o);
      },
      entry: (id) => anilist.entry(id),
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await service({ evidence: () => discs, anilist: slow }).runNow();
    error.mockRestore();
    expect(service({ evidence: () => discs, anilist }).catalogue().titles.map((t) => t.names.english)).toEqual(names.slice(0, 2));
  });

  it('M1: keeps search results as entry ids over one pool, and leaves metadata.json alone when a run changes nothing', async () => {
    const anilist = fake({ 火斬りの剣: [EMBER], 'Hinokiri no Ken': [EMBER] });
    const s = service({ evidence: () => [A, A2], anilist });
    await s.runNow();
    const file = metadata();
    expect(Object.keys(file.cache).length).toBeGreaterThan(1);
    for (const d of Object.values(file.cache)) for (const x of d.value) expect(typeof x).toBe('string');
    expect(Object.keys(file.pool)).toEqual(['anilist:100']);
    const firstRun = file.lastRunAt;
    clock += DAY;
    await s.runNow();
    expect(metadata().lastRunAt).toBe(firstRun);
    // and a restart reads the ids back
    expect(service({ evidence: () => [A, A2], anilist }).catalogue().titles.map((t) => t.id)).toEqual(['anilist:100']);
  });

  it('M3: stops after five groups fail in a row, keeps the catalogue as it was, logs once, and tries again next run', async () => {
    const { entries, discs } = reels(7);
    const anilist = fake({ ...results(entries), 火斬りの剣: [EMBER] });
    let evidence: DiscEvidence[] = [A];
    const s = service({ evidence: () => evidence, anilist });
    await s.runNow();
    evidence = [A, ...discs];
    anilist.down = true;
    anilist.calls.length = 0;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    clock += 60_000;
    await s.runNow();
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
    expect(new Set(anilist.calls).size).toBe(5);
    expect(s.catalogue().titles.map((t) => t.id)).toEqual(['anilist:100']);
    expect(s.catalogue().unsorted).toEqual([]);
    anilist.down = false;
    clock += 60_000;
    await s.runNow();
    expect(s.catalogue().titles).toHaveLength(8);
  });
});

describe('loadDiscDbOrNone', () => {
  it('means no TheDiscDB when the index is missing, logged once', () => {
    const log = vi.fn();
    const db = loadDiscDbOrNone(join(dir, 'missing.json'), log);
    expect(db.lookup('ABC')).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('loads an index', () => {
    const file = join(dir, 'index.json');
    writeFileSync(file, JSON.stringify({ discs: { ABC: { title: 'Ember Blade', kind: 'series', year: 2019, season: 1, disc: 1, episodes: [] } } }));
    expect(loadDiscDbOrNone(file, vi.fn()).lookup('abc')).toMatchObject({ title: 'Ember Blade' });
  });
});

describe('fixtureSources', () => {
  it('answers recorded searches by query and source, and entries by id', async () => {
    const tv = entry('tmdb-tv:5', { english: 'Starfall Traveler' });
    const { anilist, tmdb } = fixtureSources({ 'Starfall Traveler': [STARFALL, tv] });
    expect(await anilist.search('starfall traveler')).toEqual([STARFALL]);
    expect(await tmdb.search('Starfall Traveler')).toEqual([tv]);
    expect(await anilist.search('Other')).toEqual([]);
    expect(await tmdb.entry('tmdb-tv:5')).toEqual(tv);
    expect(await anilist.entry('anilist:1')).toBeNull();
  });
});

describe('TitleService music lookups', () => {
  const GROUP = 'Music/[2024.05.01] Lantern Parade - Night Lights [CD]';
  const cover = (n: string) => ({ small: `https://coverartarchive.org/release/${n}/front-250`, large: `https://coverartarchive.org/release/${n}/front-500` });
  const release = (more: Partial<MusicRelease> = {}): MusicRelease => ({
    source: 'musicbrainz', id: 'rel-1', title: 'Night Lights (Tour Edition)', date: '2024-05-01',
    artists: [{ id: 'mb-lantern', name: 'Lantern Parade', sortName: null, aliases: [] }], primaryType: 'Album', secondaryTypes: [], live: false, cover: cover('rel-1'), ...more,
  });
  const musicDisc = (name: string, catalogueNumbers: string[]): DiscEvidence => ({ ...ev(`media1/${GROUP}/${name}`), catalogueNumbers });
  const BD = musicDisc('BD', ['ZQCL-2468']);

  /** A music source answering a table, counting calls; `down` makes every call throw. */
  function musicSource(table: Record<string, MusicRelease | null>): MusicSource & { calls: string[]; down: boolean } {
    const src = {
      calls: [] as string[],
      down: false,
      async byCatalogue(catno: string): Promise<MusicRelease | null> {
        src.calls.push(catno);
        if (src.down) throw new SourceUnavailable('down');
        return table[catno] ?? null;
      },
    };
    return src;
  }
  const musicOf = (s: TitleService) => s.catalogue().titles.find((t) => t.kind === 'music')!;

  it('looks a music disc up once by its catalogue number, keeps it in metadata.json, and serves it after a restart with no network', async () => {
    const mb = musicSource({ 'ZQCL-2468': release() });
    const s = service({ evidence: () => [BD], anilist: fake({}), musicbrainz: mb });
    await s.runNow();
    expect(mb.calls).toEqual(['ZQCL-2468']);
    expect(musicOf(s).music).toMatchObject({ title: 'Night Lights (Tour Edition)', matched: true, artist: { id: 'mb-lantern' } });
    await s.runNow();
    expect(mb.calls).toEqual(['ZQCL-2468']);
    expect((JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')) as { music: Record<string, { value: MusicRelease }> }).music['ZQCL-2468']!.value.title).toBe('Night Lights (Tour Edition)');
    const down = musicSource({});
    down.down = true;
    const again = service({ evidence: () => [BD], anilist: fake({}), musicbrainz: down });
    expect(musicOf(again).music!.title).toBe('Night Lights (Tour Edition)');
    expect(down.calls).toEqual([]);
  });

  it('asks Discogs on a MusicBrainz miss, and for the cover alone when MusicBrainz has none', async () => {
    const mb = musicSource({ 'ZQCL-2468': release({ cover: null }) });
    const discogs = musicSource({ 'ZQCL-2468': release({ source: 'discogs', id: 'dg-1', title: 'Discogs Title', cover: cover('dg-1') }), 'ZQCL-1357': release({ source: 'discogs', id: 'dg-2', title: 'Only On Discogs' }) });
    const other = { ...ev('media1/Music/Neon Harbor - Tide/BD'), catalogueNumbers: ['ZQCL-1357'] };
    const s = service({ evidence: () => [BD, other], anilist: fake({}), musicbrainz: mb, discogs });
    await s.runNow();
    expect(mb.calls.sort()).toEqual(['ZQCL-1357', 'ZQCL-2468']);
    expect(discogs.calls.sort()).toEqual(['ZQCL-1357', 'ZQCL-2468']);
    const titles = s.catalogue().titles.filter((t) => t.kind === 'music');
    const lantern = titles.find((t) => t.music!.title === 'Night Lights (Tour Edition)')!;
    expect(s.catalogue().art(lantern.poster!)).toEqual(cover('dg-1'));
    expect(titles.map((t) => t.music!.title).sort()).toEqual(['Night Lights (Tour Edition)', 'Only On Discogs']);
  });

  it('does not ask Discogs when MusicBrainz has the release with a cover', async () => {
    const discogs = musicSource({});
    const s = service({ evidence: () => [BD], anilist: fake({}), musicbrainz: musicSource({ 'ZQCL-2468': release() }), discogs });
    await s.runNow();
    expect(discogs.calls).toEqual([]);
  });

  it('keeps a coverless MusicBrainz hit when Discogs is down, counts no failure, and asks for the cover again within a week', async () => {
    const discogs = musicSource({ 'ZQCL-2468': release({ source: 'discogs', id: 'dg-1', cover: cover('dg-1') }) });
    discogs.down = true;
    // more catalogue numbers than CIRCUIT_BREAKER, each a coverless MusicBrainz hit: none may stop the lookups
    const many = Array.from({ length: 12 }, (_, i) => ({ ...ev(`media1/Music/Neon Harbor - Tide ${i}/BD`), catalogueNumbers: [`ZQCL-${5000 + i}`] }));
    const table = Object.fromEntries(many.map((e) => [e.catalogueNumbers[0]!, release({ cover: null, title: `Tide ${e.catalogueNumbers[0]}` })]));
    const mbAll = musicSource({ 'ZQCL-2468': release({ cover: null }), ...table });
    const s = service({ evidence: () => [BD, ...many], anilist: fake({}), musicbrainz: mbAll, discogs });
    await s.runNow();
    expect(mbAll.calls).toHaveLength(13);
    expect(s.catalogue().titles.filter((t) => t.kind === 'music').every((t) => t.music!.matched)).toBe(true);
    expect(musicOf(service({ evidence: () => [BD], anilist: fake({}) })).music!.title).toBe('Night Lights (Tour Edition)');
    discogs.down = false;
    discogs.calls.length = 0;
    clock += 6 * DAY;
    await s.runNow();
    expect(discogs.calls).toEqual([]);
    clock += 1 * DAY;
    await s.runNow();
    expect(discogs.calls).toContain('ZQCL-2468');
    const lantern = s.catalogue().titles.find((t) => t.music?.title === 'Night Lights (Tour Edition)')!;
    expect(s.catalogue().art(lantern.poster!)).toEqual(cover('dg-1'));
  });

  it('loads a metadata.json from before music lookups and folder covers', async () => {
    const mb = musicSource({ 'ZQCL-2468': release() });
    await service({ evidence: () => [BD], anilist: fake({}), musicbrainz: mb }).runNow();
    const data = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')) as Record<string, unknown>;
    delete data.music;
    delete data.folderCovers;
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify(data));
    const s = service({ evidence: () => [BD], anilist: fake({}), musicbrainz: mb });
    expect(readdirSync(dir).filter((f) => f.includes('corrupt'))).toEqual([]);
    expect(musicOf(s).music!.matched).toBe(false);
    await s.runNow();
    expect(mb.calls).toEqual(['ZQCL-2468', 'ZQCL-2468']);
    expect(musicOf(s).music!.matched).toBe(true);
  });

  it('a failed lookup keeps the cached release', async () => {
    const mb = musicSource({ 'ZQCL-2468': release() });
    const s = service({ evidence: () => [BD], anilist: fake({}), musicbrainz: mb });
    await s.runNow();
    clock += 31 * DAY;
    mb.down = true;
    await s.runNow();
    expect(mb.calls).toEqual(['ZQCL-2468', 'ZQCL-2468']);
    expect(musicOf(s).music!.title).toBe('Night Lights (Tour Edition)');
    expect(musicOf(service({ evidence: () => [BD], anilist: fake({}) })).music!.title).toBe('Night Lights (Tour Edition)');
  });

  it('looks hits up again after 30 days and misses after 7', async () => {
    const miss = { ...ev('media1/Music/Neon Harbor - Tide/BD'), catalogueNumbers: ['ZQCL-1357'] };
    const mb = musicSource({ 'ZQCL-2468': release() });
    const s = service({ evidence: () => [BD, miss], anilist: fake({}), musicbrainz: mb });
    await s.runNow();
    mb.calls.length = 0;
    clock += 6 * DAY;
    await s.runNow();
    expect(mb.calls).toEqual([]);
    clock += 1 * DAY;
    await s.runNow();
    expect(mb.calls).toEqual(['ZQCL-1357']);
    mb.calls.length = 0;
    clock += 22 * DAY; // 29 days after the hit
    await s.runNow();
    expect(mb.calls).not.toContain('ZQCL-2468');
    clock += 1 * DAY;
    await s.runNow();
    expect(mb.calls).toContain('ZQCL-2468');
  });

  it('uses the first disc of a release, in path order, whose lookup hit', async () => {
    const bd1 = musicDisc('BD1', ['ZQCL-1111']);
    const bd2 = musicDisc('BD2', ['ZQCL-2222']);
    const bd3 = musicDisc('BD3', ['ZQCL-3333']);
    const mb = musicSource({ 'ZQCL-2222': release({ title: 'Second' }), 'ZQCL-3333': release({ title: 'Third' }) });
    const s = service({ evidence: () => [bd3, bd2, bd1], anilist: fake({}), musicbrainz: mb });
    await s.runNow();
    expect(mb.calls).toEqual(['ZQCL-1111', 'ZQCL-2222']);
    expect(musicOf(s).music!.title).toBe('Second');
  });

  it('skips lookups for a release whose match the owner rejected', async () => {
    const owner = new OwnerStore(dir);
    owner.setChoice(BD.discId, null, { kind: 'music', name: null, rejectMatch: true });
    const mb = musicSource({ 'ZQCL-2468': release() });
    const s = service({ evidence: () => [BD], anilist: fake({}), musicbrainz: mb, owner });
    await s.runNow();
    expect(mb.calls).toEqual([]);
    expect(musicOf(s).music).toMatchObject({ title: 'Night Lights', rejected: true });
  });

  it('finds a release\'s folder cover once, and again when its discs change or on retry day', async () => {
    const asked: string[] = [];
    const located: [string, string][] = [];
    let mtimeMs = 1;
    let discs = [BD];
    const s = service({
      evidence: () => discs, anilist: fake({}),
      locateRelease: (discId, group) => { located.push([discId, group]); return '/mnt/media1/' + group; },
      folderCover: async (d) => { asked.push(d); return { path: `${d}/cover.jpg`, size: 10, mtimeMs }; },
    });
    await s.runNow();
    expect(located).toEqual([[BD.discId, GROUP]]);
    expect(asked).toEqual([`/mnt/media1/${GROUP}`]);
    const first = musicOf(s).poster!;
    expect(s.catalogue().art(first)).toEqual({ file: `/mnt/media1/${GROUP}/cover.jpg` });
    await s.runNow();
    expect(asked).toHaveLength(1);
    discs = [{ ...BD, playlists: [{ id: '00001', durationS: 60, chapters: 1, clips: ['00001'] }] }];
    await s.runNow();
    expect(asked).toHaveLength(2);
    mtimeMs = 2;
    clock += 7 * DAY;
    await s.runNow();
    expect(asked).toHaveLength(3);
    expect(musicOf(s).poster).not.toBe(first);
    expect(musicOf(service({ evidence: () => discs, anilist: fake({}) })).poster).toBe(musicOf(s).poster);
  });
});

describe('releaseFolderOf', () => {
  it('takes the disc\'s folders below the release off its location', () => {
    expect(releaseFolderOf('/mnt/a/Music/Rel/Disc 1', ['Music', 'Rel', 'Disc 1'], 'Music/Rel')).toBe('/mnt/a/Music/Rel');
    expect(releaseFolderOf('/mnt/a/Music/Rel.iso', ['Music', 'Rel.iso'], 'Music/Rel.iso')).toBe('/mnt/a/Music/Rel.iso');
    expect(releaseFolderOf('/mnt/a/Music/Rel/BD', ['Music', 'Rel', 'BD'], 'Music/Other')).toBeNull();
  });
});
