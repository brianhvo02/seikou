import { describe, expect, it } from 'vitest';
import { normalizeTitle } from '@seikou/nas/title-text';
import type { DiscDbHit } from './discdb';
import type { DiscEvidence } from './evidence';
import { groupKey, matchDiscs } from './match';
import type { DiscMatch, MatchContext } from './match';
import { SourceUnavailable } from './sources';
import type { Entry, EntryNames, MetadataSource } from './sources';

// Every title here is made up (ruling T5a).

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

const seasons = (n: number, episodes = 12): Entry['seasons'] =>
  Array.from({ length: n }, (_, i) => ({ number: i + 1, episodes, runtimeMin: 24 }));

/** TMDB's search answers carry no seasons; only the entry by id (`/tv/<id>`) has them. */
const searchShape = (en: Entry): Entry => (en.source === 'tmdb' && en.kind === 'series' ? { ...en, seasons: [] } : en);

/** A source answering fixed entries per normalised query, recording every call; TMDB series come as search shows them. */
function fake(results: Record<string, Entry[]>, fail: readonly string[] = [], more: readonly Entry[] = []): MetadataSource & { calls: string[] } {
  const byKey = new Map(Object.entries(results).map(([q, es]) => [normalizeTitle(q), es]));
  const byId = new Map([...Object.values(results).flat(), ...more].map((en) => [en.id, en]));
  const calls: string[] = [];
  return {
    calls,
    async search(query) {
      calls.push(normalizeTitle(query));
      if (fail.some((f) => normalizeTitle(f) === normalizeTitle(query))) throw new SourceUnavailable('down');
      return (byKey.get(normalizeTitle(query)) ?? []).map(searchShape);
    },
    async entry(id) {
      return byId.get(id) ?? null;
    },
  };
}

function ctx(anilist: MetadataSource, tmdb: MetadataSource | null, discdb: Record<string, DiscDbHit> = {}): MatchContext {
  return { anilist, tmdb, discdb: { lookup: (fp) => discdb[fp] ?? null }, cache: new Map() };
}

function ev(path: string, titles: Record<string, string> = {}, fingerprint: string | null = null): DiscEvidence {
  return {
    discId: `id:${path}`,
    path,
    fingerprint,
    discTitles: Object.entries(titles).map(([lang, name]) => ({ lang, name })),
    segments: path.split('/'),
    catalogueNumbers: [],
    playlists: [],
  };
}

const byDisc = (matches: readonly DiscMatch[], path: string): DiscMatch => {
  const m = matches.find((x) => x.discId === `id:${path}`);
  if (!m) throw new Error(`no match for ${path}`);
  return m;
};

const EMBER = entry('anilist:100', { english: 'Ember Blade', romaji: 'Hinokiri no Ken', native: '火斬りの剣' }, { episodes: 12 });

describe('groupKey', () => {
  it('is the parent folder of the disc folder or ISO', () => {
    expect(groupKey(ev('BDMVs/Brasswick S02/BRASSWICK S02 VOL.2'))).toBe('BDMVs/Brasswick S02');
    expect(groupKey(ev('Lone Disc.iso'))).toBe('');
  });
});

describe('matchDiscs', () => {
  it('files a disc when one AniList entry fits and the disc title and folder agree (rules 1-4)', async () => {
    const anilist = fake({ 火斬りの剣: [EMBER] });
    const path = 'Anime/[BDMV][220629][火斬りの剣][Vol.1]';
    const { matches, entries } = await matchDiscs([ev(path, { jpn: '火斬りの剣' })], ctx(anilist, null));
    expect(byDisc(matches, path)).toEqual({
      discId: `id:${path}`, status: 'filed', entryId: 'anilist:100', season: 1, disc: 1, bonus: false, via: ['disc-title', 'folder'],
    });
    expect(entries.get('anilist:100')).toBe(EMBER);
  });

  it('sends a disc to Unsorted when two entries fit equally (rule 1: several-fit)', async () => {
    const anilist = fake({ Brasswick: [entry('anilist:200', { english: 'Brasswick Season 2' })] });
    const tmdb = fake({ Brasswick: [entry('tmdb-movie:201', { english: 'Brasswick' }, { year: 2019 })] });
    const path = 'BDMVs/[BDMV] Brasswick';
    const { matches, entries } = await matchDiscs([ev(path, { eng: 'Brasswick' })], ctx(anilist, tmdb));
    const m = byDisc(matches, path);
    expect(m).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
    expect(m.status === 'unsorted' && [...m.suggestions].sort()).toEqual(['anilist:200', 'tmdb-movie:201']);
    expect([...entries.keys()].sort()).toEqual(['anilist:200', 'tmdb-movie:201']);
  });

  it('needs a season number for a TMDB series with several seasons (rule 3: no-season)', async () => {
    const path = 'TV/Glass Orchard/GLASS_ORCHARD_D1';
    const several = fake({ 'Glass Orchard': [entry('tmdb-tv:300', { english: 'Glass Orchard' }, { seasons: seasons(3) })] });
    const r1 = await matchDiscs([ev(path, { eng: 'Glass Orchard' })], ctx(fake({}), several));
    expect(byDisc(r1.matches, path)).toMatchObject({ status: 'unsorted', reason: 'no-season', suggestions: ['tmdb-tv:300'] });

    const single = fake({ 'Glass Orchard': [entry('tmdb-tv:300', { english: 'Glass Orchard' }, { seasons: seasons(1) })] });
    const r2 = await matchDiscs([ev(path, { eng: 'Glass Orchard' })], ctx(fake({}), single));
    expect(byDisc(r2.matches, path)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:300', season: 1, disc: 1 });
  });

  it('rejects an episode range past the season (rule 3: episode-past-season)', async () => {
    const anilist = fake({ 'Starfall Traveler': [entry('anilist:400', { english: 'Starfall Traveler' }, { episodes: 12 })] });
    const path = 'Anime/[BDMV] Starfall Traveler/[BDMV] Starfall Traveler Vol.5 [第13話]';
    const { matches } = await matchDiscs([ev(path, { eng: 'Starfall Traveler' })], ctx(anilist, null));
    expect(byDisc(matches, path)).toMatchObject({ status: 'unsorted', reason: 'episode-past-season', suggestions: ['anilist:400'] });
  });

  it('numbers unnumbered siblings only when the folder gives the release disc count (rule 4)', async () => {
    const harbor = entry('anilist:500', { english: 'Harbor Line' }, { episodes: 12 });
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    const group = (parent: string): DiscEvidence[] =>
      [...letters].reverse().map((l) => ev(`Anime/${parent}/HARBOR_LINE_${l}`, { jpn: 'Harbor Line' }));

    const unknown = await matchDiscs(group('[BDMV] Harbor Line'), ctx(fake({ 'Harbor Line': [harbor] }), null));
    for (const m of unknown.matches) expect(m).toMatchObject({ status: 'unsorted', reason: 'no-disc-number', suggestions: ['anilist:500'] });

    const known = await matchDiscs(group('[BDMV] Harbor Line Vol.1-6 Fin'), ctx(fake({ 'Harbor Line': [harbor] }), null));
    letters.forEach((l, i) => {
      expect(byDisc(known.matches, `Anime/[BDMV] Harbor Line Vol.1-6 Fin/HARBOR_LINE_${l}`)).toMatchObject({ status: 'filed', entryId: 'anilist:500', season: 1, disc: i + 1 });
    });

    // five of the six discs: their order doesn't say which one is missing
    const short = await matchDiscs(group('[BDMV] Harbor Line Vol.1-6 Fin').slice(1), ctx(fake({ 'Harbor Line': [harbor] }), null));
    for (const m of short.matches) expect(m).toMatchObject({ status: 'unsorted', reason: 'no-disc-number' });
  });

  it('sends a disc to Unsorted when TheDiscDB names a different title from the folder (rule 2: sources-disagree)', async () => {
    const tmdb = fake({
      'Quiet Meadow': [entry('tmdb-movie:600', { english: 'Quiet Meadow' })],
      'Lantern Coast': [entry('tmdb-movie:999', { english: 'Lantern Coast' })],
    });
    const hit: DiscDbHit = { title: 'Lantern Coast', year: 2011, kind: 'movie', tmdbId: '999', season: null, episodes: [] };
    const path = 'Movies/Quiet Meadow';
    const { matches } = await matchDiscs([ev(path, {}, 'FP1')], ctx(fake({}), tmdb, { FP1: hit }));
    const m = byDisc(matches, path);
    expect(m).toMatchObject({ status: 'unsorted', reason: 'sources-disagree' });
    expect(m.status === 'unsorted' && m.suggestions).toContain('tmdb-movie:600');
  });

  it('files a disc when TheDiscDB agrees with the folder', async () => {
    const tmdb = fake({ 'Quiet Meadow': [entry('tmdb-movie:600', { english: 'Quiet Meadow' })] });
    const hit: DiscDbHit = { title: 'Quiet Meadow', year: 2011, kind: 'movie', tmdbId: '600', season: null, episodes: [] };
    const path = 'Movies/Quiet Meadow';
    const { matches } = await matchDiscs([ev(path, {}, 'FP1')], ctx(fake({}), tmdb, { FP1: hit }));
    expect(byDisc(matches, path)).toEqual({
      discId: `id:${path}`, status: 'filed', entryId: 'tmdb-movie:600', season: null, disc: null, bonus: false, via: ['folder', 'discdb'],
    });
  });

  it('lets loose discs inherit the group folder\'s title', async () => {
    const tmdb = fake({ Brasswick: [entry('tmdb-tv:700', { english: 'Brasswick' }, { seasons: seasons(3) })] });
    const loose = 'TV/BRASSWICK S02/BRASSWICK S02 VOL.2';
    const bare = 'TV/BRASSWICK S02/DISC3';
    const { matches } = await matchDiscs([ev(loose), ev(bare)], ctx(fake({}), tmdb));
    // both inherit the title; a VOL and a DISC number in one season are two numbering kinds, so neither is placed (M5b)
    expect(byDisc(matches, loose)).toMatchObject({ status: 'unsorted', reason: 'no-disc-number', suggestions: ['tmdb-tv:700'], seasons: { 'tmdb-tv:700': 2 } });
    expect(byDisc(matches, bare)).toMatchObject({ status: 'unsorted', reason: 'no-disc-number', suggestions: ['tmdb-tv:700'], seasons: { 'tmdb-tv:700': 2 } });
    const alone = await matchDiscs([ev(loose)], ctx(fake({}), fake({ Brasswick: [entry('tmdb-tv:700', { english: 'Brasswick' }, { seasons: seasons(3) })] })));
    expect(byDisc(alone.matches, loose)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:700', season: 2, disc: 2, via: ['folder'] });
    expect(tmdb.calls.filter((q) => q === 'brasswick')).toHaveLength(1);
  });

  it('files a foreign edition under the Japanese release\'s entry or not at all (Review Focus 1)', async () => {
    const anilist = fake({
      火斬りの剣: [EMBER],
      'Ember Blade: Hinokiri no Ken': [EMBER, entry('anilist:150', { english: 'Ember Blade Chronicles' })],
      'Hinokiri no Ken': [EMBER, entry('anilist:151', { romaji: 'Hinokiri no Ken Gaiden' })],
    });
    const tmdb = fake({ 'Ember Blade: Hinokiri no Ken': [entry('tmdb-tv:152', { english: 'Ember Blade' }, { seasons: seasons(1) })] });
    const jp = 'Anime/[BDMV][220629][火斬りの剣][Vol.1]';
    const ita = 'Anime/[BDMV] Hinokiri no Ken [Dist][ITA]';
    const { matches } = await matchDiscs([ev(jp, { jpn: '火斬りの剣' }), ev(ita, { ita: 'Ember Blade: Hinokiri no Ken' })], ctx(anilist, tmdb));
    expect(byDisc(matches, jp)).toMatchObject({ status: 'filed', entryId: 'anilist:100' });
    const m = byDisc(matches, ita);
    expect(m.status === 'filed' || m.status === 'unsorted').toBe(true);
    if (m.status === 'filed') expect(m.entryId).toBe('anilist:100');
  });

  it('puts discs under a Music folder or with a CD tag on the Music shelf, grouped by release folder', async () => {
    const anilist = fake({});
    const d1 = 'Music/Lumen Choir - First Light/DISC1';
    const d2 = 'Music/Lumen Choir - First Light/DISC2';
    const cd = 'Downloads/Lumen Choir - Night Songs [CD]';
    const { matches } = await matchDiscs([ev(d1), ev(d2), ev(cd)], ctx(anilist, fake({})));
    expect(byDisc(matches, d1)).toEqual({ discId: `id:${d1}`, status: 'music', group: 'Music/Lumen Choir - First Light', name: 'Lumen Choir - First Light' });
    expect(byDisc(matches, d2)).toMatchObject({ status: 'music', group: 'Music/Lumen Choir - First Light' });
    expect(byDisc(matches, cd)).toEqual({ discId: `id:${cd}`, status: 'music', group: cd, name: 'Lumen Choir - Night Songs [CD]' });
    expect(anilist.calls).toEqual([]);
  });

  it('files a bonus disc with a resolved title as bonus', async () => {
    const anilist = fake({ 'Starfall Traveler': [entry('anilist:400', { english: 'Starfall Traveler' }, { episodes: 12 })] });
    const path = 'Anime/[BDMV] Starfall Traveler/Starfall Traveler 特典';
    const { matches } = await matchDiscs([ev(path, { eng: 'Starfall Traveler' })], ctx(anilist, null));
    expect(byDisc(matches, path)).toMatchObject({ status: 'filed', entryId: 'anilist:400', season: 1, disc: null, bonus: true });
  });

  it('marks a group source-unreachable when a source fails, and still matches the others', async () => {
    const anilist = fake({ 火斬りの剣: [EMBER] }, ['Starfall Traveler']);
    const down = 'Anime/[BDMV] Starfall Traveler/[BDMV] Starfall Traveler Vol.1';
    const up = 'Anime2/[BDMV][220629][火斬りの剣][Vol.1]';
    const { matches } = await matchDiscs([ev(down, { eng: 'Starfall Traveler' }), ev(up, { jpn: '火斬りの剣' })], ctx(anilist, null));
    expect(byDisc(matches, down)).toEqual({ discId: `id:${down}`, status: 'unsorted', reason: 'source-unreachable', suggestions: [] });
    expect(byDisc(matches, up)).toMatchObject({ status: 'filed', entryId: 'anilist:100' });
  });

  it('sends a disc with no fitting entry to Unsorted (no-title)', async () => {
    const path = 'TV/Nothing Here';
    const { matches } = await matchDiscs([ev(path)], ctx(fake({}), fake({})));
    expect(byDisc(matches, path)).toEqual({ discId: `id:${path}`, status: 'unsorted', reason: 'no-title', suggestions: [] });
  });

  it('calls search at most once per source and candidate, through the cache', async () => {
    const harbor = entry('anilist:500', { english: 'Harbor Line' });
    const anilist = fake({ 'Harbor Line': [harbor] });
    const tmdb = fake({});
    const discs = ['A', 'B', 'C'].map((l) => ev(`Anime/[BDMV] Harbor Line Vol.1-3/HARBOR_LINE_${l}`, { jpn: 'Harbor Line' }));
    const c = ctx(anilist, tmdb);
    await matchDiscs(discs, c);
    for (const calls of [anilist.calls, tmdb.calls]) expect(new Set(calls).size).toBe(calls.length);
    await matchDiscs(discs, c);
    expect(new Set(anilist.calls).size).toBe(anilist.calls.length);
  });

  describe('review scenarios (fix round 1)', () => {
    const prequel = (id: string): Entry['relations'][number] => ({ type: 'PREQUEL', id, format: 'TV', startDate: null });

    it('C1: a disc whose own title names another entry is sources-disagree, whatever the season', async () => {
      const brasswick = entry('tmdb-tv:7', { english: 'Brasswick' }, { seasons: seasons(3) });
      const tv = fake({ Brasswick: [brasswick], 'Lantern Coast': [entry('tmdb-tv:8', { english: 'Lantern Coast' }, { seasons: seasons(1) })] });
      const r1 = await matchDiscs([ev('TV/Brasswick S02/DISC1'), ev('TV/Brasswick S02/DISC2', { eng: 'Lantern Coast' })], ctx(fake({}), tv));
      expect(byDisc(r1.matches, 'TV/Brasswick S02/DISC1')).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:7', season: 2, disc: 1 });
      expect(byDisc(r1.matches, 'TV/Brasswick S02/DISC2')).toMatchObject({ status: 'unsorted', reason: 'sources-disagree' });

      const movie = fake({ Brasswick: [brasswick], 'Lantern Coast': [entry('tmdb-movie:8', { english: 'Lantern Coast' })] });
      const r2 = await matchDiscs([ev('TV/Brasswick S02/DISC2', { eng: 'Lantern Coast' })], ctx(fake({}), movie));
      expect(byDisc(r2.matches, 'TV/Brasswick S02/DISC2')).toMatchObject({ status: 'unsorted', reason: 'sources-disagree' });

      const s1 = entry('anilist:10', { english: 'Harbor Line' });
      const s2 = entry('anilist:11', { english: 'Harbor Line 2nd Season' }, { relations: [prequel('anilist:10')] });
      const anime = fake({ 'Harbor Line': [s1, s2], 'Starfall Traveler': [entry('anilist:40', { english: 'Starfall Traveler' })] });
      const path = 'Anime/[BDMV] Harbor Line 2nd Season/Vol.3';
      const r3 = await matchDiscs([ev(path, { jpn: 'Starfall Traveler' })], ctx(anime, null));
      expect(byDisc(r3.matches, path)).toMatchObject({ status: 'unsorted', reason: 'sources-disagree' });
    });

    it('C2: a match that holds only under vowel folding is partial, never exact', async () => {
      const anilist = fake({ 'Good Hunter': [entry('anilist:66', { english: 'God Hunter' })] });
      const tmdb = fake({ 'Good Hunter': [entry('tmdb-tv:67', { english: 'Good Hunter' }, { seasons: seasons(1) })] });
      const path = 'Anime/[BDMV] Good Hunter Vol.1';
      const r1 = await matchDiscs([ev(path, { jpn: 'Good Hunter' })], ctx(anilist, tmdb));
      expect(tmdb.calls).toContain(normalizeTitle('Good Hunter'));
      const m = byDisc(r1.matches, path);
      expect(m.status === 'filed' && m.entryId === 'anilist:66').toBe(false);

      const r2 = await matchDiscs([ev('Movies/Soul Harbor')], ctx(fake({}), fake({ 'Soul Harbor': [entry('tmdb-movie:9', { english: 'Sol Harbor' })] })));
      expect(byDisc(r2.matches, 'Movies/Soul Harbor')).toMatchObject({ status: 'unsorted', reason: 'no-title' });

      const r3 = await matchDiscs([ev('Movies/Sousou Harbor')], ctx(fake({}), fake({ 'Sousou Harbor': [entry('tmdb-movie:10', { english: 'Sōsō Harbor' })] })));
      expect(byDisc(r3.matches, 'Movies/Sousou Harbor')).toMatchObject({ status: 'unsorted' });
    });

    it('C2: romaji without macrons fits a name with macrons exactly', async () => {
      const kori = entry('anilist:70', { romaji: 'Kōri no Shiro' });
      const path = 'Anime/[BDMV] Kori no Shiro/[BDMV] Kori no Shiro Vol.2';
      const { matches } = await matchDiscs([ev(path)], ctx(fake({ 'Kori no Shiro': [kori] }), fake({})));
      expect(byDisc(matches, path)).toMatchObject({ status: 'filed', entryId: 'anilist:70', disc: 2 });
    });

    it('C3: category folders and folders too far up are never candidates', async () => {
      const tmdb = fake({
        Movies: [entry('tmdb-movie:5', { english: 'Movies' })],
        Documentaries: [entry('tmdb-movie:6', { english: 'Documentaries' })],
        Anime: [entry('tmdb-movie:7', { english: 'Anime' })],
        Brasswick: [entry('tmdb-movie:8', { english: 'Brasswick' })],
      });
      const paths = ['Movies/BDROM', 'Documentaries/Some Unknown Thing/BD_VIDEO', 'Shelf/Anime/BD_VIDEO', 'Shelf/Brasswick/Extra/Deep/BD_VIDEO'];
      const { matches } = await matchDiscs(paths.map((p) => ev(p)), ctx(fake({}), tmdb));
      for (const p of paths) expect(byDisc(matches, p)).toMatchObject({ status: 'unsorted', reason: 'no-title' });
      expect(tmdb.calls).not.toContain('movies');
      expect(tmdb.calls).not.toContain('brasswick');
    });

    it('C4: an English-named foreign edition files under the Japanese release\'s AniList entry, or not at all (RF1)', async () => {
      const ember = entry('anilist:100', { english: 'Ember Blade', romaji: 'Hinokiri no Ken', native: '火斬りの剣' }, { episodes: 12, year: 2022 });
      const anilist = fake({ 火斬りの剣: [ember], 'Ember Blade': [ember] });
      const tmdb = fake({ 'Ember Blade': [entry('tmdb-tv:152', { english: 'Ember Blade' }, { seasons: seasons(1), year: 2022, animation: true })] });
      const jp = 'Anime/[BDMV][220629][火斬りの剣][Vol.1]';
      const ita = 'BDMVs/Ember Blade [ITA]/Ember Blade Vol.1';
      const { matches } = await matchDiscs([ev(jp, { jpn: '火斬りの剣' }), ev(ita, { ita: 'Ember Blade' })], ctx(anilist, tmdb));
      expect(byDisc(matches, jp)).toMatchObject({ status: 'filed', entryId: 'anilist:100' });
      const m = byDisc(matches, ita);
      expect(m.status === 'filed' || m.status === 'unsorted').toBe(true);
      if (m.status === 'filed') expect(m.entryId).toBe('anilist:100');
    });

    it('C4: AniList and TMDB fitting different things is several-fit; TMDB alone files', async () => {
      const ember = entry('anilist:100', { english: 'Ember Blade' }, { year: 2022 });
      const path = 'BDMVs/Ember Blade [ITA]/Ember Blade Vol.1';
      const film = fake({ 'Ember Blade': [entry('tmdb-movie:153', { english: 'Ember Blade' }, { year: 2022 })] });
      const r1 = await matchDiscs([ev(path, { ita: 'Ember Blade' })], ctx(fake({ 'Ember Blade': [ember] }), film));
      expect(byDisc(r1.matches, path)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });

      const older = fake({ 'Ember Blade': [entry('tmdb-tv:154', { english: 'Ember Blade' }, { seasons: seasons(1), year: 1998 })] });
      const r2 = await matchDiscs([ev(path, { ita: 'Ember Blade' })], ctx(fake({ 'Ember Blade': [ember] }), older));
      expect(byDisc(r2.matches, path)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });

      const only = fake({ 'Ember Blade': [entry('tmdb-tv:155', { english: 'Ember Blade' }, { seasons: seasons(1), year: 2022 })] });
      const r3 = await matchDiscs([ev(path, { ita: 'Ember Blade' })], ctx(fake({}), only));
      expect(byDisc(r3.matches, path)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:155', season: 1, disc: 1 });
    });

    it('I1: two boxes never put different discs in the same slot', async () => {
      const tmdb = (): MetadataSource => fake({ Brasswick: [entry('tmdb-tv:7', { english: 'Brasswick' }, { seasons: seasons(1) })] });
      const both = ['TV/Brasswick BOX 1/DISC1', 'TV/Brasswick BOX 1/DISC2', 'TV/Brasswick BOX 2/DISC1'];
      const r1 = await matchDiscs(both.map((p) => ev(p)), ctx(fake({}), tmdb()));
      expect(r1.matches.map((m) => (m.status === 'filed' ? m.disc : m.status))).toEqual([1, 2, 3]);

      const gap = ['TV/Brasswick BOX 1/DISC1', 'TV/Brasswick BOX 1/DISC3', 'TV/Brasswick BOX 2/DISC1'];
      const r3 = await matchDiscs(gap.map((p) => ev(p)), ctx(fake({}), tmdb()));
      expect(byDisc(r3.matches, 'TV/Brasswick BOX 2/DISC1')).toMatchObject({ status: 'unsorted', reason: 'no-disc-number' });

      const lastGap = ['TV/Brasswick BOX 1/DISC1', 'TV/Brasswick BOX 2/DISC1', 'TV/Brasswick BOX 2/DISC3'];
      const r4 = await matchDiscs(lastGap.map((p) => ev(p)), ctx(fake({}), tmdb()));
      for (const p of lastGap.slice(1)) expect(byDisc(r4.matches, p)).toMatchObject({ status: 'unsorted', reason: 'no-disc-number' });

      const r2 = await matchDiscs([ev('TV/Brasswick BOX 2/DISC1')], ctx(fake({}), tmdb()));
      expect(byDisc(r2.matches, 'TV/Brasswick BOX 2/DISC1')).toMatchObject({ status: 'unsorted', reason: 'no-disc-number' });
    });

    it('I2: AniList seasons: OVAs have none, a Part 2 cour takes its place in the chain, a sequel without its prequel is unresolved', async () => {
      const s1 = entry('anilist:10', { english: 'Harbor Line' });
      const ova = entry('anilist:20', { english: 'Harbor Line OVA' }, { format: 'OVA' });
      const part2 = entry('anilist:21', { english: 'Harbor Line Part 2' }, { relations: [prequel('anilist:10')] });
      const orphan = entry('anilist:22', { english: 'Harbor Line 2nd Season' });
      const anilist = fake({ 'Harbor Line OVA': [ova], 'Harbor Line Part 2': [part2], 'Harbor Line': [orphan] }, [], [s1]);
      const paths = ['Anime/[BDMV] Harbor Line OVA Vol.1', 'Anime/[BDMV] Harbor Line Part 2 Vol.1', 'Anime/[BDMV] Harbor Line 2nd Season Vol.1'];
      const { matches } = await matchDiscs(paths.map((p) => ev(p)), ctx(anilist, null));
      expect(byDisc(matches, paths[0]!)).toMatchObject({ status: 'filed', entryId: 'anilist:20', season: null, disc: 1 });
      expect(byDisc(matches, paths[1]!)).toMatchObject({ status: 'filed', entryId: 'anilist:21', season: 2, disc: 1 });
      expect(byDisc(matches, paths[2]!)).toMatchObject({ status: 'unsorted', reason: 'no-season' });
    });

    it('I3: an entry whose year is more than 1 from the evidence\'s is not a fit', async () => {
      const tmdb = fake({ Brasswick: [entry('tmdb-movie:1', { english: 'Brasswick' }, { year: 1985 }), entry('tmdb-movie:2', { english: 'Brasswick' }, { year: 2019 })] });
      const { matches } = await matchDiscs([ev('Movies/Brasswick (2019)')], ctx(fake({}), tmdb));
      expect(byDisc(matches, 'Movies/Brasswick (2019)')).toMatchObject({ status: 'filed', entryId: 'tmdb-movie:2' });

      const old = fake({ Brasswick: [entry('tmdb-movie:1', { english: 'Brasswick' }, { year: 1985 })] });
      const r2 = await matchDiscs([ev('Movies/Brasswick (2019)')], ctx(fake({}), old));
      expect(byDisc(r2.matches, 'Movies/Brasswick (2019)')).toMatchObject({ status: 'unsorted', reason: 'no-title' });
    });
  });

  describe('re-review scenarios (fix round 2)', () => {
    const prequel = (id: string): Entry['relations'][number] => ({ type: 'PREQUEL', id, format: 'TV', startDate: null });
    /** A source answering the same entries to every query. */
    const always = (es: Entry[], more: Entry[] = []): MetadataSource => ({
      search: async () => es,
      entry: async (id) => [...es, ...more].find((en) => en.id === id) ?? null,
    });

    it('N1: a disc title naming another entry disagrees even when the folder\'s year rules that entry out', async () => {
      const tmdb = fake({
        'Quiet Meadow': [entry('tmdb-movie:1', { english: 'Quiet Meadow' }, { year: 2019 })],
        'Lantern Coast': [entry('tmdb-movie:2', { english: 'Lantern Coast' }, { year: 1985 })],
      });
      const r1 = await matchDiscs([ev('Movies/Quiet Meadow (2019)', { eng: 'Lantern Coast' })], ctx(fake({}), tmdb));
      expect(byDisc(r1.matches, 'Movies/Quiet Meadow (2019)')).toMatchObject({ status: 'unsorted', reason: 'sources-disagree' });

      const tv = fake({
        Brasswick: [entry('tmdb-tv:7', { english: 'Brasswick' }, { seasons: seasons(3), year: 2019 })],
        'Lantern Coast': [entry('tmdb-tv:8', { english: 'Lantern Coast' }, { seasons: seasons(1), year: 2005 })],
      });
      const r2 = await matchDiscs([ev('TV/Brasswick (2019) S02/DISC2', { eng: 'Lantern Coast' })], ctx(fake({}), tv));
      expect(byDisc(r2.matches, 'TV/Brasswick (2019) S02/DISC2')).toMatchObject({ status: 'unsorted', reason: 'sources-disagree' });
    });

    it('N2/N3: AniList wins only when every same-titled TMDB fit is an animation twin', async () => {
      const anime = entry('anilist:200', { english: 'Glass Orchard', native: 'ガラスの果樹園' }, { year: 2019 });
      const twin = entry('tmdb-tv:201', { english: 'Glass Orchard' }, { year: 2019, seasons: seasons(1), animation: true });
      const drama = entry('tmdb-tv:203', { english: 'Glass Orchard', native: 'ガラスの果樹園' }, { year: 2020, seasons: seasons(1), animation: false });
      const unknown = entry('tmdb-tv:204', { english: 'Glass Orchard' }, { year: 2019, seasons: seasons(1), animation: null });
      const path = 'Shows/Glass Orchard/DISC1';
      const run = async (tmdb: MetadataSource | null, p = path, titles: Record<string, string> = {}) =>
        byDisc((await matchDiscs([ev(p, titles)], ctx(fake({ 'Glass Orchard': [anime], ガラスの果樹園: [anime] }), tmdb))).matches, p);

      expect(await run(fake({ 'Glass Orchard': [twin] }))).toMatchObject({ status: 'filed', entryId: 'anilist:200' });
      expect(await run(fake({ 'Glass Orchard': [twin, drama] }))).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(await run(fake({ 'Glass Orchard': [drama] }))).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(await run(fake({ 'Glass Orchard': [unknown] }))).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(await run(fake({ 'Glass Orchard': [{ ...twin, year: 1990 }] }))).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      // Japanese evidence asks TMDB too, and finds the live-action drama
      const jp = 'Drama/[BDMV] ガラスの果樹園 DISC1';
      const tmdb = fake({ ガラスの果樹園: [drama] });
      expect(await run(tmdb, jp, { jpn: 'ガラスの果樹園' })).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(tmdb.calls.length).toBeGreaterThan(0);
      // without a TMDB key AniList alone decides
      expect(await run(null)).toMatchObject({ status: 'filed', entryId: 'anilist:200' });
    });

    it('N4: more category folders are never candidates, and a folder two or more levels up is never the only evidence', async () => {
      const tmdb = fake({
        Film: [entry('tmdb-movie:91', { english: 'Film' }, { year: 1965 })],
        Drama: [entry('tmdb-movie:92', { english: 'Drama' })],
        Brasswick: [entry('tmdb-movie:93', { english: 'Brasswick' })],
      });
      const paths = ['Media/Film/BDROM', 'Video/Drama/Unknown Show/BDROM', 'Shelf/Brasswick/Extra/BDROM'];
      const { matches } = await matchDiscs(paths.map((p) => ev(p)), ctx(fake({}), tmdb));
      for (const p of paths) expect(byDisc(matches, p)).toMatchObject({ status: 'unsorted', reason: 'no-title' });

      const backed = 'Shelf/Brasswick/Extra/BDROM';
      const r2 = await matchDiscs([ev(backed, { eng: 'Brasswick' })], ctx(fake({}), tmdb));
      expect(byDisc(r2.matches, backed)).toMatchObject({ status: 'filed', entryId: 'tmdb-movie:93', via: ['disc-title', 'folder'] });
    });

    it('N5: the category list applies to disc titles', async () => {
      const tmdb = fake({ Movies: [entry('tmdb-movie:94', { english: 'Movies' })] });
      const { matches } = await matchDiscs([ev('Movies/BDROM', { eng: 'Movies' })], ctx(fake({}), tmdb));
      expect(byDisc(matches, 'Movies/BDROM')).toMatchObject({ status: 'unsorted', reason: 'no-title' });
    });

    it('N6: an evidence season that is neither the chain position nor in the entry\'s name is no-season', async () => {
      const s1 = entry('anilist:10', { english: 'Harbor Line' });
      const tides = entry('anilist:11', { english: 'Harbor Line Tides' }, { relations: [prequel('anilist:10')] });
      const path = 'Anime/[BDMV] Harbor Line Tides Season 3 Vol.1';
      const { matches } = await matchDiscs([ev(path)], ctx(fake({ 'Harbor Line Tides': [tides] }, [], [s1]), null));
      expect(byDisc(matches, path)).toMatchObject({ status: 'unsorted', reason: 'no-season' });
    });

    it('N7: titles that differ only in a significant mark are different', async () => {
      const glimmer = entry('anilist:50', { romaji: 'Glimmer' });
      const path = "Anime/[BDMV] Glimmer' Vol.1";
      const { matches } = await matchDiscs([ev(path)], ctx(fake({ "Glimmer'": [glimmer] }), null));
      const m = byDisc(matches, path);
      expect(m.status === 'filed' && m.entryId === 'anilist:50').toBe(false);
    });

    it('N8: a TV entry whose name carries a sequel marker but has no prequel is no-season', async () => {
      const marked = ['Harbor Line Final Season', 'Harbor Line 2nd Cour', 'Harbor Line Cour 2', 'Zoku Harbor Line', 'Harbor Line Part 3', '港線 第2クール', '港線 完結編', '続・港線'];
      for (const [i, name] of marked.entries()) {
        const en = entry(`anilist:${600 + i}`, { english: name });
        const path = `Anime/[BDMV] ${name} Vol.1`;
        const { matches } = await matchDiscs([ev(path)], ctx(always([en]), null));
        expect(byDisc(matches, path), name).toMatchObject({ status: 'unsorted', reason: 'no-season' });
      }
    });
  });

  describe('twin rules (fix round 3)', () => {
    const prequel = (id: string): Entry['relations'][number] => ({ type: 'PREQUEL', id, format: 'TV', startDate: null });

    it('T5q: a TMDB series dated from the chain root is the twin of a later AniList season', async () => {
      const s1 = entry('anilist:801', { english: 'Harbor Line' }, { year: 2019 });
      const s2 = entry('anilist:802', { english: 'Harbor Line Season 2' }, { year: 2021, relations: [prequel('anilist:801')] });
      const s3 = entry('anilist:803', { english: 'Harbor Line Season 3' }, { year: 2023, relations: [prequel('anilist:802')] });
      const path = 'Shows/[BDMV] Harbor Line Season 3 Vol.1';
      const run = async (t: Entry) => byDisc((await matchDiscs([ev(path)], ctx(fake({ 'Harbor Line': [s3] }, [], [s1, s2]), fake({ 'Harbor Line': [t] })))).matches, path);
      const series = entry('tmdb-tv:810', { english: 'Harbor Line' }, { year: 2019, seasons: seasons(3), animation: true });
      expect(await run(series)).toMatchObject({ status: 'filed', entryId: 'anilist:803', season: 3, disc: 1 });
      expect(await run({ ...series, animation: false })).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      // more than three years before the chain root's year: not the same series (TMDB may date it by an early special, M12);
      // in the widened years only with a Japanese name the AniList entry shares (M12b), which neither has here
      expect(await run({ ...series, year: 2016 })).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(await run({ ...series, year: 2015 })).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
    });

    it('T5r: a live-action TMDB entry named like the AniList entry, but not like the evidence, is several-fit (G4)', async () => {
      const anime = entry('anilist:200', { english: 'Glass Orchard', romaji: 'Garasu no Kajuen', native: 'ガラスの果樹園' }, { year: 2019 });
      const path = 'Drama/[BDMV] ガラスの果樹園 DISC1';
      for (const names of [{ english: 'Glass Orchard' }, { english: 'Garasu no Kajuen' }]) {
        const drama = entry('tmdb-tv:203', names, { year: 2020, seasons: seasons(1), animation: false });
        const { matches } = await matchDiscs([ev(path, { jpn: 'ガラスの果樹園' })], ctx(fake({ ガラスの果樹園: [anime] }), fake({ ガラスの果樹園: [drama] })));
        expect(byDisc(matches, path), names.english).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      }
    });
  });

  describe('single twin (fix round 4)', () => {
    const prequel = (id: string): Entry['relations'][number] => ({ type: 'PREQUEL', id, format: 'TV', startDate: null });
    const s1 = entry('anilist:801', { english: 'Harbor Line' }, { year: 2019 });
    const s2 = entry('anilist:802', { english: 'Harbor Line Season 2' }, { year: 2021, relations: [prequel('anilist:801')] });
    const s3 = entry('anilist:803', { english: 'Harbor Line Season 3' }, { year: 2023, relations: [prequel('anilist:802')] });
    const path = 'Shows/[BDMV] Harbor Line Season 3 Vol.1';
    const series = (id: string, year: number, n: number) => entry(id, { english: 'Harbor Line' }, { year, seasons: seasons(n), animation: true });
    const run = async (found: Entry[], more: Entry[] = []) =>
      byDisc((await matchDiscs([ev(path)], ctx(fake({ 'Harbor Line': [s3] }, [], [s1, s2]), fake({ 'Harbor Line': found }, [], more)))).matches, path);

    it('T5s: two animated TMDB series that both qualify as twins of an AniList season are several-fit (R1)', async () => {
      const m = await run([series('tmdb-tv:810', 2019, 3), series('tmdb-tv:819', 2022, 3)]);
      expect(m).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(m.status === 'unsorted' && [...m.suggestions].sort()).toEqual(['anilist:803', 'tmdb-tv:810', 'tmdb-tv:819']);
    });

    it('T5s: two animated TMDB entries that both qualify as twins of an AniList first season are several-fit (R3)', async () => {
      const anime = entry('anilist:200', { english: 'Glass Orchard' }, { year: 2019 });
      const tv = (id: string, year: number) => entry(id, { english: 'Glass Orchard' }, { year, seasons: seasons(1), animation: true });
      const p = 'Anime/Glass Orchard/DISC1';
      const { matches } = await matchDiscs([ev(p)], ctx(fake({ 'Glass Orchard': [anime] }), fake({ 'Glass Orchard': [tv('tmdb-tv:201', 2019), tv('tmdb-tv:209', 2020)] })));
      const m = byDisc(matches, p);
      expect(m).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(m.status === 'unsorted' && [...m.suggestions].sort()).toEqual(['anilist:200', 'tmdb-tv:201', 'tmdb-tv:209']);
    });

    it('T5t: a TMDB series with fewer seasons than the AniList chain position is not its twin (R2)', async () => {
      expect(await run([series('tmdb-tv:819', 2022, 1)])).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(await run([series('tmdb-tv:819', 2022, 4)])).toMatchObject({ status: 'filed', entryId: 'anilist:803', season: 3, disc: 1 });
    });

    it('T5t: seasons missing from the search result are fetched; still unknown, a base-name match is not a twin', async () => {
      const bare = series('tmdb-tv:819', 2022, 0);
      expect(await run([bare])).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      expect(await run([bare], [series('tmdb-tv:819', 2022, 4)])).toMatchObject({ status: 'filed', entryId: 'anilist:803', season: 3 });
    });
  });

  describe('final review', () => {
    /** Evidence as production makes it: the root's name isn't a segment. */
    const rooted = (path: string, titles: Record<string, string> = {}): DiscEvidence => ({ ...ev(path, titles), segments: path.split('/').slice(1) });

    it('I1: a TMDB series found by search (no seasons) is fetched by id once, and files by its seasons', async () => {
      const orchard = entry('tmdb-tv:300', { english: 'Glass Orchard' }, { seasons: seasons(3) });
      const tmdb = fake({ 'Glass Orchard': [orchard] });
      const entryCalls: string[] = [];
      const counting: MetadataSource = { search: (q, o) => tmdb.search(q, o), entry: async (id) => { entryCalls.push(id); return tmdb.entry(id); } };
      const path = 'TV/Glass Orchard Season 2 Disc 1';
      const second = 'TV/Glass Orchard Season 2 Disc 2';
      const c = ctx(fake({}), counting);
      const { matches, entries } = await matchDiscs([ev(path), ev(second)], c);
      expect(byDisc(matches, path)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:300', season: 2, disc: 1 });
      expect(byDisc(matches, second)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:300', season: 2, disc: 2 });
      // the catalogue gets the full entry, with its seasons
      expect(entries.get('tmdb-tv:300')!.seasons).toHaveLength(3);
      expect(entryCalls).toEqual(['tmdb-tv:300']);
      expect(c.cache.get('tmdb-entry:tmdb-tv:300')).toEqual([orchard]);
    });

    it('I1: a TheDiscDB hit on a TMDB TV set files under its season', async () => {
      const tmdb = fake({ 'Glass Orchard': [entry('tmdb-tv:300', { english: 'Glass Orchard' }, { seasons: seasons(3) })] });
      const hit: DiscDbHit = { title: 'Glass Orchard', year: null, kind: 'series', tmdbId: '300', season: 2, episodes: [] };
      const path = 'TV/Glass Orchard/GLASS_ORCHARD_S2_D1';
      const { matches } = await matchDiscs([ev(path, {}, 'FP2')], ctx(fake({}), tmdb, { FP2: hit }));
      expect(byDisc(matches, path)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:300', season: 2 });
    });

    it("I6: a root's top-level folder is evidence, alone too, but category names still aren't", async () => {
      const starfall = entry('anilist:900', { english: 'Starfall Wanderer', native: '星降りの旅人' }, { episodes: 12 });
      const anilist = fake({ 'Starfall Wanderer': [starfall], 星降りの旅人: [starfall], Anime: [entry('anilist:901', { english: 'Anime' })] });
      const tidy = 'media0/Starfall Wanderer (星降りの旅人)/Volume 2';
      const shelf = 'media0/Anime/BDROM';
      const { matches } = await matchDiscs([rooted(tidy), rooted(shelf)], ctx(anilist, null));
      expect(byDisc(matches, tidy)).toMatchObject({ status: 'filed', entryId: 'anilist:900', season: 1, disc: 2, via: ['folder'] });
      expect(byDisc(matches, shelf)).toMatchObject({ status: 'unsorted', reason: 'no-title' });
    });

    it("F6: a top-level folder is the only evidence only as the disc folder's parent; two levels up it only supports", async () => {
      const tmdb = fake({ Brasswick: [entry('tmdb-movie:93', { english: 'Brasswick' })] });
      const parent = 'media0/Brasswick/BDROM';
      const top = 'media0/Brasswick/Extra/BDROM';
      const below = 'media0/Shelf/Brasswick/Extra/BDROM';
      const { matches } = await matchDiscs([rooted(parent), rooted(top), rooted(below)], ctx(fake({}), tmdb));
      expect(byDisc(matches, parent)).toMatchObject({ status: 'filed', entryId: 'tmdb-movie:93' });
      expect(byDisc(matches, top)).toMatchObject({ status: 'unsorted', reason: 'no-title' });
      expect(byDisc(matches, below)).toMatchObject({ status: 'unsorted', reason: 'no-title' });
      // two levels up, it still supports the disc's own evidence
      const backed = 'media0/Brasswick/Extra/Brasswick';
      const r = await matchDiscs([rooted(backed)], ctx(fake({}), tmdb));
      expect(byDisc(r.matches, backed)).toMatchObject({ status: 'filed', entryId: 'tmdb-movie:93' });
    });

    it('F6: an organising top-level folder named like a title never files the discs two levels below it', async () => {
      const tmdb = fake({ Watched: [entry('tmdb-movie:1', { english: 'Watched' })] });
      const paths = ['media0/Watched/Unknown Series/Unknown Series Vol.1', 'media0/Watched/Some Unknown Thing/BDROM'];
      const { matches } = await matchDiscs(paths.map((p) => rooted(p)), ctx(fake({}), tmdb));
      for (const p of paths) expect(byDisc(matches, p)).toMatchObject({ status: 'unsorted', reason: 'no-title' });
    });

    it('F7: a checkpoint publishes box 2 and up as Unsorted until every group of its box family is matched', async () => {
      const tmdb = (): MetadataSource => fake({ Brasswick: [entry('tmdb-tv:7', { english: 'Brasswick' }, { seasons: seasons(1) })] });
      const run = async (paths: readonly string[]): Promise<{ checkpoints: DiscMatch[][]; final: DiscMatch[] }> => {
        const checkpoints: DiscMatch[][] = [];
        const c: MatchContext = { ...ctx(fake({}), tmdb()), onGroupDone: (progress) => { checkpoints.push(progress().matches); } };
        return { checkpoints, final: (await matchDiscs(paths.map((p) => ev(p)), c)).matches };
      };
      const box2 = 'TV/Brasswick BOX 2/DISC1';
      const state = (ms: readonly DiscMatch[], path: string): unknown => {
        const m = ms.find((x) => x.discId === `id:${path}`);
        return m?.status === 'filed' ? m.disc : m?.status === 'unsorted' ? m.reason : m?.status;
      };
      // box 3 has a gap, which the final pass sees: box 2 never shows as filed on the way
      const gap = ['TV/Brasswick BOX 1/DISC1', 'TV/Brasswick BOX 1/DISC2', box2, 'TV/Brasswick BOX 3/DISC1', 'TV/Brasswick BOX 3/DISC3'];
      const r1 = await run(gap);
      expect(state(r1.final, box2)).toBe('no-disc-number');
      expect(r1.checkpoints).toHaveLength(3);
      for (const cp of r1.checkpoints) if (cp.some((m) => m.discId === `id:${box2}`)) expect(state(cp, box2)).toBe('no-disc-number');
      // box 1 needs no other box, so it files at once
      expect(state(r1.checkpoints[0]!, 'TV/Brasswick BOX 1/DISC2')).toBe(2);
      // a whole family without a gap: Unsorted at the checkpoint before box 3, filed once every box is matched
      const whole = ['TV/Brasswick BOX 1/DISC1', 'TV/Brasswick BOX 1/DISC2', box2, 'TV/Brasswick BOX 3/DISC1'];
      const r2 = await run(whole);
      expect(state(r2.checkpoints[1]!, box2)).toBe('no-disc-number');
      expect(state(r2.checkpoints[2]!, box2)).toBe(3);
      expect(state(r2.final, box2)).toBe(3);
    });

    it('M2: spellings that differ only in vowels are each searched', async () => {
      const anilist = fake({});
      await matchDiscs([ev('Anime/Good Hunter/BDROM'), ev('Anime2/God Hunter/BDROM')], ctx(anilist, null));
      expect(anilist.calls.filter((q) => q === normalizeTitle('Good Hunter'))).toHaveLength(2);
    });

    it('M3: five groups failing in a row stop the run; the rest are not looked up', async () => {
      const names = ['Alpha Reel', 'Bravo Reel', 'Charlie Reel', 'Delta Reel', 'Echo Reel', 'Foxtrot Reel', 'Golf Reel'];
      const anilist = fake({}, names);
      const discs = names.map((n, i) => ev(`Anime${i}/${n}/BDROM`));
      const r = await matchDiscs(discs, ctx(anilist, null));
      expect(r.aborted).toBe(true);
      expect(new Set(anilist.calls).size).toBe(5);
      for (const m of r.matches) expect(m).toMatchObject({ status: 'unsorted', reason: 'source-unreachable' });

      // a success in between resets the count
      const some = fake({ 'Charlie Reel': [entry('anilist:3', { english: 'Charlie Reel' })] }, names.filter((n) => n !== 'Charlie Reel'));
      const r2 = await matchDiscs(discs, ctx(some, null));
      expect(r2.aborted).toBe(false);
    });

    it("I2: an Unsorted disc carries the matcher's season for each suggestion it resolved", async () => {
      const s1 = entry('anilist:10', { english: 'Harbor Line' });
      const s2 = entry('anilist:11', { english: 'Harbor Line 2nd Season' }, { relations: [{ type: 'PREQUEL', id: 'anilist:10', format: 'TV', startDate: null }] });
      const anilist = fake({ 'Harbor Line': [s2] }, [], [s1]);
      const discs = ['A', 'B'].map((l) => ev(`Anime/[BDMV] Harbor Line 2nd Season/HARBOR_${l}`));
      const { matches } = await matchDiscs(discs, ctx(anilist, null));
      for (const m of matches) expect(m).toMatchObject({ status: 'unsorted', reason: 'no-disc-number', suggestions: ['anilist:11'], seasons: { 'anilist:11': 2 } });
    });
  });

  describe('tuning after the first real run', () => {
    /** Evidence as production makes it: the root's name isn't a segment. */
    const rooted = (path: string, titles: Record<string, string> = {}): DiscEvidence => ({ ...ev(path, titles), segments: path.split('/').slice(1) });
    const related = (type: string, id: string, format: string | null = 'TV'): Entry['relations'][number] => ({ type, id, format, startDate: null });
    const run = async (paths: readonly string[], anilist: MetadataSource, tmdb: MetadataSource | null): Promise<DiscMatch[]> =>
      (await matchDiscs(paths.map((p) => rooted(p)), ctx(anilist, tmdb))).matches;
    const starfall = entry('anilist:900', { romaji: 'Hoshifuri no Tabibito', native: '星降りの旅人' }, { episodes: 12, year: 2021 });
    const starfallEn = entry('anilist:900', { english: 'Starfall Wanderer', native: '星降りの旅人' }, { episodes: 12, year: 2021 });

    describe('M1: structure-only folders are not levels', () => {
      it('files a disc under Title (日本語)/Season 1/Volume 1 and Title/Volume 1/Disc 3', async () => {
        const anilist = fake({ 'Starfall Wanderer': [starfallEn], 星降りの旅人: [starfallEn] });
        const season = 'media0/Starfall Wanderer (星降りの旅人)/Season 1/Volume 1';
        const disc = 'media0/Starfall Wanderer/Volume 1/Disc 3';
        const deep = 'media0/Starfall Wanderer (星降りの旅人)/Season 1/Volume 2/Disc 1';
        // run apart: in one run, a bare Volume 1 and Volume 1/Disc 3 are two numbering kinds of one season (M5b)
        expect(byDisc(await run([season], anilist, null), season)).toMatchObject({ status: 'filed', entryId: 'anilist:900', season: 1, disc: 1, via: ['folder'] });
        expect(byDisc(await run([disc], anilist, null), disc)).toMatchObject({ status: 'filed', entryId: 'anilist:900', season: 1, disc: 3, via: ['folder'] });
        const both = await run([season, disc], anilist, null);
        for (const p of [season, disc]) expect(byDisc(both, p)).toMatchObject({ status: 'unsorted', reason: 'no-disc-number' });
        // Season N/Volume M/Disc K puts the title three folders up: still found, and Volume 2 waits for Volume 1
        expect(byDisc(await run([deep], anilist, null), deep)).toMatchObject({ status: 'unsorted', reason: 'no-disc-number', suggestions: ['anilist:900'] });
        for (const label of ['Box 1', 'Vol.1', 'BD', 'BDROM', 'DISC_2']) {
          const p = `media0/Starfall Wanderer/${label}/Disc 1`;
          expect(byDisc(await run([p], anilist, null), p), label).toMatchObject({ status: 'filed', entryId: 'anilist:900' });
        }
      });

      it('W3/M5: discs numbered differently into one slot, and every disc of either numbering, go to no-disc-number; copies stay', async () => {
        const quill = entry('anilist:995', { english: 'Quill Harbor' }, { year: 2015 });
        const b = 'media0/Anime/Quill Harbor';
        const state = (ms: readonly DiscMatch[], p: string): unknown => { const m = byDisc(ms, p); return m.status === 'filed' ? m.disc : m.status === 'unsorted' ? m.reason : m.status; };
        const mixed = [`${b}/Volume 1/Disc 1`, `${b}/Volume 1/Disc 2`, `${b}/Volume 2`];
        const r1 = await run(mixed, fake({ 'Quill Harbor': [quill] }), null);
        expect(mixed.map((p) => state(r1, p))).toEqual(['no-disc-number', 'no-disc-number', 'no-disc-number']);
        const three = [`${b}/Volume 1/Disc 1`, `${b}/Volume 2/Disc 1`, `${b}/Volume 2/Disc 2`, `${b}/Volume 3`];
        const r2 = await run(three, fake({ 'Quill Harbor': [quill] }), null);
        expect(three.map((p) => state(r2, p))).toEqual(['no-disc-number', 'no-disc-number', 'no-disc-number', 'no-disc-number']);
        // the same disc in two places (equal content) is two copies of one disc, as before
        const copies = ['media0/Anime/Quill Harbor/Volume 1', 'media1/Backup/Quill Harbor/Volume 1'];
        const r3 = await matchDiscs(copies.map((p) => ({ ...rooted(p), fingerprint: 'FPQ1' })), ctx(fake({ 'Quill Harbor': [quill] }), null));
        for (const p of copies) expect(byDisc(r3.matches, p)).toMatchObject({ status: 'filed', entryId: 'anilist:995', disc: 1 });
        // and one layout on two roots, numbered the same way, is copies too, even without fingerprints
        const twice = ['media0', 'media1'].flatMap((root) => [1, 2].map((d) => `${root}/Anime/Quill Harbor/Volume 1/Disc ${d}`));
        const r4 = await run(twice, fake({ 'Quill Harbor': [quill] }), null);
        expect(twice.map((p) => state(r4, p))).toEqual([1, 2, 1, 2]);
      });

      it('P1: `第N巻 DISCk` names are numbered across the volumes', async () => {
        const anilist = fake({ 星降りの旅人: [starfallEn] });
        const g = 'media0/Anime/星降りの旅人';
        const paths = [`${g}/[BDMV] 星降りの旅人 第1巻 DISC1`, `${g}/[BDMV] 星降りの旅人 第1巻 DISC2`, `${g}/[BDMV] 星降りの旅人 第2巻 DISC1`];
        const ms = await run(paths, anilist, null);
        expect(paths.map((p) => { const m = byDisc(ms, p); return m.status === 'filed' ? m.disc : m.status; })).toEqual([1, 2, 3]);
      });

      it('R1/R2: discs are numbered within their own volume or box family, and one slot takes one kind of number', async () => {
        const quill = entry('anilist:996', { english: 'Quill Harbor' }, { year: 2015 });
        const b = 'media0/Anime/Quill Harbor';
        const c = 'media1/Downloads/Quill Harbor';
        const states = async (paths: readonly string[]): Promise<unknown[]> => {
          const ms = await run(paths, fake({ 'Quill Harbor': [quill] }), null);
          return paths.map((p) => { const m = byDisc(ms, p); return m.status === 'filed' ? m.disc : m.status === 'unsorted' ? m.reason : m.status; });
        };
        const N = 'no-disc-number';
        // N1: single-disc volume releases against a three-disc set's own disc numbers (and, M5, the set's other disc)
        expect(await states([`${b}/Volume 1`, `${b}/Volume 2`, `${b}/BD/Disc 1`, `${b}/BD/Disc 2`, `${b}/BD/Disc 3`])).toEqual([N, N, N, N, N]);
        // N2: a volume number against a disc number
        expect(await states([`${b}/Volume 2`, `${b}/Season 1/Disc 2`])).toEqual([N, N]);
        // N3: box 1's disc numbers against a volume number
        expect(await states([`${b}/Box 1/Disc 1`, `${b}/Box 1/Disc 2`, `${b}/Volume 2`])).toEqual([N, N, N]);
        // N4: volumes and a box set run separately: Volume 2/Disc 1 is disc 3, never 5
        expect(await states([`${b}/Volume 1/Disc 1`, `${b}/Volume 1/Disc 2`, `${b}/Volume 2/Disc 1`,
          `${b}/BOX 1/Disc 1`, `${b}/BOX 1/Disc 2`, `${b}/BOX 1/Disc 3`, `${b}/BOX 1/Disc 4`])).toEqual([N, N, N, N, N, N, N]);
        // N5: two editions on two roots run separately; where they disagree, neither is placed
        expect(await states([`${b}/Volume 1/Disc 1`, `${b}/Volume 1/Disc 2`, `${b}/Volume 2/Disc 1`,
          `${c}/Volume 1/Disc 1`, `${c}/Volume 1/Disc 2`, `${c}/Volume 1/Disc 3`])).toEqual([N, N, N, N, N, N]);
        // M5: once two numberings clash in a slot, no disc of either keeps a number (L7)
        expect(await states([`${b}/Box 1/Disc 1`, `${b}/Box 1/Disc 2`, `${b}/Volume 1`])).toEqual([N, N, N]);
        // P2: the clash counts within one group folder too (L18)
        expect(await states([`${b}/Volume 2`, `${b}/Disc 2`])).toEqual([N, N]);
        // P1: a name with a volume and a disc number runs across the volumes like Volume M/Disc K folders (L13b, L13)
        expect(await states([`${b}/Quill Harbor Vol.1 Disc 1`, `${b}/Quill Harbor Vol.1 Disc 2`, `${b}/Quill Harbor Vol.2 Disc 1`])).toEqual([1, 2, 3]);
        expect(await states([`${b}/Quill Harbor Vol.1 Disc 2`, `${b}/Quill Harbor Vol.2 Disc 1`])).toEqual([2, N]);
        expect(await states([`${b}/Quill Harbor Vol.2 Disc 1`])).toEqual([N]);
        // and agrees with the folder layout, so the two are copies
        expect(await states([`${b}/Quill Harbor Vol.1 Disc 2`, `${c}/Volume 1/Disc 2`])).toEqual([2, 2]);
        // M5b: one numbering kind per season, even with no shared slot (Q3b, Q3): `Disc 1` says Volume 1 has more discs
        expect(await states([`${b}/Volume 1/Disc 1`, `${b}/Volume 2`])).toEqual([N, N]);
        expect(await states([`${b}/Quill Harbor Vol.1 Disc 1`, `${b}/Quill Harbor Vol.2`])).toEqual([N, N]);
        // folders and names of one kind in one family still run together (Q4), and one layout on two roots is copies (Q5)
        expect(await states([`${b}/Volume 1/Disc 1`, `${b}/Volume 1/Disc 2`, `${b}/Quill Harbor Vol.2 Disc 1`])).toEqual([1, 2, 3]);
        expect(await states([`${b}/Quill Harbor Vol.1 Disc 1`, `${b}/Quill Harbor Vol.2 Disc 1`, `${c}/Quill Harbor Vol.1 Disc 1`, `${c}/Quill Harbor Vol.2 Disc 1`])).toEqual([1, 2, 1, 2]);
        // F2: inside a box, a name with a volume and a disc number has no place (Q8)
        expect(await states([`${b}/BOX 1/Quill Harbor Vol.1 Disc 1`, `${b}/BOX 1/Quill Harbor Vol.1 Disc 2`, `${b}/BOX 1/Quill Harbor Vol.2 Disc 1`])).toEqual([N, N, N]);
        // N6: one layout on two roots is copies
        expect(await states([`${b}/Volume 1/Disc 1`, `${b}/Volume 2/Disc 1`, `${c}/Volume 1/Disc 1`, `${c}/Volume 2/Disc 1`])).toEqual([1, 2, 1, 2]);
        // editions numbered by their own volume stay copies
        expect(await states([`${b}/Quill Harbor Vol.1`, `${c}/[BDMV] Quill Harbor [ITA]/Quill Harbor Vol.1`])).toEqual([1, 1]);
      });

      it('numbers Volume M/Disc K discs across the volumes, like boxes, so two volumes never share a slot', async () => {
        const anilist = fake({ 'Starfall Wanderer': [starfallEn] });
        const paths = ['media0/Starfall Wanderer/Volume 1/Disc 1', 'media0/Starfall Wanderer/Volume 1/Disc 2', 'media0/Starfall Wanderer/Volume 2/Disc 1'];
        const ms = await run(paths, anilist, null);
        expect(paths.map((p) => { const m = byDisc(ms, p); return m.status === 'filed' ? m.disc : m.status; })).toEqual([1, 2, 3]);
        const gap = await run(paths.slice(1), anilist, null);
        expect(byDisc(gap, paths[2]!)).toMatchObject({ status: 'unsorted', reason: 'no-disc-number' });
      });

      it('still counts a folder with a title candidate, and category folders still name nothing', async () => {
        const tmdb = fake({ Watched: [entry('tmdb-movie:1', { english: 'Watched' })] });
        const paths = ['media0/Watched/Unknown Series/Unknown Series Vol.1', 'media0/Watched/Unknown Series/Volume 1', 'media0/Watched/Extra/Volume 1/Disc 1'];
        const ms = await run(paths, fake({}), tmdb);
        for (const p of paths) expect(byDisc(ms, p), p).toMatchObject({ status: 'unsorted', reason: 'no-title' });
        const anime = fake({ Anime: [entry('anilist:901', { english: 'Anime' })], Movies: [entry('anilist:902', { english: 'Movies' })] });
        const shelves = ['media0/Anime/Season 1/Volume 1', 'media0/Movies/Disc 2', 'media0/Anime/Volume 1/Disc 1'];
        const ms2 = await run(shelves, anime, null);
        for (const p of shelves) expect(byDisc(ms2, p), p).toMatchObject({ status: 'unsorted', reason: 'no-title' });
      });
    });

    describe('M2: twin names', () => {
      const vols = (title: string, n = 2): string[] => Array.from({ length: n }, (_, i) => `media0/${title}/Volume ${i + 1}`);

      it('an AniList entry fitting one half of English (日本語) and an animated TMDB entry fitting the other are twins', async () => {
        const anilist = fake({ 星降りの旅人: [starfall] });
        const tv = entry('tmdb-tv:910', { english: 'Starfall Wanderer', native: '星降りの旅人' }, { year: 2021, seasons: seasons(1), animation: true });
        const paths = vols('Starfall Wanderer (星降りの旅人)');
        const ms = await run(paths, anilist, fake({ 'Starfall Wanderer': [tv] }));
        paths.forEach((p, i) => expect(byDisc(ms, p)).toMatchObject({ status: 'filed', entryId: 'anilist:900', season: 1, disc: i + 1 }));
        // the Japanese half fits as fully as the English one, so with no TMDB key AniList alone files
        const alone = await run(paths, anilist, null);
        for (const p of paths) expect(byDisc(alone, p)).toMatchObject({ status: 'filed', entryId: 'anilist:900' });
        // a note in parens is no half: it fits only partly
        const note = 'media0/Starfall Wanderer (Collector Edition)/Volume 1';
        const cut = await run([note], fake({ 'Collector Edition': [entry('anilist:905', { english: 'Collector Edition' })] }), null);
        expect(byDisc(cut, note)).toMatchObject({ status: 'unsorted' });
        // live action: still several-fit
        const drama = await run(paths, anilist, fake({ 'Starfall Wanderer': [{ ...tv, animation: false }] }));
        for (const p of paths) expect(byDisc(drama, p)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        // outside the year window: still several-fit
        const old = await run(paths, anilist, fake({ 'Starfall Wanderer': [{ ...tv, year: 2005 }] }));
        for (const p of paths) expect(byDisc(old, p)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      });

      it('a same-segment twin of a later AniList season needs as many TMDB seasons as its place (T5t)', async () => {
        const s1 = entry('anilist:920', { romaji: 'Hoshifuri no Tabibito', native: '星降りの旅人' }, { year: 2021 });
        const s2 = entry('anilist:921', { romaji: 'Hoshifuri no Tabibito 2nd Season', native: '星降りの旅人 第2期' }, { year: 2023, relations: [related('PREQUEL', 'anilist:920')] });
        const anilist = fake({ 星降りの旅人: [s2] }, [], [s1]);
        const p = 'media0/Starfall Wanderer (星降りの旅人)/Season 2/Volume 1';
        const tv = (n: number) => fake({ 'Starfall Wanderer': [entry('tmdb-tv:930', { english: 'Starfall Wanderer', native: '星降りの旅人' }, { year: 2021, seasons: seasons(n), animation: true })] });
        expect(byDisc(await run([p], anilist, tv(2)), p)).toMatchObject({ status: 'filed', entryId: 'anilist:921', season: 2, disc: 1 });
        expect(byDisc(await run([p], anilist, tv(1)), p)).toMatchObject({ status: 'unsorted' });
      });

      it('M2b: a segment twin needs TMDB to carry the Japanese name too', async () => {
        const moon = entry('anilist:906', { english: 'Moonlit Garden', native: '月影の庭' }, { year: 2021 });
        const star = entry('tmdb-tv:907', { english: 'Starfall Wanderer', native: '星降りの旅人' }, { year: 2021, seasons: seasons(1), animation: true });
        const paths = vols('Starfall Wanderer (月影の庭)');
        // TMDB's own Japanese name shows it is another work; with none, nothing ties the halves together
        for (const t of [star, { ...star, names: { ...star.names, native: null } }]) {
          const ms = await run(paths, fake({ 月影の庭: [moon] }), fake({ 'Starfall Wanderer': [t] }));
          for (const p of paths) expect(byDisc(ms, p), String(t.names.native)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        }
        // a synonym in Japanese that names the folder's half is enough
        const named = { ...star, names: { ...star.names, native: null, synonyms: ['月影の庭'] } };
        const ok = await run(paths, fake({ 月影の庭: [moon] }), fake({ 'Starfall Wanderer': [named] }));
        for (const p of paths) expect(byDisc(ok, p)).toMatchObject({ status: 'filed', entryId: 'anilist:906' });
      });

      it("names that differ only by ’ and ' or & and and are one name, so the entries are twins", async () => {
        const apos = entry('anilist:940', { english: 'Harbor’s Light' }, { year: 2018 });
        const aposTv = entry('tmdb-tv:941', { english: "Harbor's Light" }, { year: 2018, seasons: seasons(1), animation: true });
        const p1 = "media0/Harbor's Light/Volume 1";
        const r1 = await run([p1], fake({ "Harbor's Light": [apos] }), fake({ "Harbor's Light": [aposTv] }));
        expect(byDisc(r1, p1)).toMatchObject({ status: 'filed', entryId: 'anilist:940', disc: 1 });

        const amp = entry('anilist:950', { english: 'Fin & Feather' }, { year: 2020 });
        const ampTv = entry('tmdb-tv:951', { english: 'Fin and Feather' }, { year: 2020, seasons: seasons(1), animation: true });
        const p2 = 'media0/Fin and Feather/Volume 1';
        const r2 = await run([p2], fake({ 'Fin and Feather': [amp] }), fake({ 'Fin and Feather': [ampTv] }));
        expect(byDisc(r2, p2)).toMatchObject({ status: 'filed', entryId: 'anilist:950', disc: 1 });
        const r3 = await run([p2], fake({ 'Fin and Feather': [amp] }), fake({ 'Fin and Feather': [{ ...ampTv, animation: false }] }));
        expect(byDisc(r3, p2)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      });
    });

    describe('M3: series-shaped evidence', () => {
      const orchard = entry('anilist:960', { english: 'Glass Orchard', native: 'ガラスの果樹園' }, { year: 2019, episodes: 12 });
      const film = entry('tmdb-movie:961', { english: 'Glass Orchard' }, { year: 2019, animation: false });
      const vols = ['media0/Glass Orchard/Volume 1', 'media0/Glass Orchard/Volume 2'];

      it('a same-named TMDB movie, live action or of another year, does not block a series volume set', async () => {
        for (const t of [film, { ...film, year: 2008 }, { ...film, animation: true, year: 2004 }]) {
          const ms = await run(vols, fake({ 'Glass Orchard': [orchard] }), fake({ 'Glass Orchard': [t] }));
          vols.forEach((p, i) => expect(byDisc(ms, p), `${t.year}`).toMatchObject({ status: 'filed', entryId: 'anilist:960', season: 1, disc: i + 1 }));
        }
        // a season number or an episode range is series-shaped on its own
        for (const p of ['media0/Glass Orchard/Season 1/Volume 1', 'media0/Glass Orchard (01-06)/Volume 1']) {
          const ms = await run([p], fake({ 'Glass Orchard': [orchard] }), fake({ 'Glass Orchard': [film] }));
          expect(byDisc(ms, p), p).toMatchObject({ status: 'filed', entryId: 'anilist:960' });
        }
        // an AniList MOVIE is no competitor either
        const anilistFilm = entry('anilist:962', { english: 'Glass Orchard' }, { year: 2019, format: 'MOVIE', kind: 'movie' });
        const ms = await run(vols, fake({ 'Glass Orchard': [orchard, anilistFilm] }), null);
        for (const p of vols) expect(byDisc(ms, p)).toMatchObject({ status: 'filed', entryId: 'anilist:960' });
      });

      it('a lone disc without a volume number, or a lone volume, is not series-shaped: movie and series is several-fit', async () => {
        for (const p of ['media0/Glass Orchard/BDROM', 'media0/Glass Orchard/Volume 1']) {
          const ms = await run([p], fake({ 'Glass Orchard': [orchard] }), fake({ 'Glass Orchard': [film] }));
          expect(byDisc(ms, p), p).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        }
      });

      it('W1: films whose names carry a volume still compete with a series', async () => {
        const tmdb = fake({
          'Blade Night': [
            entry('tmdb-movie:992', { english: 'Blade Night: Vol. 1' }, { year: 2003 }),
            entry('tmdb-movie:993', { english: 'Blade Night: Vol. 2' }, { year: 2004 }),
            entry('tmdb-tv:994', { english: 'Blade Night' }, { year: 2010, seasons: seasons(1) }),
          ],
        });
        const paths = ['media0/Movies/Blade Night/Blade Night Vol. 1', 'media0/Movies/Blade Night/Blade Night Vol. 2'];
        const ms = await run(paths, fake({}), tmdb);
        for (const p of paths) expect(byDisc(ms, p)).toMatchObject({ status: 'unsorted' });
        for (const p of paths) expect(byDisc(ms, p).status === 'unsorted' && (byDisc(ms, p) as { suggestions: readonly string[] }).suggestions).toContain('tmdb-tv:994');
      });

      it('M3b: disc numbers alone are not series-shaped; volume numbers among siblings are', async () => {
        const tmdb = (): MetadataSource => fake({ 'Quiet Meadow': [
          entry('tmdb-tv:990', { english: 'Quiet Meadow' }, { year: 2015, seasons: seasons(1) }),
          entry('tmdb-movie:991', { english: 'Quiet Meadow' }, { year: 2015 }),
        ] });
        for (const pair of [['DISC1', 'DISC2'], ['D1', 'D2'], ['Disc 1', 'Disc 2']]) {
          const paths = pair.map((d) => `media0/Quiet Meadow/${d}`);
          const ms = await run(paths, fake({}), tmdb());
          for (const p of paths) expect(byDisc(ms, p), p).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        }
        const paths = ['media0/Quiet Meadow/Volume 1', 'media0/Quiet Meadow/Volume 2'];
        const ms = await run(paths, fake({}), tmdb());
        paths.forEach((p, i) => expect(byDisc(ms, p)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:990', season: 1, disc: i + 1 }));
      });

      it('an AniList TV entry beats its own related OVA, ONA, SPECIAL and TV_SHORT entries', async () => {
        const tv = entry('anilist:970', { english: 'Harbor Line', native: '港線' }, { year: 2019, relations: [related('SIDE_STORY', 'anilist:971', 'SPECIAL'), related('ALTERNATIVE', 'anilist:974', 'OVA')] });
        const specials = entry('anilist:971', { english: 'Harbor Line Specials', native: '港線' }, { format: 'SPECIAL', year: 2020, relations: [related('PARENT', 'anilist:970')] });
        const mini = entry('anilist:972', { english: 'Harbor Line Mini', synonyms: ['Harbor Line'] }, { format: 'TV_SHORT', year: 2020, relations: [related('PARENT', 'anilist:970')] });
        const ona = entry('anilist:973', { english: 'Harbor Line Short', native: '港線' }, { format: 'ONA', year: 2021, relations: [] });
        const ova = entry('anilist:975', { english: 'Harbor Line', native: '港線' }, { format: 'OVA', year: 2019, relations: [related('SEQUEL', 'anilist:970')] });
        const onaLinked = { ...ona, relations: [related('PREQUEL', 'anilist:970')] };
        const paths = ['media0/Harbor Line (港線)/Volume 1', 'media0/Harbor Line (港線)/Volume 2'];
        const all = [tv, specials, mini, onaLinked, ova];
        const ms = await run(paths, fake({ 'Harbor Line': all, 港線: all }), null);
        paths.forEach((p, i) => expect(byDisc(ms, p)).toMatchObject({ status: 'filed', entryId: 'anilist:970', season: 1, disc: i + 1 }));
        // an unrelated OVA of the same name (ALTERNATIVE isn't a story link, nor is no link at all): several-fit
        for (const other of [ona, entry('anilist:974', { english: 'Harbor Line', native: '港線' }, { format: 'OVA', year: 2019 })]) {
          const r = await run(paths, fake({ 'Harbor Line': [tv, other], 港線: [tv, other] }), null);
          for (const p of paths) expect(byDisc(r, p), other.id).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        }
        // two TV entries: several-fit
        const remake = entry('anilist:976', { english: 'Harbor Line', native: '港線' }, { year: 2024, relations: [related('SIDE_STORY', 'anilist:970')] });
        const r2 = await run(paths, fake({ 'Harbor Line': [tv, remake], 港線: [tv, remake] }), null);
        for (const p of paths) expect(byDisc(r2, p)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        // not series-shaped: the side entries still compete
        const lone = 'media0/Harbor Line (港線)/BDROM';
        expect(byDisc(await run([lone], fake({ 'Harbor Line': [tv, specials], 港線: [tv, specials] }), null), lone)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      });

      it('keeps anime and live-action series of one name, and AniList seasons 1 and 2 without a season number, several-fit', async () => {
        const drama = entry('tmdb-tv:963', { english: 'Glass Orchard' }, { year: 2020, seasons: seasons(1), animation: false });
        const r1 = await run(vols, fake({ 'Glass Orchard': [orchard] }), fake({ 'Glass Orchard': [drama] }));
        for (const p of vols) expect(byDisc(r1, p)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        const s2 = entry('anilist:964', { english: 'Glass Orchard 2nd Season' }, { year: 2021, relations: [related('PREQUEL', 'anilist:960')] });
        const r2 = await run(vols, fake({ 'Glass Orchard': [orchard, s2] }), null);
        for (const p of vols) expect(byDisc(r2, p)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      });
    });

    describe('M4: specials as films', () => {
      const tale = (format: string, more: Partial<Entry> = {}) =>
        entry('anilist:980', { english: 'Glass Orchard: Winter Tale' }, { format, kind: format === 'MOVIE' ? 'movie' : 'series', year: 2020, ...more });
      const film = entry('tmdb-movie:981', { english: 'Glass Orchard Winter Tale' }, { year: 2021, animation: true });
      const p = 'media0/Glass Orchard Winter Tale';

      it('an AniList MOVIE, SPECIAL or OVA and an animated TMDB movie of one name and year are one work: AniList wins', async () => {
        for (const format of ['MOVIE', 'SPECIAL', 'OVA']) {
          const ms = await run([p], fake({ 'Glass Orchard Winter Tale': [tale(format)] }), fake({ 'Glass Orchard Winter Tale': [film] }));
          expect(byDisc(ms, p), format).toMatchObject({ status: 'filed', entryId: 'anilist:980', season: null, disc: null });
        }
      });

      it('not when the TMDB movie is live action, two years off, or named differently', async () => {
        for (const t of [{ ...film, animation: false }, { ...film, year: 2022 }, { ...film, animation: null }]) {
          const ms = await run([p], fake({ 'Glass Orchard Winter Tale': [tale('SPECIAL')] }), fake({ 'Glass Orchard Winter Tale': [t] }));
          expect(byDisc(ms, p)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        }
        // the TV entry and a TMDB movie of the same name are not twins
        const ms = await run([p], fake({ 'Glass Orchard Winter Tale': [tale('TV')] }), fake({ 'Glass Orchard Winter Tale': [film] }));
        expect(byDisc(ms, p)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      });
    });
  });

  describe('tuning round 2', () => {
    const rooted = (path: string, titles: Record<string, string> = {}): DiscEvidence => ({ ...ev(path, titles), segments: path.split('/').slice(1) });
    const related = (type: string, id: string, format: string | null = 'TV'): Entry['relations'][number] => ({ type, id, format, startDate: null });
    const one = async (path: string, anilist: MetadataSource, tmdb: MetadataSource | null, titles: Record<string, string> = {}): Promise<DiscMatch> =>
      byDisc((await matchDiscs([rooted(path, titles)], ctx(anilist, tmdb))).matches, path);

    describe('M6 + M8: a Japanese release year and the anime tag', () => {
      const film = entry('anilist:1100', { romaji: 'Hoshifuri no Tabibito', native: '星降りの旅人' }, { format: 'MOVIE', kind: 'movie', year: 2013 });
      const twin = entry('tmdb-movie:1101', { english: 'Starfall Wanderer', native: '星降りの旅人' }, { year: 2013, animation: true });
      const drama = entry('tmdb-movie:1102', { english: 'Starfall Wanderer', native: '星降りの旅人' }, { year: 1976, animation: false });
      const sources = () => [fake({ 星降りの旅人: [film] }), fake({ 星降りの旅人: [twin, drama] })] as const;

      it('a [アニメ] release folder with a 2013年製作 film files under the anime film, not the 1976 live-action one', async () => {
        const p = 'media0/[BDISO+BDMV][アニメ][240703][Lantern Collection]/[2013年製作][BDISO]『星降りの旅人』/HOSHIFURI.iso';
        expect(await one(p, ...sources())).toMatchObject({ status: 'filed', entryId: 'anilist:1100', season: null, disc: null });
        // [Anime] too
        const q = 'media0/[BDMV][Anime][Lantern Collection]/[2013年製作]『星降りの旅人』/HOSHIFURI.iso';
        expect(await one(q, ...sources())).toMatchObject({ status: 'filed', entryId: 'anilist:1100' });
      });

      it('without the anime tag the live-action film still competes, unless the year rules it out', async () => {
        const p = 'media0/Lantern Collection/[BDISO]『星降りの旅人』/HOSHIFURI.iso';
        expect(await one(p, ...sources())).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        // 2013年製作 is more than a year from the 1976 film's, so that film is no fit (T5j)
        const q = 'media0/Lantern Collection/[2013年製作][BDISO]『星降りの旅人』/HOSHIFURI.iso';
        expect(await one(q, ...sources())).toMatchObject({ status: 'filed', entryId: 'anilist:1100' });
      });

      it('under the anime tag a live-action entry is no fit at all, and an unknown genre still competes', async () => {
        const p = 'media0/[BDMV][アニメ][Lantern Collection]/『星降りの旅人』/HOSHIFURI.iso';
        expect(await one(p, fake({}), fake({ 星降りの旅人: [drama] }))).toMatchObject({ status: 'unsorted', reason: 'no-title' });
        const unknown = { ...drama, animation: null };
        expect(await one(p, fake({ 星降りの旅人: [film] }), fake({ 星降りの旅人: [twin, unknown] }))).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      });
    });

    describe('M7: the Japanese evidence decides between same-named entries', () => {
      const anime = entry('anilist:1200', { english: 'Glass Orchard', native: 'ガラスの果樹園' }, { year: 2019 });
      const twin = entry('tmdb-tv:1201', { english: 'Glass Orchard', native: 'ガラスの果樹園' }, { year: 2019, seasons: seasons(1), animation: true });
      const old = entry('tmdb-movie:1202', { english: 'Glass Orchard', native: '硝子の果樹園' }, { year: 1933, animation: false });
      const p = 'media0/Anime/[BDMV] Glass Orchard/GLASS_ORCHARD_D1';
      const sources = (film: Entry = old) => [fake({ 'Glass Orchard': [anime], ガラスの果樹園: [anime] }), fake({ 'Glass Orchard': [twin, film], ガラスの果樹園: [twin] })] as const;

      it("a film whose Japanese name isn't the disc's Japanese title is no competitor", async () => {
        expect(await one(p, ...sources(), { jpn: 'ガラスの果樹園' })).toMatchObject({ status: 'filed', entryId: 'anilist:1200', season: 1, disc: 1 });
      });

      it('not without Japanese evidence, nor for an entry without a Japanese name, nor when no entry has the Japanese name', async () => {
        expect(await one(p, ...sources())).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        expect(await one(p, ...sources({ ...old, names: { ...old.names, native: null } }), { jpn: 'ガラスの果樹園' })).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        // a Japanese name differing only in kana, or by a season, is not another title: it still competes
        for (const native of ['がらすの果樹園', 'ガラスの果樹園 第2期']) {
          expect(await one(p, ...sources({ ...old, names: { ...old.names, native } }), { jpn: 'ガラスの果樹園' }), native).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        }
        // the Japanese title names neither: nothing is dropped
        const tmdb = fake({ 'Glass Orchard': [entry('tmdb-movie:1203', { english: 'Glass Orchard', native: '硝子の果樹園' }, { year: 1933 })] });
        const m = await one(p, fake({ 'Glass Orchard': [{ ...anime, names: { ...anime.names, native: 'ガラスの果樹園 新章' } }] }), tmdb, { jpn: 'ガラスの果樹園' });
        expect(m).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      });
    });

    describe('M9: an unaired AniList entry', () => {
      const s1 = entry('anilist:1300', { english: 'Harbor Line' }, { year: 2019, relations: [related('SEQUEL', 'anilist:1301')] });
      const s2 = entry('anilist:1301', { english: 'Harbor Line Season 2' }, { year: null, relations: [related('PREQUEL', 'anilist:1300')] });

      it('is no competitor when a fitting entry of its franchise has a year', async () => {
        const vol = 'media0/Anime/[BDMV][Harbor Line][Vol.2][JPN]';
        expect(await one(vol, fake({ 'Harbor Line': [s1, s2] }), null)).toMatchObject({ status: 'filed', entryId: 'anilist:1300', season: 1, disc: 2 });
        const bdrom = 'media0/Anime/[BDMV][Harbor Line][Vol.2][JPN]/BDROM';
        expect(await one(bdrom, fake({ 'Harbor Line': [s1, s2] }), null)).toMatchObject({ status: 'filed', entryId: 'anilist:1300', season: 1, disc: 2 });
      });

      it('still competes with an unrelated entry, and may be the only fit', async () => {
        const vol = 'media0/Anime/[BDMV][Harbor Line][Vol.2][JPN]';
        const other = { ...s2, relations: [] };
        expect(await one(vol, fake({ 'Harbor Line': [{ ...s1, relations: [] }, other] }), null)).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
        const s2only = 'media0/Anime/[BDMV][Harbor Line Season 2][Vol.1]';
        expect(await one(s2only, fake({ 'Harbor Line': [s2] }, [], [s1]), null)).toMatchObject({ status: 'filed', entryId: 'anilist:1301', season: 2, disc: 1 });
      });
    });

    describe("M10: a generic disc folder takes its release folder's volume", () => {
      const brasswick = entry('anilist:1500', { english: 'Brasswick' }, { year: 2016 });
      const states = async (paths: readonly string[]): Promise<unknown[]> => {
        const { matches } = await matchDiscs(paths.map((p) => rooted(p)), ctx(fake({ Brasswick: [brasswick] }), null));
        return paths.map((p) => { const m = byDisc(matches, p); return m.status === 'filed' ? m.disc : m.status === 'unsorted' ? m.reason : m.status; });
      };

      it('numbers sibling release folders by their volumes', async () => {
        expect(await states([1, 2, 3].map((v) => `media0/Anime/[BDMV][Brasswick][Vol.${v}][JPN]/BDROM`))).toEqual([1, 2, 3]);
        for (const label of ['BD', 'BD_ROM', 'BD_VIDEO', 'BDMV', 'DISC', 'VIDEO']) {
          expect(await states([`media0/Anime/[BDMV][Brasswick][Vol.4][JPN]/${label}`]), label).toEqual([4]);
        }
      });

      it('not a range, nor a numbered label, nor a folder further up', async () => {
        expect(await states(['media0/Anime/[BDMV][Brasswick][Vol.1-6 Fin]/BDROM'])).toEqual(['no-disc-number']);
        // a numbered label keeps its own number
        expect(await states(['media0/Anime/[BDMV][Brasswick][Vol.2]/BD_2'])).toEqual(['no-disc-number']);
        expect(await states(['media0/Anime/[BDMV][Brasswick][Vol.2]/Season 1/BDROM'])).toEqual(['no-disc-number']);
      });
    });

    describe('M7b: a lone fit the Japanese title contradicts', () => {
      const film = entry('tmdb-movie:1600', { english: 'Glass Orchard', native: '硝子の果樹園' }, { year: 1933 });
      const p = 'media0/Movies/Glass Orchard/BDROM';

      it('goes to Unsorted as sources-disagree', async () => {
        expect(await one(p, fake({}), fake({ 'Glass Orchard': [film] }), { jpn: 'ガラスの果樹園' })).toMatchObject({ status: 'unsorted', reason: 'sources-disagree', suggestions: ['tmdb-movie:1600'] });
      });

      it('files as before with no Japanese name, a kana or season variant of it, or no Japanese evidence', async () => {
        const runWith = (native: string | null, titles: Record<string, string>) => one(p, fake({}), fake({ 'Glass Orchard': [{ ...film, names: { ...film.names, native } }] }), titles);
        expect(await runWith(null, { jpn: 'ガラスの果樹園' })).toMatchObject({ status: 'filed', entryId: 'tmdb-movie:1600' });
        // a kana variant is the same name (M7e), and one held in the other agrees (M7f)
        expect(await runWith('がらすの果樹園', { jpn: 'ガラスの果樹園' })).toMatchObject({ status: 'filed', entryId: 'tmdb-movie:1600' });
        expect(await runWith('がらすの果樹園 殺人事件', { jpn: 'ガラスの果樹園' })).toMatchObject({ status: 'filed', entryId: 'tmdb-movie:1600' });
        // with no containment either way, even after the folds, it disagrees
        expect(await runWith('がらすの林檎園', { jpn: 'ガラスの果樹園' })).toMatchObject({ status: 'unsorted', reason: 'sources-disagree' });
        expect(await runWith('ガラスの果樹園 第2期', { jpn: 'ガラスの果樹園' })).toMatchObject({ status: 'filed', entryId: 'tmdb-movie:1600' });
        expect(await runWith('硝子の果樹園', {})).toMatchObject({ status: 'filed', entryId: 'tmdb-movie:1600' });
      });
    });

    describe('round 2 review', () => {
      const states = async (paths: readonly (string | [string, Record<string, string>])[], anilist: MetadataSource, tmdb: MetadataSource | null): Promise<unknown[]> => {
        const evs = paths.map((p) => (typeof p === 'string' ? rooted(p) : rooted(p[0], p[1])));
        const { matches } = await matchDiscs(evs, ctx(anilist, tmdb));
        return evs.map((e) => { const m = byDisc(matches, e.path); return m.status === 'filed' ? `${m.entryId}#${m.disc}` : m.status === 'unsorted' ? m.reason : m.status; });
      };
      const N = 'no-disc-number';

      it('W1: a Japanese name that extends the disc title (劇場版 X, X 夜明け編, X 冬の章) is not another title', async () => {
        const live = entry('tmdb-movie:1701', { english: 'Lantern Coast', native: 'ランタン海岸' }, { year: 2022, animation: false });
        for (const native of ['劇場版 ランタン海岸', 'ランタン海岸 夜明け編']) {
          const film = entry('anilist:1700', { english: 'Lantern Coast', native }, { year: 2021, format: 'MOVIE', kind: 'movie' });
          const r = await states([['media0/Movies/Lantern Coast/BDROM', { jpn: 'ランタン海岸' }]], fake({ 'Lantern Coast': [film] }), fake({ 'Lantern Coast': [live], ランタン海岸: [live] }));
          expect(r, native).toEqual(['several-fit']);
        }
        const a1 = entry('anilist:1710', { english: 'Glass Orchard', native: 'ガラスの果樹園' }, { year: 2019, relations: [related('SEQUEL', 'anilist:1711')] });
        const a2 = entry('anilist:1711', { english: 'Glass Orchard Season 2', native: 'ガラスの果樹園 冬の章' }, { year: 2024, relations: [related('PREQUEL', 'anilist:1710')] });
        const drama = entry('tmdb-tv:1712', { english: 'Glass Orchard', native: 'ガラスの果樹園' }, { year: 2023, seasons: seasons(2), animation: false });
        const T = { jpn: 'ガラスの果樹園' };
        const tmdb = () => fake({ 'Glass Orchard': [drama], ガラスの果樹園: [drama] });
        const j3 = await states([['media0/Anime/Glass Orchard Season 2/Vol.1', T]], fake({ 'Glass Orchard': [a2] }, [], [a1]), tmdb());
        expect(j3[0]).not.toMatch(/^tmdb/);
        const j2 = await states([['media0/Anime/Glass Orchard Season 2 (2024)/Vol.1', T]], fake({ 'Glass Orchard': [a1, a2], ガラスの果樹園: [a1] }), tmdb());
        expect(j2[0]).not.toMatch(/^tmdb/);
        // M7b: a lone fit whose Japanese name extends the disc title is not contradicted
        const film = entry('tmdb-movie:1720', { english: 'Lantern Coast', native: '劇場版 ランタン海岸' }, { year: 2021 });
        expect(await states([['media0/Movies/Lantern Coast/BDROM', { jpn: 'ランタン海岸' }]], fake({}), fake({ 'Lantern Coast': [film] }))).toEqual(['tmdb-movie:1720#null']);
      });

      describe('M10 limits', () => {
        const brasswick = entry('anilist:1800', { english: 'Brasswick' }, { year: 2016 });
        const run = (paths: readonly string[]) => states(paths, fake({ Brasswick: [brasswick] }), null);
        const R = 'media0/Anime';

        it('W2: a parent naming a disc or a box as well is not a single-disc release folder', async () => {
          expect(await run([`${R}/Brasswick Vol.2 Disc 1/BDROM`, `${R}/Brasswick Vol.2 Disc 2/BDROM`])).toEqual([N, N]);
          expect(await run([`${R}/[Brasswick][Vol.1][Disc 1]/BDROM`, `${R}/[Brasswick][Vol.1][Disc 2]/BDROM`, `${R}/[Brasswick][Vol.2][Disc 1]/BDROM`])).toEqual([N, N, N]);
          expect(await run([`${R}/[Brasswick][Vol.1][D1]/BDROM`, `${R}/[Brasswick][Vol.1][D2]/BDROM`])).toEqual([N, N]);
        });

        it('W3: a release folder holding another disc of the entry numbers none of them', async () => {
          expect(await run([`${R}/[Brasswick][Vol.2]/BD`, `${R}/[Brasswick][Vol.2]/BD2`])).toEqual([N, N]);
          expect(await run([`${R}/[Brasswick][Vol.2]/BD`, `${R}/[Brasswick][Vol.2]/BDMV`])).toEqual([N, N]);
          expect(await run([`${R}/[Brasswick][Vol.1]/BDROM`, `${R}/[Brasswick][Vol.1]/BDROM2`, `${R}/[Brasswick][Vol.2]/BDROM`])).toEqual([N, N, N]);
          // a disc in a subfolder isn't in the release folder: the BDROM keeps its number
          expect(await run([`${R}/[Brasswick][Vol.2]/BDROM`, `${R}/[Brasswick][Vol.2]/BONUS/BDROM`])).toEqual(['anilist:1800#2', 'no-title']);
        });
      });

      it('W4: the anime tag counts only in a bracket of tags with no other genre', async () => {
        const anime = entry('anilist:1900', { english: 'Glass Orchard', native: 'ガラスの果樹園' }, { year: 2019 });
        const live = entry('tmdb-tv:1901', { english: 'Glass Orchard', native: 'ガラスの果樹園' }, { year: 2019, seasons: seasons(1), animation: false });
        const run = (p: string) => states([p], fake({ 'Glass Orchard': [anime] }), fake({ 'Glass Orchard': [live] }));
        for (const shelf of ['[Anime+Drama]', '[Anime & Live Action]', '[Not Anime]', '[アニメ+実写]', '[アニメ][特撮]', '[Anime Live]']) {
          expect(await run(`media0/${shelf}/Glass Orchard/Vol.1`), shelf).toEqual(['several-fit']);
        }
        for (const shelf of ['[アニメ]', '[BDMV][アニメ]', '[BDISO+BDMV][Anime]', '[Anime+BDMV]']) {
          expect(await run(`media0/${shelf}/Glass Orchard/Vol.1`), shelf).toEqual(['anilist:1900#1']);
        }
      });

      it('M7f: a lone fit agrees with any Japanese title it holds or is held in, after kana and kanji-variant folds', async () => {
        const lone = async (native: string, jpn: string) =>
          (await states([['media0/Movies/Ocean/BDROM', { jpn }]], fake({}), fake({ Ocean: [entry('tmdb-movie:2200', { english: 'Ocean', native }, { year: 2010 })] })))[0];
        // the disc's bdmt title is noisy (extra words, truncation, kanji variants): containment either way agrees
        for (const [native, jpn] of [['海の家', '海'], ['海', '海の家'], ['星降りの旅人', '星'], ['劇場版 海の家', '海の家'], ['海の家第2期', '海の家'], ['海 殺人事件', '海'],
          ['ガラスの果樹園', 'ガラスの果樹園 本編'], ['ガラスの果樹園', 'ガラスの果樹園 BOX'], ['ガラスの果樹園', 'ガラスの果'], ['星降りの旅人 弐', '星降りの旅人 弍'],
          ['髙橋の澤', '高橋の沢'], ['カラーズ', 'カラ']]) {
          expect(await lone(native!, jpn!), `${native} / ${jpn}`).toBe('tmdb-movie:2200#null');
        }
        // no containment at all, even after the folds: another work
        for (const [native, jpn] of [['空の城', '海'], ['硝子の果樹園', 'ガラスの果樹園'], ['月の庭', '星の庭']]) {
          expect(await lone(native!, jpn!), `${native} / ${jpn}`).toBe('sources-disagree');
        }
        // drop side (M7c): a live film whose Japanese name holds the disc's at all still competes
        const anime = entry('anilist:2201', { english: 'Ocean', native: '海' }, { year: 2010, format: 'MOVIE', kind: 'movie' });
        const live = entry('tmdb-movie:2202', { english: 'Ocean', native: '海の家' }, { year: 2010, animation: false });
        expect(await states([['media0/Movies/Ocean/BDROM', { jpn: '海' }]], fake({ Ocean: [anime], 海: [anime] }), fake({ Ocean: [live] }))).toEqual(['several-fit']);
      });

      it('M7c: an anime whose Japanese name holds the disc title, glued or not, is never dropped for a live-action entry', async () => {
        const live = entry('tmdb-movie:2401', { english: 'Lantern Coast', native: 'ランタン海岸' }, { year: 2022, animation: false });
        for (const native of ['ランタン海岸2', 'ランタン海岸S', 'ランタン海岸R', 'ランタン海岸II', 'ランタン海岸Ⅱ', 'ランタン海岸SEED', 'ランタン海岸2199',
          'ランタン海岸夜明け編', '新ランタン海岸', '真ランタン海岸', '続ランタン海岸']) {
          const film = entry('anilist:2400', { english: 'Lantern Coast', native }, { year: 2021, format: 'MOVIE', kind: 'movie' });
          const r = await states([['media0/Movies/Lantern Coast/BDROM', { jpn: 'ランタン海岸' }]], fake({ 'Lantern Coast': [film] }), fake({ 'Lantern Coast': [live], ランタン海岸: [live] }));
          expect(r, native).toEqual(['several-fit']);
        }
      });

      it('R2: every disc under an M10 release folder counts, whatever its match', async () => {
        const brasswick = entry('anilist:2300', { english: 'Brasswick' }, { year: 2016 });
        const other = entry('anilist:2301', { english: 'Starfall Wanderer', native: '星降りの旅人' }, { year: 2016 });
        const run = (paths: readonly (string | [string, Record<string, string>])[]) => states(paths, fake({ Brasswick: [brasswick], 星降りの旅人: [other] }), null);
        const R = 'media0/Anime';
        expect(await run([`${R}/[Brasswick][Vol.2]/BDROM`, [`${R}/[Brasswick][Vol.2]/BDROM2`, { jpn: '星降りの旅人' }]])).toEqual([N, 'sources-disagree']);
        expect(await run([`${R}/[Brasswick][Vol.1]/BDROM`, `${R}/[Brasswick][Vol.1]/DISC2/BDROM`, `${R}/[Brasswick][Vol.2]/BDROM`])).toEqual([N, N, N]);
        // bonus-named discs don't count
        expect(await run([`${R}/[Brasswick][Vol.2]/BDROM`, `${R}/[Brasswick][Vol.2]/BONUS`])).toEqual(['anilist:2300#2', 'anilist:2300#null']);
      });

      it('W5: a year run into a title stays in it', async () => {
        const other = entry('anilist:2000', { native: '星の海' }, { year: 2021, format: 'MOVIE', kind: 'movie' });
        const mine = entry('anilist:2001', { native: '星の海2020年' }, { year: 2023, format: 'MOVIE', kind: 'movie' });
        expect(await states(['media0/Anime/星の海2020年/BDROM'], fake({ 星の海: [other], 星の海2020年: [mine] }), null)).toEqual(['anilist:2001#null']);
      });

      it('Y4: Title_2012 keeps Title 2012 as a candidate, so its entry competes', async () => {
        const night = entry('tmdb-movie:2100', { english: 'Night' }, { year: 2012 });
        const night2012 = entry('tmdb-movie:2101', { english: 'Night 2012' }, { year: 2012 });
        expect(await states(['media0/Movies/[BDMV][Night_2012]/BDROM'], fake({}), fake({ Night: [night], 'Night 2012': [night2012] }))).toEqual(['several-fit']);
      });
    });

    it('M6: a [Title_2006][US] folder searches for the title, never the region', async () => {
      const tmdb = fake({ Brasswick: [entry('tmdb-tv:1400', { english: 'Brasswick' }, { year: 2006, seasons: seasons(1) })], US: [entry('tmdb-movie:1401', { english: 'US' })] });
      const p = 'media0/TV/[BDMV][Brasswick_2006][US]/BRASSWICK_D2';
      expect(await one(p, fake({}), tmdb)).toMatchObject({ status: 'filed', entryId: 'tmdb-tv:1400', season: 1, disc: 2 });
      expect((tmdb as unknown as { calls: string[] }).calls).not.toContain(normalizeTitle('US'));
    });
  });

  describe('round 3', () => {
    const rooted = (path: string, titles: Record<string, string> = {}): DiscEvidence => ({ ...ev(path, titles), segments: path.split('/').slice(1) });
    const related = (type: string, id: string): Entry['relations'][number] => ({ type, id, format: 'TV', startDate: null });
    const state = async (path: string, anilist: MetadataSource, tmdb: MetadataSource | null): Promise<string> => {
      const m = byDisc((await matchDiscs([rooted(path)], ctx(anilist, tmdb))).matches, path);
      return m.status === 'filed' ? `${m.entryId}#${m.disc}` : m.status === 'unsorted' ? m.reason : m.status;
    };

    describe('M11: the release date', () => {
      const s1 = entry('anilist:3000', { english: 'Brasswick' }, { year: 2016, startDate: 20161005, relations: [related('SEQUEL', 'anilist:3001')] });
      const s2 = entry('anilist:3001', { english: 'Brasswick 2nd Season', synonyms: ['Brasswick'] }, { year: 2017, startDate: 20171004, relations: [related('PREQUEL', 'anilist:3000')] });
      const anilist = () => fake({ Brasswick: [s1, s2] });

      it('an entry that started after the release date is no fit', async () => {
        expect(await state('media0/Anime/[BDMV][170426][Brasswick][Vol.02]', anilist(), null)).toBe('anilist:3000#2');
        expect(await state('media0/Anime/[BDMV][20170426][Brasswick][Vol.02]', anilist(), null)).toBe('anilist:3000#2');
        expect(await state('media0/Anime/[BDMV][170426][Brasswick][Vol.02]/BDROM', anilist(), null)).toBe('anilist:3000#2');
        expect(await state('media0/Anime/[BDMV][180124][Brasswick][Vol.02]', anilist(), null)).toBe('several-fit');
        // a TMDB entry by its first-air date, and an entry with only a year
        const tmdbLater = fake({ Brasswick: [entry('tmdb-tv:3002', { english: 'Brasswick' }, { year: 2017, startDate: 20171101, seasons: seasons(1), animation: false })] });
        // an unrelated entry that started later still competes (M11b): it may be a remake on a later disc
        expect(await state('media0/Anime/[BDMV][170426][Brasswick][Vol.02]', fake({ Brasswick: [s1] }), tmdbLater)).toBe('several-fit');
        const yearOnly = fake({ Brasswick: [s1, { ...s2, startDate: undefined, year: 2018 }] });
        expect(await state('media0/Anime/[BDMV][170426][Brasswick][Vol.02]', yearOnly, null)).toBe('anilist:3000#2');
      });

      it('not an invalid or future date, nor a same-month entry with no day', async () => {
        for (const date of ['171345', '170231', '991231', '20990101']) {
          expect(await state(`media0/Anime/[BDMV][${date}][Brasswick][Vol.02]`, anilist(), null), date).toBe('several-fit');
        }
        const sameMonth = fake({ Brasswick: [s1, { ...s2, startDate: 20170400 }] });
        expect(await state('media0/Anime/[BDMV][170426][Brasswick][Vol.02]', sameMonth, null)).toBe('several-fit');
      });
    });

    it('M12: a TMDB series dated up to three years before the AniList chain root is its twin', async () => {
      const anime = entry('anilist:3100', { english: 'Quill Harbor', native: '羽根の港' }, { year: 2026 });
      const tv = (year: number) => fake({ 'Quill Harbor': [entry('tmdb-tv:3101', { english: 'Quill Harbor', native: '羽根の港' }, { year, seasons: seasons(1), animation: true })] });
      const p = 'media0/Anime/Quill Harbor/Volume 1';
      expect(await state(p, fake({ 'Quill Harbor': [anime] }), tv(2024))).toBe('anilist:3100#1');
      expect(await state(p, fake({ 'Quill Harbor': [anime] }), tv(2023))).toBe('anilist:3100#1');
      expect(await state(p, fake({ 'Quill Harbor': [anime] }), tv(2022))).toBe('several-fit');
      // M12b: in the widened years, TMDB needs the Japanese name too; an animated show of the name without one isn't a twin
      const cartoon = fake({ 'Quill Harbor': [entry('tmdb-tv:3103', { english: 'Quill Harbor' }, { year: 2024, seasons: seasons(1), animation: true })] });
      expect(await state(p, fake({ 'Quill Harbor': [anime] }), cartoon)).toBe('several-fit');
      const otherJapanese = fake({ 'Quill Harbor': [entry('tmdb-tv:3104', { english: 'Quill Harbor', native: '羽の港町' }, { year: 2024, seasons: seasons(1), animation: true })] });
      expect(await state(p, fake({ 'Quill Harbor': [anime] }), otherJapanese)).toBe('several-fit');
      // within a year it needs no Japanese name, as before
      const near = fake({ 'Quill Harbor': [entry('tmdb-tv:3105', { english: 'Quill Harbor' }, { year: 2025, seasons: seasons(1), animation: true })] });
      expect(await state(p, fake({ 'Quill Harbor': [anime] }), near)).toBe('anilist:3100#1');
      // a TMDB movie keeps one year either way
      const film = fake({ 'Quill Harbor': [entry('tmdb-movie:3102', { english: 'Quill Harbor', native: '羽根の港' }, { year: 2024, animation: true })] });
      const anilistFilm = fake({ 'Quill Harbor': [{ ...anime, format: 'MOVIE', kind: 'movie' }] });
      expect(await state('media0/Movies/Quill Harbor/BDROM', anilistFilm, film)).toBe('several-fit');
    });

    describe('M13: disc-label candidates are weak', () => {
      const film = entry('anilist:3200', { romaji: 'Hyakumeter no Kiseki', native: '百メートルの奇跡' }, { format: 'MOVIE', kind: 'movie', year: 2022 });
      const others = [entry('tmdb-movie:3201', { english: '100M Feature' }, { year: 2001 }), entry('tmdb-movie:3202', { english: '100M Feature' }, { year: 2014 })];

      it('a label fits nothing once a folder name or a disc title fits an entry', async () => {
        const p = 'media0/Movies/Hyakumeter no Kiseki/100M_FEATURE';
        expect(await state(p, fake({ 'Hyakumeter no Kiseki': [film] }), fake({ '100M FEATURE': others }))).toBe('anilist:3200#null');
        // a disc title fitting counts as well
        const q = 'media0/Movies/100M_FEATURE';
        const r = byDisc((await matchDiscs([rooted(q, { jpn: '百メートルの奇跡' })], ctx(fake({ 百メートルの奇跡: [film] }), fake({ '100M FEATURE': others })))).matches, q);
        expect(r).toMatchObject({ status: 'filed', entryId: 'anilist:3200' });
      });

      it('with no other evidence a label works as before, and its disc number still counts', async () => {
        const glass = entry('tmdb-movie:3203', { english: 'Glass Orchard' }, { year: 2019 });
        expect(await state('media0/Movies/GLASS_ORCHARD', fake({}), fake({ 'GLASS ORCHARD': [glass] }))).toBe('tmdb-movie:3203#null');
        expect(await state('media0/Movies/100M_FEATURE', fake({}), fake({ '100M FEATURE': others }))).toBe('several-fit');
        const tv = entry('anilist:3204', { english: 'Quill Harbor' }, { year: 2015 });
        expect(await state('media0/Anime/Quill Harbor/QUILL_HARBOR_D2', fake({ 'Quill Harbor': [tv] }), null)).toBe('anilist:3204#2');
      });
    });

    it("a same-named TMDB entry outside the evidence's year is no competitor to an AniList entry and its twin", async () => {
      const anime = entry('anilist:3300', { english: 'Brasswick', native: 'ブラスウィック' }, { year: 2006 });
      const twin = entry('tmdb-tv:3301', { english: 'Brasswick', native: 'ブラスウィック' }, { year: 2006, seasons: seasons(1), animation: true });
      const live = entry('tmdb-tv:3302', { english: 'Brasswick', native: 'ブラスウィック' }, { year: 2011, seasons: seasons(1), animation: false });
      const sources = () => [fake({ Brasswick: [anime] }), fake({ Brasswick: [twin, live] })] as const;
      expect(await state('media0/Anime/[BDMV][Brasswick_2006][US]/BRASSWICK_D2', ...sources())).toBe('anilist:3300#2');
      // without a year in the evidence it still competes
      expect(await state('media0/Anime/[BDMV][Brasswick][US]/BRASSWICK_D2', ...sources())).toBe('several-fit');
      // and a live-action entry within a year of the evidence still does
      expect(await state('media0/Anime/[BDMV][Brasswick_2006][US]/BRASSWICK_D2', fake({ Brasswick: [anime] }), fake({ Brasswick: [twin, { ...live, year: 2007 }] }))).toBe('several-fit');
    });

    describe('round 3 review', () => {
      it('M13b: a label that alone names one entry no other evidence fits is kept, so the disagreement shows', async () => {
        const glass = entry('anilist:3500', { english: 'Glass Orchard' }, { year: 2019, format: 'MOVIE', kind: 'movie' });
        const star = entry('anilist:3501', { english: 'Starfall Wanderer' }, { year: 2019, format: 'MOVIE', kind: 'movie' });
        const main = entry('anilist:3502', { english: 'Harbor Line' }, { year: 2019, format: 'MOVIE', kind: 'movie' });
        const spin = entry('anilist:3503', { english: 'Harbor Line Origins' }, { year: 2021, format: 'MOVIE', kind: 'movie' });
        const anilist = () => fake({ 'Glass Orchard': [glass], 'STARFALL WANDERER': [star], 'Harbor Line': [main], 'HARBOR LINE ORIGINS': [spin] });
        expect(await state('media0/Movies/Glass Orchard/STARFALL_WANDERER', anilist(), null)).toBe('sources-disagree');
        expect(await state('media0/Movies/Harbor Line/HARBOR_LINE_ORIGINS', anilist(), null)).not.toMatch(/^anilist:3502/);
        // a label naming the folder's entry adds nothing, and is set aside
        expect(await state('media0/Movies/Glass Orchard/GLASS_ORCHARD', fake({ 'Glass Orchard': [glass] }), null)).toBe('anilist:3500#null');
      });

      it('M11b: a date before Blu-ray, or an unrelated later entry, rules nothing out', async () => {
        const old = entry('anilist:3600', { english: 'Glass Orchard' }, { year: 1998, startDate: 19980405 });
        const neu = entry('anilist:3601', { english: 'Glass Orchard' }, { year: 2019, startDate: 20190410 });
        const run = (p: string) => state(p, fake({ 'Glass Orchard': [old, neu] }), null);
        for (const p of ['media0/Anime/[BDMV][Glass Orchard][010203]/Vol.1', 'media0/Anime/[BDMV][Glass Orchard][20010203]/Vol.1',
          'media0/Anime/[BDMV][Glass Orchard][010203][190925]/Vol.1', 'media0/Anime/[BDMV][190301][Glass Orchard]/Vol.1',
          'media0/[BDMV][180101][Collection]/Glass Orchard/Vol.1']) {
          expect(await run(p), p).toBe('several-fit');
        }
        // between a season and its sequel too, a date before Blu-ray (2006-06-01) is no release date
        const s1 = { ...old, relations: [{ type: 'SEQUEL', id: 'anilist:3601', format: 'TV', startDate: null }] };
        const s2 = { ...neu, relations: [{ type: 'PREQUEL', id: 'anilist:3600', format: 'TV', startDate: null }] };
        expect(await state('media0/Anime/[BDMV][Glass Orchard][010203]/Vol.1', fake({ 'Glass Orchard': [s1, s2] }), null)).toBe('several-fit');
        expect(await state('media0/Anime/[BDMV][060531][Glass Orchard]/Vol.1', fake({ 'Glass Orchard': [s1, s2] }), null)).toBe('several-fit');
        expect(await state('media0/Anime/[BDMV][060601][Glass Orchard]/Vol.1', fake({ 'Glass Orchard': [s1, s2] }), null)).toBe('anilist:3600#1');
      });

      it('R3-3: the drop side folds kanji variants, so an itaiji spelling never drops the real anime', async () => {
        const anime = entry('anilist:3700', { english: 'Takahashi Garden', native: '高橋の庭' }, { year: 2015, format: 'MOVIE', kind: 'movie' });
        const live = entry('tmdb-movie:3701', { english: 'Takahashi Garden', native: '髙橋の庭' }, { year: 2015, animation: false });
        const r = byDisc((await matchDiscs([rooted('media0/Movies/Takahashi Garden/BDROM', { jpn: '髙橋の庭' })], ctx(fake({ 'Takahashi Garden': [anime] }), fake({ 'Takahashi Garden': [live], 髙橋の庭: [live] })))).matches, 'media0/Movies/Takahashi Garden/BDROM');
        expect(r).toMatchObject({ status: 'unsorted', reason: 'several-fit' });
      });

      it('斎 and 斉 are different names', async () => {
        const film = entry('tmdb-movie:3800', { english: 'Ocean', native: '斉の庭' }, { year: 2010 });
        const r = byDisc((await matchDiscs([rooted('media0/Movies/Ocean/BDROM', { jpn: '斎の庭' })], ctx(fake({}), fake({ Ocean: [film] })))).matches, 'media0/Movies/Ocean/BDROM');
        expect(r).toMatchObject({ status: 'unsorted', reason: 'sources-disagree' });
      });
    });
  });
});
