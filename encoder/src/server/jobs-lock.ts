// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// One encode queue per data folder: the process that runs the queue holds `<data>/jobs.lock`, a file made with
// O_EXCL that holds its pid. Without it, a second process would mark the first one's running job interrupted, delete
// the partial file being written, and start a second encode beside it.

/** The lock file's name in the data folder. */
export const JOBS_LOCK_FILE = 'jobs.lock';

/** Whether a process with `pid` exists: `kill(pid, 0)` fails with ESRCH only when it does not (EPERM means it does). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The locks this process holds, released when it exits however it exits. */
const held = new Set<JobsLock>();
let exitHook = false;

/** The queue lock of one data folder, held by this process until `release`. */
export class JobsLock {
  private released = false;

  /** A lock this process took at `file`, writing `content` into it. */
  constructor(
    /** The lock file. */
    readonly file: string,
    private readonly content: string,
  ) {
    held.add(this);
    if (!exitHook) {
      exitHook = true;
      process.on('exit', () => {
        for (const lock of [...held]) lock.release();
      });
    }
  }

  /** Removes the lock file, unless another process has taken it over since; calling it again does nothing. */
  release(): void {
    if (this.released) return;
    this.released = true;
    held.delete(this);
    try {
      if (readFileSync(this.file, 'utf8') === this.content) unlinkSync(this.file);
    } catch {
      // already gone
    }
  }
}

/** What `takeJobsLock` got: the lock, or the pid of the live process that holds it. */
export type JobsLockAttempt = { readonly lock: JobsLock } | { readonly heldBy: number };

/**
 * Takes the queue lock of `dataDir` (made when missing): creates `<dataDir>/jobs.lock` with O_EXCL holding this
 * process's pid. A lock whose pid is not a live process (`alive`, `pidAlive` by default), or that holds no pid, is
 * stale: it is removed and taken. A live holder, this process included, is answered as `{ heldBy }`.
 */
export function takeJobsLock(dataDir: string, alive: (pid: number) => boolean = pidAlive): JobsLockAttempt {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, JOBS_LOCK_FILE);
  const content = `${process.pid}\n`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(file, content, { flag: 'wx' });
      return { lock: new JobsLock(file, content) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    const pid = Number(text.trim());
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) return { heldBy: pid };
    // Stale: removed only while it still says what was read, so a lock another process just took stays.
    try {
      if (readFileSync(file, 'utf8') === text) unlinkSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  throw new Error(`The queue lock ${file} could not be taken; remove it if no seikou-encode is running.`);
}
