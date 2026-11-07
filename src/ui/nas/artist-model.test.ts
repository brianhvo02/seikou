import { describe, expect, it } from 'vitest';
import type { MusicKind, TitleMusic, TitleSummary } from '@seikou/nas/nas-api';
import { artistChoice, artistCount, artistIndex, artistNames, collagePosters, artistSections, groupArtists, releaseName, releaseYear, searchArtists } from './artist-model';
import { englishKey, kanaRow } from './title-index';
import { displayName } from './title-model';

// Every artist and release here is made up.

type Artist = TitleMusic['artist'];
const LANTERN: Artist = { id: 'mb-lantern', name: 'Lantern Parade', otherName: null };
const AOI: Artist = { id: 'mb-aoi', name: 'Aoi Hoshino', otherName: '星野あおい' };
const NEON: Artist = { id: 'name:neon harbor', name: 'Neon Harbor', otherName: null };
const VARIOUS: Artist = { id: 'various', name: 'Various artists', otherName: null };

function release(id: string, artist: Artist, title: string, o: { kind?: MusicKind; date?: string | null; concertName?: string | null; display?: string | null; poster?: string | null } = {}): TitleSummary {
  return {
    id,
    kind: 'music',
    names: { english: `[folder] ${title}`, romaji: null, native: null, synonyms: [], display: o.display ?? null },
    poster: o.poster ?? null,
    year: null,
    seasons: 1,
    discs: 1,
    addedAt: 0,
    own: false,
    music: { artist, kind: o.kind ?? 'album', date: o.date === undefined ? null : o.date, concertName: o.concertName ?? null, title, matched: true, rejected: false },
  };
}

const NIGHT = release('m:1', LANTERN, 'Night Lights', { kind: 'concert', date: '2024-05-01' });
const DAWN = release('m:2', LANTERN, 'Dawn Chorus', { date: '2021' });
const STARS = release('m:3', AOI, 'Star Letters', { kind: 'single', date: '2023-05' });
const MIX = release('m:4', VARIOUS, 'Harbor Mix');
const NEON1 = release('m:5', NEON, 'Glass Tide');
const ALL = [MIX, NIGHT, STARS, DAWN, NEON1];

describe('groupArtists', () => {
  it('puts releases with the same artist id on one tile, A–Z, Various artists last', () => {
    const groups = groupArtists(ALL);
    expect(groups.map((g) => g.id)).toEqual(['mb-aoi', 'mb-lantern', 'name:neon harbor', 'various']);
    const lantern = groups.find((g) => g.id === 'mb-lantern')!;
    expect(lantern.releases.map((r) => r.id).sort()).toEqual(['m:1', 'm:2']);
    expect(lantern.name).toBe('Lantern Parade');
  });

  it('indexes an artist by its headline and other-script names', () => {
    const aoi = groupArtists(ALL).find((g) => g.id === 'mb-aoi')!;
    expect(aoi.otherName).toBe('星野あおい');
    expect(displayName(aoi.index)).toBe('Aoi Hoshino');
    expect(englishKey(aoi.index)).toBe('A');
    expect(kanaRow(aoi.index)).toBe('あ');
  });

  it('puts a title without music info under Various artists', () => {
    const own: TitleSummary = { ...release('own:1', LANTERN, 'x'), names: { english: null, romaji: null, native: null, synonyms: [], display: 'Live Tape' }, own: true, music: undefined };
    const groups = groupArtists([own, NIGHT]);
    expect(groups.map((g) => g.id)).toEqual(['mb-lantern', 'various']);
    expect(groups[1]!.name).toBe('Various artists');
  });
});

describe('artistIndex', () => {
  it('keeps Various artists last in both orders, so its jump key follows the others', () => {
    const zephyr = release('m:20', { id: 'name:zephyr band', name: 'Zephyr Band', otherName: null }, 'Gale');
    const groups = groupArtists([...ALL, zephyr]);
    expect(artistIndex(groups, 'en').map((t) => t.id).at(-1)).toBe('artist:various');
    const ja = artistIndex(groups, 'ja').map((t) => t.id);
    expect(ja.at(-1)).toBe('artist:various');
    expect(ja).toContain('artist:name:zephyr band');
    expect(ja).toHaveLength(groups.length);
  });
});

describe('artistSections', () => {
  it('sorts concerts, albums and singles, and other, newest first and undated last', () => {
    const undated = release('m:6', AOI, 'Paper Moon');
    const old = release('m:7', AOI, 'First Light', { date: '2021' });
    const live = release('m:8', AOI, 'Hall Show', { kind: 'concert', date: '2022-01-02' });
    const other = release('m:9', AOI, 'Odds', { kind: 'other' });
    const g = groupArtists([undated, old, STARS, live, other])[0]!;
    const s = artistSections(g);
    expect(s.albums.map((r) => r.id)).toEqual(['m:3', 'm:7', 'm:6']);
    expect(s.concerts.map((r) => r.id)).toEqual(['m:8']);
    expect(s.other.map((r) => r.id)).toEqual(['m:9']);
  });
});

describe('searchArtists', () => {
  const groups = groupArtists(ALL);
  it('finds an artist by its name and other name', () => {
    expect(searchArtists(groups, 'aoi').map((g) => g.id)).toEqual(['mb-aoi']);
    expect(searchArtists(groups, '星野').map((g) => g.id)).toEqual(['mb-aoi']);
  });
  it('finds an artist by a release title', () => {
    expect(searchArtists(groups, 'night lights').map((g) => g.id)).toEqual(['mb-lantern']);
  });
  it('matches nothing on a blank query', () => {
    expect(searchArtists(groups, '  ')).toEqual([]);
  });
});

describe('release labels', () => {
  it('shows the concert name only for a concert (ruling R5)', () => {
    expect(releaseName(release('a', LANTERN, 'Night Lights', { kind: 'concert', concertName: 'Harbor Hall 2024' }))).toBe('Harbor Hall 2024');
    expect(releaseName(release('b', LANTERN, 'Dawn Chorus', { kind: 'album', concertName: 'Disc Title' }))).toBe('Dawn Chorus');
    expect(releaseName(release('c', LANTERN, 'Night Lights', { kind: 'concert' }))).toBe('Night Lights');
  });
  it('an empty release title falls through to the folder name', () => {
    expect(releaseName({ ...release('a', LANTERN, ''), names: { english: '[ZQCL-2468]', romaji: null, native: null, synonyms: [], display: null } })).toBe('[ZQCL-2468]');
    expect(releaseName({ ...release('b', LANTERN, ''), names: { english: null, romaji: 'Kagami', native: null, synonyms: [], display: null } })).toBe('Kagami');
  });
  it("an owner's rename wins", () => {
    expect(releaseName(release('a', LANTERN, 'Night Lights', { kind: 'concert', concertName: 'Hall', display: 'Reel Session' }))).toBe('Reel Session');
  });
  it('the year is the first four digits of the date', () => {
    expect(releaseYear(NIGHT)).toBe('2024');
    expect(releaseYear(MIX)).toBeNull();
  });
  it('counts releases', () => {
    const [aoi, lantern] = groupArtists(ALL);
    expect(artistCount(aoi!)).toBe('1 release');
    expect(artistCount(lantern!)).toBe('2 releases');
  });
  it('lists the artist names for the Set artist picker, Various artists last', () => {
    expect(artistNames(groupArtists(ALL))).toEqual(['Aoi Hoshino', 'Lantern Parade', 'Neon Harbor', 'Various artists']);
  });
  it('sends various for Various artists and null for a blank', () => {
    expect(artistChoice(' Various Artists ')).toBe('various');
    expect(artistChoice('various')).toBe('various');
    expect(artistChoice('  ')).toBeNull();
    expect(artistChoice(' Neon Harbor ')).toBe('Neon Harbor');
  });
  it('takes up to four posters, newest release first', () => {
    const rs = ['2020', '2021', '2022', '2023', '2024'].map((d, i) => release(`p:${i}`, NEON, `R${i}`, { date: d, poster: `art${i}` }));
    const g = groupArtists([...rs, release('p:x', NEON, 'None')])[0]!;
    expect(collagePosters(g)).toEqual(['art4', 'art3', 'art2', 'art1']);
  });
});
