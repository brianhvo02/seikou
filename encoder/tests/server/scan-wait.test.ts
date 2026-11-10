// SPDX-License-Identifier: LGPL-3.0-or-later
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discKeyOfFolder } from '../../src/disc/disc-key';
import { Library, libraryOf } from '../../src/server/library';
import { startHelperServer, type AppContext, type HelperServer } from '../../src/server/server';
import { fx } from '../paths';

const TOKEN = 'scan-wait-token';

describe('a disc key asked for while the library is being scanned', () => {
  let tree: string;
  let dataDir: string;
  let server: HelperServer;
  let app: AppContext;
  let scanned: Promise<void> = Promise.resolve();

  beforeEach(async () => {
    tree = mkdtempSync(join(tmpdir(), 'scan-wait-tree-'));
    dataDir = mkdtempSync(join(tmpdir(), 'scan-wait-data-'));
    cpSync(fx('fixtures/disc-speech'), join(tree, 'speech'), { recursive: true });
    app = { dataDir, token: TOKEN, webDir: null, tools: null, sources: {} as AppContext['sources'], roots: [], nas: { client: null } };
    server = await startHelperServer(app);
  });
  afterEach(async () => {
    await scanned;
    vi.restoreAllMocks();
    await server.close();
    rmSync(tree, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  const send = (path: string, method = 'GET', body?: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path, method, headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end(body);
    });

  /** Starts a scan that holds at its first step until the returned function is called. */
  function heldScan(): () => void {
    let release!: () => void;
    const gate = new Promise<string[]>((resolve) => (release = () => resolve([tree])));
    vi.spyOn(Library.prototype, 'roots').mockImplementation(() => gate);
    scanned = libraryOf(app).scan();
    expect(libraryOf(app).scanning).toBe(true);
    return release;
  }

  it('is answered once the scan has found it, by the playlists, the manifest and the session routes', async () => {
    const { key } = await discKeyOfFolder(join(tree, 'speech'));
    const release = heldScan();
    const asks = [
      send(`/api/discs/${encodeURIComponent(key)}/playlists`),
      send(`/api/discs/${encodeURIComponent(key)}/manifest`),
      send('/api/sessions', 'POST', JSON.stringify({ discKey: key, playlistId: '00000', episodeSpec: '1-' })),
    ];
    await new Promise((r) => setTimeout(r, 50));
    release();
    expect(await Promise.all(asks)).toEqual([200, 200, 200]);
  });

  it('is still unknown when the scan ends without it', async () => {
    const release = heldScan();
    const ask = send(`/api/discs/${encodeURIComponent(`f.${'0'.repeat(32)}`)}/playlists`);
    release();
    expect(await ask).toBe(404);
  });
});
