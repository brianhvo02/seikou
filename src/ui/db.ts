const DB_NAME = 'bluray-web';
const DB_VERSION = 6;
/** v1 keyed discs by folder name, so two discs opened via folders named "BDMV" overwrote each other. */
const LEGACY_RECENT_STORE = 'recent-discs';

export const STORES = {
  recentDiscs: 'recent-discs-v2',
  shaderFiles: 'shader-files',
  shaderSets: 'shader-sets',
  settings: 'settings',
  /** The NAS pairing, one record under the key 'pairing'. */
  nas: 'nas',
  /** Places saved on this device, keyed `<discKey>/<playlistId>` (spec 2026-10-20 §6.4). */
  places: 'places',
  /** Places of NAS discs not yet accepted by the NAS, keyed as `places`. */
  placeOutbox: 'place-outbox',
  /** Subtitle files the user added to a disc on this device, keyed by disc key. */
  localTextFiles: 'local-text-files',
} as const;

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (db.objectStoreNames.contains(LEGACY_RECENT_STORE)) db.deleteObjectStore(LEGACY_RECENT_STORE);
      const create = (name: string, options: IDBObjectStoreParameters): void => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
      };
      create(STORES.recentDiscs, { keyPath: 'id', autoIncrement: true });
      create(STORES.shaderFiles, { keyPath: 'name' });
      create(STORES.shaderSets, { keyPath: 'name' });
      create(STORES.settings, { keyPath: 'key' });
      create(STORES.nas, {});
      create(STORES.places, { keyPath: 'key' });
      create(STORES.placeOutbox, { keyPath: 'key' });
      create(STORES.localTextFiles, { keyPath: 'key' });
      // Version 5 also put NAS discs' places in `places`, where a local copy of the disc (same `f.` key) found another
      // person's place: drop them (only they carry a NAS disc id; their outbox copies stay).
      if (event.oldVersion === 5) {
        const cursor = req.transaction!.objectStore(STORES.places).openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          const record = c.value as { place?: { discId?: unknown } };
          if (typeof record.place?.discId === 'string' && record.place.discId !== '') c.delete();
          c.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('The player database upgrade is blocked by another tab; close other Seikou tabs and reload.'));
  });
}

/** Runs one transaction on one store; resolves with the request's result once the transaction commits. */
export async function withStore<T>(
  factory: IDBFactory,
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await openDb(factory);
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = run(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new DOMException(`${store} transaction aborted`, 'AbortError'));
    });
  } finally {
    db.close();
  }
}
