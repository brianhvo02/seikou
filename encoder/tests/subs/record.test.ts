// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    releases: [{ source: 'tosho', id: 'r1', group: 'GroupA', label: 'GroupA batch' }],
    fonts: ['cache/r1/fonts/a.ttf'],
    episodes: [
      {
        index: 1,
        title: 'Harbor',
        tracks: [
          {
            release: 'r1',
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
      { id: 'r1', release: 'GroupA batch', files: ['cache/r1/fonts/a.ttf', 'cache/r1/ep1.ass'] },
    ]);
    await mkdir(join(dir, 'cache/r1/fonts'), { recursive: true });
    await writeFile(join(dir, 'cache/r1/fonts/a.ttf'), 'x');
    await writeFile(join(dir, 'cache/r1/ep1.ass'), 'x');
    expect(await store.missingFiles(rec)).toEqual([]);
  });
});

describe('record releases', () => {
  const legacyOf = (release: unknown): unknown => {
    const { releases: _releases, ...rest } = sample();
    const episodes = sample().episodes.map((e) => ({ ...e, tracks: e.tracks.map(({ release: _r, ...t }) => t) }));
    return { ...rest, release, episodes };
  };
  const second = { source: 'local' as const, id: 'local-0123456789abcdef', group: '', label: 'own files' };

  it('reads the old single-release form', () => {
    const rec = parseRecord(legacyOf({ source: 'tosho', id: 'r1', group: 'GroupA', label: 'GroupA batch' }));
    expect(rec).toEqual(sample());
    expect(rec).not.toHaveProperty('release');
  });
  it('reads release: null as no releases', () => {
    const none = legacyOf(null) as { episodes: { tracks: unknown[] }[] };
    none.episodes.forEach((e) => (e.tracks = []));
    expect(parseRecord(none).releases).toEqual([]);
  });
  it('writes only the new form', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'record-'));
    try {
      const store = new RecordStore(dir);
      await store.write(parseRecord(legacyOf({ source: 'tosho', id: 'r1', group: 'GroupA', label: 'GroupA batch' })));
      const saved = JSON.parse(await readFile(store.path(KEY, '00000'), 'utf8')) as Record<string, unknown>;
      expect(saved).not.toHaveProperty('release');
      expect(saved.releases).toEqual(sample().releases);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('rejects a track naming an unknown release', () => {
    const rec = sample();
    rec.episodes[0]!.tracks[0]!.release = 'nope';
    expect(() => parseRecord(rec)).toThrow(/episodes\[0\]\.tracks\[0\]\.release/);
  });
  it('rejects a repeated release id', () => {
    const rec = sample();
    rec.releases.push({ ...rec.releases[0]! });
    expect(() => parseRecord(rec)).toThrow(/releases\[1\]\.id/);
  });

  describe('missingFiles', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'record-'));
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));
    const twoReleases = (): SubtitleRecord => {
      const rec = sample();
      rec.releases[0]!.id = 'tosho-11';
      rec.episodes[0]!.tracks[0]!.release = 'tosho-11';
      rec.releases.push(second);
      const t = rec.episodes[0]!.tracks[0]!;
      rec.episodes.push({ ...rec.episodes[0]!, index: 2, tracks: [{ ...t, release: second.id, file: 'cache/own/ep2.ass' }] });
      return rec;
    };
    const cacheRelease = async (key: string, fonts: string[]): Promise<void> => {
      await mkdir(join(dir, 'releases', key), { recursive: true });
      await writeFile(join(dir, 'releases', key, 'release.json'), JSON.stringify({ key, source: 'local', label: key, group: '', files: [], fonts: fonts.map((path) => ({ name: 'f', path })) }));
    };

    it('groups a missing track by its release and a missing font by the releases listing it', async () => {
      const rec = twoReleases();
      await cacheRelease('tosho-11', ['cache/r1/fonts/a.ttf']);
      await cacheRelease('local-0123456789abcdef', []);
      expect(await new RecordStore(dir).missingFiles(rec)).toEqual([
        { id: 'tosho-11', release: 'GroupA batch', files: ['cache/r1/fonts/a.ttf', 'cache/r1/ep1.ass'] },
        { id: second.id, release: 'own files', files: ['cache/own/ep2.ass'] },
      ]);
    });
    it('a font no cached release lists is reported under every release', async () => {
      expect(await new RecordStore(dir).missingFiles(twoReleases())).toEqual([
        { id: 'tosho-11', release: 'GroupA batch', files: ['cache/r1/fonts/a.ttf', 'cache/r1/ep1.ass'] },
        { id: second.id, release: 'own files', files: ['cache/r1/fonts/a.ttf', 'cache/own/ep2.ass'] },
      ]);
    });
    it('keeps two releases with the same label apart by id', async () => {
      const rec = twoReleases();
      rec.releases[1] = { ...second, label: rec.releases[0]!.label };
      const missing = await new RecordStore(dir).missingFiles(rec);
      expect(missing.map((m) => [m.id, m.release])).toEqual([
        ['tosho-11', 'GroupA batch'],
        [second.id, 'GroupA batch'],
      ]);
    });
    it('a record with no releases groups a missing font under your own files', async () => {
      const rec = sample();
      rec.releases = [];
      rec.episodes[0]!.tracks = [];
      expect(await new RecordStore(dir).missingFiles(rec)).toEqual([{ id: null, release: 'your own files', files: ['cache/r1/fonts/a.ttf'] }]);
    });
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
