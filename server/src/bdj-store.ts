import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync,
  utimesSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isCode, lockFile, syncDir, writeSynced } from '@seikou/titles/atomic-json';
import { EMPTY_TAR, listTar, TarError } from './tar';

/** Bytes one scope's ustar archive may hold, headers and padding included. */
export const SCOPE_LIMIT_BYTES = 16 * 1024 * 1024;
/** Bytes of scope archives one person may hold in all. */
export const PERSON_LIMIT_BYTES = 256 * 1024 * 1024;

const SCOPE_RE = /^(?:persistent\/[0-9a-f]{8}|buda\/[0-9a-f]{8}(?:\/[0-9a-f]{32})?)$/;
const STALE_TEMP_MS = 60 * 60_000;
/** A person id as it may name a folder: 1 to 64 characters of letters, digits, `_` and `-`. */
export const PERSON_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Why a write or delete was refused: a failed ETag condition, a scope or person over its limit, or a body that is not a ustar archive. */
export type StoreErrorCode = 'precondition' | 'quota-scope' | 'quota-person' | 'bad-archive';

/** A refused `BdjStore` write or delete; the route turns `code` into its HTTP answer (412, 413, 507 or 400). */
export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode) {
    super(code);
    this.name = 'StoreError';
  }
}

/** Returns the scope key when it is `persistent/<orgId>` or `buda/<orgId>/<discId>`, else null. */
export function parseScope(raw: string): string | null {
  return SCOPE_RE.test(raw) ? raw : null;
}

function etagOf(stat: { ino: number | bigint; mtimeMs: number; size: number }): string {
  return createHash('sha256').update(`${stat.ino}:${stat.mtimeMs}:${stat.size}`).digest().subarray(0, 12).toString('base64url');
}

/**
 * Each person's BD-J saved data under `<dataDir>/users/<personId>/bdj/`: one ustar archive per scope, replaced atomically
 * under a lock, with an ETag built from the file's inode, mtime and size. Synchronous file access; throws on I/O errors
 * other than a missing file.
 */
export class BdjStore {
  /** Bytes one scope's archive may hold; the route refuses a body past it while it streams. */
  readonly scopeLimit: number;
  private readonly personLimit: number;

  constructor(
    private readonly dataDir: string,
    opts: { scopeLimit?: number; personLimit?: number } = {},
  ) {
    this.scopeLimit = opts.scopeLimit ?? SCOPE_LIMIT_BYTES;
    this.personLimit = opts.personLimit ?? PERSON_LIMIT_BYTES;
  }

  private personDir(personId: string): string {
    if (!PERSON_RE.test(personId)) throw new Error('bad person id');
    return join(this.dataDir, 'users', personId);
  }

  private fileFor(personId: string, scope: string): string {
    if (parseScope(scope) === null) throw new Error('bad scope');
    return join(this.personDir(personId), 'bdj', `${scope}.tar`);
  }

  /** Reads the scope file and its etag from one open handle, so they always describe the same bytes. */
  private read(file: string): { etag: string; body: Buffer } | null {
    let fd: number;
    try {
      fd = openSync(file, 'r');
    } catch (err) {
      if (isCode(err, 'ENOENT')) return null;
      throw err;
    }
    try {
      return { etag: etagOf(fstatSync(fd)), body: readFileSync(fd) };
    } finally {
      closeSync(fd);
    }
  }

  private currentEtag(file: string): string | null {
    try {
      return etagOf(statSync(file));
    } catch (err) {
      if (isCode(err, 'ENOENT')) return null;
      throw err;
    }
  }

  /** The scope's archive and its ETag, or an empty archive with a null ETag when the person has none. Throws on a malformed person id or scope. */
  get(personId: string, scope: string): { etag: string | null; body: Buffer } {
    return this.read(this.fileFor(personId, scope)) ?? { etag: null, body: EMPTY_TAR };
  }

  /**
   * Replaces the scope's archive. `ifNoneMatch` requires that none exists, otherwise `ifMatch` must equal the current ETag;
   * a failed condition is `StoreError('precondition')`. Also refuses a body over the scope limit (`quota-scope`), one that
   * would take the person over theirs (`quota-person`) and one that is not a ustar archive (`bad-archive`). Returns the new ETag.
   */
  put(
    personId: string,
    scope: string,
    body: Buffer,
    cond: { ifMatch?: string; ifNoneMatch?: boolean },
  ): { etag: string } {
    const file = this.fileFor(personId, scope);
    if (body.length > this.scopeLimit) throw new StoreError('quota-scope');
    try {
      listTar(body);
    } catch (err) {
      if (err instanceof TarError) throw new StoreError('bad-archive');
      throw err;
    }
    mkdirSync(dirname(file), { recursive: true });
    const unlock = lockFile(file);
    const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const current = this.currentEtag(file);
      if (cond.ifNoneMatch) {
        if (current !== null) throw new StoreError('precondition');
      } else if (cond.ifMatch === undefined || current !== cond.ifMatch) {
        throw new StoreError('precondition');
      }
      let currentSize = 0;
      let currentMtimeMs = 0;
      try {
        const stat = statSync(file);
        currentSize = stat.size;
        currentMtimeMs = stat.mtimeMs;
      } catch (err) {
        if (!isCode(err, 'ENOENT')) throw err;
      }
      if (this.usage(personId) - currentSize + body.length > this.personLimit) throw new StoreError('quota-person');
      this.sweepTemps(file);
      writeSynced(temp, body);
      // The etag is built from inode, mtime and size. Inode numbers get reused and mtime ticks coarsely, so
      // force the new mtime above the old one: an etag that was once handed out never comes back.
      const when = Math.max(Date.now(), currentMtimeMs + 1) / 1000;
      utimesSync(temp, when, when);
      renameSync(temp, file);
      syncDir(dirname(file));
      return { etag: etagOf(statSync(file)) };
    } finally {
      rmSync(temp, { force: true });
      unlock();
    }
  }

  /** Removes temp files that a crashed write left beside the scope file. */
  private sweepTemps(file: string): void {
    const folder = dirname(file);
    const prefix = `${basename(file)}.`;
    for (const name of readdirSync(folder)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      try {
        if (Date.now() - statSync(join(folder, name)).mtimeMs > STALE_TEMP_MS) unlinkSync(join(folder, name));
      } catch (err) {
        if (!isCode(err, 'ENOENT')) throw err;
      }
    }
  }

  /** Removes the scope's archive if its ETag is `ifMatch`; a missing archive or another ETag is `StoreError('precondition')`. */
  delete(personId: string, scope: string, ifMatch: string): void {
    const file = this.fileFor(personId, scope);
    try {
      // Look before locking: lockFile would create the lock beside a scope that doesn't exist, in a
      // folder that may not exist either.
      statSync(file);
    } catch (err) {
      if (isCode(err, 'ENOENT')) throw new StoreError('precondition');
      throw err;
    }
    const unlock = lockFile(file);
    try {
      if (this.currentEtag(file) !== ifMatch) throw new StoreError('precondition');
      unlinkSync(file);
      syncDir(dirname(file));
    } finally {
      unlock();
    }
  }

  /** Bytes of scope archives the person holds; temporary and lock files don't count. */
  usage(personId: string): number {
    const walk = (dir: string): number => {
      let total = 0;
      let names: import('node:fs').Dirent[];
      try {
        names = readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        if (isCode(err, 'ENOENT')) return 0;
        throw err;
      }
      for (const entry of names) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) total += walk(path);
        else if (entry.isFile() && entry.name.endsWith('.tar')) {
          try {
            total += statSync(path).size;
          } catch (err) {
            if (!isCode(err, 'ENOENT')) throw err;
          }
        }
      }
      return total;
    };
    return walk(join(this.personDir(personId), 'bdj'));
  }

  /** Removes everything the person has saved, for when the person is removed. */
  clear(personId: string): void {
    rmSync(this.personDir(personId), { recursive: true, force: true });
  }
}
