import { STORES, withStore } from '../db';

/** This device's pairing with a NAS. `key` is stored as the CryptoKeyPair itself; its private key is non-extractable. */
export interface NasPairing {
  /** The NAS's HTTPS API base, ending in '/', e.g. 'https://nas.example.com/bluray/api/'; '' when unknown (paired over WebRTC). */
  readonly base: string;
  /** The NAS's signalling id for WebRTC; absent on a pairing stored before WebRTC. */
  readonly nasId?: string;
  /** The rendezvous Worker this pairing was made through, for its signalling; absent means the app's built-in Worker. */
  readonly rendezvousUrl?: string;
  /**
   * Paired straight at the server from a `nas=` link, with no Worker named: its signalling id from `me` is not taken,
   * as the app's built-in Worker isn't one the person chose for it.
   */
  readonly direct?: true;
  readonly deviceId: string;
  readonly deviceName: string;
  /** The person this device belongs to; absent on a pairing stored before people. */
  readonly personName?: string;
  readonly owner: boolean;
  readonly key: CryptoKeyPair;
}

/**
 * What tells one pairing from another (another NAS, or this device paired again as another person): the device id
 * the NAS gave, with the HTTPS base it was paired at, or its NAS id when paired over WebRTC only. Both stay fixed for
 * a pairing's life (`me` may add a NAS id to a pairing made over HTTPS, which keeps its base).
 */
export function pairingKey(pairing: Pick<NasPairing, 'deviceId' | 'base' | 'nasId'>): string {
  return `${pairing.deviceId}@${pairing.base || pairing.nasId || ''}`;
}

/** Where this device keeps its pairing, one at a time: `get` reads it (null when not paired), `put` replaces it and `clear` forgets it. */
export interface NasStore {
  get(): Promise<NasPairing | null>;
  put(pairing: NasPairing): Promise<void>;
  clear(): Promise<void>;
}

const KEY = 'pairing';

/** The pairing in IndexedDB. */
export function idbNasStore(factory: IDBFactory = indexedDB): NasStore {
  return {
    async get() {
      return (await withStore<NasPairing | undefined>(factory, STORES.nas, 'readonly', (s) => s.get(KEY) as IDBRequest<NasPairing | undefined>)) ?? null;
    },
    async put(pairing) {
      await withStore(factory, STORES.nas, 'readwrite', (s) => {
        s.put(pairing, KEY);
      });
    },
    async clear() {
      await withStore(factory, STORES.nas, 'readwrite', (s) => {
        s.delete(KEY);
      });
    },
  };
}
