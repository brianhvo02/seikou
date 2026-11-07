import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as udf from '@seikou/bdmv/udf';
import { discId } from './disc-id';
import { createServer } from './http';
import { Library, SETTLE_MS, nextNightly } from './library';
import { libraryRoute } from './routes/library';

let tmp: string;
/** Fixtures are created just now, so the clock is set past the settle time. */
const FAST = { scanPauseMs: 0, now: () => Date.now() + SETTLE_MS + 1 };
const touch = (path: string, content = 'x'): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'library-'));
  const a = join(tmp, 'a');
  touch(join(a, 'Series (シリーズ)/Vol 1/BDMV/index.bdmv'));
  touch(join(a, 'Series (シリーズ)/Vol 1/BK/01.png'));
  touch(join(a, '[BDMV] Single #1 100%/bdmv/INDEX.BDMV'));
  touch(join(a, 'movie.mkv'));
  touch(join(a, 'x.torrent'));
  mkdirSync(join(a, 'lost+found'));
  copyFileSync(join(import.meta.dirname, '../../fixtures/synthetic/disc1.iso'), join(a, 'disc.iso'));
  touch(join(a, 'junk.iso'), 'iso-bytes'.repeat(100_000));
  touch(join(tmp, 'b/Other/BDMV/index.bdmv'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const roots = () => [
  { name: 'mediaA', dir: join(tmp, 'a') },
  { name: 'mediaB', dir: join(tmp, 'b') },
];

describe('Library', () => {
  it('merges roots and lists folders and discs', async () => {
    const lib = new Library(roots(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    const top = lib.list('')!;
    expect(top.discs.map((d) => [d.name, d.path, d.kind])).toEqual([
      ['[BDMV] Single #1 100%', 'mediaA/[BDMV] Single #1 100%', 'folder'],
      ['disc.iso', 'mediaA/disc.iso', 'iso'],
      ['Other', 'mediaB/Other', 'folder'],
    ]);
    expect(top.folders).toEqual([{ name: 'Series (シリーズ)', path: 'mediaA/Series (シリーズ)', discs: 1 }]);
    const a = lib.list('mediaA')!;
    expect(a.folders).toEqual([{ name: 'Series (シリーズ)', path: 'mediaA/Series (シリーズ)', discs: 1 }]);
    expect(lib.list('mediaA/Series (シリーズ)')).toMatchObject({ folders: [], discs: [{ name: 'Vol 1' }] });
    expect(lib.list('nope')).toBeNull();
  });

  it('keeps ids stable across scans and changes them when index.bdmv changes', async () => {
    const lib = new Library(roots(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    const id = lib.list('mediaB')!.discs[0]!.id;
    await lib.scan();
    expect(lib.list('mediaB')!.discs[0]!.id).toBe(id);
    expect(lib.disc(id)?.name).toBe('Other');
    touch(join(tmp, 'b/Other/BDMV/index.bdmv'), 'longer content');
    await lib.scan();
    expect(lib.list('mediaB')!.discs[0]!.id).not.toBe(id);
    expect(discId('p', 1, 2)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('loads the cache file at start', async () => {
    const file = join(tmp, 'library.json');
    await new Library(roots(), file, FAST).scan();
    const fresh = new Library(roots(), file, FAST);
    expect(fresh.list('mediaB')!.discs).toHaveLength(1);
  });

  it('answers from the previous tree while a scan is running', async () => {
    const file = join(tmp, 'library.json');
    await new Library(roots(), file, FAST).scan();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const lib = new Library(roots(), file, { ...FAST, opendir: async (p) => (await gate, opendir(p)) });
    const scan = lib.scan();
    expect(lib.scanning).toBe(true);
    expect(lib.list('')!.discs).toHaveLength(3);
    release();
    await scan;
    expect(lib.scanning).toBe(false);
  });
});

describe('Library scan behaviour', () => {
  const streamOf = (): string => join(tmp, 'a/[BDMV] Single #1 100%/bdmv/STREAM');

  it('does not read STREAM again for an unchanged disc and keeps its size', async () => {
    touch(join(streamOf(), '00001.m2ts'), '12345');
    const opened: string[] = [];
    const spy = async (p: string) => (opened.push(p), opendir(p));
    const lib = new Library(roots(), join(tmp, 'library.json'), { ...FAST, opendir: spy });
    await lib.scan();
    const size = lib.list('mediaA')!.discs.find((d) => d.name.startsWith('[BDMV]'))!.sizeBytes;
    expect(size).toBe(5);
    expect(opened.some((p) => p.endsWith('STREAM'))).toBe(true);
    opened.length = 0;
    await lib.scan();
    expect(opened.some((p) => p.endsWith('STREAM'))).toBe(false);
    expect(lib.list('mediaA')!.discs.find((d) => d.name.startsWith('[BDMV]'))!.sizeBytes).toBe(5);
  });

  it('spaces directory reads by scanPauseMs', async () => {
    const times: number[] = [];
    const spy = async (p: string) => {
      times.push(Date.now());
      return opendir(p);
    };
    const lib = new Library(roots(), join(tmp, 'library.json'), { scanPauseMs: 30, opendir: spy });
    await lib.scan();
    expect(times.length).toBeGreaterThan(4);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(25);
  });

  it('keeps a root previous entries when its top-level read fails', async () => {
    const file = join(tmp, 'library.json');
    await new Library(roots(), file, FAST).scan();
    const bDir = join(tmp, 'b');
    const lib = new Library(roots(), file, {
      ...FAST,
      opendir: async (p) => {
        if (p === bDir) throw new Error('EIO');
        return opendir(p);
      },
    });
    await lib.scan();
    expect(lib.list('mediaB')!.discs.map((d) => d.name)).toEqual(['Other']);
    expect(new Library(roots(), file, FAST).list('mediaB')!.discs).toHaveLength(1);
  });

  it('keeps a root previous entries when it lists zero entries (a drive that is not mounted)', async () => {
    const file = join(tmp, 'library.json');
    await new Library(roots(), file, FAST).scan();
    const bDir = join(tmp, 'b');
    rmSync(bDir, { recursive: true });
    mkdirSync(bDir);
    const lib = new Library(roots(), file, FAST);
    await lib.scan();
    expect(lib.list('mediaB')!.discs.map((d) => d.name)).toEqual(['Other']);
    expect(new Library(roots(), file, FAST).list('mediaB')!.discs).toHaveLength(1);
  });

  it("keeps a root previous entries when its Movies folder doesn't exist (a drive whose mount point is empty)", async () => {
    const file = join(tmp, 'library.json');
    const mounted = [{ name: 'mediaB', dir: join(tmp, 'mnt/mediaB/Movies') }];
    cpSync(join(tmp, 'b'), mounted[0]!.dir, { recursive: true, preserveTimestamps: true });
    await new Library(mounted, file, FAST).scan();
    rmSync(join(tmp, 'mnt/mediaB/Movies'), { recursive: true });
    const lib = new Library(mounted, file, FAST);
    await lib.scan();
    expect(lib.list('mediaB')!.discs.map((d) => d.name)).toEqual(['Other']);
    expect(new Library(mounted, file, FAST).list('mediaB')!.discs).toHaveLength(1);
  });

  it("keeps disc ids and library paths when a root's directory moves (/library/mediaN to /library-mnt/mediaN/Movies)", async () => {
    const before = new Library(roots(), join(tmp, 'before.json'), FAST);
    await before.scan();
    const moved = roots().map((r) => ({ name: r.name, dir: join(tmp, 'library-mnt', r.name, 'Movies') }));
    for (const [i, r] of moved.entries()) cpSync(roots()[i]!.dir, r.dir, { recursive: true, preserveTimestamps: true });
    const after = new Library(moved, join(tmp, 'after.json'), FAST);
    await after.scan();
    const discs = (lib: Library) => [...lib.list('mediaA')!.discs, ...lib.list('mediaB')!.discs, ...lib.list('mediaA/Series (シリーズ)')!.discs].map(({ id, path }) => ({ id, path }));
    expect(discs(after)).toEqual(discs(before));
    expect(discs(before).length).toBeGreaterThan(2);
    const disc = after.list('mediaB')!.discs[0]!;
    expect(after.locate(disc)).toBe(join(tmp, 'library-mnt/mediaB/Movies/Other'));
  });

  it('installs the tree after each root on a first scan', async () => {
    const bDir = join(tmp, 'b');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const lib = new Library(roots(), join(tmp, 'library.json'), {
      ...FAST,
      opendir: async (p) => {
        if (p === bDir) await gate;
        return opendir(p);
      },
    });
    const scan = lib.scan();
    await vi.waitFor(() => expect(lib.list('')!.discs.length).toBe(2));
    release();
    await scan;
    expect(lib.list('')!.discs).toHaveLength(3);
  });

  it('does not descend into a BDMV folder without index.bdmv', async () => {
    touch(join(tmp, 'a/Odd/BDMV/Nested/BDMV/index.bdmv'));
    const lib = new Library(roots(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    expect(lib.list('mediaA/Odd')).toBeNull();
  });

  it('lists an .iso only when its UDF tree has BDMV/INDEX.BDMV, and reads each image once', async () => {
    touch(join(tmp, 'a/no-bdmv.iso'), '');
    const lib = new Library(roots(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    const isos = lib.list('mediaA')!.discs.filter((d) => d.kind === 'iso');
    expect(isos.map((d) => d.name)).toEqual(['disc.iso']);
    expect(isos[0]!.sizeBytes).toBe(statSync(join(tmp, 'a/disc.iso')).size);
    const reads = vi.spyOn(udf.UdfImage, 'open');
    await lib.scan();
    expect(reads).not.toHaveBeenCalled();
    expect(lib.list('mediaA')!.discs.filter((d) => d.kind === 'iso').map((d) => d.name)).toEqual(['disc.iso']);
    reads.mockRestore();
  });

  it('drops invalid cache entries and entries of unconfigured roots', () => {
    const file = join(tmp, 'library.json');
    const good = { id: 'a', name: 'X', path: 'mediaA/X', kind: 'folder', sizeBytes: 1 };
    writeFileSync(
      file,
      JSON.stringify([good, { ...good, id: 'b', path: 'gone/X' }, { ...good, id: 'c', kind: 'zip' }, { id: 'd' }, null, { ...good, id: 'e', path: 5 }]),
    );
    const lib = new Library(roots(), file, FAST);
    expect(lib.list('')!.discs).toEqual([good]);
  });
});

describe('Library evidence', () => {
  const bdmt = '<disclib><di:discinfo><di:title><di:name>Single One</di:name></di:title></di:discinfo></disclib>';
  const single = (): string => join(tmp, 'a/[BDMV] Single #1 100%/bdmv');

  beforeEach(() => {
    touch(join(single(), 'STREAM/00001.m2ts'), '12345');
    touch(join(single(), 'META/DL/bdmt_eng.xml'), bdmt);
  });

  it('records evidence for each disc, folder and ISO, and keeps it out of the listing', async () => {
    const lib = new Library(roots(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    const byPath = new Map(lib.evidence().map((e) => [e.path, e]));
    expect([...byPath.keys()].sort()).toEqual(['mediaA/Series (シリーズ)/Vol 1', 'mediaA/[BDMV] Single #1 100%', 'mediaA/disc.iso', 'mediaB/Other']);
    const folder = byPath.get('mediaA/[BDMV] Single #1 100%')!;
    expect(folder.discTitles).toEqual([{ lang: 'eng', name: 'Single One' }]);
    expect(folder.fingerprint).toMatch(/^[0-9A-F]{32}$/);
    expect(folder.discId).toBe(lib.list('mediaA')!.discs.find((d) => d.name.startsWith('[BDMV]'))!.id);
    expect(byPath.get('mediaA/disc.iso')!.playlists.length).toBeGreaterThan(0);
    expect(lib.list('mediaA')!.discs.every((d) => !('evidence' in d))).toBe(true);
  });

  it('hands out the same evidence list until a scan installs new evidence', async () => {
    const lib = new Library(roots(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    const first = lib.evidence();
    expect(lib.evidence()).toBe(first);
    rmSync(join(tmp, 'a/disc.iso'));
    await lib.scan();
    expect(lib.evidence()).not.toBe(first);
    expect(lib.evidence().length).toBe(first.length - 1);
  });

  it('caches evidence in library.json and does not read it again for an unchanged disc', async () => {
    const file = join(tmp, 'library.json');
    await new Library(roots(), file, FAST).scan();
    writeFileSync(join(single(), 'META/DL/bdmt_eng.xml'), bdmt.replace('Single One', 'Changed'));
    rmSync(join(tmp, 'a/junk.iso')); // A new Library would probe this non-disc again.
    const opened: string[] = [];
    const lib = new Library(roots(), file, { ...FAST, opendir: async (p) => (opened.push(p), opendir(p)) });
    const title = (): string | undefined => lib.evidence().find((e) => e.path === 'mediaA/[BDMV] Single #1 100%')?.discTitles[0]?.name;
    expect(title()).toBe('Single One');
    const reads = vi.spyOn(udf.UdfImage, 'open');
    await lib.scan();
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    expect(title()).toBe('Single One');
    // Only the disc's BDMV folder is listed (for index.bdmv), none of its subfolders.
    expect(opened.filter((p) => p.startsWith(single()) && p !== single())).toEqual([]);
  });

  it('reads folder evidence through the paced directory reader', async () => {
    const opened: string[] = [];
    const lib = new Library(roots(), join(tmp, 'library.json'), { ...FAST, opendir: async (p) => (opened.push(p), opendir(p)) });
    await lib.scan();
    expect(opened).toContain(join(single(), 'META/DL'));
  });

  it('parses a new ISO image once', async () => {
    const only = [{ name: 'mediaA', dir: join(tmp, 'iso') }];
    mkdirSync(only[0]!.dir);
    copyFileSync(join(tmp, 'a/disc.iso'), join(only[0]!.dir, 'disc.iso'));
    const reads = vi.spyOn(udf.UdfImage, 'open');
    const lib = new Library(only, join(tmp, 'library.json'), FAST);
    await lib.scan();
    expect(reads).toHaveBeenCalledTimes(1);
    reads.mockRestore();
    expect(lib.evidence()[0]!.playlists.length).toBeGreaterThan(0);
  });

  it('drops malformed cached evidence, keeps the disc, and reads the evidence again', async () => {
    const file = join(tmp, 'library.json');
    await new Library(roots(), file, FAST).scan();
    const cached = JSON.parse(readFileSync(file, 'utf8')) as { path: string; evidence: Record<string, unknown> }[];
    const entry = cached.find((d) => d.path === 'mediaA/[BDMV] Single #1 100%')!;
    entry.evidence = { ...entry.evidence, playlists: [{ id: 1 }], discTitles: ['x'] };
    writeFileSync(file, JSON.stringify(cached));
    const lib = new Library(roots(), file, FAST);
    expect(lib.list('mediaA')!.discs.some((d) => d.path === entry.path)).toBe(true);
    expect(lib.evidence().some((e) => e.path === entry.path)).toBe(false);
    await lib.scan();
    expect(lib.evidence().find((e) => e.path === entry.path)?.discTitles).toEqual([{ lang: 'eng', name: 'Single One' }]);
  });

  it('reads evidence on the next scan for a cache written without it', async () => {
    const file = join(tmp, 'library.json');
    await new Library(roots(), file, FAST).scan();
    const old = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[]).map(({ evidence: _, ...d }) => d);
    writeFileSync(file, JSON.stringify(old));
    const lib = new Library(roots(), file, FAST);
    expect(lib.list('')!.discs).toHaveLength(3);
    expect(lib.evidence()).toEqual([]);
    await lib.scan();
    expect(lib.evidence()).toHaveLength(4);
    expect(lib.evidence().map((e) => e.discId).sort()).toEqual(old.map((d) => d.id as string).sort());
  });

  it('calls onScanned after every completed scan', async () => {
    const lib = new Library(roots(), join(tmp, 'library.json'), FAST);
    const calls: number[] = [];
    lib.onScanned(() => calls.push(lib.evidence().length));
    await lib.scan();
    await lib.scan();
    expect(calls).toEqual([4, 4]);
  });
});

describe('nextNightly', () => {
  it('honours a configured time', () => {
    expect(nextNightly(new Date('2026-10-17T03:59:00'), { hour: 3, minute: 30 })).toEqual(new Date('2026-10-18T03:30:00'));
  });

  it('is 04:00 today before 04:00 and tomorrow from 04:00', () => {
    expect(nextNightly(new Date('2026-10-17T03:59:00'))).toEqual(new Date('2026-10-17T04:00:00'));
    expect(nextNightly(new Date('2026-10-17T04:00:00'))).toEqual(new Date('2026-10-18T04:00:00'));
  });
});

describe('GET /api/library', () => {
  it('round-trips awkward folder names exactly', async () => {
    const nfd = 'が'.normalize('NFD');
    touch(join(tmp, `a/A+B #1 100%?/Vol/BDMV/index.bdmv`));
    touch(join(tmp, `a/${nfd}/Vol/BDMV/index.bdmv`));
    const lib = new Library(roots(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    const server = createServer([libraryRoute(lib)]);
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const port = (server.address() as AddressInfo).port;
      for (const name of ['A+B #1 100%?', nfd]) {
        const listed = lib.list('mediaA')!.folders.find((f) => f.name === name);
        expect(listed?.path).toBe(`mediaA/${name}`);
        const res = await fetch(`http://127.0.0.1:${port}/api/library?path=${encodeURIComponent(`mediaA/${name}`)}`);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { discs: { path: string }[] }).discs[0]!.path).toBe(`mediaA/${name}/Vol`);
      }
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });

  it('answers a percent-encoded folder path', async () => {
    const lib = new Library(roots(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    const server = createServer([libraryRoute(lib)]);
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/library?path=${encodeURIComponent('mediaA/Series (シリーズ)')}`);
      const body = (await res.json()) as { discs: { name: string }[]; scanning: boolean };
      expect(body.discs.map((d) => d.name)).toEqual(['Vol 1']);
      expect(body.scanning).toBe(false);
      expect((await fetch(`http://127.0.0.1:${port}/api/library?path=zzz`)).status).toBe(404);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});

describe('Downloads group', () => {
  const MIN = 60_000;
  const dl = (): { name: string; dir: string; group?: string }[] => [
    { name: 'mediaA', dir: join(tmp, 'a') },
    { name: 'mediaA-dl', dir: join(tmp, 'dl1'), group: 'Downloads' },
    { name: 'mediaB-dl', dir: join(tmp, 'dl2'), group: 'Downloads' },
  ];
  const age = (path: string, atMs: number): void => utimesSync(path, atMs / 1000, atMs / 1000);

  beforeEach(() => {
    touch(join(tmp, 'dl1/Show/Vol 1/BDMV/index.bdmv'));
    touch(join(tmp, 'dl1/Loose/BDMV/index.bdmv'));
    touch(join(tmp, 'dl2/Show/Vol 2/BDMV/index.bdmv'));
  });

  it('shows the group as one folder and merges its roots', async () => {
    const lib = new Library(dl(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    const top = lib.list('')!;
    expect(top.folders).toContainEqual({ name: 'Downloads', path: 'Downloads', discs: 3 });
    expect(top.folders.map((f) => f.path)).not.toContain('mediaA-dl/Show');
    expect(top.discs.map((d) => d.path)).not.toContain('mediaA-dl/Loose');
    const group = lib.list('Downloads')!;
    expect(group.folders).toEqual([{ name: 'Show', path: 'Downloads/Show', discs: 2 }]);
    expect(group.discs.map((d) => d.path)).toEqual(['mediaA-dl/Loose']);
    expect(lib.list('Downloads/Show')!.discs.map((d) => d.path)).toEqual(['mediaA-dl/Show/Vol 1', 'mediaB-dl/Show/Vol 2']);
    expect(lib.list('Downloads/Nope')).toBeNull();
  });

  it('keeps root-based disc paths and ids', async () => {
    const plain = new Library([{ name: 'mediaA-dl', dir: join(tmp, 'dl1') }], join(tmp, 'p.json'), FAST);
    await plain.scan();
    const grouped = new Library(dl(), join(tmp, 'g.json'), FAST);
    await grouped.scan();
    const id = plain.list('mediaA-dl')!.discs[0]!.id;
    expect(grouped.disc(id)?.path).toBe('mediaA-dl/Loose');
  });

  it('skips a disc still downloading until it settles, and keeps an earlier entry', async () => {
    const t0 = Date.now();
    const clip = join(tmp, 'dl1/Loose/BDMV/STREAM/00000.m2ts');
    touch(clip);
    for (const f of ['dl1/Loose/BDMV/index.bdmv', 'dl1/Show/Vol 1/BDMV/index.bdmv', 'dl2/Show/Vol 2/BDMV/index.bdmv']) age(join(tmp, f), t0 - 120 * MIN);
    age(clip, t0 - 10 * MIN);
    let now = t0;
    const lib = new Library(dl(), join(tmp, 'library.json'), { ...FAST, now: () => now });
    await lib.scan();
    expect(lib.list('Downloads')!.discs).toEqual([]);
    expect(lib.list('Downloads')!.folders[0]!.discs).toBe(2);
    now = t0 + 51 * MIN; // The clip is 61 minutes old.
    await lib.scan();
    expect(lib.list('Downloads')!.discs.map((d) => d.path)).toEqual(['mediaA-dl/Loose']);
    // Written to again, the disc is unsettled but stays listed from the previous scan.
    age(clip, now - MIN);
    await lib.scan();
    expect(lib.list('Downloads')!.discs.map((d) => d.path)).toEqual(['mediaA-dl/Loose']);
  });

  it('applies the settle time to ISO files in a group', async () => {
    copyFileSync(join(import.meta.dirname, '../../fixtures/synthetic/disc1.iso'), join(tmp, 'dl1/new.iso'));
    const t0 = Date.now();
    age(join(tmp, 'dl1/new.iso'), t0 - 10 * MIN);
    for (const f of ['dl1/Loose/BDMV/index.bdmv', 'dl1/Show/Vol 1/BDMV/index.bdmv', 'dl2/Show/Vol 2/BDMV/index.bdmv']) age(join(tmp, f), t0 - 120 * MIN);
    const lib = new Library(dl(), join(tmp, 'library.json'), { ...FAST, now: () => t0 });
    await lib.scan();
    expect(lib.list('Downloads')!.discs.map((d) => d.name)).not.toContain('new.iso');
    const settled = new Library(dl(), join(tmp, 'library2.json'), { ...FAST, now: () => t0 + 51 * MIN });
    await settled.scan();
    expect(settled.list('Downloads')!.discs.map((d) => d.name)).toContain('new.iso');
  });
});

describe('settle time on every root', () => {
  it('skips an unsettled disc in an ungrouped root, and keeps its earlier entry', async () => {
    let now = Date.now();
    const lib = new Library(roots(), join(tmp, 'library.json'), { ...FAST, now: () => now });
    await lib.scan();
    expect(lib.list('')).toMatchObject({ discs: [], folders: [] });
    now += SETTLE_MS + 1;
    await lib.scan();
    expect(lib.list('mediaB')!.discs).toHaveLength(1);
    now = Date.now(); // index.bdmv rewritten: unsettled again, previous entry stays.
    touch(join(tmp, 'b/Other/BDMV/index.bdmv'), 'changed');
    await lib.scan();
    expect(lib.list('mediaB')!.discs).toHaveLength(1);
  });
});

describe('Downloads group, more', () => {
  const dl = (): { name: string; dir: string; group?: string }[] => [
    { name: 'mediaA', dir: join(tmp, 'a') },
    { name: 'mediaA-dl', dir: join(tmp, 'dl1'), group: 'Downloads' },
  ];

  it('locates and finds a Downloads disc', async () => {
    touch(join(tmp, 'dl1/Show/Vol 1/BDMV/index.bdmv'));
    const lib = new Library(dl(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    const disc = lib.list('Downloads/Show')!.discs[0]!;
    expect(lib.disc(disc.id)).toEqual(disc);
    expect(lib.locate(disc)).toBe(join(tmp, 'dl1/Show/Vol 1'));
  });

  it('merges a real top-level folder named like the group into the group folder', async () => {
    touch(join(tmp, 'dl1/Show/BDMV/index.bdmv'));
    touch(join(tmp, 'a/Downloads/Old/BDMV/index.bdmv'));
    const lib = new Library(dl(), join(tmp, 'library.json'), FAST);
    await lib.scan();
    expect(lib.list('')!.folders.filter((f) => f.name === 'Downloads')).toEqual([{ name: 'Downloads', path: 'Downloads', discs: 2 }]);
    const group = lib.list('Downloads')!;
    expect(group.discs.map((d) => d.path).sort()).toEqual(['mediaA-dl/Show', 'mediaA/Downloads/Old']);
  });
});
