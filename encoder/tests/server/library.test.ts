// SPDX-License-Identifier: LGPL-3.0-or-later
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanLibrary } from '../../src/server/library';
import { startHelperServer, type AppContext, type HelperServer } from '../../src/server/server';
import { appSettings } from '../../src/subs/app-settings';
import { RecordStore, type SubtitleRecord } from '../../src/subs/record';
import { fx } from '../paths';

const TOKEN = 'library-test-token';

describe('scanLibrary', () => {
  let tree: string;
  let outside: string;
  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), 'library-tree-'));
    outside = mkdtempSync(join(tmpdir(), 'library-outside-'));
    mkdirSync(join(tree, 'a', 'b', 'c'), { recursive: true });
    cpSync(fx('fixtures/disc1'), join(tree, 'top'), { recursive: true });
    cpSync(fx('fixtures/disc3'), join(tree, 'a', 'b', 'c', 'deep4'), { recursive: true });
    mkdirSync(join(tree, 'a', 'b', 'c', 'd'), { recursive: true });
    cpSync(fx('fixtures/disc-speech'), join(tree, 'a', 'b', 'c', 'd', 'too-deep5'), { recursive: true });
    cpSync(fx('fixtures/disc-subs'), join(outside, 'escaped'), { recursive: true });
    symlinkSync(join(outside, 'escaped'), join(tree, 'link-out'));
  });
  afterAll(() => {
    rmSync(tree, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('scans discs under a root up to four levels', async () => {
    const discs = await scanLibrary([tree]);
    expect(discs.map((d) => d.relPath).sort()).toEqual(['a/b/c/deep4', 'top']);
    const top = discs.find((d) => d.relPath === 'top')!;
    expect(top.label).toBe('top');
    expect(top.key).toMatch(/^[fd]\./);
    expect(top.dir.endsWith('/top')).toBe(true);
    expect(top.root).toBe(discs[0]!.root);
  });

  it('skips a symlink that leaves the root', async () => {
    const discs = await scanLibrary([tree]);
    expect(discs.some((d) => d.relPath.includes('link-out') || d.label === 'escaped')).toBe(false);
  });
});

interface Answer {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

describe('library routes', () => {
  let tree: string;
  let dataDir: string;
  let server: HelperServer;
  let key: string;

  const send = (path: string, method = 'GET', body?: string): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path, method, headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: text === '' ? null : JSON.parse(text) });
        });
      });
      req.on('error', reject);
      req.end(body);
    });

  const untilScanned = async (): Promise<Answer['json']> => {
    for (;;) {
      const r = await send('/api/library');
      if (!r.json.scanning) return r.json;
      await new Promise((r2) => setTimeout(r2, 20));
    }
  };

  beforeAll(async () => {
    tree = mkdtempSync(join(tmpdir(), 'library-routes-'));
    dataDir = mkdtempSync(join(tmpdir(), 'library-data-'));
    cpSync(fx('fixtures/disc-speech'), join(tree, 'speech'), { recursive: true });
    const app: AppContext = { dataDir, token: TOKEN, webDir: null, tools: null, sources: {} as AppContext['sources'], roots: [] };
    server = await startHelperServer(app);
    const saved = await send('/api/settings/roots', 'PUT', JSON.stringify({ roots: [tree] }));
    expect(saved.status).toBe(200);
    key = (await untilScanned()).discs[0].key;
  });
  afterAll(async () => {
    await server.close();
    rmSync(tree, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists the library and saves the roots', async () => {
    const lib = await untilScanned();
    expect(lib.roots).toHaveLength(1);
    expect(lib.discs).toHaveLength(1);
    expect(lib.discs[0]).toMatchObject({ label: 'speech', relPath: 'speech', recordPlaylists: [] });
    expect(lib.discs[0].playlistCount).toBeGreaterThan(0);
    expect(lib.discs[0].dir).toBeUndefined();
    expect((await appSettings(dataDir).read()).roots).toHaveLength(1);
  });

  it('rejects roots that are not folders', async () => {
    expect((await send('/api/settings/roots', 'PUT', JSON.stringify({ roots: [join(tree, 'nope')] }))).status).toBe(400);
    expect((await send('/api/settings/roots', 'PUT', JSON.stringify({ roots: 'x' }))).status).toBe(400);
  });

  it('a disc key outside the library answers 404', async () => {
    expect((await send('/api/discs/f.00ff/playlists')).status).toBe(404);
    expect((await send('/api/discs/f.00ff/playlists/00000')).status).toBe(404);
    expect((await send('/api/sessions', 'POST', JSON.stringify({ discKey: 'f.00ff', playlistId: '00000', episodeSpec: '1' }))).status).toBe(404);
  });

  it('a session can be made for a library disc', async () => {
    const r = await send('/api/sessions', 'POST', JSON.stringify({ discKey: key, playlistId: '00000', episodeSpec: '1-5' }));
    expect(r.status).toBe(200);
    expect(r.json.id).toMatch(/^[0-9a-f]{16}$/);
    expect((await send(`/api/discs/${key}/manifest`)).status).toBe(200);
  });

  it('playlists are listed longest first with likely main marked', async () => {
    const r = await send(`/api/discs/${key}/playlists`);
    expect(r.status).toBe(200);
    const list = r.json.playlists as { id: string; durationMs: number; clips: number; chapters: number; likelyMain: boolean }[];
    expect(list.length).toBeGreaterThan(0);
    const durations = list.map((p) => p.durationMs);
    expect(durations).toEqual([...durations].sort((a, b) => b - a));
    expect(list[0]!.likelyMain).toBe(true);
    expect(typeof list[0]!.clips).toBe('number');
  });

  it('chapters carry start and length', async () => {
    const r = await send(`/api/discs/${key}/playlists/00000`);
    expect(r.status).toBe(200);
    const { durationMs, chapters, record } = r.json as {
      durationMs: number;
      chapters: { index: number; startMs: number; lengthMs: number }[];
      record: unknown;
    };
    expect(record).toBeNull();
    expect(chapters.length).toBeGreaterThan(1);
    expect(chapters[0]).toMatchObject({ index: 1, startMs: 0 });
    for (let i = 0; i < chapters.length; i++) {
      const next = chapters[i + 1]?.startMs ?? durationMs;
      expect(chapters[i]!.startMs + chapters[i]!.lengthMs).toBe(next);
    }
    expect((await send(`/api/discs/${key}/playlists/abc`)).status).toBe(400);
    expect((await send(`/api/discs/${key}/playlists/09999`)).status).toBe(404);
  });

  it('record episode spec is reported', async () => {
    const record: SubtitleRecord = {
      disc: { key, label: 'speech' },
      playlist: '00000',
      episodeSpec: '1-3,4-5',
      anilist: null,
      releases: [],
      fonts: [],
      episodes: [{ index: 1, title: 'One', tracks: [], metadata: { title: 'One', video: { name: 'v', language: 'jpn' }, audio: [], chapters: [] } }],
      savedAt: '2026-11-08T00:00:00Z',
    };
    await new RecordStore(dataDir).write(record);
    const r = await send(`/api/discs/${key}/playlists/00000`);
    expect(r.json.record).toEqual({ episodeSpec: '1-3,4-5' });
    const lib = await send('/api/library');
    expect(lib.json.discs[0].recordPlaylists).toEqual(['00000']);
  });

  it('rescan answers at once and the scan finishes', async () => {
    const r = await send('/api/library/rescan', 'POST');
    expect(r.status).toBe(202);
    expect((await untilScanned()).discs).toHaveLength(1);
  });
});
