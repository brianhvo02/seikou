import { describe, expect, it } from 'vitest';
import type { OwnerChoice, OwnTitle } from '@seikou/nas/nas-api';
import { artIdOf, buildCatalogue } from './catalogue';
import type { Catalogue, FolderCover } from './catalogue';
import type { DiscDbHit } from './discdb';
import type { DiscEvidence } from './evidence';
import type { DiscMatch } from './match';
import type { MusicArtist, MusicRelease } from './music-sources';
import type { OwnerSnapshot } from './owner-store';
import type { Entry, EntryNames } from './sources';

// Every title and path here is made up (ruling R4).

function entry(id: string, names: Partial<EntryNames>, more: Partial<Entry> = {}): Entry {
  const source = id.startsWith('anilist:') ? 'anilist' : 'tmdb';
  return {
    source,
    id,
    kind: id.startsWith('tmdb-movie:') ? 'movie' : 'series',
    format: source === 'anilist' ? 'TV' : null,
    names: { english: null, romaji: null, native: null, synonyms: [], ...names },
    animation: true,
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

type Playlist = DiscEvidence['playlists'][number];
const pl = (id: string, minutes: number, clips: readonly string[]): Playlist => ({ id, durationS: minutes * 60, chapters: 6, clips });
/** Three 24-minute episodes and a play-all. */
const THREE_EPISODES = [pl('00001', 24, ['00001']), pl('00002', 24, ['00002']), pl('00003', 24, ['00003']), pl('00004', 72, ['00001', '00002', '00003'])];

const id = (path: string): string => `id:${path}`;

function ev(path: string, more: Partial<DiscEvidence> = {}): DiscEvidence {
  return { discId: id(path), path, fingerprint: null, discTitles: [], segments: path.split('/').slice(1), catalogueNumbers: [], playlists: [], ...more };
}

const filed = (path: string, entryId: string, season: number | null, disc: number | null, bonus = false): DiscMatch =>
  ({ discId: id(path), status: 'filed', entryId, season, disc, bonus, via: ['folder'] });

function owner(choices: Record<string, OwnerChoice> = {}, ownTitles: OwnTitle[] = [], displayNames: Record<string, string> = {}): OwnerSnapshot {
  return { choices: new Map(Object.entries(choices)), ownTitles, displayNames: new Map(Object.entries(displayNames)), gate: null };
}

function build(input: {
  matches: DiscMatch[];
  entries?: Entry[];
  evidence: DiscEvidence[];
  owner?: OwnerSnapshot;
  discdb?: Record<string, DiscDbHit>;
  addedAt?: Record<string, number>;
  downloadRoots?: string[];
  music?: Record<string, MusicRelease | null>;
  folderCovers?: Record<string, FolderCover | null>;
}): Catalogue {
  return buildCatalogue({
    matches: input.matches,
    entries: new Map((input.entries ?? []).map((en) => [en.id, en])),
    evidence: input.evidence,
    owner: input.owner ?? owner(),
    discdb: { lookup: (fp) => input.discdb?.[fp] ?? null },
    addedAt: new Map(Object.entries(input.addedAt ?? {})),
    downloadRoots: new Set(input.downloadRoots ?? []),
    music: new Map(Object.entries(input.music ?? {})),
    folderCovers: new Map(Object.entries(input.folderCovers ?? {})),
  });
}

// An AniList chain whose ids don't follow its start dates: 300 (2019) → 120 (2021) → 450 (2023), and a film after 120.
const S1 = entry('anilist:300', { english: 'Ember Blade', native: '火斬りの剣' }, {
  year: 2019, episodes: 3, runtimeMin: 24, poster: { small: 'https://img.example/s/300.jpg', large: 'https://img.example/l/300.jpg' }, banner: 'https://img.example/b/300.jpg',
  relations: [{ type: 'SEQUEL', id: 'anilist:120', format: 'TV', startDate: 20210407 }],
});
const S2 = entry('anilist:120', { english: 'Ember Blade Season 2', romaji: 'Hinokiri no Ken 2' }, {
  year: 2021,
  relations: [
    { type: 'PREQUEL', id: 'anilist:300', format: 'TV', startDate: 20190405 },
    { type: 'SEQUEL', id: 'anilist:450', format: 'TV', startDate: 20230701 },
    { type: 'SEQUEL', id: 'anilist:500', format: 'MOVIE', startDate: 20220101 },
  ],
});
const S3 = entry('anilist:450', { romaji: 'Hinokiri no Ken: Kanketsu-hen' }, { year: 2023, relations: [{ type: 'PREQUEL', id: 'anilist:120', format: 'TV', startDate: 20210407 }] });
const FILM = entry('anilist:500', { english: 'Ember Blade: Ashfall' }, { kind: 'movie', format: 'MOVIE', year: 2022, relations: [{ type: 'PREQUEL', id: 'anilist:120', format: 'TV', startDate: 20210407 }] });
const HARBOR = entry('tmdb-tv:7', { english: 'Harbor Line' }, { seasons: [1, 2, 3, 4, 5].map((n) => ({ number: n, episodes: 3, runtimeMin: 24 })) });

describe('buildCatalogue', () => {
  const chain = () => build({
    entries: [S3, FILM, S1, S2],
    evidence: [ev('media5/Ember Blade/S1D1'), ev('media5/Ember Blade/S2D1'), ev('media5/Ember Blade/S3D1'), ev('media5/Ember Blade/Ashfall')],
    matches: [
      filed('media5/Ember Blade/S1D1', 'anilist:300', 1, 1),
      filed('media5/Ember Blade/S2D1', 'anilist:120', 2, 1),
      filed('media5/Ember Blade/S3D1', 'anilist:450', 3, 1),
      filed('media5/Ember Blade/Ashfall', 'anilist:500', null, null),
    ],
  });

  it('makes one series of an AniList SEQUEL chain, seasons ordered by start date and labelled by their names', () => {
    const cat = chain();
    const series = cat.titles.filter((t) => t.kind === 'series');
    expect(series.map((t) => t.id)).toEqual(['anilist:300']);
    expect(series[0]).toMatchObject({ seasons: 3, discs: 3, own: false, year: 2019, names: { english: 'Ember Blade', native: '火斬りの剣', display: null } });
    const detail = cat.detail('anilist:300')!;
    expect(detail.seasons.map((s) => [s.number, s.label, s.discs[0]!.copies[0]!.discId])).toEqual([
      [1, 'Ember Blade', id('media5/Ember Blade/S1D1')],
      [2, 'Ember Blade Season 2', id('media5/Ember Blade/S2D1')],
      [3, 'Hinokiri no Ken: Kanketsu-hen', id('media5/Ember Blade/S3D1')],
    ]);
    expect(detail.seasons[0]!.discs[0]).toEqual({ number: 1, label: 'Disc 1', copies: [{ discId: id('media5/Ember Blade/S1D1'), root: 'media5', folder: 'Ember Blade/S1D1', displayName: null }] });
  });

  it('lists a related film under the series and on its own (ruling T7e)', () => {
    const cat = chain();
    expect(cat.titles.find((t) => t.id === 'anilist:500')).toMatchObject({ kind: 'movie', names: { english: 'Ember Blade: Ashfall' } });
    const detail = cat.detail('anilist:300')!;
    expect(detail.related.map((t) => [t.id, t.kind])).toEqual([['anilist:500', 'movie']]);
    const film = cat.detail('anilist:500')!;
    expect(film.seasons).toEqual([{ id: expect.any(String), label: '', number: null, discs: [expect.objectContaining({ copies: [expect.objectContaining({ discId: id('media5/Ember Blade/Ashfall') })] })], episodes: null, extras: [] }]);
  });

  it('lists a film with no series as a movie title', () => {
    const cat = build({ entries: [FILM], evidence: [ev('media5/Ashfall/BD')], matches: [filed('media5/Ashfall/BD', 'anilist:500', null, null)] });
    expect(cat.titles.map((t) => [t.id, t.kind])).toEqual([['anilist:500', 'movie']]);
  });

  it('names a series after its root even when the root is not loaded (ruling T7f)', () => {
    const later = build({
      entries: [S3, S2],
      evidence: [ev('media5/Ember Blade/S2D1'), ev('media5/Ember Blade/S3D1')],
      matches: [filed('media5/Ember Blade/S2D1', 'anilist:120', 2, 1), filed('media5/Ember Blade/S3D1', 'anilist:450', 3, 1)],
    });
    expect(later.titles.map((t) => t.id)).toEqual(['anilist:300']);
    expect(later.provisional).toEqual(['anilist:300']);
    expect(later.detail('anilist:300')!.seasons.map((s) => [s.number, s.label])).toEqual([[2, 'Ember Blade Season 2'], [3, 'Hinokiri no Ken: Kanketsu-hen']]);
    expect(chain().titles.filter((t) => t.kind === 'series').map((t) => t.id)).toEqual(['anilist:300']);
  });

  it('joins a chain across a season that is not loaded, and files an owner\'s season in it', () => {
    const cat = build({
      entries: [S1, S3],
      evidence: [ev('media5/Ember Blade/S1D1'), ev('media5/Ember Blade/S3D1'), ev('media5/Ember Blade/S3D2'), ev('media5/Ember Blade/S2D1')],
      matches: [
        filed('media5/Ember Blade/S1D1', 'anilist:300', 1, 1),
        filed('media5/Ember Blade/S3D1', 'anilist:450', 3, 1),
        { discId: id('media5/Ember Blade/S3D2'), status: 'unsorted', reason: 'no-disc-number', suggestions: [] },
        { discId: id('media5/Ember Blade/S2D1'), status: 'unsorted', reason: 'no-disc-number', suggestions: [] },
      ],
      owner: owner({
        [id('media5/Ember Blade/S3D2')]: { kind: 'title', titleId: 'anilist:300', season: 3, disc: 2 },
        [id('media5/Ember Blade/S2D1')]: { kind: 'title', titleId: 'anilist:300', season: 2, disc: 1 },
      }),
    });
    expect(cat.titles.map((t) => t.id)).toEqual(['anilist:300']);
    // the owner's season wins (ruling T7h): season 2 is the owner's, not invented by the catalogue
    expect(cat.detail('anilist:300')!.seasons.map((s) => [s.number, s.label, s.discs.map((d) => d.number)])).toEqual([
      [1, 'Ember Blade', [1]],
      [2, 'Season 2', [1]],
      [3, 'Hinokiri no Ken: Kanketsu-hen', [1, 2]],
    ]);
    expect(cat.unsorted).toEqual([]);
    expect(cat.provisional).toEqual([]);
  });

  it('numbers a season by the matcher when its chain is not loaded back to the root (ruling T7h)', () => {
    const cat = build({ entries: [S3], evidence: [ev('media5/E/S3D1'), ev('media5/E/S3D2'), ev('media5/E/S3D3')], matches: [
      filed('media5/E/S3D1', 'anilist:450', 3, 1),
      { discId: id('media5/E/S3D2'), status: 'unsorted', reason: 'no-disc-number', suggestions: [] },
      { discId: id('media5/E/S3D3'), status: 'unsorted', reason: 'no-disc-number', suggestions: [] },
    ], owner: owner({
      // the series by a chain id that isn't loaded, and by the root id it will have
      [id('media5/E/S3D2')]: { kind: 'title', titleId: 'anilist:120', season: 3, disc: 2 },
      [id('media5/E/S3D3')]: { kind: 'title', titleId: 'anilist:450', season: 3, disc: 3 },
    }) });
    const [title] = cat.titles;
    expect(cat.provisional).toEqual([title!.id]);
    expect(cat.detail(title!.id)!.seasons.map((s) => [s.number, s.label, s.discs.map((d) => d.number)])).toEqual([[3, 'Hinokiri no Ken: Kanketsu-hen', [1, 2, 3]]]);
  });

  it('reads an owner choice by any chain id as the whole series, keeping its meaning as the chain loads (ruling T7i)', () => {
    const evidence = [ev('media5/E/S3D1'), ev('media5/E/Box Extras'), ev('media5/E/Loose')];
    const input = {
      evidence,
      matches: [
        filed('media5/E/S3D1', 'anilist:450', 3, 1),
        { discId: id('media5/E/Box Extras'), status: 'unsorted', reason: 'no-season', suggestions: [] } as DiscMatch,
        { discId: id('media5/E/Loose'), status: 'unsorted', reason: 'no-season', suggestions: [] } as DiscMatch,
      ],
      owner: owner({
        // saved while only S3 was loaded, when the series' provisional id was anilist:120
        [id('media5/E/Box Extras')]: { kind: 'extras', titleId: 'anilist:120', season: null },
        [id('media5/E/Loose')]: { kind: 'title', titleId: 'anilist:120', season: null, disc: 1 },
      }),
    };
    for (const entries of [[S3], [S1, S2, S3]]) {
      const cat = build({ ...input, entries });
      const detail = cat.detail(cat.titles[0]!.id)!;
      expect(detail.extras.map((d) => d.copies[0]!.discId)).toEqual([id('media5/E/Box Extras')]);
      expect(detail.seasons.map((s) => [s.number, s.extras.length])).toEqual([[3, 0]]);
      expect(cat.unsorted.map((u) => [u.discId, u.reason])).toEqual([[id('media5/E/Loose'), 'no-season']]);
    }
  });

  it('does not depend on the order of the evidence', () => {
    const evidence = [ev('media5/E/S1D1'), ev('media5/E/Y'), ev('media5/E/S3 Bonus'), ev('media5/E/Z')];
    const matches: DiscMatch[] = [
      filed('media5/E/S1D1', 'anilist:300', 1, 1),
      { discId: id('media5/E/Y'), status: 'unsorted', reason: 'no-season', suggestions: [] },
      filed('media5/E/S3 Bonus', 'anilist:450', null, null, true),
      { discId: id('media5/E/Z'), status: 'unsorted', reason: 'no-season', suggestions: [] },
    ];
    const choices = owner({
      [id('media5/E/Y')]: { kind: 'title', titleId: 'anilist:450', season: 5, disc: 1 },
      [id('media5/E/Z')]: { kind: 'title', titleId: 'anilist:450', season: null, disc: 2 },
    });
    const view = (cat: Catalogue): unknown => [cat.titles, cat.detail('anilist:300'), [...cat.unsorted].sort((a, b) => a.discId.localeCompare(b.discId))];
    const forward = build({ entries: [S1, S3], evidence, matches, owner: choices });
    const backward = build({ entries: [S1, S3], evidence: [...evidence].reverse(), matches, owner: choices });
    expect(view(backward)).toEqual(view(forward));
    expect(forward.detail('anilist:300')!.seasons.map((s) => [s.number, s.label])).toEqual([[1, 'Ember Blade'], [5, 'Season 5']]);
  });

  it('counts a chain through a SEQUEL link whose PREQUEL back-link is missing', () => {
    const lone2 = entry('anilist:120', { english: 'Ember Blade Season 2' }, { year: 2021 });
    const cat = build({
      entries: [S1, lone2],
      evidence: [ev('media5/E/S1D1'), ev('media5/E/S2D1')],
      matches: [filed('media5/E/S1D1', 'anilist:300', 1, 1), filed('media5/E/S2D1', 'anilist:120', 2, 1)],
    });
    expect(cat.titles.map((t) => t.id)).toEqual(['anilist:300']);
    expect(cat.detail('anilist:300')!.seasons.map((s) => s.number)).toEqual([1, 2]);
    expect(cat.unsorted).toEqual([]);
    expect(cat.provisional).toEqual([]);
  });

  it('sends a disc whose matcher season disagrees with a whole loaded chain to Unsorted', () => {
    const cat = build({
      entries: [S1, S2, S3],
      evidence: [ev('media5/E/S1D1'), ev('media5/E/S2D1')],
      matches: [filed('media5/E/S1D1', 'anilist:300', 1, 1), filed('media5/E/S2D1', 'anilist:120', 3, 1)],
    });
    expect(cat.detail('anilist:300')!.seasons.map((s) => s.number)).toEqual([1]);
    expect(cat.unsorted.map((u) => [u.discId, u.reason])).toEqual([[id('media5/E/S2D1'), 'no-season']]);
    expect(cat.provisional).toEqual([]);
  });

  it('keeps season ids apart from title ids', () => {
    const detail = chain().detail('anilist:300')!;
    expect(detail.seasons.map((s) => s.id)).not.toContain('anilist:300');
    expect(new Set(detail.seasons.map((s) => s.id)).size).toBe(3);
  });

  it('files an AniList bonus disc without a season in its entry\'s season extras', () => {
    const cat = build({
      entries: [S1, S2],
      evidence: [ev('media5/E/S2D1'), ev('media5/E/S2 Bonus')],
      matches: [filed('media5/E/S2D1', 'anilist:120', 2, 1), filed('media5/E/S2 Bonus', 'anilist:120', null, null, true)],
    });
    const detail = cat.detail('anilist:300')!;
    expect(detail.seasons.map((s) => [s.number, s.extras.map((d) => d.copies[0]!.discId)])).toEqual([[2, [id('media5/E/S2 Bonus')]]]);
    expect(detail.extras).toEqual([]);
  });

  it('ties a film to a series only through story relations', () => {
    const crossover = entry('anilist:600', { english: 'Crossover Night' }, { kind: 'movie', format: 'MOVIE', relations: [{ type: 'CHARACTER', id: 'anilist:300', format: 'TV', startDate: null }] });
    const ova = entry('anilist:601', { english: 'Ember Blade: Hot Springs' }, { format: 'OVA', relations: [{ type: 'SIDE_STORY', id: 'anilist:300', format: 'TV', startDate: null }] });
    const cat = build({
      entries: [S1, crossover, ova],
      evidence: [ev('media5/E/S1D1'), ev('media5/X/Crossover'), ev('media5/E/OVA')],
      matches: [filed('media5/E/S1D1', 'anilist:300', 1, 1), filed('media5/X/Crossover', 'anilist:600', null, null), filed('media5/E/OVA', 'anilist:601', null, null)],
    });
    expect(cat.detail('anilist:300')!.related.map((t) => [t.id, t.kind])).toEqual([['anilist:601', 'movie']]);
    expect(cat.titles.map((t) => t.id)).toEqual(['anilist:300', 'anilist:600', 'anilist:601']);
  });

  it('gives a TMDB TV entry one series with its seasons', () => {
    const cat = build({
      entries: [HARBOR],
      evidence: [ev('media2/Harbor Line S2/D1'), ev('media2/Harbor Line S1/D1'), ev('media2/Harbor Line S1/D2')],
      matches: [filed('media2/Harbor Line S2/D1', 'tmdb-tv:7', 2, 1), filed('media2/Harbor Line S1/D1', 'tmdb-tv:7', 1, 1), filed('media2/Harbor Line S1/D2', 'tmdb-tv:7', 1, 2)],
    });
    expect(cat.titles.map((t) => [t.id, t.kind, t.seasons, t.discs])).toEqual([['tmdb-tv:7', 'series', 2, 3]]);
    expect(cat.detail('tmdb-tv:7')!.seasons.map((s) => [s.number, s.label, s.discs.map((d) => d.number)])).toEqual([[1, 'Season 1', [1, 2]], [2, 'Season 2', [1]]]);
  });

  it('lists two discs filed as the same season and disc as copies of one disc, BDMVs before Downloads', () => {
    const cat = build({
      downloadRoots: ['media1-dl'],
      entries: [HARBOR],
      evidence: [ev('media1-dl/Harbor.Line.S05.BluRay/DISC1'), ev('media7/Harbor Line/Season 5/Disc 1')],
      matches: [filed('media1-dl/Harbor.Line.S05.BluRay/DISC1', 'tmdb-tv:7', 5, 1), filed('media7/Harbor Line/Season 5/Disc 1', 'tmdb-tv:7', 5, 1)],
    });
    const season = cat.detail('tmdb-tv:7')!.seasons[0]!;
    expect(season.discs).toHaveLength(1);
    expect(season.discs[0]!.copies.map((c) => [c.root, c.folder])).toEqual([['media7', 'Harbor Line/Season 5/Disc 1'], ['media1-dl', 'Harbor.Line.S05.BluRay/DISC1']]);
    expect(cat.titles[0]!.discs).toBe(1);
  });

  it('guesses episodes from playlists, and a TheDiscDB hit\'s episodes win over the guess', () => {
    const one = entry('tmdb-tv:8', { english: 'Quiet Orchard' }, { seasons: [{ number: 1, episodes: 3, runtimeMin: 24 }] });
    const disc = ev('media3/Quiet Orchard/D1', { fingerprint: 'FP1', playlists: THREE_EPISODES });
    const input = { entries: [one], evidence: [disc], matches: [filed(disc.path, 'tmdb-tv:8', 1, 1)] };
    const guessed = build(input).detail('tmdb-tv:8')!.seasons[0]!.episodes!;
    expect(guessed.map((e) => [e.number, e.name, e.playlistId])).toEqual([[1, null, '00001'], [2, null, '00002'], [3, null, '00003']]);
    const hit: DiscDbHit = {
      title: 'Quiet Orchard', year: null, kind: 'series', tmdbId: '8', season: 1,
      episodes: [
        { playlist: '00003', season: 1, episode: 1, name: 'Seedlings' },
        { playlist: '00001', season: 1, episode: 2, name: 'Rain' },
        { playlist: '00002', season: 1, episode: 3, name: null },
      ],
    };
    const fromHit = build({ ...input, discdb: { FP1: hit } }).detail('tmdb-tv:8')!.seasons[0]!.episodes!;
    expect(fromHit).toEqual([
      { number: 1, name: 'Seedlings', runtimeMin: 24, discId: disc.discId, playlistId: '00003' },
      { number: 2, name: 'Rain', runtimeMin: 24, discId: disc.discId, playlistId: '00001' },
      { number: 3, name: null, runtimeMin: 24, discId: disc.discId, playlistId: '00002' },
    ]);
  });

  it('hides the Episodes tab when the guess does not add up', () => {
    const cat = build({ entries: [HARBOR], evidence: [ev('media2/H/D1', { playlists: THREE_EPISODES.slice(0, 2) })], matches: [filed('media2/H/D1', 'tmdb-tv:7', 1, 1)] });
    expect(cat.detail('tmdb-tv:7')!.seasons[0]!.episodes).toBeNull();
  });

  it('puts a bonus disc with a known season in that season\'s extras, and one without in the title\'s', () => {
    const cat = build({
      entries: [HARBOR],
      evidence: [ev('media2/Harbor Line S2/D1'), ev('media2/Harbor Line S2/Bonus'), ev('media2/Harbor Line/Extras')],
      matches: [filed('media2/Harbor Line S2/D1', 'tmdb-tv:7', 2, 1), filed('media2/Harbor Line S2/Bonus', 'tmdb-tv:7', 2, null, true), filed('media2/Harbor Line/Extras', 'tmdb-tv:7', null, null, true)],
    });
    const detail = cat.detail('tmdb-tv:7')!;
    expect(detail.seasons).toHaveLength(1);
    expect(detail.seasons[0]!.discs.map((d) => d.copies[0]!.discId)).toEqual([id('media2/Harbor Line S2/D1')]);
    expect(detail.seasons[0]!.extras.map((d) => d.copies[0]!.discId)).toEqual([id('media2/Harbor Line S2/Bonus')]);
    expect(detail.extras.map((d) => d.copies[0]!.discId)).toEqual([id('media2/Harbor Line/Extras')]);
  });

  it('makes music titles of music matches, grouped by release folder', () => {
    const live = 'Music/[2024.05.01] Fictive Band - Night Tour [CD+BD]';
    const cat = build({
      evidence: [ev(`media1-dl/${live}/BD1`), ev(`media1-dl/${live}/BD2`), ev('media1-dl/Music/Other Group - Spring/BDMV')],
      matches: [
        { discId: id(`media1-dl/${live}/BD1`), status: 'music', group: live, name: '[2024.05.01] Fictive Band - Night Tour [CD+BD]' },
        { discId: id(`media1-dl/${live}/BD2`), status: 'music', group: live, name: '[2024.05.01] Fictive Band - Night Tour [CD+BD]' },
        { discId: id('media1-dl/Music/Other Group - Spring/BDMV'), status: 'music', group: 'Music/Other Group - Spring', name: 'Other Group - Spring' },
      ],
      owner: owner({}, [], {}),
    });
    const music = cat.titles.filter((t) => t.kind === 'music');
    expect(music).toHaveLength(2);
    expect(music.every((t) => /^music:[0-9a-f]+$/.test(t.id) && t.poster === null)).toBe(true);
    const tour = music.find((t) => t.names.english === '[2024.05.01] Fictive Band - Night Tour [CD+BD]')!;
    expect(tour.discs).toBe(2);
    const detail = cat.detail(tour.id)!;
    expect(detail.seasons.map((s) => [s.number, s.label, s.discs.length, s.episodes])).toEqual([[null, '', 2, null]]);
  });

  it('shows a music title\'s display name', () => {
    const group = 'Music/Other Group - Spring';
    const disc = ev(`media1-dl/${group}/BDMV`);
    const input = { evidence: [disc], matches: [{ discId: disc.discId, status: 'music', group, name: 'Other Group - Spring' } as DiscMatch] };
    const musicId = build(input).titles[0]!.id;
    expect(build({ ...input, owner: owner({}, [], { [musicId]: 'Spring Live' }) }).titles[0]!.names.display).toBe('Spring Live');
  });

  it('lets an owner choice override a match', () => {
    const cat = build({
      entries: [S1, HARBOR],
      evidence: [ev('media5/Mixed/D3')],
      matches: [filed('media5/Mixed/D3', 'anilist:300', 1, 1)],
      owner: owner({ [id('media5/Mixed/D3')]: { kind: 'title', titleId: 'tmdb-tv:7', season: 2, disc: 3 } }),
    });
    expect(cat.titles.map((t) => t.id)).toEqual(['tmdb-tv:7']);
    expect(cat.detail('tmdb-tv:7')!.seasons.map((s) => [s.number, s.discs.map((d) => [d.number, d.label])])).toEqual([[2, [[3, 'Disc 3']]]]);
    expect(cat.detail('anilist:300')).toBeNull();
  });

  it('files an owner choice by season number within an AniList series', () => {
    const cat = build({
      entries: [S1, S2, S3],
      evidence: [ev('media5/E/A'), ev('media5/E/B')],
      matches: [filed('media5/E/A', 'anilist:300', 1, 1), { discId: id('media5/E/B'), status: 'unsorted', reason: 'no-season', suggestions: ['anilist:300'] }],
      owner: owner({ [id('media5/E/B')]: { kind: 'title', titleId: 'anilist:300', season: 3, disc: 2 } }),
    });
    expect(cat.detail('anilist:300')!.seasons.map((s) => [s.number, s.discs.map((d) => d.number)])).toEqual([[1, [1]], [3, [2]]]);
  });

  it('removes a hidden disc from every title and lists it in hidden', () => {
    const cat = build({
      entries: [HARBOR],
      evidence: [ev('media2/Harbor Line S1/D1'), ev('media2/Harbor Line S1/D2')],
      matches: [filed('media2/Harbor Line S1/D1', 'tmdb-tv:7', 1, 1), filed('media2/Harbor Line S1/D2', 'tmdb-tv:7', 1, 2)],
      owner: owner({ [id('media2/Harbor Line S1/D2')]: { kind: 'hidden' } }, [], { [id('media2/Harbor Line S1/D2')]: 'Sample disc' }),
    });
    expect(cat.detail('tmdb-tv:7')!.seasons[0]!.discs.map((d) => d.number)).toEqual([1]);
    expect(cat.hidden).toEqual([{ discId: id('media2/Harbor Line S1/D2'), root: 'media2', folder: 'Harbor Line S1/D2', displayName: 'Sample disc' }]);
    expect(cat.unsorted).toEqual([]);
  });

  it('lists an own title with own: true and no poster', () => {
    const tapes: OwnTitle = { id: 'own:5f0c', kind: 'movie', name: 'Garden Tapes', seasons: null };
    const cat = build({
      evidence: [ev('media0/Home/Garden')],
      matches: [{ discId: id('media0/Home/Garden'), status: 'unsorted', reason: 'no-title', suggestions: [] }],
      owner: owner({ [id('media0/Home/Garden')]: { kind: 'title', titleId: 'own:5f0c', season: null, disc: null } }, [tapes]),
    });
    expect(cat.titles).toEqual([{
      id: 'own:5f0c', kind: 'movie', names: { english: null, romaji: null, native: null, synonyms: [], display: 'Garden Tapes' },
      poster: null, year: null, seasons: 0, discs: 1, addedAt: 0, own: true,
    }]);
    expect(cat.detail('own:5f0c')!.seasons[0]!.discs[0]!.copies[0]!.discId).toBe(id('media0/Home/Garden'));
    expect(cat.unsorted).toEqual([]);
  });

  it('keeps a disc filed under an entry that is not loaded yet in Unsorted', () => {
    const cat = build({
      evidence: [ev('media5/Later/D1')],
      matches: [{ discId: id('media5/Later/D1'), status: 'unsorted', reason: 'several-fit', suggestions: [] }],
      owner: owner({ [id('media5/Later/D1')]: { kind: 'title', titleId: 'anilist:999', season: null, disc: 1 } }),
    });
    expect(cat.titles).toEqual([]);
    expect(cat.unsorted.map((u) => [u.discId, u.reason])).toEqual([[id('media5/Later/D1'), 'no-title']]);
  });

  it('lists Unsorted discs with their reason, suggestions, folder group and catalogue number', () => {
    const cat = build({
      entries: [S2, HARBOR],
      evidence: [
        ev('media5/Mystery Box/D1', { discTitles: [{ lang: 'jpn', name: '謎の箱' }], catalogueNumbers: ['ABCD-1234'] }),
        ev('media5/Mystery Box/D2'),
      ],
      matches: [
        { discId: id('media5/Mystery Box/D1'), status: 'unsorted', reason: 'several-fit', suggestions: ['anilist:120', 'tmdb-tv:7', 'anilist:404'] },
        filed('media5/Mystery Box/D2', 'tmdb-tv:7', 1, 2),
      ],
    });
    expect(cat.unsorted).toEqual([{
      discId: id('media5/Mystery Box/D1'), path: 'media5/Mystery Box/D1', discTitles: [{ lang: 'jpn', name: '謎の箱' }], reason: 'several-fit',
      suggestions: [expect.objectContaining({ id: 'anilist:120', names: expect.objectContaining({ english: 'Ember Blade Season 2' }) }), expect.objectContaining({ id: 'tmdb-tv:7' })],
      catalogueNumber: 'ABCD-1234', group: 'media5/Mystery Box', groupSize: 2,
    }]);
  });

  it('gives titles art ids, never source URLs, and maps them back', () => {
    const cat = chain();
    const json = JSON.stringify([cat.titles, cat.detail('anilist:300')]);
    expect(json).not.toContain('img.example');
    const title = cat.titles.find((t) => t.id === 'anilist:300')!;
    expect(cat.art(title.poster!)).toEqual({ small: 'https://img.example/s/300.jpg', large: 'https://img.example/l/300.jpg' });
    expect(cat.art(cat.detail('anilist:300')!.banner!)).toEqual({ small: 'https://img.example/b/300.jpg', large: 'https://img.example/b/300.jpg' });
    expect(cat.art('nope')).toBeNull();
  });

  it('dates a title by its newest disc', () => {
    const cat = build({
      entries: [HARBOR],
      evidence: [ev('media2/H/D1'), ev('media2/H/D2')],
      matches: [filed('media2/H/D1', 'tmdb-tv:7', 1, 1), filed('media2/H/D2', 'tmdb-tv:7', 1, 2)],
      addedAt: { [id('media2/H/D1')]: 1000, [id('media2/H/D2')]: 5000 },
    });
    expect(cat.titles[0]!.addedAt).toBe(5000);
  });

  it('orders copies on Downloads roots last by the roots given, not by their names', () => {
    const cat = build({
      downloadRoots: ['media1'],
      entries: [HARBOR],
      evidence: [ev('media1/Harbor/S1D1'), ev('media7/Harbor/S1D1')],
      matches: [filed('media1/Harbor/S1D1', 'tmdb-tv:7', 1, 1), filed('media7/Harbor/S1D1', 'tmdb-tv:7', 1, 1)],
    });
    expect(cat.detail('tmdb-tv:7')!.seasons[0]!.discs[0]!.copies.map((c) => c.root)).toEqual(['media7', 'media1']);
  });

  it('takes a TheDiscDB episode from a copy that has its playlist, and drops one no copy has', () => {
    const one = entry('tmdb-tv:8', { english: 'Quiet Orchard' }, { seasons: [{ number: 1, episodes: 3, runtimeMin: 24 }] });
    const main = ev('media3/Quiet Orchard/D1', { fingerprint: 'FP1', playlists: [pl('00001', 24, ['00001'])] });
    const copy = ev('media3-dl/Quiet.Orchard/D1', { fingerprint: 'FP2', playlists: [pl('00001', 24, ['00001']), pl('00009', 25, ['00009'])] });
    const hit: DiscDbHit = {
      title: 'Quiet Orchard', year: null, kind: 'series', tmdbId: '8', season: 1,
      episodes: [{ playlist: '00001', season: 1, episode: 1, name: null }, { playlist: '00009', season: 1, episode: 2, name: null }, { playlist: '00042', season: 1, episode: 3, name: null }],
    };
    const cat = build({
      downloadRoots: ['media3-dl'], entries: [one], evidence: [copy, main], discdb: { FP1: hit },
      matches: [filed(main.path, 'tmdb-tv:8', 1, 1), filed(copy.path, 'tmdb-tv:8', 1, 1)],
    });
    expect(cat.detail('tmdb-tv:8')!.seasons[0]!.episodes!.map((e) => [e.number, e.discId, e.playlistId, e.runtimeMin])).toEqual([
      [1, main.discId, '00001', 24],
      [2, copy.discId, '00009', 25],
    ]);
  });

  it('guesses the whole season when only some discs have a TheDiscDB hit', () => {
    const two = entry('tmdb-tv:9', { english: 'Paper Lanterns' }, { seasons: [{ number: 1, episodes: 6, runtimeMin: 24 }] });
    const d1 = ev('media3/Paper Lanterns/D1', { fingerprint: 'FPA', playlists: THREE_EPISODES });
    const d2 = ev('media3/Paper Lanterns/D2', { fingerprint: 'FPB', playlists: THREE_EPISODES });
    const hit: DiscDbHit = { title: 'Paper Lanterns', year: null, kind: 'series', tmdbId: '9', season: 1, episodes: [{ playlist: '00003', season: 1, episode: 1, name: 'Wick' }] };
    const cat = build({ entries: [two], evidence: [d1, d2], discdb: { FPA: hit }, matches: [filed(d1.path, 'tmdb-tv:9', 1, 1), filed(d2.path, 'tmdb-tv:9', 1, 2)] });
    expect(cat.detail('tmdb-tv:9')!.seasons[0]!.episodes!.map((e) => [e.number, e.name, e.discId, e.playlistId])).toEqual([
      [1, null, d1.discId, '00001'], [2, null, d1.discId, '00002'], [3, null, d1.discId, '00003'],
      [4, null, d2.discId, '00001'], [5, null, d2.discId, '00002'], [6, null, d2.discId, '00003'],
    ]);
  });

  it('sends a season past a TMDB entry\'s or an own series\' seasons to Unsorted', () => {
    const saga: OwnTitle = { id: 'own:7a', kind: 'series', name: 'Home Saga', seasons: 2 };
    const cat = build({
      entries: [HARBOR],
      evidence: [ev('media2/Harbor/S6D1'), ev('media0/Saga/S3')],
      matches: [filed('media2/Harbor/S6D1', 'tmdb-tv:7', 6, 1), { discId: id('media0/Saga/S3'), status: 'unsorted', reason: 'no-title', suggestions: [] }],
      owner: owner({ [id('media0/Saga/S3')]: { kind: 'title', titleId: 'own:7a', season: 3, disc: 1 } }, [saga]),
    });
    expect(cat.unsorted.map((u) => [u.discId, u.reason])).toEqual([[id('media2/Harbor/S6D1'), 'no-season'], [id('media0/Saga/S3'), 'no-season']]);
    expect(cat.detail('own:7a')!.seasons.map((s) => [s.number, s.discs.length])).toEqual([[1, 0], [2, 0]]);
  });

  it('files an "extras of" choice in the season or title it names', () => {
    const cat = build({
      entries: [HARBOR],
      evidence: [ev('media2/Harbor/S2D1'), ev('media2/Harbor/Making Of'), ev('media2/Harbor/Interviews')],
      matches: [
        filed('media2/Harbor/S2D1', 'tmdb-tv:7', 2, 1),
        { discId: id('media2/Harbor/Making Of'), status: 'unsorted', reason: 'no-season', suggestions: [] },
        { discId: id('media2/Harbor/Interviews'), status: 'unsorted', reason: 'no-season', suggestions: [] },
      ],
      owner: owner({
        [id('media2/Harbor/Making Of')]: { kind: 'extras', titleId: 'tmdb-tv:7', season: 2 },
        [id('media2/Harbor/Interviews')]: { kind: 'extras', titleId: 'tmdb-tv:7', season: null },
      }),
    });
    const detail = cat.detail('tmdb-tv:7')!;
    expect(detail.seasons[0]!.extras.map((d) => d.copies[0]!.discId)).toEqual([id('media2/Harbor/Making Of')]);
    expect(detail.extras.map((d) => d.copies[0]!.discId)).toEqual([id('media2/Harbor/Interviews')]);
    expect(cat.unsorted).toEqual([]);
  });

  it('returns the discs of a deleted own title to Unsorted', () => {
    const cat = build({
      evidence: [ev('media0/Home/Garden')],
      matches: [{ discId: id('media0/Home/Garden'), status: 'unsorted', reason: 'no-title', suggestions: [] }],
      owner: owner({ [id('media0/Home/Garden')]: { kind: 'title', titleId: 'own:deleted', season: null, disc: null } }),
    });
    expect(cat.titles).toEqual([]);
    expect(cat.unsorted.map((u) => [u.discId, u.reason])).toEqual([[id('media0/Home/Garden'), 'no-title']]);
  });

  it('groups discs the owner marks as Music by their release folder', () => {
    const release = 'Fictive Band - Night Tour [CD][FLAC+BDMV]';
    const discs = [ev('media4-dl/Live/Concert A'), ev('media4-dl/Live/Concert B'), ev(`media4-dl/Live/${release}/BD1`), ev(`media4-dl/Live/${release}/BD2`)];
    const cat = build({
      evidence: discs,
      matches: discs.map((e) => ({ discId: e.discId, status: 'unsorted', reason: 'no-title', suggestions: [] }) as DiscMatch),
      owner: owner(Object.fromEntries(discs.map((e) => [e.discId, { kind: 'music', name: null } as OwnerChoice]))),
    });
    expect(cat.titles.map((t) => [t.names.english, t.discs]).sort()).toEqual([['Concert A', 1], ['Concert B', 1], [release, 2]]);
  });

  it('takes a music title\'s name from a choice on any of its discs first, which follows the disc (M8), else the title\'s display name', () => {
    const group = 'Music/Other Group - Spring';
    const bd1 = ev(`media1-dl/${group}/BD1`);
    const bd2 = ev(`media1-dl/${group}/BD2`);
    const matches: DiscMatch[] = [bd1, bd2].map((e) => ({ discId: e.discId, status: 'music', group, name: 'Other Group - Spring' }));
    const choices = { [bd2.discId]: { kind: 'music', name: 'Renamed' } as OwnerChoice };
    const cat = build({ evidence: [bd1, bd2], matches, owner: owner(choices) });
    expect(cat.titles.map((t) => [t.names.display, t.discs])).toEqual([['Renamed', 2]]);
    const named = build({ evidence: [bd1, bd2], matches, owner: owner(choices, [], { [cat.titles[0]!.id]: 'Spring Live' }) });
    expect(named.titles[0]!.names.display).toBe('Renamed');
    const titleOnly = build({ evidence: [bd1, bd2], matches, owner: owner({}, [], { [cat.titles[0]!.id]: 'Spring Live' }) });
    expect(titleOnly.titles[0]!.names.display).toBe('Spring Live');
  });

  describe('final review', () => {
    it("I2: each suggestion carries a season hint: the matcher's, else the evidence's, else the entry's chain place", () => {
      const solo = entry('anilist:900', { english: 'Starfall Wanderer' }, { kind: 'movie', format: 'MOVIE' });
      const cat = build({
        entries: [S1, S2, S3, HARBOR, solo],
        evidence: [ev('media5/Box/D1'), ev('media5/Harbor Line Season 3/D1'), ev('media5/Mixed/D1')],
        matches: [
          { discId: id('media5/Box/D1'), status: 'unsorted', reason: 'no-disc-number', suggestions: ['anilist:120'], seasons: { 'anilist:120': 2 } },
          { discId: id('media5/Harbor Line Season 3/D1'), status: 'unsorted', reason: 'several-fit', suggestions: ['tmdb-tv:7', 'anilist:900'] },
          { discId: id('media5/Mixed/D1'), status: 'unsorted', reason: 'sources-disagree', suggestions: ['anilist:450', 'tmdb-tv:7'] },
        ],
      });
      const hints = (path: string): [string, number | null][] => cat.unsorted.find((u) => u.path === path)!.suggestions.map((t) => [t.id, t.seasonHint]);
      expect(hints('media5/Box/D1')).toEqual([['anilist:120', 2]]);
      expect(hints('media5/Harbor Line Season 3/D1')).toEqual([['tmdb-tv:7', 3], ['anilist:900', null]]);
      expect(hints('media5/Mixed/D1')).toEqual([['anilist:450', 3], ['tmdb-tv:7', null]]);
    });

    it('M7: a series is found by any season\'s names', () => {
      const series = chain().titles.find((t) => t.id === 'anilist:300')!;
      expect(series.names.english).toBe('Ember Blade');
      expect(series.names.synonyms).toEqual(expect.arrayContaining(['Ember Blade Season 2', 'Hinokiri no Ken 2', 'Hinokiri no Ken: Kanketsu-hen']));
      expect(series.names.synonyms).not.toContain('Ember Blade');
    });

    it('M9: works out chain places with a precomputed prequel map, not a scan of every entry per link', () => {
      // counted, not timed: reads of an entry's relations. A scan per chain link reads every TV entry's relations at each
      // step (about entries × chain length × entries / 2, millions here); the precomputed map reads each a few times.
      const chains = 50;
      const length = 20;
      const entries: Entry[] = [];
      const evidence: DiscEvidence[] = [];
      const matches: DiscMatch[] = [];
      let reads = 0;
      for (let c = 0; c < chains; c++) {
        for (let k = 0; k < length; k++) {
          const n = 10_000 + c * 100 + k;
          const en = entry(`anilist:${n}`, { english: `Saga ${c} Part ${k + 1}` }, { year: 2000 + k });
          const relations: Entry['relations'] = [
            ...(k > 0 ? [{ type: 'PREQUEL', id: `anilist:${n - 1}`, format: 'TV', startDate: null }] : []),
            ...(k < length - 1 ? [{ type: 'SEQUEL', id: `anilist:${n + 1}`, format: 'TV', startDate: null }] : []),
          ];
          Object.defineProperty(en, 'relations', { enumerable: true, get: () => (reads++, relations) });
          entries.push(en);
          const path = `media1/Saga ${c}/P${k + 1}`;
          evidence.push(ev(path));
          matches.push(filed(path, `anilist:${n}`, k + 1, 1));
        }
      }
      const cat = build({ entries, evidence, matches });
      expect(cat.titles).toHaveLength(chains);
      expect(cat.detail('anilist:10000')!.seasons).toHaveLength(length);
      expect(reads).toBeLessThan(20 * entries.length);
    });

    it('M11: TheDiscDB episodes past the season\'s episode count are not used under it', () => {
      const one = entry('anilist:77', { english: 'Quiet Orchard' }, { episodes: 3, runtimeMin: 24 });
      const disc = ev('media3/Quiet Orchard/D1', { fingerprint: 'FP1', playlists: THREE_EPISODES });
      const hit: DiscDbHit = {
        title: 'Quiet Orchard', year: null, kind: 'series', tmdbId: '8', season: 1,
        episodes: [
          { playlist: '00001', season: 1, episode: 13, name: 'Later' },
          { playlist: '00002', season: 1, episode: 14, name: 'Later still' },
          { playlist: '00003', season: 1, episode: 15, name: null },
        ],
      };
      const cat = build({ entries: [one], evidence: [disc], matches: [filed(disc.path, 'anilist:77', 1, 1)], discdb: { FP1: hit } });
      expect(cat.detail('anilist:77')!.seasons[0]!.episodes!.map((e) => [e.number, e.name])).toEqual([[1, null], [2, null], [3, null]]);
    });
  });
});

describe('buildCatalogue: music releases', () => {
  const GROUP = 'Music/[2024.05.01] Lantern Parade - Night Lights [CD]';
  const lantern = (more: Partial<MusicArtist> = {}): MusicArtist => ({ id: 'mb-lantern', name: 'Lantern Parade', sortName: 'Lantern Parade', aliases: [], ...more });
  const release = (more: Partial<MusicRelease> = {}): MusicRelease => ({
    source: 'musicbrainz', id: 'rel-1', title: 'Night Lights (Tour Edition)', date: '2024-05-01', artists: [lantern()], primaryType: 'Album',
    secondaryTypes: ['Live'], live: true, cover: { small: 'https://coverartarchive.org/release/rel-1/front-250', large: 'https://coverartarchive.org/release/rel-1/front-500' }, ...more,
  });
  const COVER: FolderCover = { path: '/mnt/music/Lantern/cover.jpg', size: 1234, mtimeMs: 1_700_000_000_000 };
  const disc = (name: string, catalogueNumbers: string[], group = GROUP): DiscEvidence => ev(`media1/${group}/${name}`, { catalogueNumbers });
  const musicMatch = (e: DiscEvidence, group = GROUP): DiscMatch => ({ discId: e.discId, status: 'music', group, name: group.slice(group.lastIndexOf('/') + 1) });
  const one = (more: { music?: Record<string, MusicRelease | null>; folderCovers?: Record<string, FolderCover | null>; choice?: OwnerChoice } = {}) => {
    const bd = disc('BD', ['ZQCL-2468']);
    const cat = build({ evidence: [bd], matches: [musicMatch(bd)], owner: owner(more.choice ? { [bd.discId]: more.choice } : {}), music: more.music, folderCovers: more.folderCovers });
    return { cat, title: cat.titles[0]! };
  };

  it('gives a music title its music info from the lookup and the lookup cover as its poster', () => {
    const { cat, title } = one({ music: { 'ZQCL-2468': release() } });
    expect(title.music).toEqual({
      artist: { id: 'mb-lantern', name: 'Lantern Parade', otherName: null }, kind: 'concert', date: '2024-05-01', concertName: null,
      title: 'Night Lights (Tour Edition)', matched: true, rejected: false,
    });
    expect(title.poster).toBe(artIdOf(release().cover!));
    expect(cat.art(title.poster!)).toEqual(release().cover);
  });

  it('takes the folder cover first, served by its file, and its art id changes with the file', () => {
    const { cat, title } = one({ music: { 'ZQCL-2468': release() }, folderCovers: { [GROUP]: COVER } });
    expect(title.poster).toBe(artIdOf({ small: `file:${COVER.path}#${COVER.size}:${COVER.mtimeMs}`, large: `file:${COVER.path}#${COVER.size}:${COVER.mtimeMs}` }));
    expect(cat.art(title.poster!)).toEqual({ file: COVER.path });
    expect(one({ folderCovers: { [GROUP]: { ...COVER, mtimeMs: COVER.mtimeMs + 1 } } }).title.poster).not.toBe(title.poster);
    expect(one({ folderCovers: { [GROUP]: { ...COVER, size: 99 } } }).title.poster).not.toBe(title.poster);
  });

  it('has no poster without a folder cover or a lookup cover, and parses the folder without a lookup', () => {
    const { title } = one({ music: { 'ZQCL-2468': null } });
    expect(title.poster).toBeNull();
    expect(title.music).toMatchObject({ artist: { id: 'name:lantern parade', name: 'Lantern Parade', otherName: null }, title: 'Night Lights', date: '2024-05-01', matched: false });
  });

  it('drops the lookup and its cover when the owner rejected the match', () => {
    const choice: OwnerChoice = { kind: 'music', name: null, rejectMatch: true };
    const { cat, title } = one({ music: { 'ZQCL-2468': release() }, choice });
    expect(title.music).toMatchObject({ title: 'Night Lights', matched: false, rejected: true, artist: { id: 'name:lantern parade' } });
    expect(title.poster).toBeNull();
    expect(cat.art(artIdOf(release().cover!))).toBeNull();
    expect(one({ music: { 'ZQCL-2468': release() }, folderCovers: { [GROUP]: COVER }, choice }).cat.art(one({ folderCovers: { [GROUP]: COVER } }).title.poster!)).toEqual({ file: COVER.path });
  });

  it('lets the owner\'s artist win over the lookup', () => {
    const { title } = one({ music: { 'ZQCL-2468': release() }, choice: { kind: 'music', name: null, artist: 'Neon Harbor' } });
    expect(title.music!.artist).toEqual({ id: 'name:neon harbor', name: 'Neon Harbor', otherName: null });
    expect(title.music!.matched).toBe(true);
  });

  it('speaks for a release with the first disc, in path order, whose lookup hit', () => {
    const bd1 = disc('BD1', ['ZQCL-1111']);
    const bd2 = disc('BD2', ['ZQCL-2222']);
    const bd10 = disc('BD10', ['ZQCL-1010']);
    const music = { 'ZQCL-1111': null, 'ZQCL-2222': release({ title: 'Second' }), 'ZQCL-1010': release({ title: 'Tenth' }) };
    const cat = build({ evidence: [bd10, bd2, bd1], matches: [bd10, bd2, bd1].map((e) => musicMatch(e)), music });
    expect(cat.titles[0]!.music!.title).toBe('Second');
  });

  it('R4: joins a name-only artist to a looked-up artist whose name or alias is the same name', () => {
    const hoshino = lantern({ id: 'mb-hoshino', name: '星野あおい', sortName: 'Hoshino, Aoi', aliases: [{ name: 'Aoi Hoshino', locale: 'ja-Latn', primary: true }] });
    const looked = disc('BD', ['ZQCL-3001'], 'Music/星野あおい - Blue Hour');
    const byAlias = disc('BD', [], 'Music/Aoi Hoshino - Paper Moon');
    const byName = disc('BD', [], 'Music/星野あおい - Harbor Lights');
    const other = disc('BD', [], 'Music/Neon Harbor - Tide');
    const cat = build({
      evidence: [looked, byAlias, byName, other],
      matches: [musicMatch(looked, 'Music/星野あおい - Blue Hour'), musicMatch(byAlias, 'Music/Aoi Hoshino - Paper Moon'), musicMatch(byName, 'Music/星野あおい - Harbor Lights'), musicMatch(other, 'Music/Neon Harbor - Tide')],
      music: { 'ZQCL-3001': release({ title: 'Blue Hour', artists: [hoshino] }) },
    });
    const artistOf = (t: string) => cat.titles.find((x) => x.music!.title === t)!.music!.artist;
    const joined = { id: 'mb-hoshino', name: 'Aoi Hoshino', otherName: '星野あおい' };
    expect(artistOf('Blue Hour')).toEqual(joined);
    expect(artistOf('Paper Moon')).toEqual(joined);
    expect(artistOf('Harbor Lights')).toEqual(joined);
    expect(artistOf('Tide')).toEqual({ id: 'name:neon harbor', name: 'Neon Harbor', otherName: null });
  });
});
