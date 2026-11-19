import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { idbNasStore } from './nas-store';

describe('idbNasStore', () => {
  it('keeps one pairing, key pair included, until cleared', async () => {
    const store = idbNasStore(new IDBFactory());
    expect(await store.get()).toBeNull();
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    await store.put({ base: 'https://nas.example/bluray/api/', deviceId: 'd1', deviceName: 'iPad', owner: false, key });
    const stored = await store.get();
    expect(stored).toMatchObject({ base: 'https://nas.example/bluray/api/', deviceId: 'd1', deviceName: 'iPad', owner: false });
    expect(stored!.key.privateKey.extractable).toBe(false);
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, stored!.key.privateKey, new Uint8Array([1]));
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.publicKey, signature, new Uint8Array([1]))).toBe(true);
    await store.clear();
    expect(await store.get()).toBeNull();
  });

  it("keeps a pairing's signalling ticket, and forgets it with the pairing", async () => {
    const store = idbNasStore(new IDBFactory());
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    await store.put({ base: '', nasId: 'n'.repeat(43), deviceId: 'd1', deviceName: 'iPad', owner: false, key, signalTicket: 'tkt' });
    expect((await store.get())?.signalTicket).toBe('tkt');
    await store.clear();
    expect(await store.get()).toBeNull();
  });
});
