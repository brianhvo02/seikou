// SPDX-License-Identifier: LGPL-3.0-or-later
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { discKeyOf } from '@seikou/nas/disc-key';
import type { DiscEntry, DiscManifest, LibraryListing } from '@seikou/nas/nas-api';
import { NasClient } from '../../src/nas/client';
import { NasLibrary } from '../../src/nas/nas-library';
import { pairWithNas } from '../../src/nas/pairing';
import type { AppContext } from '../../src/server/http';
import { startNasTestServer, type NasTestServer } from './nas-test-server';

let nas: NasTestServer;
let dataDir: string;
let app: AppContext;
/** Manifest requests the NAS was sent, by disc id. */
let manifests: string[];

const counting: typeof fetch = (input, init) => {
  const m = /\/discs\/([^/]+)\/manifest/.exec(String(input));
  if (m) manifests.push(decodeURIComponent(m[1]!));
  return fetch(input, init);
};

/** Every disc the stand-in lists, walking its folders. */
async function standInDiscs(client: NasClient): Promise<DiscEntry[]> {
  const out: DiscEntry[] = [];
  const queue = [''];
  while (queue.length > 0) {
    const listing = await client.json<LibraryListing>(`library?path=${encodeURIComponent(queue.shift()!)}`);
    out.push(...listing.discs);
    queue.push(...listing.folders.map((f) => f.path));
  }
  return out;
}

async function pairedApp(server: NasTestServer): Promise<AppContext> {
  const dir = mkdtempSync(join(tmpdir(), 'nas-library-'));
  await pairWithNas(dir, { code: await server.ownerCode(), base: server.base }, 'Seikou encoder on test');
  const client = (await NasClient.load(dir, counting))!;
  return { dataDir: dir, token: 't', webDir: null, tools: null, sources: {} as AppContext['sources'], roots: [], nas: { client } };
}

beforeAll(async () => {
  nas = await startNasTestServer({ encodes: false });
});
afterAll(async () => {
  await nas.close();
});
beforeEach(async () => {
  manifests = [];
  app = await pairedApp(nas);
  dataDir = app.dataDir;
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

it('lists every disc of the NAS with its key as the NAS works it out, and its playlists', async () => {
  const library = new NasLibrary(app);
  expect(library.reachable).toBeNull();
  await library.scan();
  expect(library.reachable).toBe(true);
  const listed = await standInDiscs(app.nas.client!);
  expect(listed.length).toBeGreaterThan(5);
  expect(library.discs().map((d) => d.discId).sort()).toEqual(listed.map((d) => d.id).sort());
  for (const entry of listed) {
    const manifest = await app.nas.client!.json<DiscManifest>(`discs/${entry.id}/manifest`);
    const disc = library.discs().find((d) => d.discId === entry.id)!;
    expect(disc.key).toBe(discKeyOf(entry.id, manifest.files));
    expect(disc.relPath).toBe(entry.path);
    expect(disc.sizeBytes).toBe(entry.sizeBytes);
    expect(disc.playlistCount).toBe(manifest.files.filter((f) => f.path.startsWith('BDMV/PLAYLIST/')).length);
    expect(library.byKey(disc.key)).not.toBeNull();
  }
});

it('a second scan, even by another run, fetches no manifest whose disc id and size are unchanged', async () => {
  await new NasLibrary(app).scan();
  const first = manifests.length;
  expect(first).toBeGreaterThan(5);
  manifests = [];
  const again = new NasLibrary(app);
  await again.scan();
  expect(manifests).toEqual([]);
  expect(again.discs()).toHaveLength(first);
});

it('keeps the last listing, marked unreachable, once the NAS stops answering', async () => {
  const other = await startNasTestServer({ encodes: false });
  const otherApp = await pairedApp(other);
  try {
    const library = new NasLibrary(otherApp);
    await library.scan();
    const before = library.discs();
    expect(before.length).toBeGreaterThan(5);
    await other.close();
    await library.scan();
    expect(library.reachable).toBe(false);
    expect(library.discs()).toEqual(before);
    // A new run that cannot reach the NAS shows the saved listing.
    const fresh = new NasLibrary(otherApp);
    await fresh.scan();
    expect(fresh.reachable).toBe(false);
    expect(fresh.discs()).toEqual(before);
  } finally {
    rmSync(otherApp.dataDir, { recursive: true, force: true });
  }
});

it('lists nothing while not paired', async () => {
  const library = new NasLibrary(app);
  await library.scan();
  app.nas.client = null;
  expect(library.discs()).toEqual([]);
});

it('a pairing made while a scan for the earlier one runs gets a scan of its own', async () => {
  const other = await startNasTestServer({
    encodes: false,
    prepare: (dir) => cpSync(join(dir, 'disc1'), join(dir, 'disc1-only-here'), { recursive: true }),
  });
  const otherApp = await pairedApp(other);
  try {
    const library = new NasLibrary(app);
    const first = library.scan();
    // Re-paired with another NAS while the first scan runs, as the pair route does it.
    app.nas.client = otherApp.nas.client;
    library.forget();
    const second = library.scan();
    expect(second).not.toBe(first);
    await Promise.all([first, second]);
    const theirs = await standInDiscs(otherApp.nas.client!);
    expect(library.discs().map((d) => d.discId).sort()).toEqual(theirs.map((d) => d.id).sort());
    expect(library.discs().some((d) => d.relPath === 'syn/disc1-only-here')).toBe(true);
    expect(library.reachable).toBe(true);
  } finally {
    await other.close();
    rmSync(otherApp.dataDir, { recursive: true, force: true });
  }
});
