import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { SCOPE_QUOTA_BYTES, ScopeQuotaError, type Snapshot } from './bdj-store';
import { BDJ_STORE_DB, IdbBdjStore, SCOPES_STORE, recordKey, type ScopeRecord } from './idb-store';

const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);
const snap = (files: [string, number, Uint8Array][]): Snapshot => ({ files: files.map(([path, mtime, b]) => ({ path, mtime, bytes: b })) });
const SCOPE = 'persistent/7fff0123';

async function record(idb: IDBFactory, key: string): Promise<ScopeRecord | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = idb.open(BDJ_STORE_DB);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction(SCOPES_STORE).objectStore(SCOPES_STORE).get(key);
      r.onsuccess = () => resolve(r.result as ScopeRecord | undefined);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}

describe('IdbBdjStore', () => {
  it('answers an empty snapshot without an etag for a scope never saved', async () => {
    const store = new IdbBdjStore('local', new IDBFactory());
    expect(await store.load(SCOPE)).toEqual({ files: [], etag: null });
  });

  it('round-trips a snapshot (paths, mtimes, bytes) and names the version it stored', async () => {
    const idb = new IDBFactory();
    const s = snap([['1/save.dat', 1_700_000_000_123, bytes(1, 2, 3)], ['1/sub/opts', 1_700_000_001_000, bytes()]]);
    const saved = await new IdbBdjStore('local', idb).save(SCOPE, s, null);
    expect(saved).toEqual({ etag: expect.any(String) });
    // another connection (the next session) reads it back
    const loaded = await new IdbBdjStore('local', idb).load(SCOPE);
    expect(loaded.etag).toBe('etag' in saved ? saved.etag : null);
    expect(loaded.files.map((f) => [f.path, f.mtime, [...f.bytes]])).toEqual([['1/save.dat', 1_700_000_000_123, [1, 2, 3]], ['1/sub/opts', 1_700_000_001_000, []]]);
    const rec = await record(idb, recordKey('local', SCOPE));
    expect(rec).toMatchObject({ source: 'local', scope: SCOPE, bytes: 3 });
  });

  it('stores only the bytes of a view into a larger buffer (a VFS file with room to grow)', async () => {
    const idb = new IDBFactory();
    const buffer = new Uint8Array([9, 9, 1, 2, 3, 9, 9, 9]);
    await new IdbBdjStore('local', idb).save(SCOPE, snap([['a', 1000, buffer.subarray(2, 5)]]), null);
    const stored = (await record(idb, recordKey('local', SCOPE)))!.files[0]!.bytes;
    expect([...stored]).toEqual([1, 2, 3]);
    expect(stored.buffer.byteLength).toBe(3);
  });

  it('answers a conflict without an etag once the record is gone, and a save with none then creates it', async () => {
    const idb = new IDBFactory();
    const store = new IdbBdjStore('local', idb);
    const saved = await store.save(SCOPE, snap([['a', 1000, bytes(1)]]), null);
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = idb.open(BDJ_STORE_DB);
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction(SCOPES_STORE, 'readwrite');
      tx.objectStore(SCOPES_STORE).delete(recordKey('local', SCOPE));
      tx.oncomplete = () => resolve();
    });
    db.close();
    expect(await store.save(SCOPE, snap([['a', 2000, bytes(2)]]), 'etag' in saved ? saved.etag : null)).toEqual({ conflict: { files: [], etag: null } });
    expect(await store.save(SCOPE, snap([['a', 2000, bytes(2)]]), null)).toEqual({ etag: expect.any(String) });
  });

  it('keeps sources apart: a NAS disc and a picked folder with the same scope each have their own', async () => {
    const idb = new IDBFactory();
    const nas = new IdbBdjStore('nas:abc123', idb);
    const local = new IdbBdjStore('local', idb);
    await nas.save(SCOPE, snap([['a', 1000, bytes(1)]]), null);
    expect(await local.load(SCOPE)).toEqual({ files: [], etag: null });
    await local.save(SCOPE, snap([['a', 2000, bytes(2)]]), null);
    expect([...(await nas.load(SCOPE)).files[0]!.bytes]).toEqual([1]);
    expect([...(await local.load(SCOPE)).files[0]!.bytes]).toEqual([2]);
    expect(await nas.scopes()).toEqual([SCOPE]);
    expect((await record(idb, `nas:abc123|${SCOPE}`))?.source).toBe('nas:abc123');
  });

  it('answers a stale etag (or none when one is stored) with the stored snapshot as a conflict, and changes nothing', async () => {
    const idb = new IDBFactory();
    const a = new IdbBdjStore('local', idb);
    const first = await a.save(SCOPE, snap([['x', 1000, bytes(1)]]), null);
    const etag = 'etag' in first ? first.etag : '';
    const second = await a.save(SCOPE, snap([['x', 2000, bytes(2)]]), etag);
    expect(second).toEqual({ etag: expect.any(String) });
    expect('etag' in second && second.etag).not.toBe(etag);

    const stale = await a.save(SCOPE, snap([['x', 3000, bytes(3)]]), etag);
    expect('conflict' in stale && stale.conflict.etag).toBe('etag' in second ? second.etag : null);
    expect('conflict' in stale && [...stale.conflict.files[0]!.bytes]).toEqual([2]);
    expect('conflict' in (await a.save(SCOPE, snap([]), null))).toBe(true);
    expect([...(await a.load(SCOPE)).files[0]!.bytes]).toEqual([2]);
  });

  it('refuses a snapshot over 16 MB (ScopeQuotaError) and keeps the stored one (Review Focus 2)', async () => {
    const idb = new IDBFactory();
    const store = new IdbBdjStore('local', idb);
    const ok = await store.save(SCOPE, snap([['a', 1000, bytes(7)]]), null);
    const big = snap([['a', 2000, new Uint8Array(SCOPE_QUOTA_BYTES)], ['b', 2000, bytes(1)]]);
    await expect(store.save(SCOPE, big, 'etag' in ok ? ok.etag : null)).rejects.toBeInstanceOf(ScopeQuotaError);
    const kept = await store.load(SCOPE);
    expect(kept.etag).toBe('etag' in ok ? ok.etag : null);
    expect(kept.files.map((f) => [f.path, [...f.bytes]])).toEqual([['a', [7]]]);
    expect(await store.save(SCOPE, snap([['a', 3000, new Uint8Array(SCOPE_QUOTA_BYTES)]]), kept.etag)).toEqual({ etag: expect.any(String) });
  });

  it('marks a record (pending) in place, keeping its version, and removes it, each only at the version named', async () => {
    const store = new IdbBdjStore('nas-person:p1', new IDBFactory());
    const saved = await store.save(SCOPE, snap([['a', 1000, bytes(1)]]), null, { pending: true });
    const etag = 'etag' in saved ? saved.etag : '';
    expect((await store.loadRecord(SCOPE))?.pending).toBe(true);
    expect(await store.mark(SCOPE, 'other', (r) => ({ ...r, pending: false }))).toBe(false);
    expect(await store.mark(SCOPE, etag, (r) => ({ ...r, pending: false }))).toBe(true);
    const rec = await store.loadRecord(SCOPE);
    expect([rec?.pending, rec?.etag]).toEqual([false, etag]);
    expect(await store.remove(SCOPE, 'other')).toBe(false);
    expect(await store.remove(SCOPE, etag)).toBe(true);
    expect(await store.loadRecord(SCOPE)).toBeNull();
  });
});
