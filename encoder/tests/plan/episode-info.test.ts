// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chapterName,
  EpisodeInfoError,
  EpisodeInfoStore,
  migrateRecordChapters,
  parseEpisodeInfo,
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
      anilist: { '1': { anilistId: 990001, episode: 1, title: 'Starfall' } },
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
    const good = { chapterNames: { '1': 'Opening' }, anilist: { '1': { anilistId: 1, episode: 1, title: null } } };
    expect(parseEpisodeInfo(good)).toEqual(good);
    const bad: unknown[] = [
      { ...good, chapterNames: { '0': 'Opening' } },
      { ...good, chapterNames: { '01': 'Opening' } },
      { ...good, chapterNames: { '1': '   ' } },
      { ...good, anilist: { '1': { anilistId: 1, episode: 0, title: null } } },
      { ...good, anilist: { '1': { anilistId: 1.5, episode: 1, title: null } } },
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
    expect(parseEpisodeInfo({ chapterNames: { '3': '  Part A ' }, anilist: {} }).chapterNames).toEqual({ '3': 'Part A' });
    const refused = [
      { chapterNames: { '1': 'x'.repeat(101) }, anilist: {} },
      { chapterNames: { '1': 'Open\u0007ing' }, anilist: {} },
      { chapterNames: {}, anilist: { '1': { anilistId: 1, episode: 1, title: 'x'.repeat(301) } } },
      { chapterNames: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i + 1), 'Part A'])), anilist: {} },
      { chapterNames: [], anilist: {} },
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

describe('chapterName', () => {
  it('returns the stored name for a chapter and null for one without', () => {
    const info: EpisodeInfo = { chapterNames: { '4': 'Ending' }, anilist: {}, savedAt: '2026-11-09T00:00:00.000Z' };
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
    expect(migrateRecordChapters(null, r, '1-3,4-6', 6)).toEqual({ chapterNames: { '4': 'Opening', '6': 'Ending' }, anilist: {} });
  });

  it('keeps the names already in info, and its AniList choices', () => {
    const info: EpisodeInfo = {
      chapterNames: { '4': 'Avant' },
      anilist: { '4': { anilistId: 990001, episode: 2, title: null } },
      savedAt: '2026-11-02T00:00:00.000Z',
    };
    const r = record([episode(2, ['Opening', '', 'Ending'])]);
    expect(migrateRecordChapters(info, r, '1-3,4-6', 6)).toEqual({ chapterNames: { '4': 'Avant', '6': 'Ending' }, anilist: info.anilist });
    // every name already there: nothing to move
    expect(migrateRecordChapters({ ...info, chapterNames: { '4': 'Avant', '6': 'Preview' } }, r, '1-3,4-6', 6)).toBeNull();
  });

  it('a record with no real names gives null', () => {
    const r = record([episode(1, ['Chapter 1', ' ', 'Chapter 7']), episode(2, [])]);
    expect(migrateRecordChapters(null, r, '1-3,4-6', 6)).toBeNull();
  });
});
