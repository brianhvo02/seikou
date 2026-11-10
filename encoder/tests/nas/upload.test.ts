// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NasClient } from '../../src/nas/client';
import { pairWithNas } from '../../src/nas/pairing';
import { completionTimeoutMs, uploadEpisode, UploadError, type UploadState } from '../../src/nas/upload';
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
  /** Whether the answer to a request is lost on the way back (the NAS has acted on it). */
  let dropAnswer: (method: string, path: string) => boolean;

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
    dropAnswer = () => false;
    await pairWithNas(dataDir, { code: await nas.ownerCode(), base: nas.base }, 'Seikou encoder on test');
    client = (await NasClient.load(dataDir, async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const path = url.pathname.replace(/^\/api\//, '');
      requests.push(`${method} ${path}`);
      const res = await fetch(input, init);
      afterAnswer(method, path);
      if (dropAnswer(method, path)) {
        await res.body?.cancel();
        throw new TypeError('fetch failed');
      }
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

  it('a lost answer to the POST resumes the upload the NAS opened, with no lockout', async () => {
    writeFileSync(file, retagged(990002, 1));
    let lost = false;
    dropAnswer = (method, path) => {
      if (method !== 'POST' || path !== 'encodes/uploads' || lost) return false;
      lost = true;
      return true;
    };
    const state = fresh();
    expect(await uploadEpisode(client, file, '990002-1.mkv', state, { chunkBytes: CHUNK, sleep: noWait })).toBe('990002-1');
    expect(requests.filter((r) => r === 'POST encodes/uploads')).toHaveLength(2);
    expect(puts()).toBe(3);
    expect(readdirSync(join(nas.encodesDir!, '.uploads'))).toEqual([]);

    // the app gone before it kept the id: a fresh state opens the same upload again and sends only what is missing
    rmSync(join(nas.encodesDir!, '990002'), { recursive: true, force: true });
    const controller = new AbortController();
    afterAnswer = (method) => {
      if (method === 'PUT') controller.abort();
    };
    const first = fresh();
    await expect(uploadEpisode(client, file, '990002-1.mkv', first, { chunkBytes: CHUNK, sleep: noWait, signal: controller.signal })).rejects.toThrow();
    afterAnswer = () => {};
    requests = [];
    const again = fresh();
    expect(await uploadEpisode(client, file, '990002-1.mkv', again, { chunkBytes: CHUNK, sleep: noWait, onState: (s) => expect(s.id === null || s.id === first.id).toBe(true) })).toBe('990002-1');
    expect(puts()).toBe(2);
  });

  it('a completion whose answer was lost counts as done once the NAS lists the episode at its size, sending nothing again', async () => {
    writeFileSync(file, retagged(990002, 1));
    let lost = false;
    dropAnswer = (method, path) => {
      if (method !== 'POST' || !path.endsWith('/complete') || lost) return false;
      lost = true;
      return true;
    };
    const state = fresh();
    expect(await uploadEpisode(client, file, '990002-1.mkv', state, { chunkBytes: CHUNK, sleep: noWait })).toBe('990002-1');
    expect(puts()).toBe(3);
    expect(requests.filter((r) => r === 'POST encodes/uploads')).toHaveLength(1);
    expect(requests).toContain('GET encodes/990002-1');
    expect([state.id, state.completing]).toEqual([null, undefined]);
  });

  it('a completion that never answered is checked by the next call, which then counts it done', async () => {
    writeFileSync(file, retagged(990002, 1));
    // every answer to the completion is lost: the first files the episode, the retries are 404s nobody sees
    dropAnswer = (method, path) => method === 'POST' && path.endsWith('/complete');
    const state = fresh();
    const failure = await uploadEpisode(client, file, '990002-1.mkv', state, { chunkBytes: CHUNK, sleep: noWait }).catch((e: unknown) => e);
    expect((failure as UploadError).code).toBe('unreachable');
    expect(state.completing).toBe(true);
    const uploadId = state.id!;

    dropAnswer = () => false;
    requests = [];
    expect(await uploadEpisode(client, file, '990002-1.mkv', state, { chunkBytes: CHUNK, sleep: noWait })).toBe('990002-1');
    expect(requests).toEqual([`GET encodes/uploads/${uploadId}`, 'GET encodes/990002-1']);
  });

  it('a 404 after a completion, with another file of the episode on the NAS, starts over', async () => {
    // the NAS holds an earlier file of the episode
    writeFileSync(file, retagged(990002, 1));
    await uploadEpisode(client, file, '990002-1.mkv', fresh(), { chunkBytes: CHUNK, sleep: noWait });
    // a longer file's upload, stopped after its first piece, whose completion was sent (as far as the state knows) and
    // which the NAS then forgot
    writeFileSync(file, Buffer.concat([retagged(990002, 1), Buffer.alloc(1000)]));
    const state = fresh();
    const controller = new AbortController();
    afterAnswer = (method) => {
      if (method === 'PUT') controller.abort();
    };
    await expect(uploadEpisode(client, file, '990002-1.mkv', state, { chunkBytes: CHUNK, sleep: noWait, signal: controller.signal })).rejects.toThrow();
    for (const name of readdirSync(join(nas.encodesDir!, '.uploads'))) if (name.startsWith(state.id!)) rmSync(join(nas.encodesDir!, '.uploads', name));
    state.completing = true;

    afterAnswer = () => {};
    requests = [];
    expect(await uploadEpisode(client, file, '990002-1.mkv', state, { chunkBytes: CHUNK, sleep: noWait })).toBe('990002-1');
    expect(requests.slice(0, 3)).toEqual([expect.stringMatching(/^GET encodes\/uploads\//), 'GET encodes/990002-1', 'POST encodes/uploads']);
    expect(puts()).toBe(3);
  });

  it('gives the completion a time limit that grows with the file', () => {
    expect(completionTimeoutMs(0)).toBe(60_000);
    expect(completionTimeoutMs(50 * 1024 * 1024)).toBe(61_000);
    expect(completionTimeoutMs(4 * 1024 * 1024 * 1024)).toBe(60_000 + 82_000);
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
