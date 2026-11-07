import { closeSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DiscManifest } from '@seikou/nas/nas-api';
import { buildUdf250 } from '../../tests/helpers/udf-image';
import { appHandlers } from './app';
import type { Auth } from './auth';
import { BdjStore } from './bdj-store';
import { createServer } from './http';
import { IsoTrees } from './iso';
import { Library } from './library';
import { buildManifest } from './manifest';
import { DiscActivity } from './disc-activity';
import { discRoutes } from './routes/discs';

const FIXTURES = join(import.meta.dirname, '../../fixtures/synthetic');
const PROBE_BYTES = 4_194_304;

/** Every regular file under `dir`, as [disc-relative path as on disk, size]. */
function walk(dir: string, base = dir): [string, number][] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = join(dir, e.name);
    return e.isDirectory() ? walk(abs, base) : [[relative(base, abs), statSync(abs).size] as [string, number]];
  });
}

describe('buildManifest', () => {
  for (const disc of ['disc-menu', 'disc-bdj']) {
    it(`lists every file of ${disc} and inlines the small ones byte for byte`, async () => {
      const dir = join(FIXTURES, disc);
      const manifest = await buildManifest(dir, { id: 'abc', name: disc });
      expect(manifest.discId).toBe('abc');
      expect(manifest.name).toBe(disc);
      const onDisk = walk(dir).map(([path, size]) => ({ path: path.toUpperCase(), size }));
      expect([...manifest.files].sort((a, b) => a.path.localeCompare(b.path))).toEqual(onDisk.sort((a, b) => a.path.localeCompare(b.path)));

      const real = new Map(walk(dir).map(([path]) => [path.toUpperCase(), path]));
      const inlined = Object.keys(manifest.inline);
      expect(inlined).toContain('BDMV/INDEX.BDMV');
      const expected = [...real.keys()].filter((p) => /^BDMV\/(INDEX\.BDMV|MOVIEOBJECT\.BDMV|PLAYLIST\/.*\.MPLS|CLIPINF\/.*\.CLPI|AUXDATA\/SOUND\.BDMV|BDJO\/.*\.BDJO)$/.test(p));
      expect(inlined.sort()).toEqual(expected.sort());
      for (const path of inlined) {
        expect(Buffer.from(manifest.inline[path]!, 'base64').equals(readFileSync(join(dir, real.get(path)!))), path).toBe(true);
      }
      expect(inlined.some((p) => p.endsWith('.M2TS') || p.endsWith('.JAR'))).toBe(false);
    });
  }

  it('inlines CERTIFICATE/ID.BDMV and skips inline candidates over 1 MiB', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-'));
    try {
      cpSync(join(FIXTURES, 'disc1'), tmp, { recursive: true });
      mkdirSync(join(tmp, 'certificate'));
      writeFileSync(join(tmp, 'certificate/id.bdmv'), 'id-bytes');
      writeFileSync(join(tmp, 'BDMV/PLAYLIST/00009.mpls'), Buffer.alloc(1024 * 1024 + 1));
      const manifest = await buildManifest(tmp, { id: 'x', name: 'x' });
      expect(Buffer.from(manifest.inline['CERTIFICATE/ID.BDMV']!, 'base64').toString()).toBe('id-bytes');
      expect(manifest.inline['BDMV/PLAYLIST/00009.MPLS']).toBeUndefined();
      expect(manifest.files).toContainEqual({ path: 'BDMV/PLAYLIST/00009.MPLS', size: 1024 * 1024 + 1 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('stops inlining at 8 MiB in all and lists the rest without bytes', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'manifest-'));
    try {
      cpSync(join(FIXTURES, 'disc1'), tmp, { recursive: true });
      for (let i = 0; i < 10; i++) writeFileSync(join(tmp, `BDMV/PLAYLIST/0090${i}.mpls`), Buffer.alloc(1024 * 1024, i));
      const manifest = await buildManifest(tmp, { id: 'x', name: 'x' });
      const inlined = Object.values(manifest.inline).reduce((n, b64) => n + Buffer.from(b64, 'base64').length, 0);
      expect(inlined).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(inlined).toBeGreaterThan(7 * 1024 * 1024);
      const big = manifest.files.filter((f) => /^BDMV\/PLAYLIST\/0090\d\.MPLS$/.test(f.path));
      expect(big).toHaveLength(10);
      expect(big.filter((f) => manifest.inline[f.path] === undefined).length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('disc routes', () => {
  const AWKWARD = '[BDMV] 鋼の旅団 #1 100% + extra';
  let tmp: string;
  let base: string;
  let server: http.Server;
  let library: Library;
  const ids: Record<string, string> = {};
  /** A UDF 2.50 image whose 00001.M2TS has four extents out of order. */
  const multi = buildUdf250(3000);

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'discs-'));
    const root = join(tmp, 'root');
    cpSync(join(FIXTURES, 'disc-menu'), join(root, 'menu'), { recursive: true });
    cpSync(join(FIXTURES, 'disc1'), join(root, AWKWARD), { recursive: true });
    cpSync(join(FIXTURES, 'disc1'), join(root, 'doomed'), { recursive: true });
    // A disc with a clip larger than the probe, and one with an empty file.
    cpSync(join(FIXTURES, 'disc1'), join(root, 'big'), { recursive: true });
    writeFileSync(join(root, 'big/BDMV/STREAM/00003.m2ts'), Buffer.alloc(PROBE_BYTES + 1000, 7));
    writeFileSync(join(root, 'big/BDMV/STREAM/empty.m2ts'), '');
    copyFileSync(join(FIXTURES, 'disc1.iso'), join(root, 'disc.iso'));
    copyFileSync(join(FIXTURES, 'disc1.iso'), join(root, 'gone.iso'));
    copyFileSync(join(FIXTURES, 'disc1.iso'), join(root, 'swap.iso'));
    copyFileSync(join(FIXTURES, 'disc1.iso'), join(root, 'race.iso'));
    const fd = openSync(join(root, 'multi.iso'), 'w');
    for (const [lba, block] of multi.image.blocks) writeSync(fd, block, 0, block.length, lba * 2048);
    closeSync(fd);
    library = new Library([{ name: 'mediaA', dir: root }], join(tmp, 'library.json'), { scanPauseMs: 0, now: () => Date.now() + 3_600_001 });
    await library.scan();
    for (const d of library.list('mediaA')!.discs) ids[d.name] = d.id;
    server = createServer([discRoutes(library)]);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/discs`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    rmSync(tmp, { recursive: true, force: true });
  });

  const clip = (disc: string): Buffer => readFileSync(join(tmp, 'root', disc, 'BDMV/STREAM/00001.m2ts'));

  it('reads ISO trees through the IsoTrees it is given (shared with the quality levels)', async () => {
    const trees = new IsoTrees();
    const get = vi.spyOn(trees, 'get');
    const shared = createServer([discRoutes(library, undefined, trees)]);
    await new Promise<void>((r) => shared.listen(0, r));
    try {
      const res = await fetch(`http://127.0.0.1:${(shared.address() as AddressInfo).port}/api/discs/${ids['disc.iso']}/manifest`);
      expect(res.status).toBe(200);
      expect(get).toHaveBeenCalled();
    } finally {
      await new Promise((r) => shared.close(r));
    }
  });

  it('tells the activity of every file range read and probe, folder and ISO, but not of a manifest', async () => {
    const activity = new DiscActivity();
    const note = vi.spyOn(activity, 'note');
    const watched = createServer([discRoutes(library, undefined, undefined, activity)]);
    await new Promise<void>((r) => watched.listen(0, r));
    const at = `http://127.0.0.1:${(watched.address() as AddressInfo).port}/api/discs`;
    try {
      await (await fetch(`${at}/${ids.menu}/manifest`)).arrayBuffer();
      expect(note).not.toHaveBeenCalled();
      await (await fetch(`${at}/${ids.menu}/files/BDMV/STREAM/00001.M2TS`, { headers: { Range: 'bytes=0-191' } })).arrayBuffer();
      expect(note).toHaveBeenCalledTimes(1);
      await (await fetch(`${at}/${ids['disc.iso']}/files/BDMV/STREAM/00001.M2TS`, { headers: { Range: 'bytes=0-191' } })).arrayBuffer();
      expect(note).toHaveBeenCalledTimes(2);
      await (await fetch(`${at}/${ids.menu}/probe`)).arrayBuffer();
      expect(note).toHaveBeenCalledTimes(3);
      await (await fetch(`${at}/${ids['disc.iso']}/probe`)).arrayBuffer();
      expect(note).toHaveBeenCalledTimes(4);
      expect(activity.busy()).toBe(true);
    } finally {
      watched.closeAllConnections();
      await new Promise((r) => watched.close(r));
    }
  });

  it('resolves a disc key to the listed disc, fingerprint first', async () => {
    const get = (key: string): Promise<Response> => fetch(`${base}/resolve/${key}`);
    const byId = await get(`d.${ids.menu}`);
    expect(byId.status).toBe(200);
    expect(await byId.json()).toEqual({ disc: library.disc(ids.menu!) });
    // two copies of one synthetic disc: the one with the smaller path
    const fingerprint = library.evidence().find((e) => e.discId === ids[AWKWARD])!.fingerprint;
    const copies = library.evidence().filter((e) => e.fingerprint === fingerprint && fingerprint !== null);
    expect(copies.length).toBeGreaterThan(1);
    const smallest = [...copies].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))[0]!;
    const byFp = await get(`f.${fingerprint}`);
    expect(byFp.status).toBe(200);
    expect(await byFp.json()).toEqual({ disc: library.disc(smallest.discId) });
    for (const key of [`d.${'0'.repeat(16)}`, `f.${'A'.repeat(32)}`, 'nonsense', 'f.abc', 'f.%E0']) {
      const res = await get(key);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not-found' });
    }
  });

  it('serves the manifest', async () => {
    const res = await fetch(`${base}/${ids.menu}/manifest`);
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as DiscManifest;
    expect(manifest.discId).toBe(ids.menu);
    expect(manifest.name).toBe('menu');
    expect(manifest.files).toContainEqual({ path: 'BDMV/STREAM/00001.M2TS', size: clip('menu').length });
    expect(manifest.inline['BDMV/INDEX.BDMV']).toBeDefined();
  });

  it('answers a range with 206 and the bytes', async () => {
    const bytes = clip('menu');
    const res = await fetch(`${base}/${ids.menu}/files/BDMV/STREAM/00001.M2TS`, { headers: { Range: 'bytes=192-383' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 192-383/${bytes.length}`);
    expect(res.headers.get('content-length')).toBe('192');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes.subarray(192, 384))).toBe(true);
  });

  it('clamps a range ending past EOF and serves the whole file without a range', async () => {
    const bytes = clip('menu');
    const tail = await fetch(`${base}/${ids.menu}/files/BDMV/STREAM/00001.M2TS`, { headers: { Range: `bytes=${bytes.length - 10}-${bytes.length + 500}` } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe(`bytes ${bytes.length - 10}-${bytes.length - 1}/${bytes.length}`);
    expect(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(bytes.length - 10))).toBe(true);
    const whole = await fetch(`${base}/${ids.menu}/files/bdmv/stream/00001.m2ts`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-length')).toBe(String(bytes.length));
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('answers 416 past EOF', async () => {
    const size = clip('menu').length;
    const res = await fetch(`${base}/${ids.menu}/files/BDMV/STREAM/00001.M2TS`, { headers: { Range: `bytes=${size}-` } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${size}`);
  });

  it('serves a zero-length file and refuses ranges on it', async () => {
    const whole = await fetch(`${base}/${ids.big}/files/BDMV/STREAM/EMPTY.M2TS`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-length')).toBe('0');
    expect((await whole.arrayBuffer()).byteLength).toBe(0);
    const ranged = await fetch(`${base}/${ids.big}/files/BDMV/STREAM/EMPTY.M2TS`, { headers: { Range: 'bytes=0-0' } });
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get('content-range')).toBe('bytes */0');
  });

  it('answers HEAD with the headers only', async () => {
    const size = clip('menu').length;
    const res = await fetch(`${base}/${ids.menu}/files/BDMV/STREAM/00001.M2TS`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(size));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('refuses path traversal and unknown files with 404', async () => {
    const raw = (path: string): Promise<number> =>
      new Promise((resolve, reject) => {
        http.get(`${base}/${ids.menu}/files/${path}`, (res) => {
          res.resume();
          resolve(res.statusCode!);
        }).on('error', reject);
      });
    expect(await raw('..%2F..%2Fetc%2Fpasswd')).toBe(404);
    expect(await raw('BDMV/../../x')).toBe(404);
    expect(await raw('BDMV%2F..%2F..%2Fdoomed%2FBDMV%2FINDEX.BDMV')).toBe(404);
    expect(await raw('BDMV/STREAM/99999.M2TS')).toBe(404);
    expect(await raw('BDMV/STREAM')).toBe(404);
    expect(await raw('%E0%A4%A')).toBe(404);
  });

  it('answers 404 disc-changed to an unknown disc and to one deleted after the scan', async () => {
    const unknown = await fetch(`${base}/0123456789abcdef/manifest`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'disc-changed' });
    rmSync(join(tmp, 'root', 'doomed'), { recursive: true });
    expect(library.disc(ids.doomed!)).not.toBeNull();
    for (const path of ['manifest', 'probe', 'files/BDMV/INDEX.BDMV']) {
      const res = await fetch(`${base}/${ids.doomed}/${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: 'disc-changed' });
    }
  });

  it('answers 404 disc-changed when index.bdmv changed after the scan', async () => {
    const index = join(tmp, 'root', 'big', 'BDMV', 'index.bdmv');
    writeFileSync(index, Buffer.concat([readFileSync(index), Buffer.from([0])]));
    const res = await fetch(`${base}/${ids.big}/files/BDMV/INDEX.BDMV`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'disc-changed' });
    await library.scan();
    for (const d of library.list('mediaA')!.discs) ids[d.name] = d.id;
  });

  it('serves the bytes of a disc whose name has #, %, + and Japanese text', async () => {
    const manifest = (await (await fetch(`${base}/${ids[AWKWARD]}/manifest`)).json()) as DiscManifest;
    expect(manifest.name).toBe(AWKWARD);
    const res = await fetch(`${base}/${ids[AWKWARD]}/files/${encodeURIComponent('BDMV/STREAM/00001.M2TS')}`, { headers: { Range: 'bytes=0-191' } });
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).equals(clip(AWKWARD).subarray(0, 192))).toBe(true);
  });

  it('probes the first 4 MiB of the largest clip, or the whole clip when smaller', async () => {
    const big = await fetch(`${base}/${ids.big}/probe`);
    expect(big.status).toBe(200);
    expect(big.headers.get('content-length')).toBe(String(PROBE_BYTES));
    expect(big.headers.get('cache-control')).toBe('private, max-age=3600');
    const body = Buffer.from(await big.arrayBuffer());
    expect(body.length).toBe(PROBE_BYTES);
    expect(body.equals(readFileSync(join(tmp, 'root', 'big/BDMV/STREAM/00003.m2ts')).subarray(0, PROBE_BYTES))).toBe(true);

    const small = await fetch(`${base}/${ids.menu}/probe`);
    const largest = readFileSync(join(tmp, 'root', 'menu/BDMV/STREAM/00002.m2ts'));
    expect(Buffer.from(await small.arrayBuffer()).equals(largest)).toBe(true);
  });

  it('sits behind the token guard in the app', async () => {
    const auth = { verify: (token: string) => (token === 'good' ? { id: 'd' } : null) } as unknown as Auth;
    const app = createServer(appHandlers({ auth, library, bdjStore: new BdjStore(tmp), publicBase: 'https://nas.example/' }));
    await new Promise<void>((r) => app.listen(0, r));
    try {
      const appBase = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/discs/${ids.menu}`;
      expect((await fetch(`${appBase}/probe`)).status).toBe(401);
      expect((await fetch(`${appBase}/files/BDMV/INDEX.BDMV?t=bad`)).status).toBe(401);
      const ok = await fetch(`${appBase}/files/BDMV/INDEX.BDMV?t=good`, { headers: { Range: 'bytes=0-3' } });
      expect(ok.status).toBe(206);
      expect(await ok.text()).toBe('INDX');
    } finally {
      await new Promise((r) => app.close(r));
    }
  }, 30_000); // starts a server and pairs a device: more than vitest's 5 s default on a loaded runner

  it('serves the manifest of an ISO disc like that of the same folder disc', async () => {
    const res = await fetch(`${base}/${ids['disc.iso']}/manifest`);
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as DiscManifest;
    const folder = await buildManifest(join(FIXTURES, 'disc1'), { id: 'x', name: 'x' });
    expect(manifest.discId).toBe(ids['disc.iso']);
    expect(manifest.name).toBe('disc.iso');
    expect(manifest.files).toEqual(folder.files);
    expect(manifest.inline).toEqual(folder.inline);
  });

  it('serves ranges of ISO files, across extents too, and HEAD, 416 and unknown paths', async () => {
    const clipBytes = readFileSync(join(FIXTURES, 'disc1/BDMV/STREAM/00001.m2ts'));
    const one = await fetch(`${base}/${ids['disc.iso']}/files/bdmv/stream/00001.m2ts`, { headers: { Range: 'bytes=100-5000' } });
    expect(one.status).toBe(206);
    expect(one.headers.get('content-range')).toBe(`bytes 100-5000/${clipBytes.length}`);
    expect(Buffer.from(await one.arrayBuffer()).equals(clipBytes.subarray(100, 5001))).toBe(true);
    const whole = await fetch(`${base}/${ids['disc.iso']}/files/BDMV/STREAM/00001.M2TS`);
    expect(whole.status).toBe(200);
    expect(Buffer.from(await whole.arrayBuffer()).equals(clipBytes)).toBe(true);

    // 3 * 2048 - 10 .. 5 * 2048 + 20 spans the first three extents.
    const start = 3 * 2048 - 10;
    const end = 5 * 2048 + 20;
    const across = await fetch(`${base}/${ids['multi.iso']}/files/BDMV/STREAM/00001.M2TS`, { headers: { Range: `bytes=${start}-${end - 1}` } });
    expect(across.status).toBe(206);
    expect(Buffer.from(await across.arrayBuffer()).equals(Buffer.from(multi.m2ts.subarray(start, end)))).toBe(true);
    const clpi = await fetch(`${base}/${ids['multi.iso']}/files/BDMV/CLIPINF/00001.CLPI`);
    expect(Buffer.from(await clpi.arrayBuffer()).equals(Buffer.from(multi.clpi))).toBe(true);

    const head = await fetch(`${base}/${ids['disc.iso']}/files/BDMV/STREAM/00001.M2TS`, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe(String(clipBytes.length));
    const past = await fetch(`${base}/${ids['disc.iso']}/files/BDMV/STREAM/00001.M2TS`, { headers: { Range: `bytes=${clipBytes.length}-` } });
    expect(past.status).toBe(416);
    for (const path of ['BDMV/STREAM/99999.M2TS', 'BDMV/STREAM', 'BDMV%2F..%2FBDMV%2FINDEX.BDMV', 'OTHER/X']) {
      expect((await fetch(`${base}/${ids['disc.iso']}/files/${path}`)).status, path).toBe(404);
    }
  });

  it('probes the largest clip of an ISO disc', async () => {
    const res = await fetch(`${base}/${ids['multi.iso']}/probe`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(multi.m2ts))).toBe(true);
    const disc1 = await fetch(`${base}/${ids['disc.iso']}/probe`);
    const sizes = ['00001.m2ts', '00002.m2ts'].map((n) => readFileSync(join(FIXTURES, 'disc1/BDMV/STREAM', n)));
    const largest = sizes.reduce((a, b) => (b.length > a.length ? b : a));
    expect(Buffer.from(await disc1.arrayBuffer()).equals(largest.subarray(0, PROBE_BYTES))).toBe(true);
  });

  it('answers 404 disc-changed for an ISO removed or rewritten after the scan', async () => {
    expect((await fetch(`${base}/${ids['gone.iso']}/manifest`)).status).toBe(200);
    writeFileSync(join(tmp, 'root', 'gone.iso'), Buffer.concat([readFileSync(join(FIXTURES, 'disc1.iso')), Buffer.alloc(2048)]));
    for (const path of ['manifest', 'probe', 'files/BDMV/INDEX.BDMV']) {
      const res = await fetch(`${base}/${ids['gone.iso']}/${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: 'disc-changed' });
    }
  });

  it('answers 500 when an unchanged image no longer parses', async () => {
    const path = join(tmp, 'root', 'swap.iso');
    // A whole-second mtime, so that putting it back is exact; rescanned so the id matches it.
    utimesSync(path, 1_700_000_000, 1_700_000_000);
    await library.scan();
    for (const d of library.list('mediaA')!.discs) ids[d.name] = d.id;
    writeFileSync(path, Buffer.alloc(statSync(path).size)); // same size, same mtime: unchanged to the server
    utimesSync(path, 1_700_000_000, 1_700_000_000);
    const res = await fetch(`${base}/${ids['swap.iso']}/manifest`);
    expect(res.status).toBe(500);
  });

  it('answers 404 disc-changed when an image changes while its tree is parsed', async () => {
    const path = join(tmp, 'root', 'race.iso');
    const get = vi.spyOn(IsoTrees.prototype, 'get').mockImplementation(async () => {
      writeFileSync(path, Buffer.alloc(2048));
      throw new Error('not a UDF image');
    });
    try {
      const res = await fetch(`${base}/${ids['race.iso']}/manifest`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'disc-changed' });
    } finally {
      get.mockRestore();
    }
  });
});
