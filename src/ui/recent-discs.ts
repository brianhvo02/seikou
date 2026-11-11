import { STORES, withStore as withDbStore } from './db';

const MAX_RECENT = 5;

const withStore = <T>(factory: IDBFactory, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void) =>
  withDbStore<T>(factory, STORES.recentDiscs, mode, run);

/** A disc folder opened before, kept in IndexedDB as its directory handle (Chromium only) so it can be reopened without picking it again. */
export interface RecentDisc {
  /** The store's auto-increment key. */
  readonly id: number;
  /** The folder's name when last opened. */
  readonly name: string;
  readonly handle: FileSystemDirectoryHandle;
  /** When it was last opened, in ms since the epoch. */
  readonly openedAt: number;
  /** `discKeyOf` of the disc's files when it was last opened, for its place on this device; null when it has no fingerprint (or an older entry). */
  readonly discKey: string | null;
}

/** Whether two handles point at the same folder (injectable because test doubles can't carry methods through IndexedDB). */
export type SameFolder = (a: FileSystemDirectoryHandle, b: FileSystemDirectoryHandle) => Promise<boolean>;

const isSameFolder: SameFolder = (a, b) => a.isSameEntry(b);

/** The remembered discs, most recently opened first. */
export async function listRecentDiscs(factory: IDBFactory = indexedDB): Promise<RecentDisc[]> {
  const all = (await withStore<RecentDisc[]>(factory, 'readonly', (store) => store.getAll() as IDBRequest<RecentDisc[]>)) ?? [];
  return all.map((d) => ({ ...d, discKey: d.discKey ?? null })).sort((a, b) => b.openedAt - a.openedAt);
}

/**
 * Remembers `handle` as just opened at `now`. A handle to a folder already remembered (`sameFolder`, compared one by one)
 * updates that entry rather than adding another; only the five most recent entries are kept.
 */
export async function saveRecentDisc(
  handle: FileSystemDirectoryHandle,
  now = Date.now(),
  factory: IDBFactory = indexedDB,
  sameFolder: SameFolder = isSameFolder,
  discKey: string | null = null,
): Promise<void> {
  let match: RecentDisc | undefined;
  for (const disc of await listRecentDiscs(factory)) {
    if (await sameFolder(disc.handle, handle).catch(() => false)) {
      match = disc;
      break;
    }
  }
  await withStore(factory, 'readwrite', (store) => {
    store.put(match ? { ...match, name: handle.name, handle, openedAt: now, discKey } : { name: handle.name, handle, openedAt: now, discKey });
  });
  const stale = (await listRecentDiscs(factory)).slice(MAX_RECENT);
  for (const disc of stale) await removeRecentDisc(disc.id, factory);
}

/** Forgets one remembered disc by its `id`. */
export async function removeRecentDisc(id: number, factory: IDBFactory = indexedDB): Promise<void> {
  await withStore(factory, 'readwrite', (store) => {
    store.delete(id);
  });
}

/** Returns the handle if read permission is (or becomes) granted; null if refused or the folder is gone. Call from a click handler. */
export async function reopenRecentDisc(disc: RecentDisc): Promise<FileSystemDirectoryHandle | null> {
  const descriptor = { mode: 'read' as const };
  try {
    if ((await disc.handle.queryPermission?.(descriptor)) === 'granted') return disc.handle;
    return (await disc.handle.requestPermission?.(descriptor)) === 'granted' ? disc.handle : null;
  } catch {
    return null; // the folder was moved or deleted since it was saved
  }
}
