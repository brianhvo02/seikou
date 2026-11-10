// SPDX-License-Identifier: LGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
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
/** `bytes` with every `from` replaced by `to`, which must have the same length. */
function patch(bytes: Buffer, from: string, to: string): Buffer {
  expect(to.length).toBe(from.length);
  const out = Buffer.from(bytes);
  let n = 0;
  for (let at = out.indexOf(from); at >= 0; at = out.indexOf(from, at + from.length)) {
    out.write(to, at);
    n++;
  }
  expect(n).toBeGreaterThan(0);
  return out;
}
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
    await index.scan();
    const old = readFileSync(join(dir, '990001/1.mkv'));
    const fresh = Buffer.concat([patch(old, 'The Lantern Road', 'The Lantern Toad'), Buffer.alloc(4096)]);
    expect(fresh.length).not.toBe(old.length);
    const t = await token('Owner', true);
    // a viewer is streaming the old file
    const viewing = await call('GET', '990001-1/files/EPISODE.MKV', t);
    const reader = viewing.body!.getReader();
    const first = await reader.read();
    const id = await createId(t, { size: fresh.length, sha256: sha(fresh), name: 'again.mkv' });
    await put(t, id, fresh, 0, 99);
    await put(t, id, fresh, 100, fresh.length - 1);
    expect(readFileSync(join(dir, '990001/1.mkv')).equals(old)).toBe(true);
    expect(index.get('990001-1')!.size).toBe(old.length);
    const done = await call('POST', `uploads/${id}/complete`, t);
    expect(done.status).toBe(200);
    // the stream that began before the rename reads the old bytes to its end
    const parts: Buffer[] = [Buffer.from(first.value!)];
    for (let r = await reader.read(); !r.done; r = await reader.read()) parts.push(Buffer.from(r.value));
    expect(Buffer.concat(parts).equals(old)).toBe(true);
    expect(readFileSync(join(dir, '990001/1.mkv')).equals(fresh)).toBe(true);
    expect(index.get('990001-1')!.size).toBe(fresh.length);
    expect(index.get('990001-1')!.episodeTitle).toBe('The Lantern Toad');
    expect(readdirSync(join(dir, '990001'))).toEqual(['1.mkv']);
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
    // a valid MKV whose tag names are changed to ones the index doesn't know
    const bytes = patch(patch(readFileSync(join(FIXTURE, '1.mkv')), 'ANILIST_ID', 'ANILIST_IX'), 'EPISODE', 'EPISODX');
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

  it("answers a device's own open upload of the same file again, replaces one of another file, and refuses another device's", async () => {
    await start();
    const t = await token('Owner', true);
    const body = { size: 100, sha256: ZERO, name: 'x.mkv' };
    const id = await createId(t, body);
    expect((await put(t, id, Buffer.alloc(100), 0, 39)).status).toBe(204);
    // the same device asks again, as after a lost answer: the same upload, its stored range kept
    const again = await create(t, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id });
    expect(await (await call('GET', `uploads/${id}`, t)).json()).toEqual({ size: 100, ranges: [[0, 39]] });
    // another file under the name from the same device: the old upload goes, a new one opens
    const other = await createId(t, { size: 120, sha256: '1'.repeat(64), name: 'x.mkv' });
    expect(other).not.toBe(id);
    expect((await call('GET', `uploads/${id}`, t)).status).toBe(404);
    expect(readdirSync(join(dir, '.uploads')).sort()).toEqual([`${other}.json`, `${other}.partial`]);
    // another device's upload of the name stands
    const t2 = await token('Second owner', true);
    const dup = await create(t2, { size: 120, sha256: '1'.repeat(64), name: 'x.mkv' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: 'in-progress' });
  });

  it('refuses bad ranges', async () => {
    await start();
    const t = await token('Owner', true);
    const body = { size: 100, sha256: ZERO, name: 'x.mkv' };
    const id = await createId(t, body);
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

  it('counts the bytes open uploads still owe in the room check', async () => {
    await start();
    const t = await token('Owner', true);
    const GiB = 1024 * 1024 * 1024;
    free = 3 * GiB;
    expect((await create(t, { size: GiB, sha256: ZERO, name: 'a.mkv' })).status).toBe(200);
    // 1 GiB is owed, so this one needs 1 + 1 + 1 GiB of room and there are 3
    expect((await create(t, { size: GiB, sha256: ZERO, name: 'b.mkv' })).status).toBe(200);
    const r = await create(t, { size: GiB, sha256: ZERO, name: 'c.mkv' });
    expect(r.status).toBe(507);
  });

  it('caps open uploads at 8 per device', async () => {
    await start();
    const t = await token('Owner', true);
    for (let i = 0; i < 8; i++) expect((await create(t, { size: 10, sha256: ZERO, name: `${i}.mkv` })).status).toBe(200);
    const r = await create(t, { size: 10, sha256: ZERO, name: '8.mkv' });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: 'too-many-uploads' });
  });

  it('two POSTs of one name at once leave one upload', async () => {
    await start();
    const t = await token('Owner', true);
    const body = { size: 10, sha256: ZERO, name: 'same.mkv' };
    const answers = await Promise.all([create(t, body), create(t, body), create(t, body)]);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    const ids = await Promise.all(answers.map(async (r) => ((await r.json()) as { id: string }).id));
    expect(new Set(ids).size).toBe(1);
    expect(readdirSync(join(dir, '.uploads')).sort()).toEqual([`${ids[0]}.json`, `${ids[0]}.partial`]);
    // from two devices, one stands and the other is refused
    const t2 = await token('Second owner', true);
    const other = { size: 10, sha256: ZERO, name: 'other.mkv' };
    const statuses = (await Promise.all([create(t, other), create(t2, other)])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('refused PUTs close the connection', async () => {
    await start();
    const t = await token('Owner', true);
    const range = { 'Content-Range': 'bytes 0-0/10' };
    // (a missing token is answered 401 by the global token guard before these routes)
    const guest = await token('Guest', false);
    const forbidden = await call('PUT', 'uploads/0123456789abcdef', guest, { body: 'x', headers: range });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('connection')).toBe('close');
    const badId = await call('PUT', 'uploads/nope', t, { body: 'x', headers: range });
    expect(badId.status).toBe(404);
    expect(badId.headers.get('connection')).toBe('close');
    const missing = await call('PUT', 'uploads/0123456789abcdef', t, { body: 'x', headers: range });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('connection')).toBe('close');
    close?.();
    index.close();
    await start(false);
    const t2 = await token('Owner2', true);
    const off = await call('PUT', 'uploads/0123456789abcdef', t2, { body: 'x', headers: range });
    expect(off.status).toBe(404);
    expect(off.headers.get('connection')).toBe('close');
  });

  it('a failure to list after the rename answers 200 with entry null and filed', async () => {
    await start();
    const t = await token('Owner', true);
    const bytes = readFileSync(join(FIXTURE, '1.mkv'));
    const id = await createId(t, { size: bytes.length, sha256: sha(bytes), name: 'e1.mkv' });
    await put(t, id, bytes, 0, bytes.length - 1);
    index.add = async () => {
      throw new Error('disk full');
    };
    const r = await call('POST', `uploads/${id}/complete`, t);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ entry: null, filed: '990001-1' });
    expect(readFileSync(join(dir, '990001/1.mkv')).equals(bytes)).toBe(true);
  });

  it('refuses 503 encodes-folder-unavailable when the folder is missing, and never makes it', async () => {
    await start();
    const t = await token('Owner', true);
    rmSync(dir, { recursive: true, force: true });
    const r = await create(t, { size: 100, sha256: ZERO, name: 'x.mkv' });
    expect(r.status).toBe(503);
    const body = (await r.json()) as { error: string; message: string };
    expect(body.error).toBe('encodes-folder-unavailable');
    expect(body.message).toMatch(/encodes folder/);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses 503 encodes-folder-unavailable while the index reports the folder missing', async () => {
    await start();
    const t = await token('Owner', true);
    const moved = join(tmp, 'moved');
    renameSync(dir, moved);
    await index.scan();
    expect(index.state().rootMissing).toBe(true);
    // back in place, but the index hasn't seen it yet: still refused
    renameSync(moved, dir);
    const r = await create(t, { size: 100, sha256: ZERO, name: 'x.mkv' });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toBe('encodes-folder-unavailable');
  });

  it('refuses 503 encodes-folder-unavailable while the folder is empty and the library still lists episodes', async () => {
    await start();
    mkdirSync(join(dir, '990001'), { recursive: true });
    cpSync(join(FIXTURE, '1.mkv'), join(dir, '990001/1.mkv'));
    await index.scan();
    const t = await token('Owner', true);
    const bytes = readFileSync(join(FIXTURE, '2.mkv'));
    const id = await createId(t, { size: bytes.length, sha256: sha(bytes), name: 'e2.mkv' });
    await put(t, id, bytes, 0, bytes.length - 1);
    rmSync(join(dir, '990001'), { recursive: true, force: true });
    await index.scan();
    expect(index.state().rootEmpty).toBe(true);
    const r = await create(t, { size: 100, sha256: ZERO, name: 'x.mkv' });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toBe('encodes-folder-unavailable');
    // completing an upload made before is refused too, and files nothing
    const done = await call('POST', `uploads/${id}/complete`, t);
    expect(done.status).toBe(503);
    expect(((await done.json()) as { error: string }).error).toBe('encodes-folder-unavailable');
    expect(existsSync(join(dir, '990001'))).toBe(false);
  });

  it('refuses 409 bad-folder when the AniList folder is not a directory', async () => {
    await start();
    const t = await token('Owner', true);
    const bytes = readFileSync(join(FIXTURE, '1.mkv'));
    symlinkSync(tmp, join(dir, '990001'));
    const id = await createId(t, { size: bytes.length, sha256: sha(bytes), name: 'e1.mkv' });
    await put(t, id, bytes, 0, bytes.length - 1);
    const r = await call('POST', `uploads/${id}/complete`, t);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'bad-folder' });
    expect(existsSync(join(tmp, '1.mkv'))).toBe(false);
  });
});
