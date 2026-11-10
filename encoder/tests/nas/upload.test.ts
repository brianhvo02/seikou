// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NasClient } from '../../src/nas/client';
import { pairWithNas } from '../../src/nas/pairing';
import { uploadEpisode, UploadError, type UploadState } from '../../src/nas/upload';
import { startNasTestServer, type NasTestServer } from './nas-test-server';
import { retagged } from './retag';

/** Three PUTs for the 1.1 MB fixture. */
const CHUNK = 400_000;
const noWait = (): Promise<void> => Promise.resolve();
const fresh = (): UploadState => ({ id: null, sha256: null, size: 0, sent: 0 });

describe('uploadEpisode', () => {
  let nas: NasTestServer;
  let dataDir: string;
  let file: string;
  let client: NasClient;
  /** Requests the NAS was sent, as `<method> <path>`. */
  let requests: string[];
  /** Runs after each answer arrives. */
  let afterAnswer: (method: string, path: string) => void;

  const puts = (): number => requests.filter((r) => r.startsWith('PUT ')).length;

  beforeAll(async () => {
    nas = await startNasTestServer({ discs: false });
  });
  afterAll(async () => {
    await nas.close();
  });
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'encoder-upload-'));
    file = join(dataDir, 'episode.mkv');
    requests = [];
    afterAnswer = () => {};
    await pairWithNas(dataDir, { code: await nas.ownerCode(), base: nas.base }, 'Seikou encoder on test');
    client = (await NasClient.load(dataDir, async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const path = url.pathname.replace(/^\/api\//, '');
      requests.push(`${method} ${path}`);
      const res = await fetch(input, init);
      afterAnswer(method, path);
      return res;
    }))!;
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(join(nas.encodesDir!, '990002'), { recursive: true, force: true });
    for (const f of readdirSync(join(nas.encodesDir!, '.uploads'), { withFileTypes: true })) rmSync(join(nas.encodesDir!, '.uploads', f.name), { force: true });
  });

  it('uploads in three pieces and the episode lands in the NAS index', async () => {
    writeFileSync(file, retagged(990002, 1));
    const state = fresh();
    const progress: number[] = [];
    const id = await uploadEpisode(client, file, '990002-1.mkv', state, { chunkBytes: CHUNK, sleep: noWait, onProgress: (sent) => progress.push(sent) });
    expect(id).toBe('990002-1');
    expect(puts()).toBe(3);
    expect(progress.at(-1)).toBe(state.size);
    expect(state.id).toBeNull();
    expect(existsSync(join(nas.encodesDir!, '990002/1.mkv'))).toBe(true);
    const entry = await client.json<{ id: string; anilistId: number; episode: number }>('encodes/990002-1');
    expect([entry.id, entry.anilistId, entry.episode]).toEqual(['990002-1', 990002, 1]);
  });

  it('after an abort following the first piece, a resume sends only the rest and opens nothing new', async () => {
    writeFileSync(file, retagged(990002, 1));
    const state = fresh();
    const controller = new AbortController();
    const states: UploadState[] = [];
    afterAnswer = (method) => {
      if (method === 'PUT') controller.abort();
    };
    await expect(uploadEpisode(client, file, '990002-1.mkv', state, { chunkBytes: CHUNK, sleep: noWait, signal: controller.signal, onState: (s) => states.push(s) })).rejects.toThrow();
    expect(puts()).toBe(1);
    expect(state.id).toMatch(/^[0-9a-f]{16}$/);
    expect(state.sent).toBe(CHUNK);
    expect(states.at(-1)).toEqual(state);

    afterAnswer = () => {};
    requests = [];
    expect(await uploadEpisode(client, file, '990002-1.mkv', state, { chunkBytes: CHUNK, sleep: noWait })).toBe('990002-1');
    expect(puts()).toBe(2);
    expect(requests.filter((r) => r === 'POST encodes/uploads')).toEqual([]);
  });

  it('a stored id the NAS forgot starts over', async () => {
    writeFileSync(file, retagged(990002, 1));
    const state = fresh();
    const controller = new AbortController();
    afterAnswer = (method) => {
      if (method === 'PUT') controller.abort();
    };
    await expect(uploadEpisode(client, file, '990002-1.mkv', state, { chunkBytes: CHUNK, sleep: noWait, signal: controller.signal })).rejects.toThrow();
    const forgotten = state.id!;
    for (const name of readdirSync(join(nas.encodesDir!, '.uploads'))) if (name.startsWith(forgotten)) rmSync(join(nas.encodesDir!, '.uploads', name));

    afterAnswer = () => {};
    requests = [];
    expect(await uploadEpisode(client, file, '990002-1.mkv', state, { chunkBytes: CHUNK, sleep: noWait })).toBe('990002-1');
    expect(requests.slice(0, 2)).toEqual([`GET encodes/uploads/${forgotten}`, 'POST encodes/uploads']);
    expect(puts()).toBe(3);
  });

  it('a file without ANILIST_ID is bad-tags, and the NAS keeps no upload of it', async () => {
    writeFileSync(file, retagged(990002, 1, { noAniList: true }));
    const state = fresh();
    const failure = await uploadEpisode(client, file, '990002-1.mkv', state, { chunkBytes: CHUNK, sleep: noWait }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UploadError);
    expect((failure as UploadError).code).toBe('bad-tags');
    expect(state.id).toBeNull();
    expect(readdirSync(join(nas.encodesDir!, '.uploads'))).toEqual([]);
  });

  it('a NAS with no encodes folder is not-configured', async () => {
    const bare = await startNasTestServer({ discs: false, encodes: false });
    try {
      await pairWithNas(dataDir, { code: await bare.ownerCode(), base: bare.base }, 'Seikou encoder on test');
      const other = (await NasClient.load(dataDir))!;
      writeFileSync(file, retagged(990002, 1));
      const failure = await uploadEpisode(other, file, '990002-1.mkv', fresh(), { sleep: noWait }).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(UploadError);
      expect((failure as UploadError).code).toBe('not-configured');
    } finally {
      await bare.close();
    }
  });
});
