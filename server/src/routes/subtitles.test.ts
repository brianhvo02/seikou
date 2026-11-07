import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoredSubtitle } from '@seikou/nas/nas-api';
import { appHandlers } from '../app';
import { Auth } from '../auth';
import { BdjStore } from '../bdj-store';
import { createServer } from '../http';
import type { Library } from '../library';
import { Store } from '../store';
import { SubtitleStore } from '../subtitle-store';
import type { Catalogue } from '@seikou/titles/catalogue';
import type { DiscEvidence } from '../titles/evidence';
import type { TitleLibrary } from './titles';

// Every name here is made up.

const FP = 'C'.repeat(32);
const KEY = `f.${FP}`;
const DISC2 = '0123456789abcdef';
const KEY2 = `d.${DISC2}`;
const playlist = (id: string, chapters = 5) => ({ id, durationS: 1400, chapters, clips: ['00001'] });
const summary = { id: 'star', kind: 'series', names: { english: 'Starfall Wanderer', romaji: null, native: null, synonyms: [], display: null }, poster: 'art1', year: null, seasons: 1, discs: 1, addedAt: 0, own: false };
const detail = {
  title: summary, banner: null, related: [], extras: [{ number: null, label: 'Extras', copies: [{ discId: DISC2, root: 'r', folder: 'x', displayName: null }] }],
  seasons: [{
    id: 's1', label: '', number: 1,
    discs: [{ number: 1, label: 'Disc 1', copies: [{ discId: 'disc1', root: 'r', folder: 'f', displayName: null }] }],
    episodes: [1, 2].map((n) => ({ number: n, name: null, runtimeMin: 24, discId: 'disc1', playlistId: `0000${n}` })), extras: [],
  }],
};
// the ids the title's discs are filed under: a rematch can give them another
let liveTitleIds = new Set(['star']);
const catalogue = { titles: [summary], detail: (id: string) => (liveTitleIds.has(id) ? detail : null), unsorted: [], hidden: [], art: () => null, provisional: [] } as unknown as Catalogue;

let tmp: string;
let data: string;
let base = '';
let stop: (() => void) | undefined;
let auth: Auth;
let gate: 'owners' | 'everyone';
let discs: DiscEvidence[];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'subtitle-routes-'));
  data = join(tmp, 'data');
  auth = new Auth(new Store(data), Date.now);
  gate = 'everyone';
  liveTitleIds = new Set(['star']);
  discs = [
    { discId: 'disc1', fingerprint: FP, playlists: [playlist('00001'), playlist('00002')] },
    { discId: DISC2, fingerprint: null, playlists: [playlist('00800', 3)] },
  ] as unknown as DiscEvidence[];
  const library = { evidence: () => discs } as unknown as Library;
  const titles = { service: { gate: () => gate, catalogue: () => catalogue }, owner: {} } as unknown as TitleLibrary;
  const server = createServer(appHandlers({
    auth, library, bdjStore: new BdjStore(data), subtitleStore: new SubtitleStore(data), publicBase: 'https://nas.example/bluray/api/', titles,
  }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = () => { server.close(); server.closeAllConnections(); };
});
afterEach(() => {
  stop?.();
  rmSync(tmp, { recursive: true, force: true });
});

async function tokenFor(name: string, owner: boolean): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const { code } = auth.createCode({ newPerson: { name, owner } });
  const device = auth.redeem(code, `${name}'s phone`, jwk)!;
  const challenge = auth.challenge(device.id)!;
  const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(challenge))).toString('base64url');
  return auth.startSession(device.id, challenge, signature)!.token;
}

const call = (method: string, path: string, token: string | null, body?: string | Uint8Array | object): Promise<Response> => {
  const raw = body instanceof Uint8Array || typeof body === 'string' || body === undefined;
  return fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body),
  });
};

const episodeFor = { kind: 'episode', titleId: 'star', seasonId: 's1', episode: 2 };
const chapterFor = { kind: 'chapter', discId: DISC2, playlistId: '00800', chapter: 1 };
const meta = (over: object = {}) => ({ name: 'Fan subs', language: 'en', offsetMs: 250, for: episodeFor, ...over });

async function createSub(owner: string, over: object = {}): Promise<StoredSubtitle> {
  const res = await call('POST', '/api/subtitles', owner, meta(over));
  expect(res.status).toBe(201);
  return (await res.json()) as StoredSubtitle;
}
async function createWithFile(owner: string, over: object = {}): Promise<StoredSubtitle> {
  const s = await createSub(owner, over);
  const res = await call('PUT', `/api/subtitles/${s.id}/file/ep2.srt`, owner, new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nHello\n'));
  expect(res.status).toBe(200);
  return (await res.json()) as StoredSubtitle;
}

describe('subtitle routes', () => {
  it('answers 401 without a token', async () => {
    expect((await call('GET', '/api/subtitles?discKey=x', null)).status).toBe(401);
  });

  it('creates an episode and a chapter attachment, uploads a file and a font, lists and downloads', async () => {
    const owner = await tokenFor('Hana', true);
    const ep = await createSub(owner);
    expect(ep).toMatchObject({ name: 'Fan subs', language: 'en', offsetMs: 250, fileSize: 0, attached: true, attachment: { kind: 'episode', discKey: KEY, playlistId: '00002', titleId: 'star', seasonId: 's1', episode: 2 } });
    const ch = await createSub(owner, { for: chapterFor, name: 'Chapter subs' });
    expect(ch.attachment).toEqual({ kind: 'chapter', discKey: KEY2, playlistId: '00800', chapter: 1 });

    const file = await call('PUT', `/api/subtitles/${ep.id}/file/ep2.srt`, owner, 'hello subs');
    expect(await file.json()).toMatchObject({ fileName: 'ep2.srt', fileSize: 10 });
    const font = await call('PUT', `/api/subtitles/${ep.id}/fonts/Fancy.ttf`, owner, new Uint8Array(1000));
    expect(await font.json()).toMatchObject({ fonts: [{ name: 'Fancy.ttf', size: 1000 }] });
    await call('PUT', `/api/subtitles/${ch.id}/file/ch.ass`, owner, 'ass');

    const byDisc = (await (await call('GET', `/api/subtitles?discKey=${KEY}`, owner)).json()) as StoredSubtitle[];
    expect(byDisc.map((s) => s.id)).toEqual([ep.id]);
    // by title: the episode attachment by titleId, the chapter one through the title's extras disc
    const byTitle = (await (await call('GET', '/api/subtitles?titleId=star', owner)).json()) as StoredSubtitle[];
    expect(byTitle.map((s) => s.id).sort()).toEqual([ep.id, ch.id].sort());
    expect(await (await call('GET', '/api/subtitles?titleId=nope', owner)).json()).toEqual([]);
    expect((await call('GET', '/api/subtitles', owner)).status).toBe(400);

    const dl = await call('GET', `/api/subtitles/${ep.id}/file`, owner);
    expect(dl.headers.get('content-type')).toBe('application/octet-stream');
    expect(dl.headers.get('content-length')).toBe('10');
    expect(await dl.text()).toBe('hello subs');
    expect((await (await call('GET', `/api/subtitles/${ep.id}/fonts/Fancy.ttf`, owner)).arrayBuffer()).byteLength).toBe(1000);
    expect((await call('GET', `/api/subtitles/${ep.id}/fonts/Missing.ttf`, owner)).status).toBe(404);
  });

  it('keeps the title a chapter upload came from, so its owners still list it by title once its disc is gone', async () => {
    const owner = await tokenFor('Hana', true);
    const guest = await tokenFor('Noor', false);
    const DISC3 = 'fedcba9876543210';
    discs.push({ discId: DISC3, fingerprint: null, playlists: [playlist('00900')] } as unknown as DiscEvidence);
    const kept = await createWithFile(owner, { for: { kind: 'chapter', discId: DISC3, playlistId: '00900', chapter: 0, titleId: 'star' } });
    expect(kept.attachment).toEqual({ kind: 'chapter', discKey: `d.${DISC3}`, playlistId: '00900', chapter: 0, titleId: 'star' });
    const plain = await createWithFile(owner, { for: { kind: 'chapter', discId: DISC3, playlistId: '00900', chapter: 0 } });
    const byTitle = async (token: string): Promise<StoredSubtitle[]> => (await (await call('GET', '/api/subtitles?titleId=star', token)).json()) as StoredSubtitle[];
    // a disc outside the title: only the upload that names the title is listed by it
    expect((await byTitle(owner)).map((s) => s.id)).toEqual([kept.id]);
    discs.pop();
    expect(await byTitle(owner)).toEqual([expect.objectContaining({ id: kept.id, attached: false })]);
    expect(await byTitle(guest)).toEqual([]);
    expect(plain.attachment).not.toHaveProperty('titleId');
    // a move keeps the title it is sent with
    const moved = await call('PATCH', `/api/subtitles/${kept.id}`, owner, { for: { ...chapterFor, titleId: 'star' } });
    expect(await moved.json()).toMatchObject({ attached: true, attachment: { kind: 'chapter', discKey: KEY2, playlistId: '00800', chapter: 1, titleId: 'star' } });
    expect((await call('POST', '/api/subtitles', owner, meta({ for: { ...chapterFor, titleId: '' } }))).status).toBe(400);
  });

  it('lists an episode upload by its disc once its title id is gone, so the new title\'s owners can re-attach it', async () => {
    const owner = await tokenFor('Hana', true);
    const ep = await createWithFile(owner);
    liveTitleIds = new Set(['star-2']); // a rematch filed the same discs under another id
    const byTitle = (await (await call('GET', '/api/subtitles?titleId=star-2', owner)).json()) as StoredSubtitle[];
    expect(byTitle.map((s) => s.id)).toEqual([ep.id]);
    // while its own title still exists, another title sharing its disc doesn't list it
    liveTitleIds = new Set(['star', 'star-2']);
    expect(await (await call('GET', '/api/subtitles?titleId=star-2', owner)).json()).toEqual([]);
  });

  it('does not list an upload that has no file yet', async () => {
    const owner = await tokenFor('Hana', true);
    await createSub(owner);
    expect(await (await call('GET', `/api/subtitles?discKey=${KEY}`, owner)).json()).toEqual([]);
  });

  it('refuses a for that does not resolve', async () => {
    const owner = await tokenFor('Hana', true);
    for (const f of [
      { ...episodeFor, episode: 9 }, { ...episodeFor, seasonId: 'sx' }, { ...episodeFor, titleId: 'nope' },
      { ...chapterFor, playlistId: '00001' }, { ...chapterFor, chapter: 3 }, { ...chapterFor, discId: 'gone' },
    ]) {
      const res = await call('POST', '/api/subtitles', owner, meta({ for: f }));
      expect([res.status, await res.json()]).toEqual([400, { error: 'not-found' }]);
    }
    for (const bad of [{ name: '' }, { language: 'en_US' }, { offsetMs: 700_000 }, { offsetMs: 'x' }, { for: { kind: 'chapter' } }, { extra: 1 }]) {
      expect((await call('POST', '/api/subtitles', owner, meta(bad))).status).toBe(400);
    }
  });

  it('lets a guest write nothing, and reads follow the title gate', async () => {
    const owner = await tokenFor('Hana', true);
    const guest = await tokenFor('Mika', false);
    const s = await createWithFile(owner);
    const writes: [string, string, string | Uint8Array | object | undefined][] = [
      ['POST', '/api/subtitles', meta()], ['PATCH', `/api/subtitles/${s.id}`, { name: 'x' }], ['DELETE', `/api/subtitles/${s.id}`, undefined],
      ['PUT', `/api/subtitles/${s.id}/file/x.srt`, 'zzz'], ['PUT', `/api/subtitles/${s.id}/fonts/x.ttf`, 'zzz'],
    ];
    for (const [m, p, b] of writes) {
      const res = await call(m, p, guest, b);
      expect([m, res.status, await res.json()]).toEqual([m, 403, { error: 'forbidden' }]);
    }
    expect(await (await call('GET', `/api/subtitles?discKey=${KEY}`, owner)).json()).toEqual([expect.objectContaining({ name: 'Fan subs', fileSize: s.fileSize, fonts: [] })]);

    gate = 'owners';
    expect((await call('GET', `/api/subtitles?discKey=${KEY}`, guest)).status).toBe(404);
    expect((await call('GET', `/api/subtitles/${s.id}/file`, guest)).status).toBe(404);
    expect((await call('GET', `/api/subtitles?discKey=${KEY}`, owner)).status).toBe(200);
    gate = 'everyone';
    const guestList = (await (await call('GET', `/api/subtitles?discKey=${KEY}`, guest)).json()) as StoredSubtitle[];
    expect(guestList.length).toBe(1);
    expect(guestList[0]).not.toHaveProperty('uploaderPersonId');
    expect(((await (await call('GET', `/api/subtitles?titleId=${guestList[0].attachment.titleId ?? ''}`, guest)).json()) as StoredSubtitle[]).every((x) => !('uploaderPersonId' in x))).toBe(true);
    expect(((await (await call('GET', `/api/subtitles?discKey=${KEY}`, owner)).json()) as StoredSubtitle[])[0].uploaderPersonId).toEqual(expect.any(String));
    expect((await call('GET', `/api/subtitles/${s.id}/file`, guest)).status).toBe(200);
  });

  it('stops a subtitle over 5 MB and fonts over 50 MB in all, and refuses bad names', async () => {
    const owner = await tokenFor('Hana', true);
    const s = await createSub(owner);
    const big = await call('PUT', `/api/subtitles/${s.id}/file/big.srt`, owner, new Uint8Array(6 * 1024 * 1024));
    expect([big.status, await big.json()]).toEqual([413, { error: 'too-large' }]);
    expect(((await (await call('GET', `/api/subtitles?discKey=${KEY}`, owner)).json()) as unknown[]).length).toBe(0);
    for (const n of [1, 2]) {
      // The refused body fits in the drain allowance (20 MB left + 8 MB), so the client never writes into a closed socket.
      const res = await call('PUT', `/api/subtitles/${s.id}/fonts/f${n}.ttf`, owner, new Uint8Array((n === 1 ? 30 : 21) * 1024 * 1024));
      expect(res.status).toBe(n === 1 ? 200 : 413);
    }
    for (const p of ['file/a.exe', 'file/..%2Fa.srt', 'fonts/a.srt']) {
      const res = await call('PUT', `/api/subtitles/${s.id}/${p}`, owner, 'x');
      expect([p, res.status, await res.json()]).toEqual([p, 400, { error: 'bad-name' }]);
    }
    const empty = await call('PUT', `/api/subtitles/${s.id}/file/e.srt`, owner, '');
    expect([empty.status, await empty.json()]).toEqual([400, { error: 'empty' }]);
    expect((await call('PUT', `/api/subtitles/0000000000000000/file/a.srt`, owner, 'x')).status).toBe(404);
  }, 30_000);

  it('hides an attachment whose disc is gone from guests and marks it for owners; patch re-attaches', async () => {
    const owner = await tokenFor('Hana', true);
    const guest = await tokenFor('Mika', false);
    const s = await createWithFile(owner, { for: chapterFor });
    discs = discs.filter((d) => d.discId !== DISC2);
    const ownerList = (await (await call('GET', `/api/subtitles?discKey=${KEY2}`, owner)).json()) as StoredSubtitle[];
    expect(ownerList).toEqual([expect.objectContaining({ id: s.id, attached: false })]);
    expect(await (await call('GET', `/api/subtitles?discKey=${KEY2}`, guest)).json()).toEqual([]);
    expect((await call('GET', `/api/subtitles/${s.id}/file`, guest)).status).toBe(404);
    expect((await call('GET', `/api/subtitles/${s.id}/file`, owner)).status).toBe(200);

    const patched = await call('PATCH', `/api/subtitles/${s.id}`, owner, { for: { kind: 'chapter', discId: 'disc1', playlistId: '00001', chapter: 0 }, name: 'Moved', offsetMs: -500, language: 'ja-JP' });
    expect(await patched.json()).toMatchObject({ name: 'Moved', offsetMs: -500, language: 'ja-JP', attached: true, attachment: { kind: 'chapter', discKey: KEY, playlistId: '00001', chapter: 0 } });
    expect(((await (await call('GET', `/api/subtitles?discKey=${KEY}`, guest)).json()) as unknown[]).length).toBe(1);

    for (const bad of [{}, { name: '' }, { offsetMs: Infinity }, { offsetMs: 600_001 }, { language: '' }, { fileName: 'x' }, { for: { kind: 'chapter', discId: 'gone', playlistId: '1', chapter: 0 } }]) {
      expect((await call('PATCH', `/api/subtitles/${s.id}`, owner, bad)).status).toBe(400);
    }
    expect((await call('PATCH', '/api/subtitles/0000000000000000', owner, { name: 'x' })).status).toBe(404);
  });

  it('deletes the files and the meta', async () => {
    const owner = await tokenFor('Hana', true);
    const s = await createWithFile(owner);
    expect(existsSync(join(data, 'subtitles', s.id, 'meta.json'))).toBe(true);
    expect((await call('DELETE', `/api/subtitles/${s.id}`, owner)).status).toBe(204);
    expect(existsSync(join(data, 'subtitles', s.id))).toBe(false);
    expect((await call('DELETE', `/api/subtitles/${s.id}`, owner)).status).toBe(404);
    expect((await call('GET', `/api/subtitles/${s.id}/file`, owner)).status).toBe(404);
  });

  it('answers every refused PUT with Connection: close, a declared length over the limit at once', async () => {
    const owner = await tokenFor('Hana', true);
    const s = await createSub(owner);
    const refused = [
      await call('PUT', `/api/subtitles/${s.id}/file/a.exe`, owner, 'x'),
      await call('PUT', `/api/subtitles/${s.id}/file/e.srt`, owner, ''),
      await call('PUT', '/api/subtitles/0000000000000000/file/a.srt', owner, 'x'),
      await call('PUT', `/api/subtitles/${s.id}/file/big.srt`, owner, new Uint8Array(6 * 1024 * 1024)),
    ];
    expect(refused.map((r) => r.status)).toEqual([400, 400, 404, 413]);
    for (const r of refused) expect(r.headers.get('connection')).toBe('close');
    expect((await call('PUT', `/api/subtitles/${s.id}/file/ok.srt`, owner, 'fine')).headers.get('connection')).not.toBe('close');
    // a declared length over the font room left is refused before any byte is read
    await call('PUT', `/api/subtitles/${s.id}/fonts/a.ttf`, owner, new Uint8Array(40 * 1024 * 1024));
    const res = await new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
      const req = request(`${base}/api/subtitles/${s.id}/fonts/b.ttf`, { method: 'PUT', headers: { Authorization: `Bearer ${owner}`, 'Content-Length': String(11 * 1024 * 1024) } }, (r) => {
        resolve({ status: r.statusCode!, connection: r.headers.connection });
        req.destroy();
      });
      req.on('error', () => {});
      req.write(Buffer.alloc(1024));
      void reject;
    });
    expect(res).toEqual({ status: 413, connection: 'close' });
  }, 30_000);

  it('survives a client that goes mid-body', async () => {
    const owner = await tokenFor('Hana', true);
    const s = await createSub(owner);
    await new Promise<void>((resolve) => {
      const req = request(`${base}/api/subtitles/${s.id}/file/a.srt`, { method: 'PUT', headers: { Authorization: `Bearer ${owner}`, 'Content-Length': '1000' } });
      req.on('error', () => resolve());
      req.write(Buffer.alloc(100), () => req.destroy());
    });
    expect((await call('GET', `/api/subtitles?discKey=${KEY}`, owner)).status).toBe(200);
  });

  it('hides a font from a guest under the closed gate, and refuses a guest write there', async () => {
    const owner = await tokenFor('Hana', true);
    const guest = await tokenFor('Mika', false);
    const s = await createWithFile(owner);
    await call('PUT', `/api/subtitles/${s.id}/fonts/Fancy.ttf`, owner, new Uint8Array(10));
    gate = 'owners';
    expect((await call('GET', `/api/subtitles/${s.id}/fonts/Fancy.ttf`, guest)).status).toBe(404);
    expect((await call('PATCH', `/api/subtitles/${s.id}`, guest, { name: 'x' })).status).toBe(403);
    expect((await call('DELETE', `/api/subtitles/${s.id}`, guest)).status).toBe(403);
    expect((await call('GET', `/api/subtitles/${s.id}/fonts/Fancy.ttf`, owner)).status).toBe(200);
    expect(((await (await call('GET', `/api/subtitles?discKey=${KEY}`, owner)).json()) as StoredSubtitle[])[0]).toMatchObject({ name: 'Fan subs' });
  });
});
