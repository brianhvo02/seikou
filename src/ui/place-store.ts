import type { DiscPlaces, PlaybackPlace } from '@seikou/nas/nas-api';
import { STORES, withStore } from './db';

/** A subtitle (or font) file the user added to a disc, kept on this device so a resume here can add it again. */
export interface StoredTextFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** A place the NAS hasn't taken yet: the pairing it was saved under, and how often the NAS refused it so far. */
export interface OutboxEntry {
  readonly place: PlaybackPlace;
  /** `pairingKey` of the pairing the place was saved under: it goes to that pairing's NAS and person only. */
  readonly pairing: string;
  readonly attempts: number;
}

/** A place the NAS refuses this many times (an error answer, not an unreachable NAS) leaves the outbox. */
export const MAX_SEND_ATTEMPTS = 5;

/** A file larger than this is not kept. */
export const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
/** A disc's files together past this are not kept at all. */
export const MAX_TEXT_FILES_BYTES = 50 * 1024 * 1024;

/**
 * Places on this device: every place saved here, the NAS discs' places waiting to be sent
 * (the outbox), and the subtitle files added per disc. Every save goes here first.
 */
export interface PlaceStore {
  /** Stores a place, unless the one stored for its disc and playlist is newer. */
  put(place: PlaybackPlace): Promise<void>;
  /** A disc's places by playlist id, with the newest place's settings as the disc's defaults. */
  get(discKey: string): Promise<DiscPlaces>;
  /** The places waiting for the NAS, one per disc and playlist. */
  outbox(): Promise<OutboxEntry[]>;
  /** Puts a place saved under `pairing` in the outbox, replacing an older one for its disc and playlist. */
  queue(place: PlaybackPlace, pairing: string): Promise<void>;
  /** The NAS took (or refused for good) the place `key` saved at `updatedAt`: out of the outbox unless a newer one came. */
  sent(key: string, updatedAt: number): Promise<void>;
  /** The NAS refused the place `key` saved at `updatedAt` once more; at MAX_SEND_ATTEMPTS it leaves the outbox. */
  failed(key: string, updatedAt: number): Promise<void>;
  /** Empties the outbox (the pairing changed: nothing in it may go to the new one). */
  clearOutbox(): Promise<void>;
  /** Replaces a disc's files; a file over 5 MB is left out, and a set over 50 MB is not stored. */
  putTextFiles(discKey: string, files: readonly StoredTextFile[]): Promise<void>;
  textFiles(discKey: string): Promise<StoredTextFile[]>;
}

interface PlaceRecord {
  readonly key: string;
  readonly place: PlaybackPlace;
}

interface OutboxRecord extends OutboxEntry {
  readonly key: string;
}

interface TextFilesRecord {
  readonly key: string;
  readonly files: readonly StoredTextFile[];
}

/**
 * A NAS disc's place: only those carry the NAS's disc id (a local folder's and a disc-server disc's have none). They
 * belong in the outbox, never in `places` (`db.ts` drops the ones version 5 stored).
 */
export const isRemote = (place: Pick<PlaybackPlace, 'discId'>): boolean => place.discId !== '';

/** `<discKey>/<playlistId>`: a place's key on this device. */
export const placeKey = (place: Pick<PlaybackPlace, 'discKey' | 'playlistId'>): string => `${place.discKey}/${place.playlistId}`;

/** Writes `record` unless the store holds a newer place under its key. */
function putNewer<T extends PlaceRecord>(factory: IDBFactory, store: string, record: T): Promise<unknown> {
  return withStore(factory, store, 'readwrite', (s) => {
    const req = s.get(record.key) as IDBRequest<PlaceRecord | undefined>;
    req.onsuccess = () => {
      if (!req.result || req.result.place.updatedAt <= record.place.updatedAt) s.put(record);
    };
  });
}

/** Runs `change` on the outbox record `key` if it holds the place saved at `updatedAt` or an older one. */
function withQueued(factory: IDBFactory, key: string, updatedAt: number, change: (s: IDBObjectStore, record: OutboxRecord) => void): Promise<unknown> {
  return withStore(factory, STORES.placeOutbox, 'readwrite', (s) => {
    const req = s.get(key) as IDBRequest<OutboxRecord | undefined>;
    req.onsuccess = () => {
      if (req.result && req.result.place.updatedAt <= updatedAt) change(s, req.result);
    };
  });
}

/** `keyRange` is the browser's `IDBKeyRange` (passed in where there is none, as in the tests). */
export function idbPlaceStore(factory: IDBFactory = indexedDB, keyRange: typeof IDBKeyRange = IDBKeyRange): PlaceStore {
  return {
    async put(place) {
      if (isRemote(place)) return;
      await putNewer(factory, STORES.places, { key: placeKey(place), place });
    },
    async get(discKey) {
      const range = keyRange.bound(`${discKey}/`, `${discKey}/￿`);
      const records = (await withStore(factory, STORES.places, 'readonly', (s) => s.getAll(range) as IDBRequest<PlaceRecord[]>)) ?? [];
      const places: Record<string, PlaybackPlace> = {};
      let newest: PlaybackPlace | null = null;
      for (const { place } of records) {
        if (isRemote(place)) continue; // a NAS disc's place (stored by older builds) is never this device's
        places[place.playlistId] = place;
        if (!newest || place.updatedAt > newest.updatedAt) newest = place;
      }
      return { defaults: newest?.settings ?? null, places };
    },
    async outbox() {
      const records = (await withStore(factory, STORES.placeOutbox, 'readonly', (s) => s.getAll() as IDBRequest<OutboxRecord[]>)) ?? [];
      return records.map(({ place, pairing, attempts }) => ({ place, pairing, attempts }));
    },
    async queue(place, pairing) {
      await putNewer(factory, STORES.placeOutbox, { key: placeKey(place), place, pairing, attempts: 0 } satisfies OutboxRecord);
    },
    async sent(key, updatedAt) {
      await withQueued(factory, key, updatedAt, (s) => s.delete(key));
    },
    async failed(key, updatedAt) {
      await withQueued(factory, key, updatedAt, (s, record) => {
        if (record.attempts + 1 >= MAX_SEND_ATTEMPTS) s.delete(key);
        else s.put({ ...record, attempts: record.attempts + 1 } satisfies OutboxRecord);
      });
    },
    async clearOutbox() {
      await withStore(factory, STORES.placeOutbox, 'readwrite', (s) => {
        s.clear();
      });
    },
    async putTextFiles(discKey, files) {
      const kept = files.filter((f) => f.bytes.byteLength <= MAX_TEXT_FILE_BYTES);
      if (kept.reduce((sum, f) => sum + f.bytes.byteLength, 0) > MAX_TEXT_FILES_BYTES) return;
      await withStore(factory, STORES.localTextFiles, 'readwrite', (s) => {
        s.put({ key: discKey, files: kept } satisfies TextFilesRecord);
      });
    },
    async textFiles(discKey) {
      const record = await withStore(factory, STORES.localTextFiles, 'readonly', (s) => s.get(discKey) as IDBRequest<TextFilesRecord | undefined>);
      return record ? [...record.files] : [];
    },
  };
}
