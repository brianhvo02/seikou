// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chapterName,
  EpisodeInfoError,
  EpisodeInfoStore,
  isChecked,
  migrateRecordChapters,
  parseEpisodeInfo,
  titlesSignature,
  type EpisodeInfo,
} from '../../src/plan/episode-info';
import type { RecordEpisode, SubtitleRecord } from '../../src/subs/record';

const KEY = `f.${'AB'.repeat(16)}`;

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'episode-info-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe('EpisodeInfoStore', () => {
  it('saves and reads back, stamping savedAt', async () => {
    const store = new EpisodeInfoStore(dataDir);
    expect(await store.read(KEY, '00000')).toBeNull();
    const before = Date.now();
    const saved = await store.save(KEY, '00000', {
      chapterNames: { '1': 'Avant', '2': 'Opening' },
      titles: { '1': { title: { source: 'anilist', anilistId: 990001 }, episode: 1, name: 'Starfall' } },
    });
    expect(Date.parse(saved.savedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(saved.chapterNames).toEqual({ '1': 'Avant', '2': 'Opening' });
    const file = join(dataDir, 'chapters', KEY, '00000.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(saved);
    expect(await store.read(KEY, '00000')).toEqual(saved);
    expect(await store.read(KEY, '00001')).toBeNull();
  });

  it('refuses a bad name, key or number', () => {
    const good = { chapterNames: { '1': 'Opening' }, titles: { '1': { title: { source: 'anilist', anilistId: 1 }, episode: 1, name: null } } };
    expect(parseEpisodeInfo(good)).toEqual(good);
    const bad: unknown[] = [
      { ...good, chapterNames: { '0': 'Opening' } },
      { ...good, chapterNames: { '01': 'Opening' } },
      { ...good, chapterNames: { '1': '   ' } },
      { ...good, titles: { '1': { title: { source: 'anilist', anilistId: 1 }, episode: 0, name: null } } },
      { ...good, titles: { '1': { title: { source: 'anilist', anilistId: 1.5 }, episode: 1, name: null } } },
    ];
    for (const value of bad) {
      let caught: unknown;
      try {
        parseEpisodeInfo(value);
      } catch (e) {
        caught = e;
      }
      expect(caught, JSON.stringify(value)).toBeInstanceOf(EpisodeInfoError);
      expect((caught as EpisodeInfoError).code).toBe('bad-info');
    }
  });

  it('trims names and refuses long or control-character names, long titles and too many entries', () => {
    expect(parseEpisodeInfo({ chapterNames: { '3': '  Part A ' }, titles: {} }).chapterNames).toEqual({ '3': 'Part A' });
    const refused = [
      { chapterNames: { '1': 'x'.repeat(101) }, titles: {} },
      { chapterNames: { '1': 'Open\u0007ing' }, titles: {} },
      { chapterNames: {}, titles: { '1': { title: { source: 'anilist', anilistId: 1 }, episode: 1, name: 'x'.repeat(301) } } },
      { chapterNames: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i + 1), 'Part A'])), titles: {} },
      { chapterNames: [], titles: {} },
      null,
    ];
    for (const value of refused) expect(() => parseEpisodeInfo(value)).toThrow(EpisodeInfoError);
  });

  it('an unreadable file is info-unreadable', async () => {
    const dir = join(dataDir, 'chapters', KEY);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '00000.json'), '{');
    await expect(new EpisodeInfoStore(dataDir).read(KEY, '00000')).rejects.toMatchObject({ code: 'info-unreadable' });
  });
});

describe('older info files', () => {
  it('reads the AniList form as AniList titles and saves it in the new form', async () => {
    const dir = join(dataDir, 'chapters', KEY);
    mkdirSync(dir, { recursive: true });
    const old = { chapterNames: { '1': 'Opening' }, anilist: { '1': { anilistId: 990001, episode: 2, title: 'Starfall' } }, savedAt: '2026-11-09T00:00:00.000Z' };
    writeFileSync(join(dir, '00000.json'), JSON.stringify(old));
    const store = new EpisodeInfoStore(dataDir);
    const read = await store.read(KEY, '00000');
    expect(read).toEqual({
      chapterNames: { '1': 'Opening' },
      titles: { '1': { title: { source: 'anilist', anilistId: 990001 }, episode: 2, name: 'Starfall' } },
      savedAt: old.savedAt,
    });
    const saved = await store.save(KEY, '00000', read!);
    const onDisk = JSON.parse(readFileSync(join(dir, '00000.json'), 'utf8'));
    expect(onDisk).toEqual(saved);
    expect(onDisk).not.toHaveProperty('anilist');
    expect(await store.read(KEY, '00000')).toEqual(saved);
  });
});

describe('episode titles', () => {
  it('keeps each kind of title and refuses a malformed one', () => {
    const own = '12345678-1234-1234-1234-123456789abc';
    const titles = {
      '1': { title: { source: 'tmdb-tv', tmdbId: 990101, season: 1 }, episode: 1, name: null },
      '3': { title: { source: 'tmdb-movie', tmdbId: 990102 }, episode: 1, name: 'Film' },
      '5': { title: { source: 'own', ownId: own, season: null }, episode: 1, name: null },
    };
    expect(parseEpisodeInfo({ chapterNames: {}, titles }).titles).toEqual(titles);
    const refused = [
      { source: 'tmdb-tv', tmdbId: 990101 },
      { source: 'tmdb-movie', tmdbId: 0 },
      { source: 'own', ownId: 'not-a-uuid', season: null },
      { source: 'own', ownId: own },
      { source: 'other', tmdbId: 1 },
    ];
    for (const title of refused) expect(() => parseEpisodeInfo({ chapterNames: {}, titles: { '1': { title, episode: 1, name: null } } })).toThrow(EpisodeInfoError);
  });
});

describe('chapterName', () => {
  it('returns the stored name for a chapter and null for one without', () => {
    const info: EpisodeInfo = { chapterNames: { '4': 'Ending' }, titles: {}, savedAt: '2026-11-09T00:00:00.000Z' };
    expect(chapterName(info, 4)).toBe('Ending');
    expect(chapterName(info, 3)).toBeNull();
    expect(chapterName(null, 4)).toBeNull();
  });
});

describe('migrateRecordChapters', () => {
  const episode = (index: number, chapters: string[]): RecordEpisode => ({
    index,
    title: `Episode ${index}`,
    tracks: [],
    metadata: { title: '', video: { name: '', language: 'und' }, audio: [], chapters },
  });
  const record = (episodes: RecordEpisode[]): SubtitleRecord => ({
    disc: { key: KEY, label: 'Starfall Wanderer' },
    playlist: '00000',
    episodeSpec: '1-3,4-6',
    anilist: null,
    releases: [],
    fonts: [],
    episodes,
    savedAt: '2026-11-01T00:00:00.000Z',
  });

  it('maps episode-local names onto playlist chapters', () => {
    const r = record([episode(1, ['Chapter 1', 'Chapter 2', 'Chapter 3']), episode(2, ['Opening', '', 'Ending'])]);
    expect(migrateRecordChapters(null, r, '1-3,4-6', 6)).toEqual({ chapterNames: { '4': 'Opening', '6': 'Ending' }, titles: {} });
  });

  it('keeps the names already in info, and its AniList choices', () => {
    const info: EpisodeInfo = {
      chapterNames: { '4': 'Avant' },
      titles: { '4': { title: { source: 'anilist', anilistId: 990001 }, episode: 2, name: null } },
      savedAt: '2026-11-02T00:00:00.000Z',
    };
    const r = record([episode(2, ['Opening', '', 'Ending'])]);
    expect(migrateRecordChapters(info, r, '1-3,4-6', 6)).toEqual({ chapterNames: { '4': 'Avant', '6': 'Ending' }, titles: info.titles });
    // every name already there: nothing to move
    expect(migrateRecordChapters({ ...info, chapterNames: { '4': 'Avant', '6': 'Preview' } }, r, '1-3,4-6', 6)).toBeNull();
  });

  it('a record with no real names gives null', () => {
    const r = record([episode(1, ['Chapter 1', ' ', 'Chapter 7']), episode(2, [])]);
    expect(migrateRecordChapters(null, r, '1-3,4-6', 6)).toBeNull();
  });
});

describe('checked mark', () => {
  const titles = { '1': { title: { source: 'anilist', anilistId: 990001 }, episode: 1, name: null } } as const;
  const info = (checked?: EpisodeInfo['checked'], t: EpisodeInfo['titles'] = titles): EpisodeInfo => ({
    chapterNames: {},
    titles: t,
    ...(checked === undefined ? {} : { checked }),
    savedAt: '2026-11-10T00:00:00.000Z',
  });
  const mark = (spec: string, t: EpisodeInfo['titles'] = titles): NonNullable<EpisodeInfo['checked']> => ({ episodeSpec: spec, signature: titlesSignature(t), at: '2026-11-10T01:00:00.000Z' });

  it('signs the titles map the same whatever the key order', () => {
    const a = { '1': { title: { source: 'anilist', anilistId: 1 }, episode: 1, name: 'x' } } as const;
    const b = { '1': { name: 'x', episode: 1, title: { anilistId: 1, source: 'anilist' } } } as unknown as EpisodeInfo['titles'];
    expect(titlesSignature(a)).toBe(titlesSignature(b));
    expect(titlesSignature(a)).not.toBe(titlesSignature({ '1': { ...a['1'], episode: 2 } }));
  });

  it('is checked only for the marked list and titles', () => {
    expect(isChecked(null, '1-3', 12)).toBe(false);
    expect(isChecked(info(), '1-3', 12)).toBe(false);
    expect(isChecked(info(mark('1-3,4-')), '1-3,4-', 12)).toBe(true);
    expect(isChecked(info(mark('1-3,4-')), '1-3,4-12', 12)).toBe(true);
    expect(isChecked(info(mark('1-3,4-')), '1-4,5-', 12)).toBe(false);
    const changed = { '1': { ...titles['1'], episode: 2 } };
    expect(isChecked(info(mark('1-3'), changed), '1-3', 12)).toBe(false);
  });

  it('is written and read with the file, validated', async () => {
    const store = new EpisodeInfoStore(dataDir);
    const saved = await store.save(KEY, '00000', { chapterNames: {}, titles, checked: mark('1-3') });
    expect((await store.read(KEY, '00000'))?.checked).toEqual(mark('1-3'));
    expect(saved.checked).toEqual(mark('1-3'));
    expect(() => parseEpisodeInfo({ chapterNames: {}, titles: {}, checked: { episodeSpec: '', signature: '', at: 'x' } })).toThrow(EpisodeInfoError);
    expect(() => parseEpisodeInfo({ chapterNames: {}, titles: {}, checked: 3 })).toThrow(EpisodeInfoError);
  });
});
