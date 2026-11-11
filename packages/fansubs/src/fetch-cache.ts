import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lockFile, replaceAtomically, syncDir, writeSynced } from '@seikou/titles/atomic-json';

interface Entry {
  size: number;
  /** A counter, not a time: larger is more recent. */
  used: number;
}

interface IndexFile {
  entries: Record<string, Entry>;
}

const INDEX = 'index.json';

/**
 * Downloads kept on disk, keyed by the SHA-256 of their URL, evicted least recently used first once they pass
 * `maxBytes`. One fetch per URL runs at a time. A file is written to a temp name and renamed, and enters the
 * index only after it is in place, so a restart mid-write leaves nothing half-served; files the index doesn't
 * name are removed at the next start.
 * @example ../examples/fetch-cache.ts#construct
 */
export class FetchCache {
  private entries: Record<string, Entry> = {};
  private clock = 0;
  private readonly inFlight = new Map<string, Promise<Buffer>>();
  /** Hashes a `get` is working on or returning: never evicted. */
  private readonly pinned = new Map<string, number>();

  constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      this.entries = (JSON.parse(readFileSync(join(dir, INDEX), 'utf8')) as IndexFile).entries ?? {};
    } catch {
      this.entries = {};
    }
    for (const e of Object.values(this.entries)) this.clock = Math.max(this.clock, e.used);
    for (const name of readdirSync(dir)) {
      if (name !== INDEX && !name.endsWith('.lock') && !(name in this.entries)) rmSync(join(dir, name), { force: true });
    }
  }

  /**
   * The cached bytes for `url`, running `fetchFn` to fetch them when they are not on disk; calls for one URL share one fetch.
   * @example ../examples/fetch-cache.ts#get
   */
  async get(url: string, fetchFn: () => Promise<Buffer>): Promise<Buffer> {
    const hash = createHash('sha256').update(url).digest('hex');
    const running = this.inFlight.get(hash);
    if (running) return running;
    const work = this.load(hash, fetchFn);
    this.inFlight.set(hash, work);
    this.pin(hash);
    try {
      return await work;
    } finally {
      this.inFlight.delete(hash);
      this.unpin(hash);
    }
  }

  private async load(hash: string, fetchFn: () => Promise<Buffer>): Promise<Buffer> {
    if (hash in this.entries) {
      try {
        const bytes = await readFile(join(this.dir, hash));
        this.entries[hash]!.used = ++this.clock;
        this.saveIndex();
        return bytes;
      } catch {
        // The file is gone: forget it and fetch again.
        delete this.entries[hash];
      }
    }
    const bytes = await fetchFn();
    const temp = join(this.dir, `${hash}.${process.pid}.tmp`);
    writeSynced(temp, bytes);
    renameSync(temp, join(this.dir, hash));
    syncDir(this.dir);
    this.entries[hash] = { size: bytes.length, used: ++this.clock };
    this.evict();
    this.saveIndex();
    return bytes;
  }

  private evict(): void {
    let total = Object.values(this.entries).reduce((sum, e) => sum + e.size, 0);
    const oldest = Object.entries(this.entries).sort((a, b) => a[1].used - b[1].used);
    for (const [hash, entry] of oldest) {
      if (total <= this.maxBytes) break;
      if (this.pinned.has(hash)) continue;
      delete this.entries[hash];
      rmSync(join(this.dir, hash), { force: true });
      total -= entry.size;
    }
  }

  private saveIndex(): void {
    const file = join(this.dir, INDEX);
    const unlock = lockFile(file);
    try {
      replaceAtomically(file, JSON.stringify({ entries: this.entries } satisfies IndexFile));
    } finally {
      unlock();
    }
  }

  private pin(hash: string): void {
    this.pinned.set(hash, (this.pinned.get(hash) ?? 0) + 1);
  }

  private unpin(hash: string): void {
    const n = (this.pinned.get(hash) ?? 1) - 1;
    if (n <= 0) this.pinned.delete(hash);
    else this.pinned.set(hash, n);
  }
}
