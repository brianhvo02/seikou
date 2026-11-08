// SPDX-License-Identifier: LGPL-3.0-or-later
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EncodeIndex } from './index-store';

const FIXTURES = join(import.meta.dirname, '../../../fixtures/encodes/990001');
let tmp: string;
let dir: string;
let data: string;
let reads: string[];
let logs: string[];

const make = (): EncodeIndex => new EncodeIndex({ dir, dataDir: data, log: (m) => logs.push(m), onRead: (p) => reads.push(p) });

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

  it('forgets a file that is gone', async () => {
    cpSync(join(FIXTURES, '1.mkv'), join(dir, '990001/1.mkv'));
    const index = make();
    await index.scan();
    rmSync(join(dir, '990001/1.mkv'));
    await index.scan();
    expect(index.list()).toEqual([]);
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
});
