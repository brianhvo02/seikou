import type { webcrypto } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ECDSA_KEY, ECDSA_SIGN, base64url, iceServersOf, nasIdOf, signedMessage, turnRequestMessage, unregisterMessage } from '../../rendezvous/src/protocol';
import type { IceServerInfo } from '../../rendezvous/src/protocol';
import type { EcPublicJwk } from '@seikou/nas/nas-api';
import type { CodeRegistrar } from './codes';
import { createOnce } from './store';

const TIMEOUT_MS = 10_000;

interface NasKey {
  privateKey: webcrypto.CryptoKey;
  publicKeyJwk: EcPublicJwk;
}

/**
 * Registers this NAS's pairing codes with the rendezvous Worker, so a device can find the NAS from a code alone.
 * The NAS's P-256 key lives in `keyFile` (mode 600, made once); the NAS registers its public key once per
 * process, then signs each code registration with the private key.
 */
export class RendezvousClient implements CodeRegistrar {
  private readonly base: string;
  private key: Promise<NasKey> | undefined;
  private nasId: Promise<string> | undefined;
  private loggedNotAllowed = false;

  constructor(
    base: string,
    private readonly keyFile: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = console.error,
  ) {
    this.base = base.endsWith('/') ? base : `${base}/`;
  }

  /** This NAS's id with the service, registering its public key on the first call. */
  ensureRegistered(): Promise<string> {
    this.nasId ??= this.register().catch((err: unknown) => {
      this.nasId = undefined;
      throw err;
    });
    return this.nasId;
  }

  /**
   * This NAS's id, the thumbprint of its public key, without asking the service (the key is made when there is none).
   * It is the id `POST /nas` answers and the one the Worker's `TURN_NAS_IDS` lists.
   */
  async localNasId(): Promise<string> {
    return nasIdOf((await this.loadKey()).publicKeyJwk);
  }

  /** Registers the public key again (as after the service lost its registry), giving this NAS's id. */
  reregister(): Promise<string> {
    this.nasId = undefined;
    return this.ensureRegistered();
  }

  /** The base64url ECDSA P-256 signature of `message` by this NAS's key (as for the signalling socket's challenge). */
  async sign(message: Uint8Array<ArrayBuffer>): Promise<string> {
    const { privateKey } = await this.loadKey();
    return base64url(new Uint8Array(await crypto.subtle.sign(ECDSA_SIGN, privateKey, message)));
  }

  /** Registers a code's hash and the route to this NAS with the Worker (as `CodeRegistrar`); registers the NAS first when the Worker does not know it. Throws on any answer but 204. */
  async registerCode(codeHash: string, routes: { https: string }, expiresAt: number): Promise<void> {
    // The key's own id first, not a `POST /nas`: the running server has registered the key, and every registration
    // spends one of the Worker's 5 an hour per address, which the server needs when it reconnects.
    let status = await this.postCode(await (this.nasId ?? this.localNasId()), codeHash, routes, expiresAt);
    if (status === 401) {
      // An unknown NAS: never registered, or the service lost its registry (a new deployment). Register, once.
      this.nasId = undefined;
      status = await this.postCode(await this.ensureRegistered(), codeHash, routes, expiresAt);
    }
    if (status !== 204) throw new Error(`rendezvous POST /codes answered ${status}`);
  }

  /** Signs and sends `DELETE /codes`; the service answers 204 whether or not it still held the code. */
  async unregisterCode(codeHash: string): Promise<void> {
    const nasId = await this.ensureRegistered();
    const { privateKey } = await this.loadKey();
    const signature = await crypto.subtle.sign(ECDSA_SIGN, privateKey, unregisterMessage({ nasId, codeHash }));
    const res = await this.send('DELETE', 'codes', { nasId, codeHash, signature: base64url(new Uint8Array(signature)) });
    await res.body?.cancel();
    if (res.status !== 204) throw new Error(`rendezvous DELETE /codes answered ${res.status}`);
  }

  /**
   * Fresh TURN credentials (an hour) from the Worker's `POST /turn`, signed with this NAS's key. A 401 may mean the
   * service lost its registry, so the key is registered again, once. Throws when the Worker can't give any.
   */
  async turnServers(): Promise<IceServerInfo[]> {
    let res = await this.postTurn(await this.ensureRegistered());
    if (res.status === 401) {
      await res.body?.cancel();
      res = await this.postTurn(await this.reregister());
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`rendezvous POST /turn answered ${res.status}`);
    }
    const servers = iceServersOf(((await res.json()) as { iceServers?: unknown }).iceServers);
    if (servers === null) throw new Error('rendezvous POST /turn answered no usable servers');
    return servers;
  }

  private async postTurn(nasId: string): Promise<Response> {
    const ts = this.now();
    return this.post('turn', { nasId, ts, signature: await this.sign(turnRequestMessage({ nasId, ts })) });
  }

  private async register(): Promise<string> {
    const { publicKeyJwk } = await this.loadKey();
    const res = await this.post('nas', { publicKeyJwk });
    if (!res.ok) {
      if (res.status === 403) await this.noteRefusal(res);
      else await res.body?.cancel();
      throw new Error(`rendezvous POST /nas answered ${res.status}`);
    }
    const { nasId } = (await res.json()) as { nasId?: unknown };
    const expected = await nasIdOf(publicKeyJwk);
    if (nasId !== expected) throw new Error('rendezvous POST /nas answered an unexpected id');
    return expected;
  }

  /** Says once that the Worker's allowlist (`NAS_IDS`) does not hold this NAS, which would otherwise show only as 403s. */
  private async noteRefusal(res: Response): Promise<void> {
    const error = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
    if (error !== 'nas-not-allowed' || this.loggedNotAllowed) return;
    this.loggedNotAllowed = true;
    this.log("rendezvous refused this NAS (nas-not-allowed): add its id to the Worker's NAS_IDS");
  }

  private async postCode(nasId: string, codeHash: string, routes: { https: string }, expiresAt: number): Promise<number> {
    const { privateKey } = await this.loadKey();
    const fields = { nasId, codeHash, routes: { https: routes.https }, expiresAt };
    const signature = await crypto.subtle.sign(ECDSA_SIGN, privateKey, signedMessage(fields));
    const res = await this.post('codes', { ...fields, signature: base64url(new Uint8Array(signature)) });
    await res.body?.cancel();
    return res.status;
  }

  private post(path: string, body: unknown): Promise<Response> {
    return this.send('POST', path, body);
  }

  private send(method: 'POST' | 'DELETE', path: string, body: unknown): Promise<Response> {
    return this.fetchFn(new URL(path, this.base), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  private loadKey(): Promise<NasKey> {
    this.key ??= this.readOrCreateKey().catch((err: unknown) => {
      this.key = undefined;
      throw err;
    });
    return this.key;
  }

  /** Reads the key file, first making a new key when there is none (another process's new key wins a race). */
  private async readOrCreateKey(): Promise<NasKey> {
    let text = this.readKeyFile();
    if (text === null) {
      const pair = (await crypto.subtle.generateKey(ECDSA_KEY, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
      const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
      mkdirSync(dirname(this.keyFile), { recursive: true });
      createOnce(this.keyFile, JSON.stringify({ privateKeyJwk }));
      text = this.readKeyFile()!;
    }
    let jwk: webcrypto.JsonWebKey | undefined;
    try {
      jwk = (JSON.parse(text) as { privateKeyJwk?: webcrypto.JsonWebKey }).privateKeyJwk;
    } catch {
      jwk = undefined;
    }
    const { kty, crv, x, y, d } = jwk ?? {};
    if (kty !== 'EC' || crv !== 'P-256' || typeof x !== 'string' || typeof y !== 'string' || typeof d !== 'string') {
      throw new Error(`${this.keyFile} is corrupt: not a P-256 private key`);
    }
    const privateKey = await crypto.subtle.importKey('jwk', { kty, crv, x, y, d }, ECDSA_KEY, false, ['sign']);
    return { privateKey, publicKeyJwk: { kty, crv, x, y } };
  }

  private readKeyFile(): string | null {
    try {
      return readFileSync(this.keyFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}
