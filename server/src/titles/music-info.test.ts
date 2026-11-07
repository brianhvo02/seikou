import { describe, expect, it } from 'vitest';
import { normalizeTitle } from '@seikou/nas/title-text';
import type { DiscEvidence } from './evidence';
import { artistKey, musicInfo, VARIOUS_ID } from './music-info';
import { VARIOUS_ARTISTS_MBID, type MusicArtist, type MusicRelease } from './music-sources';

const ev = (...names: string[]): DiscEvidence[] => [{ discTitles: names.map((name) => ({ lang: 'eng', name })) } as unknown as DiscEvidence];
const artist = (over: Partial<MusicArtist> = {}): MusicArtist => ({ id: 'mb-1', name: 'Lantern Parade', sortName: 'Lantern Parade', aliases: [], ...over });
const release = (over: Partial<MusicRelease> = {}): MusicRelease => ({ source: 'musicbrainz', id: 'r1', title: 'Night Lights', date: '2021-06-02', artists: [artist()], primaryType: 'Album', secondaryTypes: [], live: false, cover: null, ...over });
const base = { releaseFolder: '[2021.06.02] Lantern Parade - Night Lights [CD]', parentFolder: 'Music', evidence: ev(), lookup: null, ownerArtist: null, rejectMatch: false };

describe('musicInfo', () => {
  it('uses the lookup', () => {
    const m = musicInfo({ ...base, lookup: release({ title: 'Night Lights (Deluxe)', date: '2021' }) });
    expect(m).toMatchObject({ title: 'Night Lights (Deluxe)', date: '2021', matched: true, rejected: false, artist: { id: 'mb-1', name: 'Lantern Parade', otherName: null } });
  });
  it('headline is the Latin name', () => {
    const jp = (a: Partial<MusicArtist>) => musicInfo({ ...base, lookup: release({ artists: [artist({ name: '星野あおい', ...a })] }) }).artist;
    expect(jp({ aliases: [{ name: 'Aoi Hoshino', locale: 'ja-Latn', primary: true }] })).toMatchObject({ name: 'Aoi Hoshino', otherName: '星野あおい' });
    expect(jp({ sortName: 'Hoshino, Aoi' })).toMatchObject({ name: 'Aoi Hoshino', otherName: '星野あおい' });
    expect(jp({ name: 'Aoi Hoshino', sortName: 'Hoshino, Aoi' })).toMatchObject({ name: 'Aoi Hoshino', otherName: null });
  });
  it('various artists', () => {
    const v = musicInfo({ ...base, lookup: release({ artists: [artist({ id: VARIOUS_ARTISTS_MBID, name: 'Various Artists' })] }) });
    expect(v.artist).toEqual({ id: VARIOUS_ID, name: 'Various artists', otherName: null });
    expect(musicInfo({ ...base, lookup: release({ secondaryTypes: ['Soundtrack'] }) }).artist.id).toBe('various');
    expect(musicInfo({ ...base, lookup: release({ secondaryTypes: ['Compilation'] }) }).artist.id).toBe('various');
  });
  it('owner artist wins', () => {
    const a = musicInfo({ ...base, lookup: release(), ownerArtist: 'Neon Harbor' }).artist;
    expect(a).toMatchObject({ id: 'name:' + artistKey('Neon Harbor'), name: 'Neon Harbor' });
    expect(musicInfo({ ...base, lookup: release(), ownerArtist: 'various' }).artist.id).toBe('various');
    expect(musicInfo({ ...base, lookup: release(), ownerArtist: 'Various artists' }).artist.id).toBe('various');
  });
  it('a lookup crediting Various from any source is Various artists', () => {
    expect(musicInfo({ ...base, lookup: release({ source: 'discogs', artists: [artist({ id: '194', name: 'Various' })] }) }).artist.id).toBe('various');
  });
  it('rejectMatch ignores the lookup', () => {
    const m = musicInfo({ ...base, lookup: release({ title: 'Other', live: true }), rejectMatch: true });
    expect(m).toMatchObject({ title: 'Night Lights', matched: false, rejected: true, kind: 'other', artist: { name: 'Lantern Parade', id: 'name:lantern parade' } });
  });
  it('kind', () => {
    const k = (o: object) => musicInfo({ ...base, ...o }).kind;
    expect(k({ lookup: release({ live: true }) })).toBe('concert');
    expect(k({ evidence: ev('Lantern Parade Live 2019') })).toBe('concert');
    expect(k({ releaseFolder: 'Lantern Parade - Summer Tour' })).toBe('concert');
    expect(k({ lookup: release({ primaryType: 'Single' }) })).toBe('single');
    expect(k({ releaseFolder: 'Lantern Parade - Dawn (Single)' })).toBe('single');
    expect(k({ lookup: release({ primaryType: 'Album' }), releaseFolder: 'Lantern Parade - Dawn (Single)' })).toBe('album');
    expect(k({ lookup: release({ primaryType: 'EP' }) })).toBe('album');
    expect(k({ lookup: release({ primaryType: 'Album' }) })).toBe('album');
    expect(k({ lookup: release({ primaryType: null }) })).toBe('other');
  });
  it('concert name from the disc', () => {
    expect(musicInfo({ ...base, lookup: release(), evidence: ev('Lantern Parade Hall Tour 2019') }).concertName).toBe('Lantern Parade Hall Tour 2019');
    expect(musicInfo({ ...base, lookup: release(), evidence: ev('NIGHT LIGHTS') }).concertName).toBeNull();
    expect(normalizeTitle('NIGHT LIGHTS')).toBe(normalizeTitle('Night Lights'));
  });
  it('normalized names group together', () => {
    expect(artistKey('ＬＡＮＴＥＲＮ　Parade')).toBe(artistKey('lantern parade'));
    expect(artistKey('ミナト・楽団')).toBe(artistKey('ミナト 楽団'));
  });
  it('a title that parses empty falls back to the release folder, then the disc folder', () => {
    expect(musicInfo({ ...base, releaseFolder: '[ZQCL-2468]' }).title).toBe('[ZQCL-2468]');
    expect(musicInfo({ ...base, releaseFolder: '[ZQCL-2468]', lookup: release({ title: '  ' }) }).title).toBe('[ZQCL-2468]');
    const disc = [{ discTitles: [], path: 'Music/ /Lantern Parade Live Disc' } as unknown as DiscEvidence];
    expect(musicInfo({ ...base, releaseFolder: ' ', evidence: disc }).title).toBe('Lantern Parade Live Disc');
  });
  it('no lookup and no artist goes to Various artists', () => {
    const f = 'Paper Lanterns Hall Concert 2018';
    expect(musicInfo({ ...base, releaseFolder: f, parentFolder: 'Music' }).artist.id).toBe('various');
    expect(musicInfo({ ...base, releaseFolder: f, parentFolder: 'Paper Lanterns' }).artist).toMatchObject({ name: 'Paper Lanterns', id: 'name:paper lanterns' });
    expect(musicInfo({ ...base, releaseFolder: f, parentFolder: null }).artist.id).toBe('various');
  });
});
