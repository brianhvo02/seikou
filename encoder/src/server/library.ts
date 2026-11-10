// SPDX-License-Identifier: LGPL-3.0-or-later
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { appSettings } from '../subs/app-settings';
import { discKeyOfFolder } from '../disc/disc-key';
import { nasLibraryOf } from '../nas/nas-library';
import type { AppContext } from './http';

// The disc library: the folders under the user's roots that hold a Blu-ray disc, found by walking the roots a few
// levels deep. The walk reads only inside a root: a link that leads out of it is not followed.

/** One disc folder found under a root. */
export interface LibraryDisc {
  /** The disc's key (`f.<content fingerprint>`, or `d.<id>` for a disc with no streams), as the disc routes take it. */
  readonly key: string;
  /** The disc folder's name. */
  readonly label: string;
  /** Real path of the folder that holds BDMV. */
  readonly dir: string;
  /** The folder's path under its root, with `/` separators (the root's own name when the root is the disc). */
  readonly relPath: string;
  /** Real path of the root the disc was found under. */
  readonly root: string;
}

/** Whether `child` is `parent` or lies under it; both are real paths. */
function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** The entry of `dir` named `name` in any letter case, or null. */
async function childNamed(dir: string, name: string): Promise<string | null> {
  try {
    const found = (await readdir(dir)).find((n) => n.toUpperCase() === name);
    return found === undefined ? null : join(dir, found);
  } catch {
    return null;
  }
}

/** Whether `dir` holds `BDMV/index.bdmv` (any case) as files that lie inside `root`. */
async function isDisc(dir: string, root: string): Promise<boolean> {
  const bdmv = await childNamed(dir, 'BDMV');
  const index = bdmv === null ? null : await childNamed(bdmv, 'INDEX.BDMV');
  if (index === null) return false;
  try {
    const real = await realpath(index);
    return within(root, real) && (await stat(real)).isFile();
  } catch {
    return false;
  }
}

/**
 * Every folder under `roots` (or a root itself) that holds `BDMV/index.bdmv`, found at most `depth` folders below its
 * root, sorted by path under the root. Folders and links are followed only when their real path lies inside the root,
 * a folder starting with a dot is skipped, and the walk goes no deeper into a disc. A disc whose key cannot be read is
 * left out, as is a root that cannot be read. Two roots that overlap list a disc once.
 */
export async function scanLibrary(roots: readonly string[], depth = 4): Promise<LibraryDisc[]> {
  return (await scanRoots(roots, depth)).discs;
}

/** What `scanRoots` found: the discs, the roots that could not be read, and the real path of each root that could. */
interface RootsScan {
  readonly discs: LibraryDisc[];
  /** The roots, as given, that are missing, not a folder or not readable. */
  readonly unreadable: string[];
  /** Real path of each readable root, by the path it was given as. */
  readonly resolved: Map<string, string>;
}

/** `scanLibrary`, also saying which roots could not be read and where the others really are. */
async function scanRoots(roots: readonly string[], depth = 4): Promise<RootsScan> {
  const found = new Map<string, LibraryDisc>();
  const unreadable: string[] = [];
  const resolved = new Map<string, string>();
  for (const given of roots) {
    let root: string;
    try {
      root = await realpath(given);
      if (!(await stat(root)).isDirectory()) throw new Error('not a folder');
      await readdir(root);
    } catch {
      unreadable.push(given);
      continue;
    }
    resolved.set(given, root);
    const visit = async (dir: string, level: number): Promise<void> => {
      if (await isDisc(dir, root)) {
        if (found.has(dir)) return;
        try {
          const { key, label } = await discKeyOfFolder(dir);
          found.set(dir, { key, label, dir, relPath: dir === root ? basename(root) : relative(root, dir).split(sep).join('/'), root });
        } catch {
          // not a readable disc
        }
        return;
      }
      if (level >= depth) return;
      let names: string[];
      try {
        names = (await readdir(dir)).sort();
      } catch {
        return;
      }
      for (const name of names) {
        if (name.startsWith('.')) continue;
        try {
          const real = await realpath(join(dir, name));
          if (within(root, real) && (await stat(real)).isDirectory()) await visit(real, level + 1);
        } catch {
          // unreadable or a dangling link
        }
      }
    };
    await visit(root, 0);
  }
  const discs = [...found.values()].sort((a, b) => a.relPath.localeCompare(b.relPath) || a.dir.localeCompare(b.dir));
  return { discs, unreadable, resolved };
}

/**
 * The library of one app: the last complete scan of its roots (the saved ones plus those the run was given), and at
 * most one scan running at a time. A scan builds a new list and swaps it in whole when it ends, so a reader never sees
 * a half-made list.
 */
export class Library {
  private current: readonly LibraryDisc[] = [];
  private byKey = new Map<string, string>();
  private running: Promise<void> | null = null;
  private completed = false;
  private unreadable: readonly string[] = [];
  private realOf = new Map<string, string>();

  constructor(private readonly app: AppContext) {}

  /** Whether a scan is running. */
  get scanning(): boolean {
    return this.running !== null;
  }

  /** Whether any scan has finished since the app started. */
  get scanned(): boolean {
    return this.completed;
  }

  /** The discs of the last complete scan. */
  get discs(): readonly LibraryDisc[] {
    return this.current;
  }

  /** The roots the last scan could not read; their discs from the scan before are kept. */
  get unreadableRoots(): readonly string[] {
    return this.unreadable;
  }

  /**
   * Resolves when no scan is running: at once when none is, else when the one running ends or after `timeoutMs`,
   * whichever comes first.
   */
  async idle(timeoutMs: number): Promise<void> {
    const running = this.running;
    if (running === null) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([running, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The folder of the library disc with `key` in the last complete scan, else null. */
  dirOf(key: string): string | null {
    return this.byKey.get(key) ?? null;
  }

  /** The roots the next scan reads: the saved ones, then the run's own, without repeats. */
  async roots(): Promise<string[]> {
    const saved = await appSettings(this.app.dataDir).read();
    return [...new Set([...saved.roots, ...this.app.roots])];
  }

  /**
   * Starts a scan unless one is running; resolves when the scan that is running ends. Never rejects. While the encoder
   * is paired, the NAS's discs are listed again beside the local scan (`NasLibrary`), and the scan ends when both have.
   */
  scan(): Promise<void> {
    if (this.running === null) {
      const nas = this.app.nas.client === null ? Promise.resolve() : nasLibraryOf(this.app).scan();
      const run = (async (): Promise<void> => {
        try {
          const scan = await scanRoots(await this.roots());
          // a root that cannot be read now keeps the discs found under it before
          const kept = new Set(scan.unreadable.map((g) => this.realOf.get(g)).filter((r): r is string => r !== undefined));
          const discs = [...scan.discs];
          for (const d of this.current) if (kept.has(d.root) && !discs.some((n) => n.dir === d.dir)) discs.push(d);
          discs.sort((a, b) => a.relPath.localeCompare(b.relPath) || a.dir.localeCompare(b.dir));
          for (const [given, real] of scan.resolved) this.realOf.set(given, real);
          this.unreadable = scan.unreadable;
          const byKey = new Map<string, string>();
          for (const d of discs) if (!byKey.has(d.key)) byKey.set(d.key, d.dir);
          this.current = discs;
          this.byKey = byKey;
          this.completed = true;
        } catch {
          // keeps the last complete scan
        } finally {
          await nas;
          this.running = null;
        }
      })();
      this.running = run;
    }
    return this.running;
  }
}

const libraries = new WeakMap<AppContext, Library>();

/** The one `Library` of `app`, made on first use. */
export function libraryOf(app: AppContext): Library {
  let library = libraries.get(app);
  if (!library) {
    library = new Library(app);
    libraries.set(app, library);
  }
  return library;
}
