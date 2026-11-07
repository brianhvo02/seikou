import { closeSync, fsyncSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `lockFile` waited its 5 s and another holder still has the lock. */
export class LockHeldError extends Error {
  constructor(path: string) {
    super(`${path} is held`);
    this.name = 'LockHeldError';
  }
}

export function isCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

/** Writes `data` to a new mode-600 file at `path` and flushes it to disk. */
export function writeSynced(path: string, data: string | Buffer): void {
  const fd = openSync(path, 'w', 0o600);
  try {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Flushes a directory entry change; not every platform allows it, hence best effort. */
export function syncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Best effort.
  }
}

/** Replaces `file` atomically: a synced temp file, then rename, then a directory sync. */
export function replaceAtomically(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeSynced(temp, text);
  renameSync(temp, file);
  syncDir(dirname(file));
}

/**
 * Takes the lock file `<file>.lock`. The wait blocks the event loop, which is acceptable here: holders
 * keep the lock for a single small file write (well under a millisecond) and changes are rare.
 */
export function lockFile(file: string): () => void {
  const path = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(path, 'wx', 0o600));
      return () => unlinkSync(path);
    } catch (err) {
      if (!isCode(err, 'EEXIST')) throw err;
    }
    try {
      // A holder that died mid-write leaves its lock behind.
      if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
    } catch (err) {
      if (!isCode(err, 'ENOENT')) throw err;
    }
    if (Date.now() > deadline) throw new LockHeldError(path);
    sleepSync(10);
  }
}
