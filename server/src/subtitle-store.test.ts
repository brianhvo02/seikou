import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FansubSource, StoredSubtitle } from '../../src/engine/disc/nas-api';
import { BadNameError, EmptyBodyError, SubtitleStore, TooLargeError, type SubtitleMeta } from './subtitle-store';

// Counts the store's disk reads, so a test can say a listing or a budget check never walks the folders.
const reads = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const counted = <F extends (...a: never[]) => unknown>(f: F): F => ((...a: Parameters<F>) => {
    reads.n++;
    return f(...a);
  }) as F;
  return { ...fs, readdirSync: counted(fs.readdirSync), readFileSync: counted(fs.readFileSync), statSync: counted(fs.statSync) };
});

const META: SubtitleMeta = {
  name: 'Fan subs', language: 'en', offsetMs: 0, uploaderPersonId: 'p1',
  attachment: { kind: 'chapter', discKey: 'disc-a', playlistId: '00001', chapter: 2 },
};

async function* body(...parts: (string | Buffer)[]): AsyncGenerator<Buffer> {
  for (const p of parts) yield Buffer.from(p);
}
const bytes = (n: number): AsyncGenerator<Buffer> => body(Buffer.alloc(n, 65));

let dir: string;
let clock: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'subs-'));
  clock = 1_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const make = (maxTotalBytes?: number): SubtitleStore => new SubtitleStore(dir, { maxTotalBytes, now: () => clock });
const leftovers = (id: string): string[] => readdirSync(join(dir, 'subtitles', id), { recursive: true }).map(String).filter((n) => n.includes('.tmp-'));

describe('SubtitleStore', () => {
  it('holds fonts to 50 MiB even when two upload at once', async () => {
    const s = make();
    const { id } = s.create(META);
    const mib = 1024 * 1024;
    const r = await Promise.allSettled([s.writeFont(id, 'a.ttf', bytes(30 * mib)), s.writeFont(id, 'b.ttf', bytes(30 * mib))]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.find((x) => x.status === 'rejected')).toMatchObject({ reason: expect.any(TooLargeError) });
    expect(s.get(id)!.fonts).toHaveLength(1);
    expect(leftovers(id)).toEqual([]);
  });

  it('refuses an empty subtitle and keeps the existing file', async () => {
    const s = make();
    const { id } = s.create(META);
    await expect(s.writeFile(id, 'a.srt', body())).rejects.toBeInstanceOf(EmptyBodyError);
    expect(s.list()).toEqual([]);
    await s.writeFile(id, 'a.srt', body('keep'));
    await expect(s.writeFile(id, 'b.srt', body())).rejects.toBeInstanceOf(EmptyBodyError);
    expect(readFileSync(s.filePath(id)!, 'utf8')).toBe('keep');
    expect(leftovers(id)).toEqual([]);
  });

  it('leaves no folder when the upload is deleted during a stream', async () => {
    const s = make();
    const { id } = s.create(META);
    async function* slow(): AsyncGenerator<Buffer> {
      yield Buffer.from('x');
      s.delete(id);
      yield Buffer.from('y');
    }
    await expect(s.writeFile(id, 'a.srt', slow())).rejects.toThrow();
    expect(existsSync(join(dir, 'subtitles', id))).toBe(false);
  });

  it('measures names in bytes', async () => {
    const s = make();
    const { id } = s.create(META);
    await expect(s.writeFile(id, `${'é'.repeat(126)}.ass`, body('x'))).rejects.toBeInstanceOf(BadNameError);
  });

  it('lists an upload only once it has a file', async () => {
    const s = make();
    const c = s.create(META);
    expect(c).toMatchObject({ fileSize: 0, fonts: [], uploadedAt: clock });
    expect(c.id).toMatch(/^[0-9a-f]{16}$/);
    expect(s.list()).toEqual([]);
    expect(s.filePath(c.id)).toBeNull();
    const w = await s.writeFile(c.id, 'ep1.srt', body('1\n00:00:01,000 --> 00:00:02,000\nhi\n'));
    expect(w.fileName).toBe('ep1.srt');
    expect(s.list().map((x: StoredSubtitle) => x.id)).toEqual([c.id]);
    expect(readFileSync(s.filePath(c.id)!, 'utf8')).toContain('hi');
    expect(s.get(c.id)).toEqual(w);
  });

  it('replaces an earlier file, even under another name', async () => {
    const s = make();
    const { id } = s.create(META);
    await s.writeFile(id, 'a.srt', body('one'));
    const w = await s.writeFile(id, 'b.ass', body('three'));
    expect(w).toMatchObject({ fileName: 'b.ass', fileSize: 5 });
    expect(existsSync(join(dir, 'subtitles', id, 'sub', 'a.srt'))).toBe(false);
    expect(readFileSync(s.filePath(id)!, 'utf8')).toBe('three');
  });

  it('refuses a subtitle over 5 MiB and leaves nothing behind', async () => {
    const s = make();
    const { id } = s.create(META);
    await expect(s.writeFile(id, 'big.srt', bytes(5 * 1024 * 1024 + 1))).rejects.toBeInstanceOf(TooLargeError);
    expect(leftovers(id)).toEqual([]);
    expect(existsSync(join(dir, 'subtitles', id, 'sub', 'big.srt'))).toBe(false);
    expect(s.list()).toEqual([]);
    await s.writeFile(id, 'ok.srt', bytes(5 * 1024 * 1024));
  });

  it('keeps the old file when a replacement is too large', async () => {
    const s = make();
    const { id } = s.create(META);
    await s.writeFile(id, 'a.srt', body('keep'));
    await expect(s.writeFile(id, 'a.srt', bytes(6 * 1024 * 1024))).rejects.toBeInstanceOf(TooLargeError);
    expect(readFileSync(s.filePath(id)!, 'utf8')).toBe('keep');
    expect(leftovers(id)).toEqual([]);
  });

  it('removes the temp file when the body fails midway', async () => {
    const s = make();
    const { id } = s.create(META);
    async function* broken(): AsyncGenerator<Buffer> {
      yield Buffer.from('x');
      throw new Error('socket closed');
    }
    await expect(s.writeFile(id, 'a.srt', broken())).rejects.toThrow('socket closed');
    expect(leftovers(id)).toEqual([]);
  });

  it('holds fonts to 50 MiB in all, and the same name replaces', async () => {
    const s = make();
    const { id } = s.create(META);
    const mib = 1024 * 1024;
    await s.writeFont(id, 'a.ttf', bytes(30 * mib));
    await expect(s.writeFont(id, 'b.otf', bytes(21 * mib))).rejects.toBeInstanceOf(TooLargeError);
    expect(leftovers(id)).toEqual([]);
    expect(s.get(id)!.fonts).toEqual([{ name: 'a.ttf', size: 30 * mib }]);
    const w = await s.writeFont(id, 'a.ttf', bytes(45 * mib));
    expect(w.fonts).toEqual([{ name: 'a.ttf', size: 45 * mib }]);
    await s.writeFont(id, 'b.woff', bytes(5 * mib));
    expect(s.fontPath(id, 'b.woff')).toBe(join(dir, 'subtitles', id, 'fonts', 'b.woff'));
    await expect(s.writeFont(id, 'c.woff2', bytes(1))).rejects.toBeInstanceOf(BadNameError);
    expect(s.fontPath(id, 'nope.ttf')).toBeNull();
  });

  it('counts every upload against the total', async () => {
    const s = make(1_000);
    const a = s.create(META);
    const b = s.create(META);
    await s.writeFile(a.id, 'a.srt', bytes(600));
    await s.writeFont(a.id, 'f.ttf', bytes(300));
    await expect(s.writeFile(b.id, 'b.srt', bytes(101))).rejects.toBeInstanceOf(TooLargeError);
    await s.writeFile(b.id, 'b.srt', bytes(100));
    // Replacing counts only the difference.
    await s.writeFile(a.id, 'a.srt', bytes(600));
    await expect(s.writeFile(a.id, 'a.srt', bytes(601))).rejects.toBeInstanceOf(TooLargeError);
    expect(leftovers(a.id)).toEqual([]);
    expect(leftovers(b.id)).toEqual([]);
  });

  it.each(['../x.ttf', 'a/b.ass', 'x\0.ass', '.', '..', 'x.exe', '', `${'a'.repeat(252)}.ass`])('refuses the name %j', async (name) => {
    const s = make();
    const { id } = s.create(META);
    await expect(s.writeFile(id, name, body('x'))).rejects.toBeInstanceOf(BadNameError);
    await expect(s.writeFont(id, name, body('x'))).rejects.toBeInstanceOf(BadNameError);
    expect(leftovers(id)).toEqual([]);
  });

  it('refuses a font name on a subtitle and the reverse', async () => {
    const s = make();
    const { id } = s.create(META);
    await expect(s.writeFile(id, 'a.ttf', body('x'))).rejects.toBeInstanceOf(BadNameError);
    await expect(s.writeFont(id, 'a.srt', body('x'))).rejects.toBeInstanceOf(BadNameError);
    for (const ok of ['a.SRT', 'a.ssa', 'a.ass']) await s.writeFile(id, ok, body('x'));
    for (const ok of ['a.ttc', 'a.woff', 'a.otf']) await s.writeFont(id, ok, body('x'));
  });

  it('updates, deletes, and survives a new instance', async () => {
    const s = make();
    const { id } = s.create(META);
    await s.writeFile(id, 'a.srt', body('x'));
    const att = { kind: 'episode', discKey: 'disc-b', playlistId: '00002', titleId: 't', seasonId: 's', episode: 3 } as const;
    expect(s.update(id, { name: 'New', language: 'fr', offsetMs: -250, attachment: att })).toMatchObject({ name: 'New', language: 'fr', offsetMs: -250, attachment: att, fileName: 'a.srt' });
    expect(make().get(id)).toMatchObject({ name: 'New' });
    expect(s.update('0123456789abcdef', { name: 'x' })).toBeNull();
    expect(s.delete(id)).toBe(true);
    expect(s.delete(id)).toBe(false);
    expect(s.get(id)).toBeNull();
    expect(s.list()).toEqual([]);
  });

  it('ignores ids that are not ours', () => {
    const s = make();
    expect(s.get('../..')).toBeNull();
    expect(s.delete('../..')).toBe(false);
    expect(s.filePath('../x')).toBeNull();
  });

  it('removes an upload with no file after an hour', async () => {
    const s = make();
    const stale = s.create(META);
    clock += 30 * 60_000;
    const fresh = s.create(META);
    const done = s.create(META);
    await s.writeFile(done.id, 'a.srt', body('x'));
    clock += 30 * 60_000 + 1;
    expect(s.list().map((x) => x.id)).toEqual([done.id]);
    expect(s.get(stale.id)).toBeNull();
    expect(existsSync(join(dir, 'subtitles', stale.id))).toBe(false);
    expect(s.get(fresh.id)).not.toBeNull();
  });

  describe('fansubs', () => {
    const SOURCE: FansubSource = {
      kind: 'fansub', group: 'Grp', tracker: 'nyaa', rank: 'best', toshoFileId: 7, track: 2, trackName: 'English',
      alignment: { kind: 'offset', offsetMs: 120, confidence: 0.9 }, linedUpOn: { discKey: 'd.1', playlistId: '00001' },
    };
    const FMETA = { ...META, source: SOURCE };
    const pool = (): string[] => readdirSync(join(dir, 'subtitles', '.fonts'));

    it('stores a fansub with its original and pooled fonts', () => {
      const s = make();
      const f = s.createFansub(FMETA, { name: 'a.ass', data: Buffer.from('aligned'), original: Buffer.from('o') }, [{ name: 'F.ttf', data: Buffer.from('X') }]);
      expect(readFileSync(s.filePath(f.id)!, 'utf8')).toBe('aligned');
      expect(readFileSync(s.originalPath(f.id)!, 'utf8')).toBe('o');
      expect(readFileSync(s.fontPath(f.id, 'F.ttf')!, 'utf8')).toBe('X');
      expect(s.list()[0].source!.kind).toBe('fansub');
      expect(s.originalPath(s.create(META).id)).toBeNull();
    });

    it('shares a font between fansubs', () => {
      const s = make();
      const file = { name: 'a.ass', data: Buffer.from('a'), original: Buffer.from('o') };
      const font = [{ name: 'F.ttf', data: Buffer.from('X') }];
      const a = s.createFansub(FMETA, file, font);
      const b = s.createFansub(FMETA, file, font);
      expect(pool()).toHaveLength(1);
      s.delete(a.id);
      expect(readFileSync(s.fontPath(b.id, 'F.ttf')!, 'utf8')).toBe('X');
      s.delete(b.id);
      expect(pool()).toEqual([]);
    });

    it('counts fansubs against their own budget', async () => {
      const s = new SubtitleStore(dir, { maxTotalBytes: 100, maxFansubBytes: 1000, now: () => clock });
      s.createFansub(FMETA, { name: 'a.ass', data: Buffer.alloc(250), original: Buffer.alloc(250) }, []);
      const { id } = s.create(META);
      await s.writeFile(id, 'u.srt', bytes(80));
      expect(() => s.createFansub(FMETA, { name: 'b.ass', data: Buffer.alloc(300), original: Buffer.alloc(300) }, [])).toThrow(TooLargeError);
      expect(readdirSync(join(dir, 'subtitles')).filter((n) => /^[0-9a-f]{16}$/.test(n))).toHaveLength(2);
    });

    it('says what replacing fansubs would cost, with the old ones kept and with them gone', () => {
      const s = new SubtitleStore(dir, { maxFansubBytes: 1000, now: () => clock });
      const shared = { name: 'S.ttf', data: Buffer.alloc(10, 1) };
      const own = { name: 'O.ttf', data: Buffer.alloc(20, 2) };
      const old = s.createFansub(FMETA, { name: 'a.ass', data: Buffer.alloc(100), original: Buffer.alloc(100) }, [shared, own]);
      s.createFansub(FMETA, { name: 'b.ass', data: Buffer.alloc(50), original: Buffer.alloc(50) }, [shared]);
      // used: 200 + 100 + 10 + 20 = 330
      const files = [{ data: Buffer.alloc(150), original: Buffer.alloc(150) }];
      const fresh = { name: 'N.ttf', data: Buffer.alloc(5, 3) };
      expect(s.fansubSwap([old.id], files, [shared, fresh])).toEqual({ room: 670, keep: 305, swap: 305 - 200 - 20 });
      // A font only the old one used comes back with the new one: kept, it costs nothing; swapped, it is freed and added again.
      expect(s.fansubSwap([old.id], files, [own])).toEqual({ room: 670, keep: 300, swap: 300 - 200 - 20 + 20 });
    });

    it('lists, prices and stores fansubs without reading the disk', async () => {
      const s = new SubtitleStore(dir, { maxFansubBytes: 1000, now: () => clock });
      const font = { name: 'F.ttf', data: Buffer.alloc(10, 1) };
      const a = s.createFansub(FMETA, { name: 'a.ass', data: Buffer.alloc(100), original: Buffer.alloc(50) }, [font]);
      const { id } = s.create(META);
      await s.writeFile(id, 'u.srt', body('x'));
      reads.n = 0;
      expect(s.list()).toHaveLength(2);
      const files = [{ data: Buffer.alloc(10), original: Buffer.alloc(10) }];
      expect(s.fansubSwap([a.id], files, [font])).toEqual({ room: 840, keep: 20, swap: 20 - 150 });
      const b = s.createFansub(FMETA, { name: 'b.ass', data: Buffer.alloc(10), original: Buffer.alloc(10) }, [font]);
      expect(s.get(b.id)).not.toBeNull();
      s.delete(a.id);
      expect(s.fansubSwap([], [], [])).toMatchObject({ room: 1000 - 20 - 10 });
      expect(reads.n).toBe(0);
    });

    it('a fresh instance loads what an earlier one wrote, originals and pooled fonts included', async () => {
      const first = new SubtitleStore(dir, { maxTotalBytes: 100, maxFansubBytes: 1000, now: () => clock });
      const font = { name: 'F.ttf', data: Buffer.alloc(10, 1) };
      const a = first.createFansub(FMETA, { name: 'a.ass', data: Buffer.alloc(100), original: Buffer.alloc(50) }, [font]);
      first.createFansub(FMETA, { name: 'b.ass', data: Buffer.alloc(20), original: Buffer.alloc(20) }, [font]);
      const { id } = first.create(META);
      await first.writeFile(id, 'u.srt', bytes(60));
      const s = new SubtitleStore(dir, { maxTotalBytes: 100, maxFansubBytes: 1000, now: () => clock });
      expect(s.list().map((x) => x.id).sort()).toEqual(first.list().map((x) => x.id).sort());
      expect(s.fansubSwap([a.id], [], [])).toEqual({ room: 1000 - 190 - 10, keep: 0, swap: -150 });
      const other = s.create(META);
      await expect(s.writeFile(other.id, 'v.srt', bytes(41))).rejects.toBeInstanceOf(TooLargeError);
      await s.writeFile(other.id, 'v.srt', bytes(40));
    });

    it('sweeps pooled fonts no fansub uses at start-up', () => {
      const first = make();
      const f = first.createFansub(FMETA, { name: 'a.ass', data: Buffer.from('a'), original: Buffer.from('o') }, [{ name: 'F.ttf', data: Buffer.from('X') }]);
      // What a createFansub that failed after writing its fonts leaves behind.
      writeFileSync(join(dir, 'subtitles', '.fonts', 'a'.repeat(64)), 'orphan');
      writeFileSync(join(dir, 'subtitles', '.fonts', `${'b'.repeat(64)}.tmp-123456`), 'half');
      const s = make();
      expect(pool()).toEqual([s.get(f.id)!.fonts[0].hash]);
      expect(readFileSync(s.fontPath(f.id, 'F.ttf')!, 'utf8')).toBe('X');
    });

    it('replaceFile keeps the original', () => {
      const s = make();
      const f = s.createFansub(FMETA, { name: 'a.ass', data: Buffer.from('a'), original: Buffer.from('o') }, []);
      const r = s.replaceFile(f.id, Buffer.from('b'), { ...SOURCE, alignment: { kind: 'original' } });
      expect(r!.source!.alignment.kind).toBe('original');
      expect(readFileSync(s.filePath(f.id)!, 'utf8')).toBe('b');
      expect(readFileSync(s.originalPath(f.id)!, 'utf8')).toBe('o');
      expect(s.get(f.id)!.source!.alignment.kind).toBe('original');
    });
  });
});
