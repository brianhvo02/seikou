// SPDX-License-Identifier: LGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appHandlers } from '../app';
import { Auth } from '../auth';
import { BdjStore } from '../bdj-store';
import { createServer, handle, markChannelRequest } from '../http';
import { Library } from '../library';
import { Store } from '../store';
import type { TitleLibrary } from '../routes/titles';
import { EncodeIndex } from './index-store';
import { MAX_CHUNK_BYTES, UploadStore } from './uploads';

const FIXTURE = join(import.meta.dirname, '../../../fixtures/encodes/990001');
let tmp: string;
let dir: string;
let base = '';
let close: (() => void) | undefined;
let auth: Auth;
let clock: number;
let free: number;
let index: EncodeIndex;
let uploads: UploadStore;
let handlers: ReturnType<typeof appHandlers>;

async function start(configured = true): Promise<void> {
  const data = join(tmp, 'data');
  dir = join(tmp, 'encodes');
  mkdirSync(dir, { recursive: true });
  auth = new Auth(new Store(data), Date.now);
  const library = new Library([], join(data, 'library.json'), { scanPauseMs: 0 });
  index = new EncodeIndex({ dir, dataDir: data, log: () => {}, settleMs: 0 });
  await index.scan();
  uploads = new UploadStore({ dir, index, log: () => {}, now: () => clock, freeBytes: async () => free });
  const titles = { service: { gate: () => 'everyone' }, owner: {} } as unknown as TitleLibrary;
  handlers = appHandlers({ auth, library, bdjStore: new BdjStore(data), publicBase: 'https://nas.example/bluray/api/', titles, ...(configured ? { encodes: index, encodeUploads: uploads } : {}) });
  const server = createServer(handlers);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.close();
    server.closeAllConnections();
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'encodes-uploads-'));
  clock = 1_000_000;
  free = 1e15;
});
afterEach(() => {
  close?.();
  index?.close();
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

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const ZERO = '0'.repeat(64);
const call = (method: string, path: string, t: string, init: { body?: Buffer | string; headers?: Record<string, string> } = {}): Promise<Response> =>
  fetch(`${base}/api/encodes/${path}`, { method, headers: { Authorization: `Bearer ${t}`, ...init.headers }, ...(init.body !== undefined ? { body: init.body } : {}) });
const create = (t: string, body: unknown): Promise<Response> => call('POST', 'uploads', t, { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const createId = async (t: string, body: unknown): Promise<string> => ((await (await create(t, body)).json()) as { id: string }).id;
const put = (t: string, id: string, bytes: Buffer, a: number, b: number): Promise<Response> =>
  call('PUT', `uploads/${id}`, t, { body: bytes.subarray(a, b + 1), headers: { 'Content-Range': `bytes ${a}-${b}/${bytes.length}` } });

describe('encode uploads', () => {
  it('an upload in three out-of-order chunks completes and files the episode', async () => {
    await start();
    const t = await token('Owner', true);
    const bytes = readFileSync(join(FIXTURE, '1.mkv'));
    const third = Math.floor(bytes.length / 3);
    const id = await createId(t, { size: bytes.length, sha256: sha(bytes), name: 'e1.mkv' });
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect((await put(t, id, bytes, 2 * third, bytes.length - 1)).status).toBe(204);
    expect((await put(t, id, bytes, 0, third - 1)).status).toBe(204);
    expect((await put(t, id, bytes, 0, third - 1)).status).toBe(204);
    const early = await call('POST', `uploads/${id}/complete`, t);
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({ error: 'incomplete', missing: [[third, 2 * third - 1]] });
    expect(await (await call('GET', `uploads/${id}`, t)).json()).toEqual({ size: bytes.length, ranges: [[0, third - 1], [2 * third, bytes.length - 1]] });
    expect((await put(t, id, bytes, third, 2 * third - 1)).status).toBe(204);
    const done = await call('POST', `uploads/${id}/complete`, t);
    expect(done.status).toBe(200);
    const { entry } = (await done.json()) as { entry: { id: string; path?: string } };
    expect(entry.id).toBe('990001-1');
    expect(entry.path).toBeUndefined();
    expect(readFileSync(join(dir, '990001/1.mkv')).equals(bytes)).toBe(true);
    expect(index.get('990001-1')).not.toBeNull();
    expect(readdirSync(join(dir, '.uploads'))).toEqual([]);
  });

  it('a wrong hash is refused and nothing is listed', async () => {
    await start();
    const t = await token('Owner', true);
    const bytes = readFileSync(join(FIXTURE, '1.mkv'));
    const id = await createId(t, { size: bytes.length, sha256: ZERO, name: 'e1.mkv' });
    await put(t, id, bytes, 0, bytes.length - 1);
    const r = await call('POST', `uploads/${id}/complete`, t);
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'hash-mismatch' });
    expect(index.list()).toEqual([]);
    expect(existsSync(join(dir, '990001'))).toBe(false);
    expect(readdirSync(join(dir, '.uploads'))).toEqual([]);
  });

  it('replacing an episode keeps the old file until the new upload completes', async () => {
    await start();
    mkdirSync(join(dir, '990001'), { recursive: true });
    cpSync(join(FIXTURE, '1.mkv'), join(dir, '990001/1.mkv'));
    const old = readFileSync(join(dir, '990001/1.mkv'));
    const t = await token('Owner', true);
    const id = await createId(t, { size: old.length, sha256: sha(old), name: 'again.mkv' });
    await put(t, id, old, 0, 99);
    expect(readFileSync(join(dir, '990001/1.mkv')).equals(old)).toBe(true);
    await put(t, id, old, 100, old.length - 1);
    expect(readFileSync(join(dir, '990001/1.mkv')).equals(old)).toBe(true);
    expect((await call('POST', `uploads/${id}/complete`, t)).status).toBe(200);
    expect(readdirSync(join(dir, '990001'))).toEqual(['1.mkv']);
    expect(readdirSync(join(dir, '.uploads'))).toEqual([]);
  });

  it('a guest device gets 403', async () => {
    await start();
    const g = await token('Guest', false);
    expect((await create(g, { size: 10, sha256: ZERO, name: 'x.mkv' })).status).toBe(403);
    expect((await call('GET', 'uploads/0123456789abcdef', g)).status).toBe(403);
    expect((await call('DELETE', '990001-1', g)).status).toBe(403);
  });

  it('a WebRTC request gets 403 https-only', async () => {
    await start();
    const t = await token('Owner', true);
    const req = Object.assign(Readable.from([]), { method: 'POST', url: '/api/encodes/uploads', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' } }) as unknown as IncomingMessage;
    markChannelRequest(req);
    const res = await handle(handlers, req);
    expect(res.status).toBe(403);
    expect(JSON.parse(String(res.body))).toEqual({ error: 'https-only' });
  });

  it('not enough room answers 507', async () => {
    await start();
    const t = await token('Owner', true);
    free = 1024 * 1024 * 1024 + 99;
    const r = await create(t, { size: 100, sha256: ZERO, name: 'x.mkv' });
    expect(r.status).toBe(507);
    expect(await r.json()).toEqual({ error: 'no-room' });
  });

  it('an upload untouched for 24 h is removed', async () => {
    await start();
    const t = await token('Owner', true);
    const id = await createId(t, { size: 100, sha256: ZERO, name: 'x.mkv' });
    clock += 24 * 3600_000 - 1;
    expect(await uploads.sweep()).toBe(0);
    clock += 2;
    expect(await uploads.sweep()).toBe(1);
    expect((await call('GET', `uploads/${id}`, t)).status).toBe(404);
    expect(readdirSync(join(dir, '.uploads'))).toEqual([]);
  });

  it('missing tags answer 422 bad-tags and keep the upload', async () => {
    await start();
    const t = await token('Owner', true);
    const bytes = Buffer.from('not a matroska file');
    const id = await createId(t, { size: bytes.length, sha256: sha(bytes), name: 'x.mkv' });
    await put(t, id, bytes, 0, bytes.length - 1);
    const r = await call('POST', `uploads/${id}/complete`, t);
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'bad-tags' });
    expect(index.list()).toEqual([]);
    expect(readdirSync(join(dir, '.uploads')).sort()).toEqual([`${id}.json`, `${id}.partial`]);
    expect((await call('DELETE', `uploads/${id}`, t)).status).toBe(204);
    expect(readdirSync(join(dir, '.uploads'))).toEqual([]);
  });

  it('refuses a second open upload of a name, and bad ranges', async () => {
    await start();
    const t = await token('Owner', true);
    const body = { size: 100, sha256: ZERO, name: 'x.mkv' };
    const id = await createId(t, body);
    const dup = await create(t, body);
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: 'in-progress' });
    const bytes = Buffer.alloc(100);
    expect((await call('PUT', `uploads/${id}`, t, { body: bytes, headers: { 'Content-Range': 'bytes 0-99/101' } })).status).toBe(400);
    expect((await call('PUT', `uploads/${id}`, t, { body: bytes, headers: { 'Content-Range': 'bytes 50-149/100' } })).status).toBe(400);
    expect((await call('PUT', `uploads/${id}`, t, { body: bytes.subarray(0, 40), headers: { 'Content-Range': 'bytes 0-49/100' } })).status).toBe(400);
    expect(await (await call('GET', `uploads/${id}`, t)).json()).toEqual({ size: 100, ranges: [] });
  });

  it('a chunk over 16 MiB answers 413', async () => {
    await start();
    const t = await token('Owner', true);
    const size = MAX_CHUNK_BYTES + 10;
    const id = await createId(t, { size, sha256: ZERO, name: 'big.mkv' });
    const r = await call('PUT', `uploads/${id}`, t, { body: Buffer.alloc(MAX_CHUNK_BYTES + 1), headers: { 'Content-Range': `bytes 0-${MAX_CHUNK_BYTES}/${size}` } });
    expect(r.status).toBe(413);
  });

  it('DELETE removes an encode and its file', async () => {
    await start();
    mkdirSync(join(dir, '990001'), { recursive: true });
    cpSync(join(FIXTURE, '1.mkv'), join(dir, '990001/1.mkv'));
    await index.scan();
    const t = await token('Owner', true);
    expect((await call('DELETE', '990001-1', t)).status).toBe(204);
    expect(existsSync(join(dir, '990001/1.mkv'))).toBe(false);
    expect(index.get('990001-1')).toBeNull();
    expect((await call('DELETE', '990001-1', t)).status).toBe(404);
  });

  it('without ENCODES_DIR every upload route answers 404 not-configured', async () => {
    await start(false);
    const t = await token('Owner', true);
    const r = await create(t, { size: 10, sha256: ZERO, name: 'x.mkv' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not-configured' });
  });
});
