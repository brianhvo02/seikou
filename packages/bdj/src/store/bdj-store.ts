/*
 * Original code for Seikou: where BD-J's saved data lives between viewings (saved data in
 * docs/superpowers/specs/2026-10-18-m5e-bdj-library-coverage-design.md). A scope (scopes.ts) is read and written
 * whole, as a snapshot, through a BdjStore: the browser's (idb-store.ts) or the NAS's (nas-store.ts). The stores run
 * in the BD-J worker.
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

export type { StorageLoss } from '@seikou/engine/bdj-types';

/** One file of a scope: its path relative to the scope (no leading slash), mtime in ms and bytes. */
export interface SnapshotFile {
  readonly path: string;
  /** Epoch ms. The NAS keeps whole seconds (the tar entry's mtime): merges compare seconds (mergeSnapshots). */
  readonly mtime: number;
  readonly bytes: Uint8Array;
}

/** A scope's files at one moment: what a store keeps and replaces whole. */
export interface Snapshot {
  readonly files: ReadonlyArray<SnapshotFile>;
}

/** A loaded snapshot with the version a save must name: null when the store holds none for the scope. */
export interface LoadedSnapshot extends Snapshot {
  /** The stored version, which the next save names; null when nothing is stored. */
  readonly etag: string | null;
}

/**
 * A save's answer: the new version, or what is stored now (a conflict). A conflict's etag is null when nothing is
 * stored any more (the record was removed): saving again with null creates it (the NAS's If-None-Match: *).
 */
export type SaveResult = { readonly etag: string } | { readonly conflict: Snapshot & { readonly etag: string | null } };

/**
 * Keeps BD-J scopes. load answers an empty snapshot (etag null) for a scope never saved, at once. save replaces the
 * scope atomically when `etag` is the version stored (null: none is stored), else answers the stored one as a conflict
 * (the caller merges and saves again). Over the quota it rejects with ScopeQuotaError and the stored snapshot stays.
 */
export interface BdjStore {
  /**
   * How long a save waits after the last write; without it 2 s (scope-sync.ts SAVE_DEBOUNCE_MS), which
   * spares a remote store a request per write. A local store sets less (idb-store.ts IDB_SAVE_DEBOUNCE_MS).
   */
  readonly saveDebounceMs?: number;
  /**
   * How long ScopeSync waits for a scope's load before it keeps the scope in memory only; without it 3 s
   * (scope-sync.ts LOAD_TIMEOUT_MS), enough for IndexedDB. A remote store sets more (nas-store.ts), in line with the
   * disc's own reads: the load counts as I/O, which the start-up timeout passes over for at most 120 s per boot.
   */
  readonly loadTimeoutMs?: number;
  /**
   * How the scope quota counts (Vfs QuotaAccounting): `tar` for a store that keeps scopes as ustar archives with a 16 MB
   * limit on their size (the NAS, which counts headers and padding too, so the write that would cross it fails in Java
   * at once instead of as a later 507); file lengths (`bytes`) without it.
   */
  readonly quotaAccounting?: 'bytes' | 'tar';
  /** The scope's stored snapshot, or EMPTY_SNAPSHOT when none is stored. */
  load(scope: string): Promise<LoadedSnapshot>;
  /** Replaces the scope when `etag` names the stored version, else answers the stored one as a conflict. */
  save(scope: string, snapshot: Snapshot, etag: string | null): Promise<SaveResult>;
  /**
   * Sends on what the store holds but has not passed on yet (a NAS disc's write-ahead copy, nas-store.ts) now, rather
   * than at its own debounce: at the engine's flush (the page hidden or shown again) and at the stop. Settles once
   * that is done or has failed (logged).
   */
  flush?(): Promise<void>;
}

/** The NAS store's limit per scope, 16 MB, which every store keeps (the NAS also has 256 MB per person). */
export const SCOPE_QUOTA_BYTES = 16 * 1024 * 1024;

/** A save past a quota (the NAS's 507): Java sees a full disk, and the stored snapshot stays the last complete one. */
export class ScopeQuotaError extends Error {
  constructor(
    /** The scope the save was for. */
    readonly scope: string,
    /** What the save would have held, in bytes. */
    readonly bytes: number,
    /** The limit it went over, in bytes. */
    readonly limitBytes: number,
  ) {
    super(`${scope}: ${bytes} bytes is over the quota of ${limitBytes} bytes (No space left on device)`);
    this.name = 'ScopeQuotaError';
  }
}

/** The NAS's 507: over the scope's 16 MB or the person's 256 MB (the NAS store contract). */
export const PERSON_QUOTA_BYTES = 256 * 1024 * 1024;

/** The NAS refused a put for room (507): `limit` says whether the scope's 16 MB or the person's 256 MB was crossed. */
export class NasQuotaError extends ScopeQuotaError {
  constructor(
    scope: string,
    bytes: number,
    readonly limit: 'scope' | 'person',
  ) {
    super(scope, bytes, limit === 'person' ? PERSON_QUOTA_BYTES : SCOPE_QUOTA_BYTES);
    this.name = 'NasQuotaError';
    this.message = `${scope}: the NAS has no room for ${bytes} bytes (over the ${limit === 'person' ? "person's" : "scope's"} quota of ${this.limitBytes} bytes; No space left on device)`;
  }
}

/** What load answers for a scope never saved: no files, no version. */
export const EMPTY_SNAPSHOT: LoadedSnapshot = { files: [], etag: null };

/** The bytes a snapshot's files hold together (what the quota counts). */
export function snapshotBytes(s: Snapshot): number {
  let n = 0;
  for (const f of s.files) n += f.bytes.length;
  return n;
}

/** Whole seconds, as a tar entry carries an mtime. */
const seconds = (ms: number): number => Math.floor(ms / 1000);

/**
 * A 412's merge (the NAS contract): every file of either side, and for a path in both the newer by mtime in whole
 * seconds; a tie keeps `local`, the write being retried. `fromRemote`: the paths the merge took from `remote` that
 * `local` lacks or had older.
 */
export function mergeSnapshots(local: Snapshot, remote: Snapshot): { readonly merged: Snapshot; readonly fromRemote: readonly SnapshotFile[] } {
  const byPath = new Map<string, SnapshotFile>();
  for (const f of local.files) byPath.set(f.path, f);
  const fromRemote: SnapshotFile[] = [];
  for (const f of remote.files) {
    const mine = byPath.get(f.path);
    if (mine && seconds(f.mtime) <= seconds(mine.mtime)) continue;
    byPath.set(f.path, f);
    fromRemote.push(f);
  }
  return { merged: { files: sortFiles([...byPath.values()]) }, fromRemote };
}

/**
 * The merge of a copy written without seeing `remote` (a write-ahead copy kept after a boot that missed the NAS, so
 * Java wrote it without the saved data): `remote`'s file wins at every path on both sides, whatever the mtimes, and only the paths `remote` lacks come
 * from `local`, so a fresh file Java wrote with no saved data in sight never replaces real saved data. `dropped`: the
 * paths on both sides whose local file differed from the remote one (left out).
 */
export function mergeKeepingRemote(local: Snapshot, remote: Snapshot): { readonly merged: Snapshot; readonly dropped: number } {
  const byPath = new Map<string, SnapshotFile>();
  for (const f of remote.files) byPath.set(f.path, f);
  let dropped = 0;
  for (const f of local.files) {
    const theirs = byPath.get(f.path);
    if (!theirs) byPath.set(f.path, f);
    else if (!sameSnapshot({ files: [theirs] }, { files: [f] })) dropped++;
  }
  return { merged: { files: sortFiles([...byPath.values()]) }, dropped };
}

/** Sorts `files` in place by path, in code unit order, and returns it: the order snapshots keep their files in. */
export function sortFiles(files: SnapshotFile[]): SnapshotFile[] {
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A store in memory, empty at first: what a browser with no saved data has (the replay harness and the library check
 * use it, so golden runs go through the store's paths with nothing stored). Over its quota (file lengths) a save
 * rejects with ScopeQuotaError.
 */
export class MemoryBdjStore implements BdjStore {
  private readonly scopes = new Map<string, LoadedSnapshot & { readonly etag: string }>();

  /** Forgets a scope, as when its record is removed elsewhere. */
  remove(scope: string): void {
    this.scopes.delete(scope);
  }
  private n = 0;

  constructor(private readonly quotaBytes = SCOPE_QUOTA_BYTES) {}

  async load(scope: string): Promise<LoadedSnapshot> {
    return this.scopes.get(scope) ?? EMPTY_SNAPSHOT;
  }

  async save(scope: string, snapshot: Snapshot, etag: string | null): Promise<SaveResult> {
    const bytes = snapshotBytes(snapshot);
    if (bytes > this.quotaBytes) throw new ScopeQuotaError(scope, bytes, this.quotaBytes);
    const current = this.scopes.get(scope);
    if ((current?.etag ?? null) !== etag) return { conflict: { files: current?.files ?? [], etag: current?.etag ?? null } };
    const next = { files: snapshot.files.map((f) => ({ path: f.path, mtime: f.mtime, bytes: f.bytes.slice() })), etag: `m${++this.n}` };
    this.scopes.set(scope, next);
    return { etag: next.etag };
  }
}

/** Same paths, mtimes and bytes, in order. */
export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (a.files.length !== b.files.length) return false;
  for (let i = 0; i < a.files.length; i++) {
    const x = a.files[i]!;
    const y = b.files[i]!;
    if (x.path !== y.path || x.mtime !== y.mtime || x.bytes.length !== y.bytes.length) return false;
    if (x.bytes === y.bytes) continue;
    for (let j = 0; j < x.bytes.length; j++) if (x.bytes[j] !== y.bytes[j]) return false;
  }
  return true;
}
