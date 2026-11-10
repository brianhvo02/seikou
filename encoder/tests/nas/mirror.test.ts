// SPDX-License-Identifier: LGPL-3.0-or-later
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { discKeyOf } from '@seikou/nas/disc-key';
import type { DiscManifest, LibraryListing } from '@seikou/nas/nas-api';
import { discKeyOfFolder } from '../../src/disc/disc-key';
import { loadPlaylist } from '../../src/disc/playlist';
import { NasClient } from '../../src/nas/client';
import { ensureMirror, FetchError, isMirror, mirrorDirOf } from '../../src/nas/mirror';
import { pairWithNas } from '../../src/nas/pairing';
import { startNasTestServer, type NasTestServer } from './nas-test-server';

describe('ensureMirror', () => {
  let nas: NasTestServer;
  let dataDir: string;
  let client: NasClient;
  let discId: string;
  let source: string;

  beforeAll(async () => {
    nas = await startNasTestServer({ encodes: false });
    source = join(nas.discsDir!, 'disc1');
  });
  afterAll(async () => {
    await nas.close();
  });
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'encoder-mirror-'));
    await pairWithNas(dataDir, { code: await nas.ownerCode(), base: nas.base }, 'Seikou encoder on test');
    client = (await NasClient.load(dataDir))!;
    const listing = await client.json<LibraryListing>('library');
    discId = listing.discs.find((d) => d.name === 'disc1')!.id;
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes metadata whole and every clip as a sparse file of its size, under the names the readers look for', async () => {
    const { dir, key, label } = await ensureMirror(dataDir, client, discId);
    expect(dir).toBe(mirrorDirOf(dataDir, key));
    expect(label).toBe('disc1');
    expect(await isMirror(dir)).toBe(true);
    expect(readFileSync(join(dir, 'BDMV/index.bdmv'))).toEqual(readFileSync(join(source, 'BDMV/index.bdmv')));
    // Folder names upper-case, file names lower-case: what loadPlaylist, probeClip and readPmt open on any filesystem.
    expect(readdirSync(join(dir, 'BDMV/PLAYLIST')).sort()).toEqual(['00000.mpls', '00001.mpls']);
    expect(readdirSync(join(dir, 'BDMV/CLIPINF')).sort()).toEqual(['00001.clpi', '00002.clpi']);
    expect(readdirSync(join(dir, 'BDMV/STREAM')).sort()).toEqual(['00001.m2ts', '00002.m2ts']);
    for (const clip of ['00001.m2ts', '00002.m2ts']) {
      const st = statSync(join(dir, 'BDMV/STREAM', clip));
      expect(st.size).toBe(statSync(join(source, 'BDMV/STREAM', clip)).size);
      expect(st.blocks * 512).toBeLessThan(st.size / 4);
    }
    const playlist = await loadPlaylist(dir, '00000');
    expect(playlist.items.length).toBeGreaterThan(0);

    const manifest = await client.json<DiscManifest>(`discs/${discId}/manifest`);
    expect(key).toBe(discKeyOf(discId, manifest.files));
    expect((await discKeyOfFolder(dir)).key).toBe(key);
    const state = JSON.parse(readFileSync(join(dir, 'fetch.json'), 'utf8')) as Record<string, unknown>;
    expect(state).toMatchObject({ discId, discKey: key, label: 'disc1', ranges: { 'BDMV/STREAM/00001.M2TS': [], 'BDMV/STREAM/00002.M2TS': [] }, heads: [] });
  });

  it('throws disc-changed and removes the old mirror when the NAS disc has other sizes', async () => {
    const { dir } = await ensureMirror(dataDir, client, discId);
    const clip = join(source, 'BDMV/STREAM/00002.m2ts');
    const size = statSync(clip).size;
    appendFileSync(clip, Buffer.alloc(192 * 10, 7));
    try {
      await expect(ensureMirror(dataDir, client, discId)).rejects.toMatchObject({ code: 'disc-changed' });
      expect(existsSync(dir)).toBe(false);
      // Asked again, it mirrors the disc as it now is.
      const again = await ensureMirror(dataDir, client, discId);
      expect(again.dir).not.toBe(dir);
      expect(statSync(join(again.dir, 'BDMV/STREAM/00002.m2ts')).size).toBe(size + 1920);
    } finally {
      truncateSync(clip, size);
    }
  });

  it('throws disc-changed when the disc is not the expected one', async () => {
    const err = await ensureMirror(dataDir, client, discId, `f.${'0'.repeat(32)}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err).toMatchObject({ code: 'disc-changed' });
    const { key } = await ensureMirror(dataDir, client, discId);
    await expect(ensureMirror(dataDir, client, discId, key)).resolves.toMatchObject({ key });
  });

  it('throws disc-changed for a disc the NAS no longer lists', async () => {
    await expect(ensureMirror(dataDir, client, '0123456789abcdef')).rejects.toMatchObject({ code: 'disc-changed' });
  });
});
