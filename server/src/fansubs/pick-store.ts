/**
 * Where viewers' Anime Tosho picks are kept (spec §9): `<dataDir>/fansubs/picks/<id>/` holds a pick's `meta.json` and
 * lined-up file, and fonts live once each in `<dataDir>/fansubs/pick-fonts/<sha256>`, since every file of a release
 * carries the same font pack. Picks unused for 30 days go, and the least recently used go first when the picks pass
 * their byte budget. The metas are held in memory, loaded once. Original code.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FansubPick } from '@seikou/nas/nas-api';
import { isCode, replaceAtomically } from '../atomic-json';

const KEEP_MS = 30 * 86_400_000;
const HOUR_MS = 3_600_000;
const ID_RE = /^[0-9a-f]{16}$/;

/** The pick alone is larger than the picks' whole budget. */
export class PickTooLarge extends Error {
  override name = 'PickTooLarge';
}

export interface PickFile {
  readonly subtitle: FansubPick;
  readonly usedAt: number;
}

export interface PickStoreOptions {
  /** `FANSUB_PICKS_BYTES`: what the picks may hold in all. */
  readonly maxBytes: number;
  readonly now: () => number;
  /** Whether a build of this pick id is running (its temp folder isn't a leftover). */
  readonly building: (id: string) => boolean;
}

/** A pick's own bytes: its file and any font kept in its own folder (picks from before the pool). */
const ownBytes = (s: FansubPick): number => s.fileSize + s.fonts.reduce((n, f) => n + (f.hash ? 0 : f.size), 0);

export class PickStore {
  private readonly root: string;
  private readonly fontsDir: string;
  private readonly entries = new Map<string, PickFile>();
  private readonly pool = new Map<string, { size: number; refs: number }>();
  private bytes = 0;

  constructor(dataDir: string, private readonly opts: PickStoreOptions) {
    this.root = join(dataDir, 'fansubs', 'picks');
    this.fontsDir = join(dataDir, 'fansubs', 'pick-fonts');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(this.fontsDir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.root)) {
      const kept = ID_RE.test(name) ? this.readMeta(name) : null;
      if (kept) this.add(kept);
    }
    this.sweep();
  }

  get(id: string): PickFile | null {
    return this.entries.get(id) ?? null;
  }

  /** The pick's lined-up file, or null; a use keeps it another 30 days. */
  filePath(id: string): string | null {
    const kept = this.entries.get(id);
    if (!kept) return null;
    this.touch(id, kept);
    return join(this.root, id, 'sub', kept.subtitle.fileName);
  }

  fontPath(id: string, name: string): string | null {
    const kept = this.entries.get(id);
    const font = kept?.subtitle.fonts.find((f) => f.name === name);
    if (!kept || !font) return null;
    this.touch(id, kept);
    return font.hash ? join(this.fontsDir, font.hash) : join(this.root, id, 'fonts', font.name);
  }

  /**
   * Keeps a pick (its fonts pooled by content, each written once), making room by removing the least recently used
   * others; a pick larger than the whole budget is refused. Returns the subtitle as kept, its fonts with their hashes.
   */
  put(subtitle: FansubPick, data: Buffer, fonts: ReadonlyMap<string, Buffer>): FansubPick {
    const hashed = [...fonts].map(([name, d]) => ({ name, size: d.length, hash: createHash('sha256').update(d).digest('hex'), data: d }));
    const unique = new Map(hashed.map((f) => [f.hash, f.data]));
    let alone = data.length;
    for (const d of unique.values()) alone += d.length;
    if (alone > this.opts.maxBytes) throw new PickTooLarge('too large');
    const kept: PickFile = {
      subtitle: { ...subtitle, fileSize: data.length, fonts: hashed.map(({ name, size, hash }) => ({ name, size, hash })) },
      usedAt: this.opts.now(),
    };
    const id = subtitle.id;
    if (this.entries.has(id)) this.remove(id);
    // Counted first, so making room never takes a font this pick uses.
    this.add(kept);
    const victims = [...this.entries.values()].filter((e) => e.subtitle.id !== id).sort((a, b) => a.usedAt - b.usedAt);
    for (const v of victims) {
      if (this.bytes <= this.opts.maxBytes) break;
      this.remove(v.subtitle.id);
    }
    // Written whole beside its place and renamed in, so a pick is either all there or not at all.
    const temp = join(this.root, `.tmp-${id}-${randomBytes(4).toString('hex')}`);
    try {
      for (const [hash, d] of unique) {
        const dest = join(this.fontsDir, hash);
        if (existsSync(dest)) continue;
        const t = `${dest}.tmp-${randomBytes(6).toString('hex')}`;
        writeFileSync(t, d, { mode: 0o600 });
        renameSync(t, dest);
      }
      mkdirSync(join(temp, 'sub'), { recursive: true });
      writeFileSync(join(temp, 'sub', subtitle.fileName), data, { mode: 0o600 });
      writeFileSync(join(temp, 'meta.json'), JSON.stringify(kept), { mode: 0o600 });
      rmSync(join(this.root, id), { recursive: true, force: true });
      renameSync(temp, join(this.root, id));
    } catch (err) {
      rmSync(temp, { recursive: true, force: true });
      this.remove(id);
      throw err;
    }
    return kept.subtitle;
  }

  /** Removes picks unused for 30 days, damaged ones, leftover temp folders and pooled fonts no pick uses. */
  sweep(): void {
    const now = this.opts.now();
    for (const name of readdirSync(this.root)) {
      const kept = this.entries.get(name);
      if (kept && now - kept.usedAt > KEEP_MS) this.remove(name);
      // a temp folder no running build owns was left by a crash; an id folder not in memory is damaged
      else if (!kept && !(name.startsWith('.tmp-') && this.opts.building(name.slice(5, 21)))) rmSync(join(this.root, name), { recursive: true, force: true });
    }
    for (const name of readdirSync(this.fontsDir)) if (!this.pool.has(name)) rmSync(join(this.fontsDir, name), { force: true });
  }

  private readMeta(id: string): PickFile | null {
    try {
      const parsed = JSON.parse(readFileSync(join(this.root, id, 'meta.json'), 'utf8')) as PickFile;
      return typeof parsed?.usedAt === 'number' && parsed.subtitle?.id === id && Array.isArray(parsed.subtitle.fonts) ? parsed : null;
    } catch (err) {
      if (isCode(err, 'ENOENT') || isCode(err, 'ENOTDIR') || err instanceof SyntaxError) return null;
      throw err;
    }
  }

  /** Notes a use, at most once an hour per pick. */
  touch(id: string, kept = this.entries.get(id)): void {
    if (!kept) return;
    const now = this.opts.now();
    if (now - kept.usedAt < HOUR_MS) return;
    const next: PickFile = { ...kept, usedAt: now };
    try {
      replaceAtomically(join(this.root, id, 'meta.json'), JSON.stringify(next));
      this.entries.set(id, next);
    } catch (err) {
      if (!isCode(err, 'ENOENT')) throw err;
    }
  }

  private add(kept: PickFile): void {
    this.entries.set(kept.subtitle.id, kept);
    this.bytes += ownBytes(kept.subtitle);
    for (const f of kept.subtitle.fonts) {
      if (!f.hash) continue;
      const cur = this.pool.get(f.hash);
      if (cur) cur.refs++;
      else {
        this.pool.set(f.hash, { size: f.size, refs: 1 });
        this.bytes += f.size;
      }
    }
  }

  /** Forgets a pick and removes its folder, and the pooled fonts no other pick uses. */
  private remove(id: string): void {
    const kept = this.entries.get(id);
    rmSync(join(this.root, id), { recursive: true, force: true });
    if (!kept) return;
    this.entries.delete(id);
    this.bytes -= ownBytes(kept.subtitle);
    for (const f of kept.subtitle.fonts) {
      const cur = f.hash ? this.pool.get(f.hash) : undefined;
      if (!cur || --cur.refs > 0) continue;
      this.pool.delete(f.hash!);
      this.bytes -= cur.size;
      rmSync(join(this.fontsDir, f.hash!), { force: true });
    }
  }
}
