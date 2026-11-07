// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appDataDir } from '../../src/subs/app-data';
import { RecordError, RecordStore, parseRecord, type SubtitleRecord } from '../../src/subs/record';

describe('appDataDir', () => {
  it('uses Application Support on macOS', () => {
    expect(appDataDir({}, 'darwin', '/Users/a')).toBe('/Users/a/Library/Application Support/seikou-encode');
  });
  it('uses XDG_DATA_HOME on linux, else ~/.local/share', () => {
    expect(appDataDir({ XDG_DATA_HOME: '/x' }, 'linux', '/home/a')).toBe('/x/seikou-encode');
    expect(appDataDir({}, 'linux', '/home/a')).toBe('/home/a/.local/share/seikou-encode');
  });
  it('lets SEIKOU_ENCODE_DATA override both', () => {
    expect(appDataDir({ SEIKOU_ENCODE_DATA: '/d' }, 'darwin', '/Users/a')).toBe('/d');
    expect(appDataDir({ SEIKOU_ENCODE_DATA: '/d' }, 'linux', '/home/a')).toBe('/d');
  });
});

const KEY = 'd.0123456789abcdef';
const FKEY = `f.${'AB'.repeat(16)}`;

function sample(): SubtitleRecord {
  return {
    disc: { key: KEY, label: 'LANTERN_HARBOR_1' },
    playlist: '00000',
    episodeSpec: '1-2',
    anilist: { id: 900101, title: 'Lantern Harbor', episodeOffset: 0 },
    release: { source: 'tosho', id: 'r1', group: 'GroupA', label: 'GroupA batch' },
    fonts: ['cache/r1/fonts/a.ttf'],
    episodes: [
      {
        index: 1,
        title: 'Harbor',
        tracks: [
          {
            file: 'cache/r1/ep1.ass',
            kind: 'full',
            language: 'eng',
            name: 'GroupA',
            shiftMs: 1208,
            nudgeMs: -42,
            split: null,
            included: true,
          },
        ],
        metadata: {
          title: 'Harbor',
          video: { name: '', language: 'und' },
          audio: [{ pid: 4352, name: 'Japanese', language: 'jpn', included: true }],
          chapters: ['Part A'],
        },
      },
    ],
    savedAt: '2026-11-07T10:00:00Z',
  };
}

describe('RecordStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'record-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('round-trips a record', async () => {
    const store = new RecordStore(dir);
    expect(await store.read(KEY, '00000')).toBeNull();
    await store.write(sample());
    expect(await store.read(KEY, '00000')).toEqual(sample());
  });

  it('throws RecordError for a corrupt file', async () => {
    const store = new RecordStore(dir);
    await mkdir(join(dir, 'subtitles', KEY), { recursive: true });
    await writeFile(store.path(KEY, '00000'), '{nope');
    await expect(store.read(KEY, '00000')).rejects.toBeInstanceOf(RecordError);
  });

  it('missingFiles groups by release', async () => {
    const store = new RecordStore(dir);
    const rec = sample();
    expect(await store.missingFiles(rec)).toEqual([
      { release: 'GroupA batch', files: ['cache/r1/fonts/a.ttf', 'cache/r1/ep1.ass'] },
    ]);
    await mkdir(join(dir, 'cache/r1/fonts'), { recursive: true });
    await writeFile(join(dir, 'cache/r1/fonts/a.ttf'), 'x');
    await writeFile(join(dir, 'cache/r1/ep1.ass'), 'x');
    expect(await store.missingFiles(rec)).toEqual([]);
  });
});

describe('record path safety', () => {
  it('rejects a key or playlist that could leave subtitles/', () => {
    const store = new RecordStore('/data');
    expect(() => store.path('../x', '00000')).toThrow(RecordError);
    expect(() => store.path('/abs', '00000')).toThrow(RecordError);
    expect(() => store.path(KEY, '../x')).toThrow(RecordError);
    expect(() => store.path(KEY, '/abs')).toThrow(RecordError);
    const rec = sample();
    rec.disc.key = '../x';
    expect(() => parseRecord(rec)).toThrow(/disc\.key/);
    const rec2 = sample();
    rec2.playlist = '../../x';
    expect(() => parseRecord(rec2)).toThrow(/playlist/);
  });
  it('accepts a fingerprint key', () => {
    const rec = sample();
    rec.disc.key = FKEY;
    expect(parseRecord(rec).disc.key).toBe(FKEY);
    expect(new RecordStore('/data').path(FKEY, '00001')).toBe(`/data/subtitles/${FKEY}/00001.json`);
  });
});

describe('parseRecord', () => {
  it('rejects a bad language with its path', () => {
    const rec = sample();
    rec.episodes[0]!.tracks[0]!.language = 'en';
    expect(() => parseRecord(rec)).toThrow(/episodes\[0\]\.tracks\[0\]\.language/);
  });
  it('rejects a path that leaves the data dir', () => {
    const rec = sample();
    rec.fonts = ['../outside.ttf'];
    expect(() => parseRecord(rec)).toThrow(/fonts\[0\]/);
    const rec2 = sample();
    rec2.episodes[0]!.tracks[0]!.file = '/abs/x.ass';
    expect(() => parseRecord(rec2)).toThrow(/episodes\[0\]\.tracks\[0\]\.file/);
  });
  it('rejects duplicate or non-positive episode indexes and non-finite shifts', () => {
    const dup = sample();
    dup.episodes.push({ ...dup.episodes[0]! });
    expect(() => parseRecord(dup)).toThrow(/episodes\[1\]\.index/);
    const zero = sample();
    zero.episodes[0]!.index = 0;
    expect(() => parseRecord(zero)).toThrow(/episodes\[0\]\.index/);
    const nan = sample();
    nan.episodes[0]!.tracks[0]!.nudgeMs = Number.NaN;
    expect(() => parseRecord(nan)).toThrow(/nudgeMs/);
  });
});
