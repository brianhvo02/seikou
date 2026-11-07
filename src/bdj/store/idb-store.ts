/*
 * Original code for bluray-web: the browser's BD-J store, in IndexedDB. Discs from a picked folder keep their saved
 * data here, and so do discs on a server without a per-person store (`nas:<discId>`); a NAS disc keeps its write-ahead
 * copy here (nas-store.ts, source `nas-person:<personId>`), into which the `nas:<discId>` records move once.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { SCOPE_QUOTA_BYTES, ScopeQuotaError, snapshotBytes, type BdjStore, type LoadedSnapshot, type SaveResult, type Snapshot, type SnapshotFile } from './bdj-store';

export const BDJ_STORE_DB = 'bdj-store';
export const BDJ_STORE_DB_VERSION = 1;
/** Object store of ScopeRecords, keyed `<source>|<scope>`, with an index on `source`. */
export const SCOPES_STORE = 'scopes';
export const SOURCE_INDEX = 'source';

/**
 * The browser's store saves this soon after Java's last write, not the 2 s a remote store waits: a page closed soon
 * after a save must keep it (ruling R1, Review Focus 3), and the pagehide flush cannot see to that. Chrome and Safari
 * drop an IndexedDB transaction started during pagehide, even one started on the page itself, and the flush has to
 * cross two workers first, which the browser terminates as the page goes (Task 6's report has the measurements).
 * Writes come in bursts (a FileWriter's open, writes and close; a few files): 100 ms gathers one into one save.
 */
export const IDB_SAVE_DEBOUNCE_MS = 100;

/** One scope's snapshot as IndexedDB keeps it. */
export interface ScopeRecord {
  /** `local`, `nas:<nasDiscId>` (scopes.ts storeSource) or `nas-person:<personId>` (nas-store.ts). */
  readonly source: string;
  /** `persistent/<orgId>` or `buda/<orgId>/<discId>`. */
  readonly scope: string;
  readonly etag: string;
  readonly files: readonly SnapshotFile[];
  /** The files' bytes together. */
  readonly bytes: number;
  /** Epoch ms of the save. */
  readonly savedAt: number;
  /**
   * A NAS disc's write-ahead copy (ruling R17, source `nas-person:<personId>`): true while the snapshot is not yet on
   * the NAS. Absent on the browser-only sources.
   */
  readonly pending?: boolean;
  /** A browser-only NAS disc record (`nas:<discId>`) merged into this person's write-ahead copy, to go once the NAS has it. */
  readonly migratedTo?: string;
  /**
   * A pending write-ahead copy that was never merged with the NAS's (ruling R28): written in a session whose boot got
   * no answer from the NAS in time and had no copy here, so Java started with none. It is not put in that session;
   * the next boot merges it with the NAS's files winning at every path both have (ruling R29). Absent once merged.
   */
  readonly unmerged?: boolean;
}

/** What a save marks on the record (IdbBdjStore.save). */
export interface RecordMarks {
  readonly pending?: boolean;
  /** ScopeRecord.unmerged; left out (false) otherwise. */
  readonly unmerged?: boolean;
}

/** A short value kept beside the scope records under a source of its own (IdbBdjStore.loadNote). */
interface NoteRecord {
  readonly source: string;
  readonly scope: string;
  readonly note: string;
}

export function recordKey(source: string, scope: string): string {
  return `${source}|${scope}`;
}

let etagCounter = 0;
function newEtag(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${(etagCounter++).toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The view covers its whole buffer. */
function wholeBuffer(b: Uint8Array): boolean {
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

/** The scopes of one disc source in the database `bdj-store`. Each save is one readwrite transaction, committed when it resolves. */
export class IdbBdjStore implements BdjStore {
  readonly saveDebounceMs = IDB_SAVE_DEBOUNCE_MS;
  private db: Promise<IDBDatabase> | null = null;

  constructor(
    readonly source: string,
    private readonly idb: IDBFactory = globalThis.indexedDB,
    private readonly quotaBytes = SCOPE_QUOTA_BYTES,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async load(scope: string): Promise<LoadedSnapshot> {
    const db = await this.open();
    const tx = db.transaction(SCOPES_STORE, 'readonly');
    const rec = (await request(tx.objectStore(SCOPES_STORE).get(recordKey(this.source, scope)))) as ScopeRecord | undefined;
    return rec ? { files: rec.files, etag: rec.etag } : { files: [], etag: null };
  }

  /** The scope's record as stored, or null. */
  async loadRecord(scope: string): Promise<ScopeRecord | null> {
    const db = await this.open();
    const tx = db.transaction(SCOPES_STORE, 'readonly');
    return ((await request(tx.objectStore(SCOPES_STORE).get(recordKey(this.source, scope)))) as ScopeRecord | undefined) ?? null;
  }

  async save(scope: string, snapshot: Snapshot, etag: string | null, marks: RecordMarks = {}): Promise<SaveResult> {
    const bytes = snapshotBytes(snapshot);
    if (bytes > this.quotaBytes) throw new ScopeQuotaError(scope, bytes, this.quotaBytes);
    const db = await this.open();
    // strict: committed to disk when the transaction completes, so a page closed right after keeps the save (ruling R1)
    const tx = db.transaction(SCOPES_STORE, 'readwrite', { durability: 'strict' });
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
    done.catch(() => undefined); // awaited below
    const store = tx.objectStore(SCOPES_STORE);
    const key = recordKey(this.source, scope);
    const current = (await request(store.get(key))) as ScopeRecord | undefined;
    if ((current?.etag ?? null) !== etag) {
      await done;
      return { conflict: { files: current?.files ?? [], etag: current?.etag ?? null } };
    }
    const record: ScopeRecord = {
      source: this.source,
      scope,
      etag: newEtag(),
      // a view of part of a buffer (a VFS file's) is copied: the rest of its buffer is not stored
      files: snapshot.files.map((f) => ({ path: f.path, mtime: f.mtime, bytes: wholeBuffer(f.bytes) ? f.bytes : f.bytes.slice() })),
      bytes,
      savedAt: this.nowMs(),
      ...(marks.pending !== undefined ? { pending: marks.pending } : {}),
      ...(marks.unmerged === true ? { unmerged: true } : {}),
    };
    store.put(record, key);
    await done;
    return { etag: record.etag };
  }

  /**
   * Changes the record of `scope` in place when its version is still `etag`, keeping that version (its files are
   * untouched): true when it did. The write-ahead copy is marked as on the NAS, a migrated record as merged.
   */
  async mark(scope: string, etag: string, change: (r: ScopeRecord) => ScopeRecord): Promise<boolean> {
    return this.update(scope, (current) => (current?.etag === etag ? change(current) : undefined));
  }

  /** Removes the record of `scope` when its version is still `etag`: true when it did. */
  async remove(scope: string, etag: string): Promise<boolean> {
    return this.update(scope, (current) => (current?.etag === etag ? null : undefined));
  }

  /**
   * A short value under `key` in this source, or null; not a scope (nas-store.ts keeps the person a device was last
   * confirmed as here, source `nas-device`).
   */
  async loadNote(key: string): Promise<string | null> {
    const rec = (await this.loadRecord(key)) as Partial<NoteRecord> | null;
    return typeof rec?.note === 'string' ? rec.note : null;
  }

  /** Keeps `note` under `key` (loadNote). */
  async saveNote(key: string, note: string): Promise<void> {
    await this.update(key, (current) => ((current as Partial<NoteRecord> | undefined)?.note === note ? undefined : ({ source: this.source, scope: key, note } as NoteRecord as unknown as ScopeRecord)));
  }

  /** One readwrite transaction over a record: `change` answers the new record, null to delete it, undefined to leave it. */
  private async update(scope: string, change: (current: ScopeRecord | undefined) => ScopeRecord | null | undefined): Promise<boolean> {
    const db = await this.open();
    const tx = db.transaction(SCOPES_STORE, 'readwrite', { durability: 'strict' });
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
    done.catch(() => undefined); // awaited below
    const store = tx.objectStore(SCOPES_STORE);
    const key = recordKey(this.source, scope);
    const next = change((await request(store.get(key))) as ScopeRecord | undefined);
    if (next === null) store.delete(key);
    else if (next !== undefined) store.put(next, key);
    await done;
    return next !== undefined;
  }

  /**
   * Removes the records whose source starts with `prefix` (any source, not only this one's) for which `drop` answers
   * true, reading keys only, never a record's files: a record's age comes from its note under `ageSource` (keyed by
   * the record's key, epoch ms; null when it has none, and one is written with `nowMs` then). Notes whose record is
   * gone are removed too. One readwrite transaction; answers how many records went (nas-store.ts, copies kept apart).
   */
  async pruneByKey(prefix: string, ageSource: string, nowMs: number, drop: (source: string, ageMs: number | null) => boolean): Promise<number> {
    const db = await this.open();
    const tx = db.transaction(SCOPES_STORE, 'readwrite', { durability: 'strict' });
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
    done.catch(() => undefined); // awaited below
    const store = tx.objectStore(SCOPES_STORE);
    // every key (a few per disc), no values; no IDBKeyRange, which a test's fake IndexedDB keeps elsewhere
    const keys = ((await request(store.getAllKeys())) as IDBValidKey[]).filter((k): k is string => typeof k === 'string');
    const notePrefix = `${ageSource}|`;
    const records = keys.filter((k) => k.startsWith(prefix));
    const noted = new Set(keys.filter((k) => k.startsWith(notePrefix)).map((k) => k.slice(notePrefix.length)));
    let gone = 0;
    for (const key of records) {
      const source = key.slice(0, key.lastIndexOf('|'));
      const noteKey = recordKey(ageSource, key);
      let age: number | null = null;
      if (noted.has(key)) {
        const note = (await request(store.get(noteKey))) as Partial<NoteRecord> | undefined;
        const at = Number(note?.note);
        if (Number.isFinite(at)) age = nowMs - at;
      }
      if (drop(source, age)) {
        store.delete(key);
        store.delete(noteKey);
        gone++;
      } else if (age === null) {
        store.put({ source: ageSource, scope: key, note: String(nowMs) } satisfies NoteRecord, noteKey);
      }
      noted.delete(key);
    }
    // notes of records gone (attached, removed elsewhere)
    for (const key of noted) store.delete(recordKey(ageSource, key));
    await done;
    return gone;
  }

  /** The scopes this source keeps (Task 8's migration). */
  async scopes(): Promise<string[]> {
    const db = await this.open();
    const tx = db.transaction(SCOPES_STORE, 'readonly');
    const recs = (await request(tx.objectStore(SCOPES_STORE).index(SOURCE_INDEX).getAll(this.source))) as ScopeRecord[];
    return recs.map((r) => r.scope).sort();
  }

  /** Closes the connection (another may open later). */
  close(): void {
    const db = this.db;
    this.db = null;
    void db?.then((d) => d.close(), () => undefined);
  }

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const r = this.idb.open(BDJ_STORE_DB, BDJ_STORE_DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(SCOPES_STORE)) db.createObjectStore(SCOPES_STORE).createIndex(SOURCE_INDEX, 'source');
      };
      r.onsuccess = () => {
        const db = r.result;
        // a later version opened elsewhere (another tab's newer build) asks this connection to go
        db.onversionchange = () => {
          db.close();
          if (this.db === opening) this.db = null;
        };
        resolve(db);
      };
      // (blocked: an upgrade waits for older connections, which close on versionchange; the loads' timeout bounds it)
      r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'));
    });
    this.db = opening;
    opening.catch(() => {
      if (this.db === opening) this.db = null;
    });
    return opening;
  }
}
