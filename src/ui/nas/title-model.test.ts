import { describe, expect, it } from 'vitest';
import type { DiscSlot, SeasonDetail, TitleDetail, TitleKind, TitleNames, TitleSummary } from '@seikou/nas/nas-api';
import { copiesLabel, discHeading, displayName, emptyLibraryText, episodeMeta, initials, recentlyAdded, searchTitles, seasonCounts, seasonLabel, secondaryName, shelf, titleMeta } from './title-model';

// Every title here is made up (ruling R4).

function title(id: string, kind: TitleKind, names: Partial<TitleNames>, addedAt = 0): TitleSummary {
  return {
    id,
    kind,
    names: { english: null, romaji: null, native: null, synonyms: [], display: null, ...names },
    poster: null,
    year: null,
    seasons: kind === 'series' ? 1 : 0,
    discs: 1,
    addedAt,
    own: false,
  };
}

const STARFALL = title('a:1', 'series', { english: 'Starfall Wanderer', romaji: 'Hoshifuri no Tabibito', native: '星降りの旅人' }, 30);
const EMBER = title('a:2', 'series', { english: 'Ember Blade', romaji: 'Hinokiri no Ken', native: '火斬りの剣' }, 10);
const HARBOR = title('a:3', 'movie', { english: 'Moonlit Harbor', native: '月影の港' }, 20);
const LANTERN = title('m:1', 'music', { english: 'Lantern Parade Live 2024' }, 40);
const FALLING = title('a:4', 'series', { english: 'After the Starfall', synonyms: ['Atosuta'] }, 5);
const ALL = [STARFALL, EMBER, HARBOR, LANTERN, FALLING];

describe('searchTitles', () => {
  it('finds Starfall Wanderer by its English, romaji and Japanese names', () => {
    expect(searchTitles(ALL, 'starfall').map((t) => t.id)).toContain('a:1');
    expect(searchTitles(ALL, 'hoshifuri').map((t) => t.id)).toEqual(['a:1']);
    expect(searchTitles(ALL, '星降り').map((t) => t.id)).toEqual(['a:1']);
  });

  it('puts prefix matches before substring matches', () => {
    expect(searchTitles(ALL, 'starfall').map((t) => t.id)).toEqual(['a:1', 'a:4']);
  });

  it('searches synonyms and display names', () => {
    expect(searchTitles(ALL, 'atosuta').map((t) => t.id)).toEqual(['a:4']);
    const renamed = title('m:2', 'music', { english: 'Disc folder name', display: 'Summer Tour' });
    expect(searchTitles([renamed], 'summer tour').map((t) => t.id)).toEqual(['m:2']);
  });

  it('finds a music release by its release title, concert name and artist names', () => {
    const rel: TitleSummary = {
      ...title('m:3', 'music', { english: '[ZQCL-2468]' }),
      music: { artist: { id: 'mb-aoi', name: 'Aoi Hoshino', otherName: '星野あおい' }, kind: 'concert', date: null, concertName: 'Harbor Hall 2024', title: 'Night Lights', matched: true, rejected: false },
    };
    for (const q of ['night lights', 'harbor hall', 'aoi hoshino', '星野']) expect(searchTitles([rel], q).map((t) => t.id)).toEqual(['m:3']);
  });

  it('finds nothing for a blank query', () => {
    expect(searchTitles(ALL, '  ')).toEqual([]);
  });
});

describe('shelf', () => {
  it('lists one kind, A–Z by the displayed name', () => {
    expect(shelf(ALL, 'series').map((t) => t.id)).toEqual(['a:4', 'a:2', 'a:1']);
    expect(shelf(ALL, 'movie').map((t) => t.id)).toEqual(['a:3']);
    expect(shelf(ALL, 'music').map((t) => t.id)).toEqual(['m:1']);
  });
});

describe('recentlyAdded', () => {
  it('lists the newest first, at most n', () => {
    expect(recentlyAdded(ALL, 3).map((t) => t.id)).toEqual(['m:1', 'a:1', 'a:3']);
    expect(recentlyAdded(ALL)).toHaveLength(5);
  });
});

describe('names', () => {
  it('displayName prefers display, then English, romaji and native', () => {
    expect(displayName(title('x', 'music', { english: 'Folder', display: 'Shown' }))).toBe('Shown');
    const music = { ...title('x', 'music', { english: '[2024.05.01] Lantern Parade - Night Lights [CD]' }), music: { artist: { id: 'a', name: 'Lantern Parade', otherName: null }, kind: 'concert' as const, date: null, concertName: null, title: 'Night Lights', matched: true, rejected: false } };
    expect(displayName(music)).toBe('Night Lights');
    expect(displayName({ ...music, names: { ...music.names, display: 'Shown' } })).toBe('Shown');
    expect(displayName({ ...music, music: { ...music.music, title: '' } })).toBe('[2024.05.01] Lantern Parade - Night Lights [CD]');
    expect(displayName(STARFALL)).toBe('Starfall Wanderer');
    expect(displayName(title('x', 'series', { romaji: 'Hoshifuri no Tabibito', native: '星降りの旅人' }))).toBe('Hoshifuri no Tabibito');
    expect(displayName(title('x', 'series', { native: '星降りの旅人' }))).toBe('星降りの旅人');
  });

  it('secondaryName is the native name when it differs', () => {
    expect(secondaryName(STARFALL)).toBe('星降りの旅人');
    expect(secondaryName(title('x', 'series', { native: '星降りの旅人' }))).toBeNull();
    expect(secondaryName(LANTERN)).toBeNull();
  });

  it('initials stand in for a missing poster', () => {
    expect(initials('Starfall Wanderer')).toBe('SW');
    expect(initials('Lantern Parade Live 2024')).toBe('LP');
    expect(initials('星降りの旅人')).toBe('星');
  });
});

const slot = (number: number, ...discIds: string[]): DiscSlot => ({ number, label: `Disc ${number}`, copies: discIds.map((discId) => ({ discId, root: 'media1', folder: `Anime/${discId}`, displayName: null })) });
const SEASON: SeasonDetail = {
  id: 'a:1#s1',
  label: 'Starfall Wanderer',
  number: 1,
  discs: [slot(1, 'd1', 'd1b'), slot(2, 'd2')],
  episodes: [
    { number: 1, name: null, runtimeMin: 24, discId: 'd1', playlistId: '00001' },
    { number: 2, name: null, runtimeMin: 24, discId: 'd1', playlistId: '00002' },
    { number: 3, name: null, runtimeMin: 0, discId: 'd2', playlistId: '00001' },
  ],
  extras: [],
};

describe('labels', () => {
  it('names and counts a season', () => {
    expect(seasonLabel(SEASON)).toBe('Season 1');
    expect(seasonLabel({ ...SEASON, number: null, label: 'Specials' })).toBe('Specials');
    expect(seasonCounts(SEASON)).toBe('3 episodes · 2 discs');
    expect(seasonCounts({ ...SEASON, episodes: null, discs: [slot(1, 'd1')] })).toBe('1 disc');
  });

  it('describes episodes, disc cards and copies', () => {
    expect(episodeMeta(SEASON, SEASON.episodes![0]!)).toBe('24 min · Disc 1');
    expect(episodeMeta(SEASON, SEASON.episodes![2]!)).toBe('Disc 2');
    expect(discHeading(SEASON, SEASON.discs[0]!)).toBe('Disc 1 · Episodes 1–2');
    expect(discHeading(SEASON, SEASON.discs[1]!)).toBe('Disc 2 · Episode 3');
    expect(discHeading({ ...SEASON, episodes: null }, SEASON.discs[1]!)).toBe('Disc 2');
    expect(copiesLabel(SEASON.discs[0]!)).toBe('2 copies');
    expect(copiesLabel(SEASON.discs[1]!)).toBeNull();
  });

  it('sums up a series: kind, years, seasons and movies', () => {
    const detail: TitleDetail = {
      title: { ...STARFALL, year: 2016 },
      banner: null,
      seasons: [SEASON, { ...SEASON, id: 'a:1#s2', number: 2 }],
      related: [{ ...HARBOR, year: 2023 }],
      extras: [],
    };
    expect(titleMeta(detail)).toBe('TV · 2016–2023 · 2 seasons, 1 movie');
    expect(titleMeta({ ...detail, title: { ...HARBOR, year: 2019 }, seasons: [], related: [] })).toBe('Movie · 2019');
  });
});

describe('emptyLibraryText', () => {
  it('tells owners how far matching is, and guests that the library is being prepared (ruling F4)', () => {
    expect(emptyLibraryText(true, { running: true, groupsDone: 12, groupsTotal: 340 })).toBe('Matching your library… 12 of 340 folders');
    expect(emptyLibraryText(true, { running: false, groupsDone: 0, groupsTotal: 0 })).toBe('No titles yet. The NAS files discs under titles after each scan.');
    expect(emptyLibraryText(true, null)).toBe('No titles yet. The NAS files discs under titles after each scan.');
    expect(emptyLibraryText(false, null)).toBe('The library is being prepared');
  });
});
