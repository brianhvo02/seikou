import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discDbKind, indexDisc, loadDiscDb, mergeIndex } from './discdb';
import type { DiscDbHit } from './discdb';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'discdb-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const series: DiscDbHit = {
  title: 'Starfall Wanderer',
  year: 2023,
  kind: 'series',
  tmdbId: '990101',
  season: 1,
  episodes: [
    { playlist: '00001', season: 1, episode: 1, name: 'The First Star' },
    { playlist: '00002', season: 1, episode: 2, name: null },
  ],
};
const movie: DiscDbHit = { title: 'Lanternfall', year: 2019, kind: 'movie', tmdbId: null, season: null, episodes: [] };

describe('loadDiscDb', () => {
  it('finds both discs of a two-entry index and nothing else', () => {
    const file = join(tmp, 'index.json');
    writeFileSync(
      file,
      JSON.stringify({ source: { repo: 'https://github.com/TheDiscDb/data', commit: 'abc', license: 'MIT' }, discs: { '0123456789ABCDEF0123456789ABCDEF': series, FEDCBA9876543210FEDCBA9876543210: movie } }),
    );
    const db = loadDiscDb(file);
    expect(db.lookup('0123456789ABCDEF0123456789ABCDEF')).toEqual(series);
    expect(db.lookup('fedcba9876543210fedcba9876543210')).toEqual(movie);
    expect(db.lookup('00000000000000000000000000000000')).toBeNull();
    expect(db.lookup('__proto__')).toBeNull();
  });

  it('throws for a missing file, a corrupt one and JSON that is not an index', () => {
    expect(() => loadDiscDb(join(tmp, 'missing.json'))).toThrow();
    writeFileSync(join(tmp, 'corrupt.json'), '{"source":');
    expect(() => loadDiscDb(join(tmp, 'corrupt.json'))).toThrow();
    writeFileSync(join(tmp, 'other.json'), '[1, 2]');
    expect(() => loadDiscDb(join(tmp, 'other.json'))).toThrow('not a TheDiscDB index');
  });
});

describe('indexDisc', () => {
  const metadata = { Title: 'Starfall Wanderer', FullTitle: 'Starfall Wanderer (TV Series 2023– )', Type: 'Series', Year: 2023, ExternalIds: { Tmdb: '990101' } };
  const disc = {
    Index: 1,
    Name: 'Disc 1',
    Format: 'Blu-Ray',
    ContentHash: '0123456789abcdef0123456789abcdef',
    Titles: [
      { SourceFile: '00001.mpls', Item: { Title: 'The First Star', Type: 'Episode', Season: '1', Episode: '1' } },
      { SourceFile: '00002.MPLS', Item: { Title: '', Type: 'Episode', Season: '1', Episode: '2' } },
      { SourceFile: '00003.mpls', Item: { Title: 'Trailer', Type: 'Extra' } },
      { SourceFile: '00004.mpls' },
      { SourceFile: '00005.mpls', Item: { Type: 'Episode', Season: 'x', Episode: '3' } },
    ],
  };

  it('keeps the hash, title, year, kind, TMDB id and mapped episodes', () => {
    expect(indexDisc(disc, metadata)).toEqual({ hash: '0123456789ABCDEF0123456789ABCDEF', hit: series });
  });

  it('names the title by Title, falling back to FullTitle', () => {
    expect(indexDisc(disc, { ...metadata, FullTitle: '星降りの旅人' })?.hit.title).toBe('Starfall Wanderer');
    expect(indexDisc(disc, { ...metadata, Title: '' })?.hit.title).toBe('Starfall Wanderer (TV Series 2023– )');
    expect(indexDisc(disc, { ...metadata, Title: undefined, FullTitle: undefined })).toBeNull();
  });

  it('leaves out a title whose Type is neither Series nor Movie', () => {
    expect(indexDisc(disc, { ...metadata, Type: 'Set' })).toBeNull();
    expect(indexDisc(disc, { ...metadata, Type: undefined })).toBeNull();
    expect(discDbKind({ Type: 'Movie' })).toBe('movie');
    expect(discDbKind({ Type: 'Series' })).toBe('series');
    expect(discDbKind(null)).toBeNull();
  });

  it('gives a disc spanning seasons no season', () => {
    const two = { ...disc, Titles: [disc.Titles[0], { SourceFile: '00009.mpls', Item: { Type: 'Episode', Season: '2', Episode: '1' } }] };
    expect(indexDisc(two, metadata)?.hit.season).toBeNull();
  });

  it('leaves out DVDs, discs without a hash and the hash of no files', () => {
    expect(indexDisc({ ...disc, Format: 'DVD' }, metadata)).toBeNull();
    expect(indexDisc({ ...disc, ContentHash: null }, metadata)).toBeNull();
    expect(indexDisc({ ...disc, ContentHash: 'd41d8cd98f00b204e9800998ecf8427e' }, metadata)).toBeNull();
    expect(indexDisc(null, metadata)).toBeNull();
  });

  it('reads a movie', () => {
    const hit = indexDisc({ Format: 'UHD', ContentHash: 'FEDCBA9876543210FEDCBA9876543210', Titles: [{ SourceFile: '00800.mpls', Item: { Type: 'MainMovie' } }] }, { Title: 'Lanternfall', Type: 'Movie', Year: 2019 });
    expect(hit).toEqual({ hash: 'FEDCBA9876543210FEDCBA9876543210', hit: movie });
  });
});

describe('mergeIndex', () => {
  it('keeps one record per hash when they agree and drops a hash whose records disagree', () => {
    const other: DiscDbHit = { ...series, title: 'Some Other Series', tmdbId: '5' };
    const merged = mergeIndex([
      { hash: 'A', hit: series },
      { hash: 'A', hit: { ...series, episodes: [] } },
      { hash: 'B', hit: series },
      { hash: 'B', hit: other },
      { hash: 'C', hit: movie },
    ]);
    expect(merged).toEqual({ discs: { A: series, C: movie }, conflicts: 1 });
  });
});
