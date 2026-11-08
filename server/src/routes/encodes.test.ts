// SPDX-License-Identifier: LGPL-3.0-or-later
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscManifest } from '@seikou/nas/nas-api';
import { appHandlers } from '../app';
import { Auth } from '../auth';
import { BdjStore } from '../bdj-store';
import { EncodeIndex } from '../encodes/index-store';
import { createServer } from '../http';
import { Library } from '../library';
import { Store } from '../store';
import type { TitleLibrary } from './titles';

const FIXTURE = join(import.meta.dirname, '../../../fixtures/encodes/990001');
let tmp: string;
let base = '';
let close: (() => void) | undefined;
let auth: Auth;
let gate: 'owners' | 'everyone';

async function start(configured: boolean): Promise<void> {
  const data = join(tmp, 'data');
  const dir = join(tmp, 'encodes');
  mkdirSync(join(dir, '990001'), { recursive: true });
  cpSync(join(FIXTURE, '1.mkv'), join(dir, '990001/1.mkv'));
  auth = new Auth(new Store(data), Date.now);
  const library = new Library([], join(data, 'library.json'), { scanPauseMs: 0 });
  const encodes = configured ? new EncodeIndex({ dir, dataDir: data, log: () => {} }) : undefined;
  if (encodes) void encodes.scan();
  const titles = { service: { gate: () => gate }, owner: {} } as unknown as TitleLibrary;
  const server = createServer(appHandlers({
    auth, library, bdjStore: new BdjStore(data), publicBase: 'https://nas.example/bluray/api/', titles, ...(encodes ? { encodes } : {}),
  }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.close();
    server.closeAllConnections();
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'encodes-routes-'));
  gate = 'everyone';
});
afterEach(() => {
  close?.();
  rmSync(tmp, { recursive: true, force: true });
});

async function token(name: string, owner: boolean): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const { code } = auth.createCode({ newPerson: { name, owner } });
  const device = auth.redeem(code, `${name}'s phone`, jwk)!;
  const challenge = auth.challenge(device.id)!;
  const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(challenge))).toString('base64url');
  return auth.startSession(device.id, challenge, signature)!.token;
}

const get = (path: string, t: string | null, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/api/encodes/${path}`, { headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...headers } });

describe('encodes routes', () => {
  it('serves a range of an episode with 206 and 416 out of range', async () => {
    await start(true);
    const t = await token('Guest', false);
    const bytes = readFileSync(join(FIXTURE, '1.mkv'));
    const manifest = (await (await get('990001-1/manifest', t)).json()) as DiscManifest;
    expect(manifest).toEqual({ discId: '990001-1', name: 'The Lantern Road', files: [{ path: 'EPISODE.MKV', size: bytes.length }], inline: {} });
    const part = await get('990001-1/files/EPISODE.MKV', t, { Range: 'bytes=100-299' });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 100-299/${bytes.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 300))).toBe(true);
    const whole = await get('990001-1/files/EPISODE.MKV', t);
    expect(whole.status).toBe(200);
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);
    expect((await get('990001-1/files/EPISODE.MKV', t, { Range: `bytes=${bytes.length}-` })).status).toBe(416);
    expect((await get('990001-9/manifest', t)).status).toBe(404);
    expect((await get('990001-1/files/OTHER.MKV', t)).status).toBe(404);
    expect((await get('990001-1/manifest', null)).status).toBe(401);
  });

  it('answers the details without the server path', async () => {
    await start(true);
    const t = await token('Guest', false);
    const detail = (await (await get('990001-1', t)).json()) as Record<string, unknown>;
    expect(detail).toMatchObject({ id: '990001-1', anilistId: 990001, episode: 1, episodeTitle: 'The Lantern Road' });
    expect(detail.path).toBeUndefined();
    expect((detail.chapters as unknown[]).length).toBe(5);
    expect((detail.tracks as unknown[]).length).toBe(4);
    expect(JSON.stringify(detail)).not.toContain(tmp);
  });

  it('status says not configured without ENCODES_DIR', async () => {
    await start(false);
    const t = await token('Owner', true);
    expect(await (await get('status', t)).json()).toEqual({ configured: false, count: 0 });
    expect((await get('990001-1/manifest', t)).status).toBe(404);
  });

  it('status counts the indexed episodes once the first scan is done', async () => {
    await start(true);
    const t = await token('Owner', true);
    expect(await (await get('status', t)).json()).toEqual({ configured: true, count: 1 });
  });

  it('a guest behind a closed gate gets 404', async () => {
    await start(true);
    gate = 'owners';
    const guest = await token('Guest', false);
    const owner = await token('Owner', true);
    expect((await get('status', guest)).status).toBe(404);
    expect((await get('990001-1/manifest', guest)).status).toBe(404);
    expect((await get('990001-1/files/EPISODE.MKV', guest)).status).toBe(404);
    expect((await get('990001-1/manifest', owner)).status).toBe(200);
  });
});
