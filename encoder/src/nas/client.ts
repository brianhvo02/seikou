// SPDX-License-Identifier: LGPL-3.0-or-later
import { webcrypto } from 'node:crypto';
import { readNasPairing, type NasPairingFile } from './nas-store';

// Requests to the NAS as the paired owner device: a session token signed for with the device's key (as Seikou's app
// and scripts/verify-level.ts do), kept in memory only and renewed before it lapses. Nothing here logs, and no error
// message carries the token, the key or a query string.

/** Why a NAS request failed. */
export type NasErrorCode = 'unreachable' | 'unauthorized' | 'not-owner' | 'bad-address' | 'http';

/**
 * A NAS request that failed: `unreachable` (no answer: network, timeout), `unauthorized` (the NAS no longer knows this
 * device or refused its session), `not-owner` (a pairing code for a person who is not an owner), `bad-address` (not a
 * NAS API address this encoder may use) or `http` (any other error answer; `status` is its status and `error` the
 * body's `error` when it had one).
 */
export class NasError extends Error {
  constructor(
    readonly code: NasErrorCode,
    readonly status: number | null,
    message: string,
    readonly error: string | null = null,
  ) {
    super(message);
    this.name = 'NasError';
  }
}

/** Renew a session this long before the NAS said it lapses. */
const RENEW_MARGIN_MS = 60_000;

const base64url = (bytes: ArrayBuffer): string => Buffer.from(bytes).toString('base64url');

/** The host name of `base`, for messages (never its path or query). */
export function hostOf(base: string): string {
  try {
    return new URL(base).hostname;
  } catch {
    return 'the NAS';
  }
}

/** `{ error }` of an error answer's JSON body, or null. Reads the body. */
export async function errorOfBody(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as unknown;
    if (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') return (body as { error: string }).error;
  } catch {
    // not JSON
  }
  return null;
}

/** Runs `fetchImpl`, turning a network failure, abort or timeout into `NasError('unreachable')` naming only the host. */
export async function reach(fetchImpl: typeof fetch, url: string, init: RequestInit, host: string): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch {
    return Promise.reject(new NasError('unreachable', null, `${host} is not answering.`));
  }
}

/** `init` as a JSON POST of `body`. */
export function jsonPost(body: unknown, signal?: AbortSignal | null): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) };
}

/** The NAS as the paired encoder sees it. */
export class NasClient {
  /** The session, while one is held. */
  private session: { readonly token: string; readonly expiresAt: number } | null = null;
  /** The session being signed for, shared by the requests that wait on it. */
  private signing: Promise<string> | null = null;
  private readonly host: string;

  private constructor(
    private readonly pairing: NasPairingFile,
    private readonly key: webcrypto.CryptoKey,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.host = hostOf(pairing.base);
  }

  /** The client of the pairing in `dataDir`, or null when the encoder is not paired (or its file is not usable). */
  static async load(dataDir: string, fetchImpl: typeof fetch = fetch): Promise<NasClient | null> {
    const pairing = await readNasPairing(dataDir);
    if (pairing === null) return null;
    let key: webcrypto.CryptoKey;
    try {
      key = await webcrypto.subtle.importKey('jwk', pairing.privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    } catch {
      return null;
    }
    return new NasClient(pairing, key, fetchImpl);
  }

  /** The NAS's API base, ending in `/api/`. */
  get base(): string {
    return this.pairing.base;
  }

  /** The person the encoder paired as. */
  get personName(): string {
    return this.pairing.personName;
  }

  /** A session token, signed for again when none is held, it lapses within a minute, or `fresh`. */
  private token(fresh: boolean, signal: AbortSignal | null): Promise<string> {
    if (!fresh && this.session !== null && this.session.expiresAt - Date.now() > RENEW_MARGIN_MS) return Promise.resolve(this.session.token);
    if (fresh) this.session = null;
    this.signing ??= this.sign(signal).finally(() => {
      this.signing = null;
    });
    return this.signing;
  }

  private async sign(signal: AbortSignal | null): Promise<string> {
    const { base, deviceId } = this.pairing;
    const challengeRes = await reach(this.fetchImpl, `${base}session/challenge`, jsonPost({ deviceId }, signal), this.host);
    if (!challengeRes.ok) throw await this.sessionError(challengeRes);
    const { challenge } = (await challengeRes.json()) as { challenge: string };
    const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.key, new TextEncoder().encode(challenge));
    const res = await reach(this.fetchImpl, `${base}session`, jsonPost({ deviceId, challenge, signature: base64url(signature) }, signal), this.host);
    if (!res.ok) throw await this.sessionError(res);
    const session = (await res.json()) as { token: string; expiresAt: number };
    this.session = { token: session.token, expiresAt: session.expiresAt };
    return session.token;
  }

  private async sessionError(res: Response): Promise<NasError> {
    const error = await errorOfBody(res);
    if (res.status === 401) return new NasError('unauthorized', 401, `${this.host} no longer knows this encoder. Pair it again.`, error);
    return new NasError('http', res.status, `${this.host} answered ${res.status} when the encoder signed in.`, error);
  }

  /**
   * `path` (relative to the API base, such as `encodes/status`) with a session token; a 401 signs for a new session
   * once and sends the request again. A network failure, abort or timeout throws `NasError('unreachable')`. A body
   * that is a stream cannot be sent twice, so pass bytes or a string when a 401 may need the retry.
   */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const signal = init.signal ?? null;
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${await this.token(attempt > 0, signal)}`);
      const res = await reach(this.fetchImpl, `${this.pairing.base}${path}`, { ...init, headers }, this.host);
      if (res.status !== 401 || attempt > 0) return res;
      await res.body?.cancel();
    }
  }

  /** `request`, then the answer's JSON; an error answer throws `NasError` (`unauthorized` for 401, else `http`) with its status and `error`. */
  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(path, init);
    if (!res.ok) {
      const error = await errorOfBody(res);
      const what = path.split('?')[0];
      if (res.status === 401) throw new NasError('unauthorized', 401, `${this.host} refused the encoder's session for ${what}. Pair it again.`, error);
      throw new NasError('http', res.status, `${this.host} answered ${res.status}${error === null ? '' : ` (${error})`} for ${what}.`, error);
    }
    return (await res.json()) as T;
  }

  /** `GET me`: whether the encoder's person is an owner, and their name. */
  async me(init: RequestInit = {}): Promise<{ owner: boolean; personName: string }> {
    const me = await this.json<{ owner: boolean; personName: string }>('me', init);
    return { owner: me.owner, personName: me.personName };
  }
}
