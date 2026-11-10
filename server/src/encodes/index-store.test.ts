// SPDX-License-Identifier: LGPL-3.0-or-later
import { appendFileSync, chmodSync, cpSync, readFileSync, renameSync, mkdirSync, symlinkSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EncodeIndex } from './index-store';
import { retagged } from './test-retag';

const FIXTURES = join(import.meta.dirname, '../../../fixtures/encodes/990001');
let tmp: string;
let dir: string;
let data: string;
let reads: string[];
let logs: string[];

const make = (settleMs = 0): EncodeIndex => new EncodeIndex({ dir, dataDir: data, log: (m) => logs.push(m), onRead: (p) => { reads.push(p); }, settleMs });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'encodes-'));
  dir = join(tmp, 'encodes');
  data = join(tmp, 'data');
  mkdirSync(join(dir, '990001'), { recursive: true });
  mkdirSync(data);
  reads = [];
  logs = [];
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('EncodeIndex', () => {
  it('scans the folder, files tagged MKVs and lists untagged ones as unfiled', async () => {
    cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv'));
    cpSync(join(FIXTURES, '2.mkv'), join(dir, '990001/2.mkv'));
    writeFileSync(join(dir, 'loose.mkv'), 'not matroska at all');
    mkdirSync(join(dir, 'show'));
    cpSync(join(FIXTURES, '2.mkv'), join(dir, 'show/misplaced.mkv'));
    mkdirSync(join(dir, '.uploads'));
    cpSync(join(FIXTURES, '1.mkv'), join(dir, '.uploads/hidden.mkv'));
    const index = make();
    await index.scan();
    expect(index.list().map((e) => e.id)).toEqual(['990001-1', '990001-2']);
    const one = index.get('990001-1')!;
    expect(one).toMatchObject({
      anilistId: 990001, episode: 1, episodeTitle: 'The Lantern Road', discKey: 'f.148C2FD8E35B72A696EB6FB331CB0AE7',
      playlistId: '00000', episodeStartMs: 0, path: join(dir, '990001/1.mkv'),
    });
    expect(one.durationMs).toBeGreaterThan(60_000);
    expect(one.chapters.map((c) => c.name)).toEqual(['Avant', 'Opening', 'Part A', 'Ending', 'Preview']);
    expect(one.tracks.map((t) => [t.kind, t.codec])).toEqual([['video', 'V_AV1'], ['audio', 'A_OPUS'], ['subtitle', 'S_TEXT/ASS'], ['subtitle', 'S_HDMV/PGS']]);
    expect(index.get('990001-2')!.episodeStartMs).toBe(60000);
    // a duplicate of 990001-2 in another folder loses to the canonical path, and is logged
    expect(logs.join('\n')).toContain('show/misplaced.mkv');
    expect(index.unfiled().map((u) => u.path)).toEqual([join(dir, 'loose.mkv')]);
    expect(index.get('1-1')).toBeNull();
  });

  it('lists a tagged file outside its canonical path under its tags', async () => {
    mkdirSync(join(dir, 'other'));
    cpSync(join(FIXTURES, '1.mkv'), join(dir, 'other/a.mkv'));
    const index = make();
    await index.scan();
    expect(index.get('990001-1')!.path).toBe(join(dir, 'other/a.mkv'));
    expect(index.unfiled()).toEqual([]);
  });

  it('skips .partial files', async () => {
    cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv.partial'));
    cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/2.mkv.partial'));
    const index = make();
    await index.scan();
    expect(index.list()).toEqual([]);
    expect(index.unfiled()).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('rescans only what changed (size, mtime)', async () => {
    cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv'));
    cpSync(join(FIXTURES, '2.mkv'), join(dir, '990001/2.mkv'));
    await make().scan();
    expect(reads.length).toBe(2);
    reads = [];
    const again = make(); // a restart reads encodes.json
    await again.scan();
    expect(reads).toEqual([]);
    expect(again.list().length).toBe(2);
    const when = new Date(Date.now() + 5000);
    utimesSync(join(dir, '990001/2.mkv'), when, when);
    await again.scan();
    expect(reads).toEqual(['990001/2.mkv']);
  });

  it('reports a missing root and keeps no index', async () => {
    rmSync(dir, { recursive: true });
    const index = make();
    await index.scan();
    expect(index.state()).toEqual({ scanning: false, rootMissing: true, rootEmpty: false, scanError: null });
    expect(index.list()).toEqual([]);
    expect(logs.filter((l) => l.includes("can't be read")).length).toBe(1);
    await index.scan();
    expect(logs.filter((l) => l.includes("can't be read")).length).toBe(1);
  });

  it('keeps the last index when the root disappears between scans', async () => {
    cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv'));
    await make().scan();
    const restarted = make();
    rmSync(dir, { recursive: true });
    await restarted.scan();
    expect(restarted.state().rootMissing).toBe(true);
    expect(restarted.list().map((e) => e.id)).toEqual(['990001-1']);
    mkdirSync(join(dir, '990001'), { recursive: true });
    cpSync(join(FIXTURES, '2.mkv'), join(dir, '990001/2.mkv'));
    await restarted.scan();
    expect(restarted.state().rootMissing).toBe(false);
    expect(restarted.list().map((e) => e.id)).toEqual(['990001-2']);
  });

  it('skips a subfolder it cannot read and keeps what it held', async () => {
    cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv'));
    mkdirSync(join(dir, 'ok'));
    cpSync(join(FIXTURES, '2.mkv'), join(dir, 'ok/2.mkv'));
    const index = make();
    await index.scan();
    chmodSync(join(dir, '990001'), 0o000);
    try {
      await index.scan();
      expect(index.list().map((e) => e.id)).toEqual(['990001-1', '990001-2']);
      expect(logs.join('\n')).toContain('skipping 990001');
    } finally {
      chmodSync(join(dir, '990001'), 0o755);
    }
  });

  it('leaves a file modified in the last 10 s for the next scan', async () => {
    cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv'));
    const index = make(10_000);
    await index.scan();
    expect(index.list()).toEqual([]);
    expect(reads).toEqual([]);
    const later = new EncodeIndex({ dir, dataDir: data, log: () => {}, now: () => Date.now() + 60_000 });
    await later.scan();
    expect(later.list().map((e) => e.id)).toEqual(['990001-1']);
  });

  it('keeps the index when the folder is readable but empty', async () => {
    cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv'));
    const index = make();
    await index.scan();
    rmSync(join(dir, '990001'), { recursive: true });
    await index.scan();
    await index.scan();
    expect(index.list().map((e) => e.id)).toEqual(['990001-1']);
    expect(index.state().rootEmpty).toBe(true);
    expect(logs.filter((l) => l.includes('holds no MKV')).length).toBe(1);
    mkdirSync(join(dir, '990001'));
    cpSync(join(FIXTURES, '2.mkv'), join(dir, '990001/2.mkv'));
    await index.scan();
    expect(index.state().rootEmpty).toBe(false);
    expect(index.list().map((e) => e.id)).toEqual(['990001-2']);
  });

  it('keeps the old list and reports scanError when the index cannot be saved', async () => {
    cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv'));
    let fail = false;
    const index = new EncodeIndex({ dir, dataDir: data, log: () => {}, settleMs: 0, writeIndex: (f, j) => { if (fail) throw new Error('disk full'); writeFileSync(f, j); } });
    await index.scan();
    cpSync(join(FIXTURES, '2.mkv'), join(dir, '990001/2.mkv'));
    fail = true;
    await expect(index.scan()).rejects.toThrow('disk full');
    expect(index.list().map((e) => e.id)).toEqual(['990001-1']);
    expect(index.state().scanError).toBe('disk full');
    fail = false;
    await index.scan();
    expect(index.list().map((e) => e.id)).toEqual(['990001-1', '990001-2']);
    expect(index.state().scanError).toBeNull();
  });

  it('refuses a symlink inside the folder that points outside it', async () => {
    const index = make();
    await index.scan();
    cpSync(join(FIXTURES, '1.mkv'), join(tmp, 'outside.mkv'));
    symlinkSync(join(tmp, 'outside.mkv'), join(dir, '990001/link.mkv'));
    await expect(index.add(join(dir, '990001/link.mkv'))).rejects.toThrow('not inside');
  });

  it('says so when the folder or the file is missing on add', async () => {
    const index = make();
    await expect(index.add(join(dir, '990001/none.mkv'))).rejects.toThrow('no such file');
    rmSync(dir, { recursive: true });
    await expect(index.add(join(dir, '990001/none.mkv'))).rejects.toThrow('the encodes folder is missing');
  });

  it('refuses to add a file outside the folder', async () => {
    const index = make();
    await index.scan();
    cpSync(join(FIXTURES, '1.mkv'), join(tmp, 'outside.mkv'));
    await expect(index.add(join(tmp, 'outside.mkv'))).rejects.toThrow('not inside');
    await expect(index.add(join(dir, '..', 'outside.mkv'))).rejects.toThrow('not inside');
  });

  it('forgets a file that is gone', async () => {
    cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv'));
    cpSync(join(FIXTURES, '2.mkv'), join(dir, '990001/2.mkv'));
    const index = make();
    await index.scan();
    rmSync(join(dir, '990001/1.mkv'));
    await index.scan();
    expect(index.list().map((e) => e.id)).toEqual(['990001-2']);
  });

  it('adds and removes one file', async () => {
    const index = make();
    await index.scan();
    cpSync(join(FIXTURES, '2.mkv'), join(dir, '990001/2.mkv'));
    const entry = await index.add(join(dir, '990001/2.mkv'));
    expect(entry.id).toBe('990001-2');
    expect(index.list().length).toBe(1);
    await index.remove('990001-2');
    expect(index.get('990001-2')).toBeNull();
  });

  describe('titles beyond AniList', () => {
    const TV = { SEIKOU_TITLE: 'tmdb-tv:990101', SEASON: '1', EPISODE: '2', ANILIST_ID: null, ENCODER: null, SEIKOU_DISC_KEY: null, TITLE_NAME: ' Starfall Wanderer ' };

    it('lists a TMDB series episode by its title part, with its TITLE_NAME', async () => {
      mkdirSync(join(dir, 'tv990101s1'));
      writeFileSync(join(dir, 'tv990101s1/2.mkv'), retagged(1, TV));
      cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv'));
      cpSync(join(FIXTURES, '2.mkv'), join(dir, '990001/2.mkv'));
      const index = make();
      await index.scan();
      expect(index.list().map((e) => e.id)).toEqual(['990001-1', '990001-2', 'tv990101s1-2']);
      expect(index.get('tv990101s1-2')).toMatchObject({
        title: { source: 'tmdb-tv', tmdbId: 990101, season: 1 }, titleName: 'Starfall Wanderer', anilistId: null, episode: 2, path: join(dir, 'tv990101s1/2.mkv'),
      });
      expect(index.get('990001-1')).toMatchObject({ title: { source: 'anilist', anilistId: 990001 }, anilistId: 990001, titleName: null });
    });

    it('keeps the file at <titlePart>/<episode>.mkv when two name the same episode', async () => {
      mkdirSync(join(dir, 'tv990101s1'));
      mkdirSync(join(dir, 'elsewhere'));
      writeFileSync(join(dir, 'elsewhere/copy.mkv'), retagged(1, TV));
      // the copy elsewhere is newer, but the canonical path wins
      writeFileSync(join(dir, 'tv990101s1/2.mkv'), retagged(1, TV));
      const old = new Date(Date.now() - 60_000);
      utimesSync(join(dir, 'tv990101s1/2.mkv'), old, old);
      const index = make();
      await index.scan();
      expect(index.get('tv990101s1-2')!.path).toBe(join(dir, 'tv990101s1/2.mkv'));
    });

    it('leaves a tmdb-tv file without SEASON, or with a malformed SEIKOU_TITLE, unfiled', async () => {
      writeFileSync(join(dir, 'noseason.mkv'), retagged(1, { ...TV, SEIKOU_TITLE: 'tmdb-tv:5', SEASON: null }));
      writeFileSync(join(dir, 'bad.mkv'), retagged(1, { ...TV, SEIKOU_TITLE: 'tmdb:990101' }));
      const index = make();
      await index.scan();
      expect(index.list()).toEqual([]);
      expect(index.unfiled().map((u) => u.path)).toEqual([join(dir, 'bad.mkv'), join(dir, 'noseason.mkv')]);
    });

    it('adds and removes a TMDB film', async () => {
      const index = make();
      await index.scan();
      mkdirSync(join(dir, 'mv990102'));
      writeFileSync(join(dir, 'mv990102/1.mkv'), retagged(1, { ANILIST_ID: null, ENCODER: null, SEIKOU_TITLE: 'tmdb-movie:990102', EPISODE: '1' }));
      expect((await index.add(join(dir, 'mv990102/1.mkv'))).id).toBe('mv990102-1');
      await index.remove('mv990102-1');
      expect(index.list()).toEqual([]);
    });

    it("loads an index file from before titles without reading its listed files again, and rereads the ones it couldn't file", async () => {
      cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv'));
      writeFileSync(join(dir, 'tv.mkv'), retagged(1, TV));
      await make().scan();
      // rewrite encodes.json as the server before titles wrote it: version 1, `anilistId` only, the TMDB file unfiled
      const file = join(data, 'encodes.json');
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { version: number; files: Record<string, { entry: Record<string, unknown> | null }> };
      const v1 = { version: 1, files: Object.fromEntries(Object.entries(saved.files).map(([rel, r]) => {
        if (!r.entry || r.entry.anilistId === null) return [rel, { ...r, entry: null }];
        const { title: _t, titleName: _n, ...rest } = r.entry;
        return [rel, { ...r, entry: rest }];
      })) };
      writeFileSync(file, JSON.stringify(v1));
      reads = [];
      const index = make();
      expect(index.get('990001-1')).toMatchObject({ title: { source: 'anilist', anilistId: 990001 }, titleName: null });
      await index.scan();
      expect(reads).toEqual(['tv.mkv']);
      expect(index.list().map((e) => e.id)).toEqual(['990001-1', 'tv990101s1-2']);
    });
  });

  describe('while a scan is running', () => {
    /** An index whose read of `holdPath` waits for `release()`; `held` resolves once the scan is inside that read. */
    function held(holdPath: string): { index: EncodeIndex; held: Promise<void>; release: () => void } {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const held = new Promise<void>((r) => { entered = r; });
      let armed = true;
      const index = new EncodeIndex({
        dir, dataDir: data, log: () => {}, settleMs: 0,
        onRead: async (p) => {
          if (p === holdPath && armed) {
            armed = false;
            entered();
            await gate;
          }
        },
      });
      return { index, held, release };
    }

    it('an add during the scan survives the scan\'s commit', async () => {
      cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv'));
      const h = held('990001/1.mkv');
      const scan = h.index.scan();
      await h.held;
      cpSync(join(FIXTURES, '2.mkv'), join(dir, '990001/2.mkv'));
      await h.index.add(join(dir, '990001/2.mkv'));
      h.release();
      await scan;
      expect(h.index.list().map((e) => e.id)).toEqual(['990001-1', '990001-2']);
    });

    it('a replacement added during the scan keeps its new record', async () => {
      cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv'));
      cpSync(join(FIXTURES, '2.mkv'), join(dir, '990001/2.mkv'));
      await make().scan();
      const before = make();
      expect(before.get('990001-2')!.size).toBeGreaterThan(0);
      const h = held('990001/2.mkv');
      // the scan rereads 2.mkv because it changed since the index was saved
      appendFileSync(join(dir, '990001/2.mkv'), Buffer.alloc(10));
      const scan = h.index.scan();
      await h.held;
      cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv.new'));
      renameSync(join(dir, '990001/1.mkv.new'), join(dir, '990001/1.mkv'));
      appendFileSync(join(dir, '990001/1.mkv'), Buffer.alloc(100));
      const added = await h.index.add(join(dir, '990001/1.mkv'));
      h.release();
      await scan;
      expect(h.index.get('990001-1')!.size).toBe(added.size);
    });

    it('a remove during the scan stays removed', async () => {
      cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv'));
      cpSync(join(FIXTURES, '2.mkv'), join(dir, '990001/2.mkv'));
      await make().scan();
      const h = held('990001/2.mkv');
      const when = new Date(Date.now() + 5000);
      utimesSync(join(dir, '990001/2.mkv'), when, when);
      const scan = h.index.scan();
      await h.held;
      await h.index.remove('990001-1');
      h.release();
      await scan;
      expect(h.index.list().map((e) => e.id)).toEqual(['990001-2']);
    });
  });
});
