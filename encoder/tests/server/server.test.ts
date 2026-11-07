// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureFansubSources } from '@seikou/fansubs/fixture-sources';
import type { DiscManifest } from '@seikou/nas/nas-api';
import { startHelperServer, type HelperContext } from '../../src/server/server';
import { fixtureAniList } from '../../src/subs/fixture-anilist';
import { fx } from '../paths';

const TOKEN = 'helper-test-token';
const FANSUBS = fileURLToPath(new URL('../fixtures/fansubs/', import.meta.url));
/** One frame at 23.976 fps, in microseconds: the planner puts episode edges on frame boundaries. */
const FRAME_US = 1_001_000 / 24;

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

let server: Awaited<ReturnType<typeof startHelperServer>>;
let dataDir: string;
let webDir: string;

/** A raw request: the path goes out as written (`..` survives) and the Host header can be set, unlike fetch. */
function send(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };
const api = (path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> =>
  send(path, { ...auth, ...headers }, method);
const body = <T>(reply: Reply): T => JSON.parse(reply.body.toString('utf8')) as T;

async function discKey(): Promise<string> {
  return body<{ discKey: string }>(await api('/api/session')).discKey;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'helper-data-'));
  webDir = mkdtempSync(join(tmpdir(), 'helper-web-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>helper</title>');
  const fansubs = fixtureFansubSources(FANSUBS);
  const anilist = fixtureAniList(FANSUBS);
  const ctx: HelperContext = {
    discDir: fx('fixtures/disc-speech'),
    playlistId: '00000',
    episodeSpec: '1-3,4-5',
    dataDir,
    token: TOKEN,
    webDir,
    tools: null,
    sources: { seadex: fansubs.seadex, tosho: fansubs.tosho, anilist: anilist.source, episodes: anilist.episodes },
  };
  server = await startHelperServer(ctx);
});

afterAll(async () => {
  await server?.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(webDir, { recursive: true, force: true });
});

describe('helper server', () => {
  it('listens on loopback', () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
  });

  it('session names the disc and spec', async () => {
    const reply = await api('/api/session');
    expect(reply.status).toBe(200);
    const session = body<{ discKey: string; label: string; playlistId: string; episodeSpec: string; toolsReady: boolean }>(reply);
    expect(session.discKey).toMatch(/^f\.[0-9A-F]{32}$/);
    expect(session).toMatchObject({ label: 'disc-speech', playlistId: '00000', episodeSpec: '1-3,4-5', toolsReady: false });
  });

  it('manifest lists the disc\'s files and inlines the playlist', async () => {
    const reply = await api(`/api/discs/${await discKey()}/manifest`);
    expect(reply.status).toBe(200);
    const manifest = body<DiscManifest>(reply);
    expect(manifest.name).toBe('disc-speech');
    expect(manifest.files.map((f) => f.path)).toContain('BDMV/STREAM/00001.M2TS');
    expect(manifest.inline['BDMV/PLAYLIST/00000.MPLS']).toBeTypeOf('string');
    expect(manifest.inline['BDMV/STREAM/00001.M2TS']).toBeUndefined();
  });

  it('serves a range', async () => {
    const reply = await send(`/api/discs/${await discKey()}/files/BDMV/STREAM/00001.M2TS?t=${TOKEN}`, { range: 'bytes=0-191' });
    expect(reply.status).toBe(206);
    expect(reply.body.length).toBe(192);
    expect(reply.body[4]).toBe(0x47);
    expect(reply.headers['content-range']).toMatch(/^bytes 0-191\/\d+$/);
  });

  it('answers HEAD on a file without a body', async () => {
    const reply = await api(`/api/discs/${await discKey()}/files/BDMV/INDEX.BDMV`, {}, 'HEAD');
    expect(reply.status).toBe(200);
    expect(Number(reply.headers['content-length'])).toBeGreaterThan(0);
    expect(reply.body.length).toBe(0);
  });

  it('lists the playlists', async () => {
    const playlists = body<{ id: string; duration45: number; clipIds: string[] }[]>(await api('/api/playlists'));
    expect(playlists.map((p) => p.id)).toEqual(['00000']);
    expect(playlists[0]!.clipIds).toEqual(['00001', '00002']);
  });

  it('episodes give playlist times', async () => {
    const reply = await api('/api/episodes');
    expect(reply.status).toBe(200);
    const answer = body<{
      episodes: { index: number; startUs: number; durationUs: number; chapters: { startUs: number }[] }[];
      audio: { pid: number; codingType: number; language: string }[];
      pgCount: number;
    }>(reply);
    expect(answer.episodes.map((e) => e.index)).toEqual([1, 2]);
    const [first, second] = answer.episodes;
    expect(first!.startUs).toBe(0);
    expect(first!.chapters).toHaveLength(3);
    expect(second!.startUs).toBe(90_000_000);
    expect(Math.abs(second!.durationUs - 60_000_000)).toBeLessThanOrEqual(FRAME_US);
    expect(second!.chapters).toHaveLength(2);
    expect(second!.chapters[0]!.startUs).toBe(90_000_000);
    expect(Math.abs(second!.chapters[1]!.startUs - 120_000_000)).toBeLessThanOrEqual(FRAME_US);
    expect(answer.audio.length).toBeGreaterThan(0);
    expect(answer.audio[0]).toMatchObject({ pid: expect.any(Number), codingType: expect.any(Number), language: expect.any(String) });
    expect(answer.pgCount).toBeGreaterThanOrEqual(0);
  });

  it('refuses without a token', async () => {
    for (const reply of [await send('/api/session'), await send('/api/session', { authorization: 'Bearer wrong' }), await send('/api/session?t=wrong')]) {
      expect(reply.status).toBe(401);
      expect(body<{ error: string }>(reply).error).toBe('unauthorized');
    }
    expect((await send(`/api/session?t=${TOKEN}`)).status).toBe(200);
  });

  it('refuses a foreign Host', async () => {
    const reply = await api('/api/session', { host: `evil.example:${server.port}` });
    expect(reply.status).toBe(403);
    expect(body<{ error: string }>(reply).error).toBe('bad-host');
    expect((await send('/', { host: `evil.example:${server.port}` })).status).toBe(403);
    expect((await api('/api/session', { host: `localhost:${server.port}` })).status).toBe(200);
    expect((await api('/api/session', { host: `127.0.0.1:${server.port + 1}` })).status).toBe(403);
  });

  it('refuses .. in a path', async () => {
    const key = await discKey();
    for (const path of [
      `/api/discs/${key}/files/BDMV/../BDMV/INDEX.BDMV`,
      `/api/discs/${key}/files/BDMV/%2e%2e/BDMV/INDEX.BDMV`,
      `/api/discs/${key}/files/BDMV//INDEX.BDMV`,
      `/api/discs/${key}/files/BDMV/./INDEX.BDMV`,
      '/../index.html',
    ]) {
      const reply = await api(path);
      expect(reply.status, path).toBe(400);
      expect(body<{ error: string }>(reply).error).toBe('bad-path');
    }
  });

  it('answers 416 past the end', async () => {
    const key = await discKey();
    const manifest = body<DiscManifest>(await api(`/api/discs/${key}/manifest`));
    const size = manifest.files.find((f) => f.path === 'BDMV/STREAM/00001.M2TS')!.size;
    const reply = await api(`/api/discs/${key}/files/BDMV/STREAM/00001.M2TS`, { range: `bytes=${size}-${size + 10}` });
    expect(reply.status).toBe(416);
    expect(reply.headers['content-range']).toBe(`bytes */${size}`);
  });

  it('answers 404 disc-changed for another disc key', async () => {
    const other = `f.${'0'.repeat(32)}`;
    for (const path of [`/api/discs/${other}/manifest`, `/api/discs/${other}/files/BDMV/INDEX.BDMV`]) {
      const reply = await api(path);
      expect(reply.status).toBe(404);
      expect(body<{ error: string }>(reply).error).toBe('disc-changed');
    }
  });

  it('answers 404 for a file the disc does not have, and for an unknown route', async () => {
    const missing = await api(`/api/discs/${await discKey()}/files/BDMV/STREAM/09999.M2TS`);
    expect(missing.status).toBe(404);
    expect(body<{ error: string }>(missing).error).toBe('not-found');
    const unknown = await api('/api/nothing');
    expect(unknown.status).toBe(404);
    expect(body<{ error: string }>(unknown).error).toBe('not-found');
    const wrongMethod = await api('/api/session', {}, 'DELETE');
    expect(wrongMethod.status).toBe(405);
  });

  it('serves the page without a token', async () => {
    const page = await send('/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.body.toString()).toContain('<title>helper</title>');
    expect((await send('/missing.js')).status).toBe(404);
  });

  it('sets the isolation headers on the page and the API', async () => {
    const replies = [await send('/'), await api('/api/session'), await send('/api/session'), await api('/api/nothing')];
    for (const reply of replies) {
      expect(reply.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(reply.headers['cross-origin-embedder-policy']).toBe('require-corp');
      expect(reply.headers['cross-origin-resource-policy']).toBe('same-origin');
    }
    for (const reply of replies.slice(1)) expect(reply.headers['cache-control']).toBe('no-store');
  });
});
