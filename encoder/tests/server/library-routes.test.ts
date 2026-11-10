// SPDX-License-Identifier: LGPL-3.0-or-later
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiscManifest, LibraryListing } from '@seikou/nas/nas-api';
import { NasClient } from '../../src/nas/client';
import { ensureMirror, HEAD_BYTES, mirrorDirOf } from '../../src/nas/mirror';
import { pairWithNas } from '../../src/nas/pairing';
import { startHelperServer, type AppContext, type HelperServer } from '../../src/server/server';
import { startNasTestServer, type NasTestServer } from '../nas/nas-test-server';
import { fx } from '../paths';

const TOKEN = 'library-routes-token';

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Buffer;
}

describe('NAS discs in the library', () => {
  let nas: NasTestServer;
  let server: HelperServer;
  let app: AppContext;
  /** The NAS's disc1 clip 2, lengthened past a head and 8 MiB. */
  let clip2: Buffer;

  const get = async (path: string, init: RequestInit = {}): Promise<Answer> => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string>) } });
    return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
  };
  const json = <T>(a: Answer): T => JSON.parse(a.bytes.toString('utf8')) as T;

  interface Disc {
    key: string;
    label: string;
    relPath: string;
    root: string;
    source: string;
    playlistCount: number;
    otherPaths: { relPath: string; root: string }[];
  }
  let nasDiscs: Disc[];
  let disc1: Disc;
  /** A folder of local discs: a copy of disc3. */
  let shelf: string;
  /** Every disc of the first listing. */
  let allDiscs: Disc[];

  beforeAll(async () => {
    nas = await startNasTestServer({
      encodes: false,
      prepare: (dir) => {
        // The speech disc's clips carry a PAT and PMT, which planning reads (the synthetic discs' do not).
        cpSync(fx('fixtures/disc-speech'), join(dir, 'speech'), { recursive: true });
        appendFileSync(join(dir, 'disc1/BDMV/STREAM/00002.m2ts'), randomBytes(HEAD_BYTES + 9 * 1024 * 1024 + 192 * 5));
        mkdirSync(join(dir, 'disc1/BDMV/META/DL'), { recursive: true });
        writeFileSync(join(dir, 'disc1/BDMV/META/DL/bdmt_eng.xml'), Buffer.alloc(64, 0x41));
        // Another copy of the same disc whose metadata differs.
        cpSync(join(dir, 'disc1'), join(dir, 'disc1-copy'), { recursive: true });
        writeFileSync(join(dir, 'disc1-copy/BDMV/META/DL/bdmt_eng.xml'), Buffer.alloc(64, 0x42));
      },
    });
    clip2 = readFileSync(join(nas.discsDir!, 'disc1/BDMV/STREAM/00002.m2ts'));
    const dataDir = mkdtempSync(join(tmpdir(), 'library-routes-'));
    await pairWithNas(dataDir, { code: await nas.ownerCode(), base: nas.base }, 'Seikou encoder on test');
    // A local copy of disc3, which the NAS has too.
    shelf = mkdtempSync(join(tmpdir(), 'library-routes-shelf-'));
    cpSync(fx('../fixtures/synthetic/disc3'), join(shelf, 'disc3-here'), { recursive: true });
    app = { dataDir, token: TOKEN, webDir: null, tools: null, sources: {} as AppContext['sources'], roots: [shelf], nas: { client: await NasClient.load(dataDir) } };
    server = await startHelperServer(app);
    let answer = json<{ scanning: boolean; discs: Disc[]; nas: { scanning: boolean } }>(await get('/api/library'));
    while (answer.scanning || answer.nas.scanning) {
      await new Promise((r) => setTimeout(r, 50));
      answer = json(await get('/api/library'));
    }
    allDiscs = answer.discs;
    nasDiscs = answer.discs.filter((d) => d.source === 'nas');
    disc1 = nasDiscs.find((d) => d.label === 'disc1')!;
  });
  afterAll(async () => {
    await server.close();
    await nas.close();
    rmSync(app.dataDir, { recursive: true, force: true });
    rmSync(shelf, { recursive: true, force: true });
  });

  it('GET /api/library lists the NAS discs once per key, with the NAS paths of the other copies', async () => {
    const answer = json<{ discs: Disc[]; nas: { paired: boolean; scanning: boolean; reachable: boolean | null } }>(await get('/api/library'));
    expect(answer.nas).toEqual({ paired: true, scanning: false, reachable: true });
    expect(nasDiscs.length).toBeGreaterThan(5);
    expect(disc1).toMatchObject({ root: 'NAS', relPath: 'syn/disc1', source: 'nas', playlistCount: 2 });
    expect(disc1.otherPaths).toContainEqual({ relPath: 'syn/disc1-copy', root: 'NAS' });
    expect(new Set(nasDiscs.map((d) => d.key)).size).toBe(nasDiscs.length);
  });

  it('a disc both here and on the NAS is listed once, as the local copy, with the NAS path among its other places', async () => {
    const copies = allDiscs.filter((d) => d.label === 'disc3-here' || d.relPath === 'syn/disc3');
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ source: 'local', relPath: 'disc3-here', otherPaths: [{ relPath: 'syn/disc3', root: 'NAS' }] });
    expect(nasDiscs.some((d) => d.key === copies[0]!.key)).toBe(false);
  });

  it('serves the NAS disc manifest with the NAS manifest files', async () => {
    const listing = await app.nas.client!.json<LibraryListing>('library?path=syn');
    const id = listing.discs.find((d) => d.name === 'disc1')!.id;
    const theirs = await app.nas.client!.json<DiscManifest>(`discs/${id}/manifest`);
    const ours = await get(`/api/discs/${disc1.key}/manifest`);
    expect(ours.status).toBe(200);
    expect(json<DiscManifest>(ours).files).toEqual(theirs.files);
  });

  it('reads stream ranges in the head, past it and over 8 MiB as the NAS bytes', async () => {
    const path = `/api/discs/${disc1.key}/files/BDMV/STREAM/00002.M2TS`;
    const head = await get(path, { headers: { Range: 'bytes=0-1023' } });
    expect(head.status).toBe(206);
    expect(head.bytes.equals(clip2.subarray(0, 1024))).toBe(true);
    const past = await get(path, { headers: { Range: `bytes=${HEAD_BYTES + 4096}-${HEAD_BYTES + 4096 + 1023}` } });
    expect(past.status).toBe(206);
    expect(past.headers.get('content-range')).toBe(`bytes ${HEAD_BYTES + 4096}-${HEAD_BYTES + 4096 + 1023}/${clip2.length}`);
    expect(past.bytes.equals(clip2.subarray(HEAD_BYTES + 4096, HEAD_BYTES + 4096 + 1024))).toBe(true);
    const big = await get(path, { headers: { Range: `bytes=100-${100 + 10 * 1024 * 1024 - 1}` } });
    expect(big.status).toBe(206);
    expect(big.bytes.equals(clip2.subarray(100, 100 + 10 * 1024 * 1024))).toBe(true);
    // Nothing past the head was kept in the mirror.
    const state = JSON.parse(readFileSync(join(mirrorDirOf(app.dataDir, disc1.key), 'fetch.json'), 'utf8')) as { ranges: Record<string, [number, number][]> };
    expect(state.ranges['BDMV/STREAM/00002.M2TS']).toEqual([]);
  });

  it('a session on a NAS disc fetches its heads first and plans from the mirror', async () => {
    const speech = nasDiscs.find((d) => d.relPath === 'syn/speech')!;
    const made = await get('/api/sessions', { method: 'POST', body: JSON.stringify({ discKey: speech.key, playlistId: '00000', episodeSpec: '1-3,4-5' }) });
    expect(made.status).toBe(200);
    const { id } = json<{ id: string }>(made);
    const state = JSON.parse(readFileSync(join(mirrorDirOf(app.dataDir, speech.key), 'fetch.json'), 'utf8')) as { heads: string[] };
    expect(state.heads).toEqual(['BDMV/STREAM/00001.M2TS', 'BDMV/STREAM/00002.M2TS']);
    const episodes = await get(`/api/sessions/${id}/episodes`);
    expect(episodes.status).toBe(200);
    expect(json<{ episodes: unknown[] }>(episodes).episodes).toHaveLength(2);
    expect(json<{ label: string; discKey: string }>(await get(`/api/sessions/${id}`))).toMatchObject({ label: 'speech', discKey: speech.key });
  });

  it('a session on a mirror keeps its metadata when another copy of the disc is opened', async () => {
    const made = await get('/api/sessions', { method: 'POST', body: JSON.stringify({ discKey: disc1.key, playlistId: '00000', episodeSpec: '1-' }) });
    expect(made.status).toBe(200);
    const mirror = mirrorDirOf(app.dataDir, disc1.key);
    const before = JSON.parse(readFileSync(join(mirror, 'fetch.json'), 'utf8')) as { heads: string[]; metadataFrom: string };
    expect(before.heads).toEqual(['BDMV/STREAM/00001.M2TS', 'BDMV/STREAM/00002.M2TS']);
    const listing = await app.nas.client!.json<LibraryListing>('library?path=syn');
    const copyId = listing.discs.find((d) => d.name === 'disc1-copy')!.id;
    expect(copyId).not.toBe(before.metadataFrom);
    await ensureMirror(app.dataDir, app.nas.client!, copyId, disc1.key);
    expect(readFileSync(join(mirror, 'BDMV/META/DL/bdmt_eng.xml')).equals(Buffer.alloc(64, 0x41))).toBe(true);
    expect((JSON.parse(readFileSync(join(mirror, 'fetch.json'), 'utf8')) as { metadataFrom: string }).metadataFrom).toBe(before.metadataFrom);
  });

  it('while the NAS cannot be reached, a disc whose mirror is here still opens, and the listing stays', async () => {
    const other = await startNasTestServer({ encodes: false });
    const dataDir = mkdtempSync(join(tmpdir(), 'library-routes-off-'));
    let run: HelperServer | null = null;
    try {
      await pairWithNas(dataDir, { code: await other.ownerCode(), base: other.base }, 'Seikou encoder on test');
      const offApp: AppContext = { ...app, dataDir, nas: { client: await NasClient.load(dataDir) } };
      run = await startHelperServer(offApp);
      const call = async (path: string): Promise<Answer> => {
        const res = await fetch(`http://127.0.0.1:${run!.port}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
      };
      await call('/api/library');
      await libraryIdle(call);
      const listed = json<{ discs: Disc[] }>(await call('/api/library')).discs.filter((d) => d.source === 'nas');
      const one = listed.find((d) => d.label === 'disc1')!;
      const two = listed.find((d) => d.label === 'disc2')!;
      expect((await call(`/api/discs/${one.key}/manifest`)).status).toBe(200);
      await run.close();
      await other.close();

      // A new run: the NAS is gone, the mirror of disc1 is here, disc2 was never opened.
      run = await startHelperServer({ ...offApp, nas: { client: await NasClient.load(dataDir) } });
      await call('/api/library');
      const answer = json<{ discs: Disc[]; nas: { reachable: boolean | null } }>(await libraryIdle(call));
      expect(answer.nas.reachable).toBe(false);
      expect(answer.discs.filter((d) => d.source === 'nas')).toEqual(listed);
      expect((await call(`/api/discs/${one.key}/manifest`)).status).toBe(200);
      expect(json<{ error: string }>(await call(`/api/discs/${two.key}/manifest`)).error).toBe('disc-changed');
    } finally {
      await run?.close();
      await other.close().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

/** Asks for the library until no scan runs, and gives that answer. */
async function libraryIdle(call: (path: string) => Promise<Answer>): Promise<Answer> {
  for (;;) {
    const a = await call('/api/library');
    const body = JSON.parse(a.bytes.toString('utf8')) as { scanning: boolean; nas: { scanning: boolean } };
    if (!body.scanning && !body.nas.scanning) return a;
    await new Promise((r) => setTimeout(r, 50));
  }
}
