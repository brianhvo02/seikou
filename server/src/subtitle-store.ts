import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { FansubSource, StoredSubtitle } from '../../src/engine/disc/nas-api';
import { isCode, lockFile, replaceAtomically, syncDir, writeSynced } from './atomic-json';
import { SubtitleIndex } from './subtitle-index';

export const SUBTITLE_LIMIT_BYTES = 5 * 1024 * 1024;
export const FONTS_LIMIT_BYTES = 50 * 1024 * 1024;
export const TOTAL_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
export const FANSUB_LIMIT_BYTES = 20 * 1024 ** 3;
const STALE_UPLOAD_MS = 60 * 60_000;
const ID_RE = /^[0-9a-f]{16}$/;
const SUBTITLE_EXT = /\.(?:srt|ass|ssa)$/i;
// WOFF2 is refused: the ASS renderer can't read it (Brotli and table transforms).
const FONT_EXT = /\.(?:ttf|otf|ttc|woff)$/i;

/** A body went past its limit (a file, the upload's fonts, or the store's total). */
export class TooLargeError extends Error {
  constructor() {
    super('too large');
    this.name = 'TooLargeError';
  }
}

/** A subtitle file with no bytes. */
export class EmptyBodyError extends Error {
  constructor() {
    super('empty body');
    this.name = 'EmptyBodyError';
  }
}

/** The upload doesn't exist (any more). */
export class NotFoundError extends Error {
  constructor() {
    super('no such subtitle');
    this.name = 'NotFoundError';
  }
}

/** A file name that isn't a plain name with an allowed extension. */
export class BadNameError extends Error {
  constructor() {
    super('bad name');
    this.name = 'BadNameError';
  }
}

export type SubtitleMeta = Omit<StoredSubtitle, 'id' | 'fileName' | 'fileSize' | 'fonts' | 'uploadedAt' | 'attached'>;

function checkName(name: string, ext: RegExp): void {
  if (name.length < 1 || Buffer.byteLength(name) > 255 || /[/\\\0]/.test(name) || name === '.' || name === '..' || !ext.test(name)) throw new BadNameError();
}

/** What counts against the 2 GB total: owner uploads only; fansubs have their own budget. */
const total = (s: StoredSubtitle): number => (s.source ? 0 : s.fileSize + s.fonts.reduce((n, f) => n + f.size, 0));
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * Subtitles under `subtitles/<id>/`: `meta.json`, the file in `sub/`, fonts in `fonts/`. A fansub also keeps
 * its unaligned `original/` file, and its fonts live in the shared pool `subtitles/.fonts/<sha256>`.
 */
export class SubtitleStore {
  private readonly maxTotal: number;
  private readonly maxFansub: number;
  private readonly now: () => number;
  private readonly index = new SubtitleIndex();

  constructor(private readonly dataDir: string, opts: { maxTotalBytes?: number; maxFansubBytes?: number; now?: () => number } = {}) {
    this.maxTotal = opts.maxTotalBytes ?? TOTAL_LIMIT_BYTES;
    this.maxFansub = opts.maxFansubBytes ?? FANSUB_LIMIT_BYTES;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  /** Reads every `meta.json` once (and each fansub's original's size, which the meta doesn't hold) into the index, then sweeps the font pool. */
  private load(): void {
    let names: string[];
    try {
      names = readdirSync(this.root());
    } catch (err) {
      if (isCode(err, 'ENOENT')) return;
      throw err;
    }
    for (const name of names) {
      const s = ID_RE.test(name) ? this.read(join(this.root(), name)) : null;
      if (!s) continue;
      let original = 0;
      if (s.source && s.fileName) {
        try {
          original = statSync(join(this.root(), s.id, 'original', s.fileName)).size;
        } catch (err) {
          if (!isCode(err, 'ENOENT')) throw err;
        }
      }
      this.index.set(s, original);
    }
    this.sweepPool();
  }

  /** Removes pooled fonts no fansub uses (left by a fansub whose store failed midway) and temp files. */
  private sweepPool(): void {
    const dir = join(this.root(), '.fonts');
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if (isCode(err, 'ENOENT')) return;
      throw err;
    }
    const used = this.index.pooled();
    for (const name of names) if (!used.has(name)) rmSync(join(dir, name), { force: true });
  }

  private root(): string {
    return join(this.dataDir, 'subtitles');
  }

  private dir(id: string): string | null {
    return ID_RE.test(id) ? join(this.root(), id) : null;
  }

  private read(dir: string): StoredSubtitle | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
      return typeof parsed === 'object' && parsed !== null ? (parsed as StoredSubtitle) : null;
    } catch (err) {
      if (isCode(err, 'ENOENT') || err instanceof SyntaxError) return null;
      throw err;
    }
  }

  /** Runs `fn` on an upload's meta under its lock; a returned meta is written, null leaves it alone. */
  private edit<T>(id: string, fn: (cur: StoredSubtitle) => { next: StoredSubtitle | null; result: T }): T | null {
    const dir = this.dir(id);
    if (dir === null) return null;
    const file = join(dir, 'meta.json');
    let unlock: () => void;
    try {
      unlock = lockFile(file);
    } catch (err) {
      if (isCode(err, 'ENOENT')) return null;
      throw err;
    }
    try {
      const cur = this.read(dir);
      if (!cur) return null;
      const { next, result } = fn(cur);
      if (next) {
        replaceAtomically(file, JSON.stringify(next));
        this.index.set(next);
      }
      return result;
    } finally {
      unlock();
    }
  }

  create(meta: SubtitleMeta): StoredSubtitle {
    const id = randomBytes(8).toString('hex');
    const stored: StoredSubtitle = { ...meta, id, fileName: '', fileSize: 0, fonts: [], uploadedAt: this.now() };
    const dir = join(this.root(), id);
    mkdirSync(dir, { recursive: true });
    replaceAtomically(join(dir, 'meta.json'), JSON.stringify(stored));
    this.index.set(stored);
    return stored;
  }

  get(id: string): StoredSubtitle | null {
    return ID_RE.test(id) ? this.index.get(id) : null;
  }

  /** Uploads that have a file. Uploads that never got one are removed after an hour. */
  list(): StoredSubtitle[] {
    const out: StoredSubtitle[] = [];
    for (const s of this.index.values()) {
      if (s.fileSize > 0) out.push(s);
      else if (this.now() - s.uploadedAt > STALE_UPLOAD_MS) this.delete(s.id);
    }
    return out;
  }

  update(id: string, patch: Partial<Pick<StoredSubtitle, 'name' | 'language' | 'offsetMs' | 'attachment'>>): StoredSubtitle | null {
    return this.edit(id, (cur) => {
      const next = { ...cur, ...patch };
      return { next, result: next };
    });
  }

  delete(id: string): boolean {
    const dir = this.dir(id);
    if (dir === null || !existsSync(dir)) {
      if (dir !== null) this.index.remove(id);
      return false;
    }
    const gone = this.index.remove(id);
    rmSync(dir, { recursive: true, force: true });
    syncDir(this.root());
    const used = this.index.pooled();
    for (const f of gone?.fonts ?? []) if (f.hash && !used.has(f.hash)) rmSync(this.poolFile(f.hash), { force: true });
    return true;
  }

  private poolFile(hash: string): string {
    return join(this.root(), '.fonts', hash);
  }

  /**
   * What replacing the fansubs `oldIds` with new ones would take from the fansub budget: `room` left now, `keep` the bytes
   * the new ones add while the old ones stay, `swap` the change once the old ones (and the pooled fonts only they use) are gone.
   */
  fansubSwap(
    oldIds: readonly string[], files: readonly { data: Buffer; original: Buffer }[], fonts: readonly { data: Buffer }[],
  ): { room: number; keep: number; swap: number } {
    const usedByOld = new Map<string, { size: number; refs: number }>();
    let oldFiles = 0;
    for (const id of new Set(oldIds)) {
      const s = this.index.get(id);
      if (!s?.source) continue;
      oldFiles += s.fileSize + this.index.originalSize(id);
      for (const f of s.fonts) {
        if (!f.hash) continue;
        const u = usedByOld.get(f.hash) ?? { size: f.size, refs: 0 };
        u.refs++;
        usedByOld.set(f.hash, u);
      }
    }
    // A pooled font is used by others when more fansubs reference it than the old ones do.
    const pooled = this.index.pooled();
    const usedByOthers = (hash: string): boolean => (pooled.get(hash)?.refs ?? 0) > (usedByOld.get(hash)?.refs ?? 0);
    const newFiles = files.reduce((n, f) => n + f.data.length + f.original.length, 0);
    const newFonts = new Map(fonts.map((f) => [sha256(f.data), f.data.length]));
    let keep = newFiles;
    let swap = newFiles - oldFiles;
    for (const [hash, size] of newFonts) {
      if (!pooled.has(hash)) keep += size;
      if (!usedByOthers(hash)) swap += size;
    }
    for (const [hash, { size }] of usedByOld) if (!usedByOthers(hash)) swap -= size;
    return { room: this.maxFansub - this.index.fansubBytes(), keep, swap };
  }

  /**
   * Stores a fansub whole: the aligned file, the original, and its fonts in the shared pool (each written
   * once). No per-file limits; the fansubs together stay under their own budget.
   */
  createFansub(
    meta: SubtitleMeta & { source: FansubSource },
    file: { name: string; data: Buffer; original: Buffer },
    fonts: readonly { name: string; data: Buffer }[],
  ): StoredSubtitle {
    checkName(file.name, SUBTITLE_EXT);
    if (file.data.length === 0) throw new EmptyBodyError();
    const byName = new Map(fonts.map((f) => [f.name, { name: f.name, size: f.data.length, hash: sha256(f.data), data: f.data }]));
    const entries = [...byName.values()];
    const pooled = this.index.pooled();
    const fresh = new Map<string, Buffer>();
    for (const f of entries) if (!pooled.has(f.hash)) fresh.set(f.hash, f.data);
    let add = file.data.length + file.original.length;
    for (const d of fresh.values()) add += d.length;
    if (this.index.fansubBytes() + add > this.maxFansub) throw new TooLargeError();

    const id = randomBytes(8).toString('hex');
    const dir = join(this.root(), id);
    try {
      mkdirSync(join(dir, 'sub'), { recursive: true });
      mkdirSync(join(dir, 'original'), { recursive: true });
      writeFileSync(join(dir, 'sub', file.name), file.data, { mode: 0o600 });
      writeFileSync(join(dir, 'original', file.name), file.original, { mode: 0o600 });
      mkdirSync(join(this.root(), '.fonts'), { recursive: true });
      for (const [hash, data] of fresh) {
        const dest = this.poolFile(hash);
        if (existsSync(dest)) continue;
        const temp = `${dest}.tmp-${randomBytes(6).toString('hex')}`;
        writeFileSync(temp, data, { mode: 0o600 });
        renameSync(temp, dest);
      }
      const stored: StoredSubtitle = {
        ...meta, id, fileName: file.name, fileSize: file.data.length,
        fonts: entries.map(({ name, size, hash }) => ({ name, size, hash })), uploadedAt: this.now(),
      };
      replaceAtomically(join(dir, 'meta.json'), JSON.stringify(stored));
      this.index.set(stored, file.original.length);
      return stored;
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /** Rewrites a fansub's aligned file (a re-alignment) and its source; the original stays. */
  replaceFile(id: string, data: Buffer, source: FansubSource): StoredSubtitle | null {
    return this.edit(id, (cur) => {
      if (!cur.source || data.length === 0) return { next: null, result: null };
      const dest = join(this.root(), id, 'sub', cur.fileName);
      const temp = `${dest}.tmp-${randomBytes(6).toString('hex')}`;
      writeSynced(temp, data);
      renameSync(temp, dest);
      const next = { ...cur, fileSize: data.length, source };
      return { next, result: next };
    });
  }

  originalPath(id: string): string | null {
    const s = this.get(id);
    return s?.source && s.fileSize > 0 ? join(this.root(), id, 'original', s.fileName) : null;
  }

  filePath(id: string): string | null {
    const s = this.get(id);
    return s && s.fileSize > 0 ? join(this.root(), id, 'sub', s.fileName) : null;
  }

  fontPath(id: string, name: string): string | null {
    const s = this.get(id);
    const font = s?.fonts.find((f) => f.name === name);
    if (!font) return null;
    return font.hash ? this.poolFile(font.hash) : join(this.root(), id, 'fonts', name);
  }

  /** Streams `body` into a temp file in the upload's folder, at most `limit` bytes; a failure removes it. */
  private async stream(id: string, body: AsyncIterable<Buffer>, limit: number): Promise<{ temp: string; size: number }> {
    const temp = join(this.root(), id, `.tmp-${randomBytes(6).toString('hex')}`);
    const fh = await open(temp, 'wx', 0o600);
    let size = 0;
    try {
      for await (const chunk of body) {
        size += chunk.length;
        if (size > limit) throw new TooLargeError();
        await fh.write(chunk);
      }
      await fh.sync();
    } catch (err) {
      await fh.close();
      rmSync(temp, { force: true });
      throw err;
    }
    await fh.close();
    return { temp, size };
  }

  private async put(
    id: string, sub: 'sub' | 'fonts', name: string, body: AsyncIterable<Buffer>, limit: number,
    others: (s: StoredSubtitle) => number, commit: (cur: StoredSubtitle, size: number) => StoredSubtitle, afterCommit?: (before: StoredSubtitle) => void,
  ): Promise<StoredSubtitle> {
    const s = this.get(id);
    if (!s) throw new NotFoundError();
    const used = this.index.ownerBytes() - total(s) + others(s);
    const { temp, size } = await this.stream(id, body, Math.min(limit, this.maxTotal - used));
    try {
      const dest = join(this.root(), id, sub, name);
      const result = this.edit(id, (cur) => {
        const next = commit(cur, size);
        if (this.index.ownerBytes() - total(this.index.get(id) ?? cur) + total(next) > this.maxTotal) throw new TooLargeError();
        mkdirSync(join(this.root(), id, sub), { recursive: true });
        renameSync(temp, dest);
        afterCommit?.(cur);
        return { next, result: next };
      });
      if (!result) throw new NotFoundError();
      syncDir(join(this.root(), id, sub));
      return result;
    } catch (err) {
      rmSync(temp, { force: true });
      throw err;
    }
  }

  /** Stores the subtitle file (at most `limit` bytes), replacing an earlier one. */
  async writeFile(id: string, fileName: string, body: AsyncIterable<Buffer>, limit = SUBTITLE_LIMIT_BYTES): Promise<StoredSubtitle> {
    checkName(fileName, SUBTITLE_EXT);
    return this.put(id, 'sub', fileName, body, limit, (o) => total(o) - o.fileSize,
      (cur, size) => {
        if (size === 0) throw new EmptyBodyError();
        return { ...cur, fileName, fileSize: size };
      },
      (before) => {
        if (before.fileName && before.fileName !== fileName) rmSync(join(this.root(), id, 'sub', before.fileName), { force: true });
      });
  }

  /** Stores a font; the upload's fonts together stay under 50 MiB, and the same name replaces. */
  async writeFont(id: string, fontName: string, body: AsyncIterable<Buffer>, limit = FONTS_LIMIT_BYTES): Promise<StoredSubtitle> {
    checkName(fontName, FONT_EXT);
    const cur = this.get(id);
    if (!cur) throw new NotFoundError();
    const others = cur.fonts.filter((f) => f.name !== fontName).reduce((n, f) => n + f.size, 0);
    return this.put(id, 'fonts', fontName, body, Math.min(limit, FONTS_LIMIT_BYTES - others),
      (o) => total(o) - o.fonts.filter((f) => f.name === fontName).reduce((n, f) => n + f.size, 0),
      (c, size) => {
        const fonts = [...c.fonts.filter((f) => f.name !== fontName), { name: fontName, size }];
        if (fonts.reduce((n, f) => n + f.size, 0) > FONTS_LIMIT_BYTES) throw new TooLargeError();
        return { ...c, fonts };
      });
  }
}
