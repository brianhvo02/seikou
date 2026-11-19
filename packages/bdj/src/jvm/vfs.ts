/*
 * Original code for Seikou: the virtual file system that java.io and libbluray's file natives see.
 *
 * Copyright (C) 2026 Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import type { ByteSource } from '@seikou/bdmv/byte-source';
import type { ZipArchive } from './zip';

/** What stat() reports for a path. */
export interface VfsStat {
  readonly kind: 'file' | 'dir';
  /** The file's length in bytes; 0 for a directory. */
  readonly size: number;
  /** Modification time in ms since the epoch; 0 on the read-only mounts. */
  readonly mtimeMs: number;
}

/** An open file (open()), which the java.io natives keep behind a file descriptor until close(). */
export interface VfsHandle {
  /** The path it was opened with. */
  readonly path: string;
  /** The byte offset the next read or write uses. */
  position: number;
  /** The file's current length in bytes. */
  readonly size: () => number;
  /** Opened for writing, on a memory mount. */
  readonly writable: boolean;
}

/** What a Vfs serves and how it reports changes. */
export interface VfsOptions {
  /** The disc, served read-only under /disc/ with case-insensitive names; null for no disc. */
  readonly disc: ByteSource | null;
  /** rt-bdj.jar; its lib/ entries appear under /jdk/lib/. */
  readonly jdkLib: ZipArchive;
  /** The disc's normalised file paths (FileSource.paths()); required when `disc` is given. */
  readonly discPaths?: Iterable<string>;
  /** The clock for modification times, in ms since the epoch. */
  readonly nowMs: () => number;
  /** Normalised (upper-case) disc path to the disc's own spelling, used for listings. */
  readonly originalNames?: ReadonlyMap<string, string>;
  /** Read-only files served under /app/, keyed by path relative to /app/. */
  readonly app?: ReadonlyMap<string, Uint8Array>;
  /** More read-only files under /jdk/, keyed by path relative to /jdk/, fetched the first time they are read. */
  readonly jdkLazy?: ReadonlyMap<string, LazyFile>;
  /**
   * The memory mounts' capacity (/tmp/, /persistent/, /buda/ together, file lengths): a write beyond it fails, as on a
   * full disk (the memory profile's bdjVfsCacheBytes). Default: none.
   */
  readonly memLimitBytes?: number;
  /**
   * A write, truncate or rename to `path` was refused for the limit: the memory mounts' (`quotaDir` null) or the quota
   * of the directory `quotaDir` (setQuota).
   */
  readonly onFull?: (path: string, limitBytes: number, quotaDir: string | null) => void;
  /**
   * Something on /tmp/, /persistent/ or /buda/ changed (after the change): `path` canonical; for a rename, `to` is the new
   * path. Snapshots imported with importFiles do not count.
   */
  readonly onChange?: (path: string, change: VfsChange, to?: string) => void;
}

/** What changed on a memory mount (onChange): 'truncate' is a cut or extension, also open('w') on an existing file. */
export type VfsChange = 'create' | 'write' | 'truncate' | 'delete' | 'mkdir' | 'rename' | 'mtime';

/** One file of a memory subtree (importFiles, exportFiles): its path relative to the subtree, mtime in ms and bytes. */
export interface VfsTreeFile {
  readonly path: string;
  readonly mtime: number;
  readonly bytes: Uint8Array;
}

/** A directory whose files' lengths together may not pass `limit` (setQuota): a BD-J storage scope. */
interface QuotaRoot {
  /** Canonical, without a trailing slash. */
  readonly dir: string;
  /** setQuotaLimit changes it (the NAS out of room). */
  limit: number;
  /** Only the files directly in `dir` count, not those in its subdirectories. */
  readonly looseOnly: boolean;
  /** What a file of `len` bytes counts toward it (QuotaAccounting). */
  readonly cost: (len: number) => number;
  used: number;
}

/**
 * How a quota counts: `bytes`, the files' lengths; `tar`, the size of the ustar archive the NAS keeps the scope in, so
 * the write that would cross the NAS's limit fails at once instead of a later refused upload: 512 bytes of header per file plus its length rounded up to 512, and 1024 bytes of end blocks.
 */
export type QuotaAccounting = 'bytes' | 'tar';

const TAR_BLOCK = 512;
const tarCost = (len: number): number => TAR_BLOCK + Math.ceil(len / TAR_BLOCK) * TAR_BLOCK;
const byteCost = (len: number): number => len;

/** A file whose size is known up front and whose bytes are fetched when first read (reads of it return promises). */
export interface LazyFile {
  readonly size: number;
  /** Called on each read until a call succeeds; the bytes must be `size` long. */
  readonly load: () => Promise<Uint8Array>;
}

/** How open() opens a file, as fopen does: read, write (create or truncate), append (create), or read and write (create, no truncation). */
export type VfsMode = 'r' | 'w' | 'a' | 'rw';

interface MemDir {
  readonly kind: 'dir';
  readonly children: Map<string, MemNode>;
  mtimeMs: number;
}
interface MemFile {
  readonly kind: 'file';
  buf: Uint8Array;
  len: number;
  mtimeMs: number;
  /** `buf` was handed out by peek(): it is never written again, a write goes to a copy. */
  shared: boolean;
  /** In a directory (not deleted while open): its length counts toward the memory mounts' limit. */
  linked: boolean;
  /** The quota its length counts toward while linked (setQuota), by its path. */
  quota: QuotaRoot | null;
}
type MemNode = MemDir | MemFile;

type Backing = { readonly type: 'disc' } | { readonly type: 'mem'; readonly root: MemDir } | { readonly type: 'ro'; readonly tree: RoTree };

/** A read-only file's bytes, or a promise of them while they are fetched. */
type RoBytes = () => Uint8Array | Promise<Uint8Array>;

class RoTree {
  private readonly files = new Map<string, RoBytes>();
  private readonly sizes = new Map<string, number>();
  private readonly dirs = new Map<string, Set<string>>([['', new Set()]]);

  add(path: string, size: number, get: RoBytes): void {
    const parts = path.split('/').filter((s) => s !== '');
    if (parts.length === 0) return;
    let dir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      this.link(dir, parts[i]!);
      dir = dir === '' ? parts[i]! : `${dir}/${parts[i]}`;
    }
    this.link(dir, parts[parts.length - 1]!);
    const full = parts.join('/');
    this.files.set(full, get);
    this.sizes.set(full, size);
  }

  private link(dir: string, name: string): void {
    let set = this.dirs.get(dir);
    if (!set) this.dirs.set(dir, (set = new Set()));
    set.add(name);
    const child = dir === '' ? name : `${dir}/${name}`;
    if (!this.dirs.has(child)) this.dirs.set(child, new Set());
  }

  isDir(path: string): boolean {
    return this.dirs.has(path) && !this.files.has(path);
  }
  fileSize(path: string): number | undefined {
    return this.sizes.get(path);
  }
  bytes(path: string): Uint8Array | Promise<Uint8Array> | undefined {
    return this.files.get(path)?.();
  }
  list(path: string): string[] | null {
    const set = this.isDir(path) ? this.dirs.get(path) : undefined;
    return set ? [...set].sort() : null;
  }
}

class Handle implements VfsHandle {
  position = 0;
  constructor(
    readonly path: string,
    readonly size: () => number,
    readonly writable: boolean,
    readonly append: boolean,
    readonly node: MemFile | null,
    readonly discPath: string | null,
    readonly data: RoBytes | null,
  ) {}
}

const MOUNTS = ['/disc/', '/tmp/', '/persistent/', '/buda/', '/jdk/', '/app/'] as const;

const SPECIAL_NAMES = new Map([
  ['INDEX.BDMV', 'index.bdmv'],
  ['MOVIEOBJECT.BDMV', 'MovieObject.bdmv'],
  ['ID.BDMV', 'id.bdmv'],
  ['SOUND.BDMV', 'sound.bdmv'],
]);

/** Room a closed file's buffer may keep beyond its length (more is given back, as is more than an eighth of it). */
const SLACK_KEPT = 4096;

/** Before `file`'s buffer is written in place: a buffer peek() handed out is replaced by a copy. */
function unshare(file: MemFile): void {
  if (!file.shared) return;
  const copy = new Uint8Array(file.buf.length);
  copy.set(file.buf.subarray(0, file.len));
  file.buf = copy;
  file.shared = false;
}

function newDir(now: number): MemDir {
  return { kind: 'dir', children: new Map(), mtimeMs: now };
}

/**
 * The file system Java sees on the BD-J worker: /disc/ (the disc, read-only), /tmp/, /persistent/ and /buda/ (in
 * memory, writable, with a shared limit and per-scope quotas), /jdk/ (the class library's lib/ files, read-only) and
 * /app/ (read-only files the host supplies). Paths are absolute with `/` separators. Failures are reported as false
 * or null (a failed disc or lazy read as a rejected promise), so the natives can give the messages the JDK would.
 */
export class Vfs {
  /** The mount points, each with a trailing slash. */
  readonly mounts: readonly string[] = MOUNTS;
  private readonly disc: ByteSource | null;
  private readonly nowMs: () => number;
  private readonly backings = new Map<string, Backing>();
  private readonly discDirs = new Map<string, Set<string>>([['', new Set()]]);
  private readonly spelling = new Map<string, string>();
  private readonly jdkCache = new Map<string, Uint8Array>();
  private readonly memLimit: number;
  private readonly onFull: ((path: string, limitBytes: number, quotaDir: string | null) => void) | undefined;
  private readonly onChange: ((path: string, change: VfsChange, to?: string) => void) | undefined;
  /** The lengths of the files on the memory mounts. */
  private memUsed = 0;
  private readonly quotas: QuotaRoot[] = [];
  /** The writable handles open on each memory file (writing): a stored snapshot is not imported over one. */
  private readonly writers = new WeakMap<MemFile, Set<Handle>>();

  constructor(opts: VfsOptions) {
    this.disc = opts.disc;
    this.nowMs = opts.nowMs;
    this.memLimit = opts.memLimitBytes ?? Infinity;
    this.onFull = opts.onFull;
    this.onChange = opts.onChange;
    if (opts.disc) {
      if (!opts.discPaths) throw new Error('Vfs: discPaths is required when a disc is given');
      for (const path of opts.discPaths) {
        const parts = path.toUpperCase().split('/').filter(Boolean);
        let dir = '';
        for (let i = 0; i < parts.length - 1; i++) {
          let kids = this.discDirs.get(dir);
          if (!kids) this.discDirs.set(dir, (kids = new Set()));
          kids.add(parts[i]!);
          dir = dir === '' ? parts[i]! : `${dir}/${parts[i]}`;
          if (!this.discDirs.has(dir)) this.discDirs.set(dir, new Set());
        }
        if (parts.length > 0) this.discDirs.get(dir)!.add(parts[parts.length - 1]!);
      }
    }
    const now = opts.nowMs();
    this.backings.set('disc', { type: 'disc' });
    for (const m of ['tmp', 'persistent', 'buda']) this.backings.set(m, { type: 'mem', root: newDir(now) });

    const jdk = new RoTree();
    for (const name of opts.jdkLib.names) {
      const entry = opts.jdkLib.entries.get(name);
      if (!entry || !name.startsWith('lib/') || name.endsWith('/')) continue;
      jdk.add(name, entry.size, () => {
        let data = this.jdkCache.get(name);
        if (!data) {
          data = opts.jdkLib.read(name) ?? new Uint8Array(0);
          this.jdkCache.set(name, data);
        }
        return data;
      });
    }
    for (const [path, file] of opts.jdkLazy ?? []) {
      let bytes: Uint8Array | null = null;
      let loading: Promise<Uint8Array> | null = null;
      jdk.add(path, file.size, () => {
        if (bytes) return bytes;
        loading ??= file.load().then(
          (b) => {
            if (b.length !== file.size) throw new Error(`/jdk/${path}: expected ${file.size} bytes, got ${b.length}`);
            return (bytes = b);
          },
          (e: unknown) => {
            loading = null;
            throw e;
          },
        );
        return loading;
      });
    }
    this.backings.set('jdk', { type: 'ro', tree: jdk });

    const app = new RoTree();
    for (const [path, bytes] of opts.app ?? []) app.add(path.replace(/^\/?(app\/)?/, ''), bytes.length, () => bytes);
    this.backings.set('app', { type: 'ro', tree: app });

    for (const [key, original] of opts.originalNames ?? []) {
      const keyParts = key.split('/').filter(Boolean);
      const origParts = original.split('/').filter(Boolean).slice(-keyParts.length);
      if (origParts.length !== keyParts.length) continue;
      for (let i = 0; i < keyParts.length; i++) this.spelling.set(keyParts.slice(0, i + 1).join('/'), origParts[i]!);
    }
  }

  /**
   * What the memory mounts and the /jdk/ cache keep (Jvm.memoryStats): `memBytes` counts the files' allocations,
   * `memUsed` their lengths (what the limit applies to).
   */
  memoryStats(): { readonly memFiles: number; readonly memBytes: number; readonly memUsed: number; readonly jdkCacheBytes: number } {
    const files = this.memFiles();
    let jdkCacheBytes = 0;
    for (const d of this.jdkCache.values()) jdkCacheBytes += d.byteLength;
    return { memFiles: files.length, memBytes: files.reduce((n, f) => n + f.buf.byteLength, 0), memUsed: this.memUsed, jdkCacheBytes };
  }

  /** The buffers the memory mounts' files and the /jdk/ cache hold now (memory accounting). */
  buffers(): Set<ArrayBufferLike> {
    return new Set([...this.memFiles().map((f) => f.buf.buffer), ...[...this.jdkCache.values()].map((d) => d.buffer)]);
  }

  private memFiles(): MemFile[] {
    const out: MemFile[] = [];
    const visit = (dir: MemDir): void => {
      for (const node of dir.children.values()) {
        if (node.kind === 'dir') visit(node);
        else out.push(node);
      }
    };
    for (const b of this.backings.values()) if (b.type === 'mem') visit(b.root);
    return out;
  }

  /** `path` without empty, `.` and `..` segments, as an absolute path; `..` above the root stays at the root. */
  canonicalize(path: string): string {
    const out: string[] = [];
    for (const seg of path.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return `/${out.join('/')}`;
  }

  /** The file or directory at `path`; null when there is none. The root and mount points are directories. */
  stat(path: string): VfsStat | null {
    const r = this.resolve(path);
    if (!r) return null;
    if (r.mount === null) return { kind: 'dir', size: 0, mtimeMs: 0 };
    const b = this.backings.get(r.mount)!;
    if (b.type === 'mem') {
      const node = this.walk(b.root, r.rest);
      if (!node) return null;
      return { kind: node.kind, size: node.kind === 'file' ? node.len : 0, mtimeMs: node.mtimeMs };
    }
    if (b.type === 'ro') {
      const key = r.rest.join('/');
      const size = b.tree.fileSize(key);
      if (size !== undefined) return { kind: 'file', size, mtimeMs: 0 };
      return b.tree.isDir(key) ? { kind: 'dir', size: 0, mtimeMs: 0 } : null;
    }
    return this.discStat(r.rest);
  }

  /** The names in directory `dir`, sorted (disc names in the disc's own spelling where it is known); null when it is not a directory. */
  list(dir: string): string[] | null {
    const r = this.resolve(dir);
    if (!r) return null;
    if (r.mount === null) return this.mounts.map((m) => m.slice(1, -1)).sort();
    const b = this.backings.get(r.mount)!;
    if (b.type === 'mem') {
      const node = this.walk(b.root, r.rest);
      return node?.kind === 'dir' ? [...node.children.keys()].sort() : null;
    }
    if (b.type === 'ro') return b.tree.list(r.rest.join('/'));
    return this.discList(r.rest);
  }

  /** Makes a directory on a memory mount; false when its parent is missing, the name exists or the mount is read-only. */
  mkdir(path: string): boolean {
    const t = this.memParent(path);
    if (!t || t.parent.children.has(t.name)) return false;
    const now = this.nowMs();
    t.parent.children.set(t.name, newDir(now));
    t.parent.mtimeMs = now;
    this.changed(path, 'mkdir');
    return true;
  }

  private changed(path: string, change: VfsChange, to?: string): void {
    if (this.onChange) this.onChange(this.canonicalize(path), change, to === undefined ? undefined : this.canonicalize(to));
  }

  /** Deletes a file or empty directory on a memory mount; false otherwise. An open handle keeps the deleted file's bytes. */
  delete(path: string): boolean {
    const t = this.memParent(path);
    if (!t) return false;
    const node = t.parent.children.get(t.name);
    if (!node || (node.kind === 'dir' && node.children.size > 0)) return false;
    t.parent.children.delete(t.name);
    if (node.kind === 'file') this.unlink(node);
    t.parent.mtimeMs = this.nowMs();
    this.changed(path, 'delete');
    return true;
  }

  private unlink(file: MemFile): void {
    if (file.linked) {
      this.memUsed -= file.len;
      if (file.quota) file.quota.used -= file.quota.cost(file.len);
    }
    file.linked = false;
    file.quota = null;
  }

  /** Counts a file put in a directory toward the limit and the quota of its canonical path. */
  private link(file: MemFile, canonPath: string): void {
    file.linked = true;
    file.quota = this.quotaFor(canonPath);
    this.memUsed += file.len;
    if (file.quota) file.quota.used += file.quota.cost(file.len);
  }

  /** Sets a memory file's length, counting it toward the limit; false (and nothing changes) when it would go over. */
  private resize(file: MemFile, len: number): boolean {
    if (file.linked) {
      const used = this.memUsed - file.len + len;
      const q = file.quota;
      if (len > file.len && (used > this.memLimit || (q !== null && q.used - q.cost(file.len) + q.cost(len) > q.limit))) return false;
      this.memUsed = used;
      if (q) q.used += q.cost(len) - q.cost(file.len);
    }
    file.len = len;
    return true;
  }

  /**
   * Limits the files under `dir` (on a memory mount) to `limitBytes` of lengths together, beyond the memory mounts'
   * limit: a write past it fails as on a full disk. Files already there count toward it at once. `looseOnly`: only the
   * files directly in `dir`. A file counts toward one quota at most: the innermost that holds it.
   */
  setQuota(dir: string, limitBytes: number, looseOnly = false, accounting: QuotaAccounting = 'bytes'): void {
    const canon = this.canonicalize(dir);
    const tar = accounting === 'tar';
    const root: QuotaRoot = { dir: canon, limit: limitBytes, looseOnly, cost: tar ? tarCost : byteCost, used: tar ? 2 * TAR_BLOCK : 0 };
    this.quotas.push(root);
    const node = this.memNode(canon);
    if (!node) return;
    this.visitFiles(node, canon, (file, path) => {
      if (!file.linked || this.quotaFor(path) !== root) return;
      if (file.quota) file.quota.used -= file.quota.cost(file.len);
      file.quota = root;
      root.used += root.cost(file.len);
    });
  }

  /**
   * Changes the limit of the quota of `dir` (setQuota): false without one. A limit at or below what its files hold now
   * refuses every write that needs more room, as a full disk does; the files already there stay.
   */
  setQuotaLimit(dir: string, limitBytes: number): boolean {
    const canon = this.canonicalize(dir);
    const root = this.quotas.find((q) => q.dir === canon);
    if (!root) return false;
    root.limit = limitBytes;
    return true;
  }

  /** Whether a quota (setQuota) has no room for a new, empty file at `path` (its tar header): a full disk's ENOSPC. */
  quotaRefusesNewFile(path: string): boolean {
    const q = this.quotaFor(this.canonicalize(path));
    return q !== null && q.used + q.cost(0) > q.limit;
  }

  /** What the files that count toward the quota of `dir` (setQuota) add up to, as it counts them; 0 without one. */
  quotaUsed(dir: string): number {
    const canon = this.canonicalize(dir);
    return this.quotas.find((q) => q.dir === canon)?.used ?? 0;
  }

  /** The innermost quota whose directory holds the canonical path. */
  private quotaFor(canonPath: string): QuotaRoot | null {
    let best: QuotaRoot | null = null;
    for (const q of this.quotas) {
      if (!canonPath.startsWith(`${q.dir}/`) || (q.looseOnly && canonPath.indexOf('/', q.dir.length + 1) >= 0)) continue;
      if (!best || q.dir.length > best.dir.length) best = q;
    }
    return best;
  }

  /** The memory node at a canonical path; null elsewhere or when it is missing. */
  private memNode(canon: string): MemNode | null {
    const r = this.resolve(canon);
    if (!r || r.mount === null) return null;
    const b = this.backings.get(r.mount)!;
    return b.type === 'mem' ? this.walk(b.root, r.rest) : null;
  }

  private visitFiles(node: MemNode, path: string, fn: (file: MemFile, path: string) => void): void {
    if (node.kind === 'file') return fn(node, path);
    for (const [name, child] of node.children) this.visitFiles(child, `${path}/${name}`, fn);
  }

  /**
   * Puts `files` under the memory directory `dir` (created as needed), replacing files of the same path (in place when
   * a writable handle is open on one): a stored snapshot. They count toward the limit and the quotas (even beyond them) but are no change for onChange. The bytes
   * are kept without a copy and never written in place: a write goes to a copy.
   */
  importFiles(dir: string, files: Iterable<VfsTreeFile>): void {
    const base = this.canonicalize(dir);
    for (const f of files) {
      const path = this.canonicalize(`${base}/${f.path}`);
      if (!path.startsWith(`${base}/`)) continue;
      const parts = path.split('/').filter(Boolean);
      const b = this.backings.get(parts[0]!);
      if (b?.type !== 'mem' || parts.length < 2) continue;
      let parent: MemDir | null = b.root;
      for (const seg of parts.slice(1, -1)) {
        let next: MemNode | undefined = parent.children.get(seg);
        if (!next) parent.children.set(seg, (next = newDir(f.mtime)));
        if (next.kind !== 'dir') {
          parent = null;
          break;
        }
        parent = next;
      }
      const name = parts[parts.length - 1]!;
      const old = parent?.children.get(name);
      if (!parent || old?.kind === 'dir') continue;
      if (old && (this.writers.get(old)?.size ?? 0) > 0) {
        // a file with a writable handle open is replaced in place, so that handle writes to the file as it is now
        // rather than to an unlinked one
        this.unlink(old);
        old.buf = f.bytes;
        old.len = f.bytes.length;
        old.mtimeMs = f.mtime;
        old.shared = true;
        this.link(old, path);
        continue;
      }
      if (old) this.unlink(old);
      const file: MemFile = { kind: 'file', buf: f.bytes, len: f.bytes.length, mtimeMs: f.mtime, shared: true, linked: false, quota: null };
      this.link(file, path);
      parent.children.set(name, file);
    }
  }

  /** Whether a memory file at `path` has a writable handle open (a write in progress: ScopeSync imports nothing over it). */
  writing(path: string): boolean {
    const node = this.memNode(this.canonicalize(path));
    return node?.kind === 'file' && (this.writers.get(node)?.size ?? 0) > 0;
  }

  /**
   * The files under the memory directory `dir` (`looseOnly`: only those directly in it), paths relative to it in
   * order, without a copy: a file returned is not written in place again (as peek), so the bytes stay as they are.
   * Empty when `dir` is missing.
   */
  exportFiles(dir: string, looseOnly = false): VfsTreeFile[] {
    const node = this.memNode(this.canonicalize(dir));
    if (node?.kind !== 'dir') return [];
    const out: VfsTreeFile[] = [];
    const take = (file: MemFile, path: string): void => {
      file.shared = true;
      out.push({ path, mtime: file.mtimeMs, bytes: file.buf.subarray(0, file.len) });
    };
    if (looseOnly) {
      for (const [name, child] of node.children) if (child.kind === 'file') take(child, name);
    } else this.visitFiles(node, '', (file, path) => take(file, path.slice(1)));
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Whether writing `length` bytes through `h` at its position fits in the memory mounts' limit. */
  fits(h: VfsHandle, length: number): boolean {
    const handle = h as Handle;
    return this.fitsLength(h, (handle.append ? (handle.node?.len ?? 0) : handle.position) + length);
  }

  /** Whether `h`'s file can grow to `length` bytes within the memory mounts' limit; onFull hears of a refusal. */
  fitsLength(h: VfsHandle, length: number): boolean {
    const file = (h as Handle).node;
    if (!file?.linked || length <= file.len) return true;
    if (this.memUsed - file.len + length > this.memLimit) {
      this.onFull?.(h.path, this.memLimit, null);
      return false;
    }
    const q = file.quota;
    if (q && q.used - q.cost(file.len) + q.cost(length) > q.limit) {
      this.onFull?.(h.path, q.limit, q.dir);
      return false;
    }
    return true;
  }

  /**
   * Moves a file or directory within the memory mounts, replacing a file at `to`, as rename(2) does. False when either
   * path is not on a memory mount, `from` is missing, a directory meets a file or would move into itself, or a quota
   * would go over.
   */
  rename(from: string, to: string): boolean {
    const src = this.memParent(from);
    const dst = this.memParent(to);
    if (!src || !dst) return false;
    const node = src.parent.children.get(src.name);
    if (!node) return false;
    const existing = dst.parent.children.get(dst.name);
    if (existing === node) return true;
    if (existing && (existing.kind === 'dir' || node.kind === 'dir')) return false;
    if (node.kind === 'dir' && this.isWithin(node, dst.parent)) return false;
    if (!this.requota(node, this.canonicalize(to), existing?.kind === 'file' ? existing : null)) return false;
    src.parent.children.delete(src.name);
    if (existing?.kind === 'file') this.unlink(existing);
    dst.parent.children.set(dst.name, node);
    const now = this.nowMs();
    src.parent.mtimeMs = dst.parent.mtimeMs = now;
    this.changed(from, 'rename', to);
    return true;
  }

  /**
   * A rename moves the files of `node` to `to`: each counts toward its new path's quota from now on. False (nothing
   * changes, onFull hears of it) when a quota would go over; `replaced`, the file the rename replaces, is freed first.
   */
  private requota(node: MemNode, to: string, replaced: MemFile | null): boolean {
    const moves: [MemFile, QuotaRoot | null][] = [];
    this.visitFiles(node, to, (file, path) => {
      if (file.linked) moves.push([file, this.quotaFor(path)]);
    });
    const added = new Map<QuotaRoot, number>();
    for (const [file, q] of moves) if (q && q !== file.quota) added.set(q, (added.get(q) ?? 0) + q.cost(file.len));
    for (const [q, n] of added) {
      const freed = replaced?.linked && replaced.quota === q ? q.cost(replaced.len) : 0;
      if (q.used - freed + n > q.limit) {
        this.onFull?.(to, q.limit, q.dir);
        return false;
      }
    }
    for (const [file, q] of moves) {
      if (q === file.quota) continue;
      if (file.quota) file.quota.used -= file.quota.cost(file.len);
      if (q) q.used += q.cost(file.len);
      file.quota = q;
    }
    return true;
  }

  /**
   * Opens a file in `mode`, creating it on a memory mount for any mode but 'r'. Returns null when the file is missing,
   * is a directory, the mode needs a read-only mount to be written, or a new file does not fit its quota.
   */
  open(path: string, mode: VfsMode): VfsHandle | null {
    const r = this.resolve(path);
    if (!r || r.mount === null || r.rest.length === 0) return null;
    const canon = this.canonicalize(path);
    const b = this.backings.get(r.mount)!;
    if (b.type === 'mem') {
      const t = this.memParent(path);
      if (!t) return null;
      let node = t.parent.children.get(t.name);
      if (node?.kind === 'dir') return null;
      if (!node) {
        if (mode === 'r') return null;
        const q = this.quotaFor(canon);
        if (q && q.used + q.cost(0) > q.limit) {
          // its header alone does not fit the quota (tar accounting): as a full disk refuses a new file
          this.onFull?.(canon, q.limit, q.dir);
          return null;
        }
        const now = this.nowMs();
        node = { kind: 'file', buf: new Uint8Array(0), len: 0, mtimeMs: now, shared: false, linked: false, quota: null };
        this.link(node, canon);
        t.parent.children.set(t.name, node);
        t.parent.mtimeMs = now;
        this.changed(canon, 'create');
      } else if (mode === 'w') {
        this.resize(node, 0);
        node.mtimeMs = this.nowMs();
        this.changed(canon, 'truncate');
      }
      const file = node;
      const h = new Handle(canon, () => file.len, mode !== 'r', mode === 'a', file, null, null);
      if (mode === 'a') h.position = file.len;
      if (h.writable) {
        let open = this.writers.get(file);
        if (!open) this.writers.set(file, (open = new Set()));
        open.add(h);
      }
      return h;
    }
    if (mode !== 'r') return null;
    if (b.type === 'ro') {
      const key = r.rest.join('/');
      const size = b.tree.fileSize(key);
      if (size === undefined) return null;
      return new Handle(canon, () => size, false, false, null, null, () => b.tree.bytes(key)!);
    }
    const discPath = r.rest.join('/').toUpperCase();
    if (!this.disc?.exists(discPath)) return null;
    const disc = this.disc;
    return new Handle(canon, () => disc.size(discPath), false, false, null, discPath, null);
  }

  /** Memory and /jdk/ reads are synchronous; /disc/ reads, and lazy /jdk/ files' first reads, return a promise. Returns -1 at end of file. */
  read(h: VfsHandle, out: Uint8Array, offset: number, length: number): number | Promise<number> {
    const handle = h as Handle;
    if (length === 0) return 0;
    const n = Math.min(length, handle.size() - handle.position);
    if (n <= 0) return -1;
    const pos = handle.position;
    handle.position += n;
    if (handle.node) {
      out.set(handle.node.buf.subarray(pos, pos + n), offset);
      return n;
    }
    if (handle.data) {
      const data = handle.data();
      if (data instanceof Promise) {
        return data.then(
          (bytes) => {
            out.set(bytes.subarray(pos, pos + n), offset);
            return n;
          },
          (e: unknown) => {
            handle.position = pos;
            throw e;
          },
        );
      }
      out.set(data.subarray(pos, pos + n), offset);
      return n;
    }
    return this.disc!.read(handle.discPath!, pos, n).then((bytes) => {
      out.set(bytes.subarray(0, n), offset);
      handle.position -= n - bytes.length;
      return bytes.length;
    });
  }

  /**
   * Returns false when the handle was not opened for writing (read-only mounts and 'r' handles), or when the write
   * does not fit in the memory mounts' limit (fits()).
   */
  write(h: VfsHandle, data: Uint8Array, offset: number, length: number): boolean {
    const handle = h as Handle;
    const file = handle.node;
    if (!file || !handle.writable || !this.fits(h, length)) return false;
    if (handle.append) handle.position = file.len;
    const end = handle.position + length;
    if (end > file.buf.length) {
      const grown = new Uint8Array(Math.max(end, file.buf.length * 2, 64));
      grown.set(file.buf.subarray(0, file.len));
      file.buf = grown;
      file.shared = false;
    } else unshare(file);
    if (handle.position > file.len) file.buf.fill(0, file.len, handle.position);
    file.buf.set(data.subarray(offset, offset + length), handle.position);
    handle.position = end;
    if (end > file.len) this.resize(file, end);
    file.mtimeMs = this.nowMs();
    if (file.linked) this.changed(handle.path, 'write');
    return true;
  }

  /** A file written through `h` gives back the room its buffer grew by beyond its length. */
  close(h: VfsHandle): void {
    const file = (h as Handle).node;
    if (file) this.writers.get(file)?.delete(h as Handle);
    if (!file || !h.writable || file.shared) return;
    const slack = file.buf.length - file.len;
    if (slack >= Math.max(SLACK_KEPT, file.len >> 3)) file.buf = file.buf.slice(0, file.len);
  }

  /**
   * A whole memory or /jdk/ file's bytes without a copy, for an archive that keeps them (java.util.zip.ZipFile);
   * null for a disc file, a lazy /jdk/ file not fetched yet, or a missing one. A memory file is never written in
   * place again: later writes go to a copy, so the bytes returned stay as they are.
   */
  peek(path: string): Uint8Array | null {
    const r = this.resolve(path);
    if (!r || r.mount === null || r.rest.length === 0) return null;
    const b = this.backings.get(r.mount)!;
    if (b.type === 'mem') {
      const node = this.walk(b.root, r.rest);
      if (node?.kind !== 'file') return null;
      node.shared = true;
      return node.buf.subarray(0, node.len);
    }
    if (b.type === 'ro') {
      const key = r.rest.join('/');
      if (b.tree.fileSize(key) === undefined) return null;
      const bytes = b.tree.bytes(key);
      return bytes instanceof Uint8Array ? bytes : null;
    }
    return null;
  }

  /** The path is on a writable (memory) mount, below its root. */
  writable(path: string): boolean {
    const r = this.resolve(path);
    return r !== null && r.mount !== null && r.rest.length > 0 && this.backings.get(r.mount)!.type === 'mem';
  }

  /** Sets a memory file's or directory's modification time; false elsewhere or when it is missing. */
  setMtime(path: string, ms: number): boolean {
    const r = this.resolve(path);
    if (!r || r.mount === null) return false;
    const b = this.backings.get(r.mount)!;
    if (b.type !== 'mem') return false;
    const node = this.walk(b.root, r.rest);
    if (!node) return false;
    node.mtimeMs = ms;
    this.changed(path, 'mtime');
    return true;
  }

  /** Cuts or zero-extends a writable handle's file to `length` bytes; the position moves back to the end if beyond it. */
  truncate(h: VfsHandle, length: number): boolean {
    const handle = h as Handle;
    const file = handle.node;
    if (!file || !handle.writable) return false;
    if (!this.fitsLength(h, length)) return false;
    if (length > file.buf.length) {
      const grown = new Uint8Array(length);
      grown.set(file.buf.subarray(0, file.len));
      file.buf = grown;
      file.shared = false;
    } else if (length > file.len) {
      unshare(file);
      file.buf.fill(0, file.len, length);
    }
    this.resize(file, length);
    if (handle.position > length) handle.position = length;
    file.mtimeMs = this.nowMs();
    if (file.linked) this.changed(handle.path, 'truncate');
    return true;
  }

  private resolve(path: string): { mount: string | null; rest: string[] } | null {
    if (!path.startsWith('/')) return null;
    const parts = this.canonicalize(path).split('/').filter(Boolean);
    if (parts.length === 0) return { mount: null, rest: [] };
    const mount = parts[0]!;
    if (!this.backings.has(mount)) return null;
    return { mount, rest: parts.slice(1) };
  }

  private walk(root: MemDir, rest: readonly string[]): MemNode | null {
    let node: MemNode = root;
    for (const seg of rest) {
      if (node.kind !== 'dir') return null;
      const next: MemNode | undefined = node.children.get(seg);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  /** The directory that holds `path` and the entry's name, for writable mounts only. */
  private memParent(path: string): { parent: MemDir; name: string } | null {
    const r = this.resolve(path);
    if (!r || r.mount === null || r.rest.length === 0) return null;
    const b = this.backings.get(r.mount)!;
    if (b.type !== 'mem') return null;
    const parent = this.walk(b.root, r.rest.slice(0, -1));
    return parent?.kind === 'dir' ? { parent, name: r.rest[r.rest.length - 1]! } : null;
  }

  private isWithin(dir: MemDir, target: MemDir): boolean {
    if (dir === target) return true;
    for (const child of dir.children.values()) if (child.kind === 'dir' && this.isWithin(child, target)) return true;
    return false;
  }

  private discStat(rest: readonly string[]): VfsStat | null {
    const key = rest.join('/').toUpperCase();
    if (this.discDirs.has(key)) return { kind: 'dir', size: 0, mtimeMs: 0 };
    if (this.disc?.exists(key)) return { kind: 'file', size: this.disc.size(key), mtimeMs: 0 };
    return null;
  }

  private discList(rest: readonly string[]): string[] | null {
    const key = rest.join('/').toUpperCase();
    const kids = this.discDirs.get(key);
    if (!kids) return null;
    const prefix = key === '' ? '' : `${key}/`;
    return [...kids].map((n) => this.spelling.get(prefix + n) ?? this.conventional(prefix + n, n)).sort();
  }

  private conventional(key: string, name: string): string {
    if (this.discDirs.has(key)) return name.toUpperCase();
    const upper = name.toUpperCase();
    const special = SPECIAL_NAMES.get(upper);
    if (special) return special;
    const dot = upper.lastIndexOf('.');
    return dot < 0 ? upper : upper.slice(0, dot) + upper.slice(dot).toLowerCase();
  }
}
