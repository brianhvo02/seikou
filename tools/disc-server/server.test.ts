import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { request, createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createByteSource } from '../../src/engine/disc/disc-spec';
import type { DiscManifest, LibraryListing } from '@seikou/nas/nas-api';
import { openDisc } from '../../src/engine/disc/open-disc';
import { corsAllowed, createDiscHandler, discApiBase, findDiscs, isLocalAddress, parseRange } from './server';

const TOKEN = 'test-token-0123456789';
const GIB = 1024 ** 3;
const BIG_SIZE = 5 * GIB; // over 4 GiB: sizes and offsets beyond 2^32
const MARK_AT = 4.5 * GIB;
const MARK = Buffer.from('far-marker');
const SYNTHETIC = fileURLToPath(new URL('../../fixtures/synthetic/', import.meta.url));

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

let dir: string;
let distDir: string;
let server: Server;
let port: number;
let origin: string;
/** The remote address the handler sees; tests set it to check the LAN filter. */
let remote = '127.0.0.1';

/** A raw request: the path goes out unnormalised (`..` survives), unlike fetch. */
function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
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

async function discId(name: string): Promise<string> {
  const listing = JSON.parse((await get('/api/library?path=', auth)).body.toString()) as LibraryListing;
  const found = listing.discs.find((d) => d.name === name);
  if (!found) throw new Error(`no disc ${name} in ${JSON.stringify(listing)}`);
  return found.id;
}

/** `/api/discs/<id>/` of the big test disc. */
async function bigDisc(): Promise<string> {
  return `/api/discs/${await discId('Big Disc')}/`;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'disc-server-'));
  const disc = join(dir, 'library', 'Big Disc');
  mkdirSync(join(disc, 'BDMV', 'STREAM'), { recursive: true });
  writeFileSync(join(disc, 'BDMV', 'index.bdmv'), Buffer.from('INDX0200abcdefghij'));
  // sparse: only the marker's block is ever written, so the test needs no 5 GiB of disk or memory
  const fd = openSync(join(disc, 'BDMV', 'STREAM', '00000.m2ts'), 'w');
  writeSync(fd, MARK, 0, MARK.length, MARK_AT);
  writeSync(fd, Buffer.from([0x47]), 0, 1, BIG_SIZE - 1);
  closeSync(fd);
  writeFileSync(join(disc, 'notes.txt'), 'outside BDMV: never listed nor served');
  writeFileSync(join(dir, 'library', 'secret.txt'), 'not part of any disc');
  mkdirSync(join(dir, 'library', 'Not A Disc'));
  distDir = join(dir, 'dist');
  mkdirSync(distDir);
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>player</title>');

  const handler = createDiscHandler({ roots: [join(dir, 'library'), SYNTHETIC], token: TOKEN, distDir, remoteAddressOf: () => remote });
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('isLocalAddress', () => {
  it('accepts loopback and private LAN addresses only', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '::ffff:192.168.1.20', '169.254.3.4', 'fe80::1', 'fd12:3456::1']) {
      expect(isLocalAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '::ffff:8.8.8.8', '2001:db8::1', '', 'nonsense']) {
      expect(isLocalAddress(a), a).toBe(false);
    }
  });
});

describe("parseRange (the NAS server's)", () => {
  it('parses single byte ranges against the size', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=95-200', 100)).toEqual({ start: 95, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange(`bytes=${MARK_AT}-${MARK_AT + 9}`, BIG_SIZE)).toEqual({ start: MARK_AT, end: MARK_AT + 9 });
  });

  it('reports unsatisfiable ranges and ignores ones it does not understand', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('bytes=9-2', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
    expect(parseRange(undefined, 100)).toBeNull();
  });
});

describe('findDiscs', () => {
  it('finds the folders that contain BDMV/index.bdmv, with stable ids and root-relative paths', () => {
    const a = findDiscs([join(dir, 'library')]);
    const b = findDiscs([join(dir, 'library')]);
    expect(a.map((d) => d.name)).toEqual(['Big Disc']);
    expect(a[0]!.id).toMatch(/^[0-9a-f]{16}$/);
    expect(a[0]!.path).toBe('library/Big Disc');
    expect(b[0]!.id).toBe(a[0]!.id);
  });
});

describe('disc server (the NAS disc API)', () => {
  it('refuses API requests without the token (401, as the NAS answers)', async () => {
    const base = await bigDisc();
    for (const path of ['/api/library?path=', `${base}manifest`, `${base}files/BDMV/index.bdmv`, `${base}probe`]) {
      const r = await get(path);
      expect(r.status, path).toBe(401);
      expect(JSON.parse(r.body.toString()), path).toEqual({ error: 'unauthorized' });
    }
    expect((await get('/api/library?path=', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await get(`${base}files/BDMV/index.bdmv?t=wrong`)).status).toBe(401);
  });

  it('takes the token as Authorization: Bearer or ?t= (what HttpTransport sends), not the old ?token=', async () => {
    const r = await get(`/api/library?path=&t=${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect((await get(`/api/library?path=&token=${TOKEN}`)).status).toBe(401);
  });

  it('refuses every request from an address outside the local network (403)', async () => {
    remote = '8.8.8.8';
    try {
      expect((await get('/api/library?path=', auth)).status).toBe(403);
      expect((await get('/')).status).toBe(403);
    } finally {
      remote = '127.0.0.1';
    }
    remote = '::ffff:192.168.1.30';
    try {
      expect((await get('/api/library?path=', auth)).status).toBe(200);
    } finally {
      remote = '127.0.0.1';
    }
  });

  it('lists every disc as the NAS library does: a flat LibraryListing of DiscEntry', async () => {
    const r = await get('/api/library?path=', auth);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    const listing = JSON.parse(r.body.toString()) as LibraryListing;
    expect(listing.folders).toEqual([]);
    expect(listing.scanning).toBe(false);
    const big = listing.discs.find((d) => d.name === 'Big Disc');
    expect(big).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), name: 'Big Disc', path: 'library/Big Disc', kind: 'folder', sizeBytes: BIG_SIZE + 18 });
    expect(listing.discs.map((d) => d.name)).toContain('disc1');
  });

  it("serves the NAS's manifest: upper-case paths under BDMV and CERTIFICATE, sizes, and the metadata inlined", async () => {
    const base = await bigDisc();
    const r = await get(`${base}manifest`, auth);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    const manifest = JSON.parse(r.body.toString()) as DiscManifest;
    expect(manifest).toEqual({
      discId: base.split('/')[3],
      name: 'Big Disc',
      files: [
        { path: 'BDMV/INDEX.BDMV', size: 18 },
        { path: 'BDMV/STREAM/00000.M2TS', size: BIG_SIZE },
      ],
      inline: { 'BDMV/INDEX.BDMV': Buffer.from('INDX0200abcdefghij').toString('base64') },
    });
  });

  it("answers an unknown disc with the NAS's disc-changed 404, a missing file with not found", async () => {
    const unknown = await get('/api/discs/0000000000000000/manifest', auth);
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body.toString())).toEqual({ error: 'disc-changed' });
    const base = await bigDisc();
    for (const p of ['BDMV/MovieObject.bdmv', 'BDMV/STREAM', 'notes.txt']) {
      const r = await get(`${base}files/${p}`, auth);
      expect(r.status, p).toBe(404); // missing, a directory, outside BDMV/CERTIFICATE
      expect(JSON.parse(r.body.toString())).toEqual({ error: 'not found' });
    }
  });

  it('refuses paths that climb out of the disc', async () => {
    const base = await bigDisc();
    for (const p of ['../secret.txt', 'BDMV/../../secret.txt', '%2e%2e/secret.txt', 'BDMV/%2e%2e/%2e%2e/secret.txt', '..%2fsecret.txt', 'BDMV//index.bdmv', './BDMV/index.bdmv', 'BDMV%5c..%5c..%5csecret.txt', 'BDMV/index.bdmv%00']) {
      const r = await get(`${base}files/${p}`, auth);
      expect(r.status, p).toBe(400);
    }
    expect((await get(`${base}../../secret.txt`, auth)).status).toBe(400);
  });

  it('serves files in any case, as the manifest spells them (upper case) or as they are on disk', async () => {
    const base = await bigDisc();
    for (const p of ['BDMV/INDEX.BDMV', 'BDMV/index.bdmv', 'bdmv/Index.Bdmv']) {
      const r = await get(`${base}files/${p}`, auth);
      expect(r.status, p).toBe(200);
      expect(r.body.toString()).toBe('INDX0200abcdefghij');
    }
  });

  it('answers Range: bytes=0-9 with 206 and 10 bytes', async () => {
    const base = await bigDisc();
    const r = await get(`${base}files/BDMV/INDEX.BDMV`, { ...auth, range: 'bytes=0-9' });
    expect(r.status).toBe(206);
    expect(r.body.toString()).toBe('INDX0200ab');
    expect(r.headers['content-range']).toBe('bytes 0-9/18');
    expect(r.headers['content-length']).toBe('10');
    expect(r.headers['accept-ranges']).toBe('bytes');
  });

  it('answers a whole-file GET with 200, and HEAD with headers only', async () => {
    const base = await bigDisc();
    const r = await get(`${base}files/BDMV/INDEX.BDMV`, auth);
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('INDX0200abcdefghij');
    const h = await get(`${base}files/BDMV/STREAM/00000.M2TS`, auth, 'HEAD');
    expect(h.status).toBe(200);
    expect(h.headers['content-length']).toBe(String(BIG_SIZE));
    expect(h.body.length).toBe(0);
  });

  it('answers a range starting beyond the end of the file with 416', async () => {
    const base = await bigDisc();
    const r = await get(`${base}files/BDMV/INDEX.BDMV`, { ...auth, range: 'bytes=18-30' });
    expect(r.status).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */18');
  });

  it('serves ranges of a file over 4 GiB without reading the rest of it', async () => {
    const base = await bigDisc();
    const r = await get(`${base}files/BDMV/STREAM/00000.M2TS`, { ...auth, range: `bytes=${MARK_AT}-${MARK_AT + MARK.length - 1}` });
    expect(r.status).toBe(206);
    expect(r.body.equals(MARK)).toBe(true);
    expect(r.headers['content-range']).toBe(`bytes ${MARK_AT}-${MARK_AT + MARK.length - 1}/${BIG_SIZE}`);
    const tail = await get(`${base}files/BDMV/STREAM/00000.M2TS`, { ...auth, range: 'bytes=-1' });
    expect([...tail.body]).toEqual([0x47]);
  });

  it("serves the probe as the NAS does: the largest clip's first 4 MiB, whole", async () => {
    const base = await bigDisc();
    const r = await get(`${base}probe?t=${TOKEN}`);
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(4 * 1024 * 1024);
  });

  it('serves the built player without a token, cross-origin isolated', async () => {
    const r = await get('/');
    expect(r.status).toBe(200);
    expect(r.body.toString()).toContain('<title>player</title>');
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(r.headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect((await get('/missing.js')).status).toBe(404);
    expect((await get('/../secret.txt')).status).toBe(400);
  });

  it('answers a deep app path with index.html', async () => {
    const r = await get('/nas/title/anilist%3A21', auth);
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('<!doctype html><title>player</title>');
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(r.headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect((await get('/missing.js', auth)).status).toBe(404);
  });

  it('answers a /nas play link ending in an extension-like hex suffix with the shell, without a token too', async () => {
    const play = '/nas/play/f.0123456789ABCDEF0123456789ABCDEF';
    const withToken = await get(play, auth);
    expect(withToken.status).toBe(200);
    expect(withToken.body.toString()).toBe('<!doctype html><title>player</title>');
    // the shell is public, as the player's own page is: the API behind it is what needs the token
    const noToken = await get('/nas/title/anilist%3A21');
    expect(noToken.status).toBe(200);
    expect(noToken.body.toString()).toBe('<!doctype html><title>player</title>');
  });

  it('answers a CORS preflight without the token, and only for the API', async () => {
    const base = await bigDisc();
    const r = await get(`${base}manifest`, { origin: 'http://localhost:5173', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' }, 'OPTIONS');
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(r.headers['access-control-allow-headers']).toMatch(/authorization/i);
    const g = await get(`${base}files/BDMV/INDEX.BDMV`, { ...auth, origin: 'http://localhost:5173', range: 'bytes=0-0' });
    expect(g.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(g.headers['access-control-expose-headers']).toMatch(/content-range/i);
    expect((await get('/', { origin: 'http://localhost:5173' }, 'OPTIONS')).status).toBe(405);
  });

  it('lets only its own origin and the Vite dev server read the API across origins', async () => {
    const base = await bigDisc();
    for (const origin of ['https://192.168.1.5:5173', 'http://127.0.0.1:5173', `http://127.0.0.1:${port}`]) {
      const r = await get(`${base}manifest`, { ...auth, origin });
      expect(r.headers['access-control-allow-origin'], origin).toBe(origin);
    }
    for (const origin of ['https://evil.example', 'https://evil.example:5173', 'http://8.8.8.8:5173', 'http://localhost:4173', 'null']) {
      const r = await get(`${base}manifest`, { ...auth, origin });
      expect(r.headers['access-control-allow-origin'], origin).toBeUndefined();
      const p = await get(`${base}manifest`, { origin, 'access-control-request-method': 'GET' }, 'OPTIONS');
      expect(p.headers['access-control-allow-origin'], origin).toBeUndefined();
    }
  });

  it('corsAllowed: own origin, or port 5173 on loopback or a private address', () => {
    expect(corsAllowed('https://10.0.0.2:8443', 'https://10.0.0.2:8443')).toBe(true);
    expect(corsAllowed('http://[::1]:5173', null)).toBe(true);
    expect(corsAllowed('http://localhost:5173', null)).toBe(true);
    expect(corsAllowed('https://10.0.0.2:8443', 'https://10.0.0.3:8443')).toBe(false);
    expect(corsAllowed('http://100.64.0.1:5173', null)).toBe(false);
    expect(corsAllowed('not a url', null)).toBe(false);
  });
});

describe("the player's client path against the dev server (RemoteSource + HttpTransport, as for a NAS disc)", () => {
  /** What the player opens for a served disc: the manifest the UI fetched with the token, then range reads. */
  async function remoteSource(name: string) {
    const disc = findDiscs([join(dir, 'library'), SYNTHETIC]).find((d) => d.name === name)!;
    const base = discApiBase(origin, disc.id);
    const response = await fetch(`${base}manifest`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const manifest = (await response.json()) as DiscManifest;
    return createByteSource({ kind: 'remote', base, token: TOKEN, manifest }, { fetch, readAheadBytes: 8 * 1024 * 1024, chunkBytes: 64 * 1024, onWaiting: () => undefined });
  }

  it('opens the synthetic disc: openDisc succeeds over the manifest and range reads', async () => {
    const source = await remoteSource('disc1');
    expect(source.exists('bdmv/index.bdmv')).toBe(true);
    expect(source.list('BDMV/STREAM')).toEqual(['00001.M2TS', '00002.M2TS']);
    const disc = await openDisc(source);
    expect(disc.summaries.length).toBeGreaterThan(0);
    const head = await source.read('BDMV/STREAM/00001.m2ts', 0, 192);
    expect(head[4]).toBe(0x47); // a source packet's sync byte, read through the files route
  });

  it('reads a range past 4 GiB of a sparse clip, by a mixed-case path', async () => {
    const source = await remoteSource('Big Disc');
    expect(source.size('BDMV/Stream/00000.m2ts')).toBe(BIG_SIZE);
    const bytes = await source.read('BDMV/Stream/00000.m2ts', MARK_AT, MARK.length);
    expect(Buffer.from(bytes).equals(MARK)).toBe(true);
    const tail = await source.read('BDMV/STREAM/00000.M2TS', BIG_SIZE - 1, 10);
    expect([...tail]).toEqual([0x47]);
  });

  it('fails the read as unpaired when the token is wrong (no refresh for the dev server)', async () => {
    const disc = findDiscs([SYNTHETIC]).find((d) => d.name === 'disc1')!;
    const base = discApiBase(origin, disc.id);
    const manifest = (await (await fetch(`${base}manifest`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()) as DiscManifest;
    const source = createByteSource({ kind: 'remote', base, token: 'stale', manifest }, { fetch, readAheadBytes: 0, onWaiting: () => undefined });
    await expect(source.read('BDMV/STREAM/00001.M2TS', 0, 192)).rejects.toMatchObject({ reason: 'nas-unpaired' });
  });
});
