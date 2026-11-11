import type { CodeLookup, CodeRoutes, EcPublicJwk } from '@seikou/nas/nas-api';
import { ECDSA_KEY, ECDSA_SIGN, MAX_CODE_AHEAD_MS, codeHashOf, fromBase64url, isNasId, nasIdOf, signedMessage, unregisterMessage } from './protocol';

/** The part of a Durable Object's storage API the registry uses (the KV-style API, on SQLite-backed storage). */
export interface RegistryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string; limit?: number; startAfter?: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

/** The part of `DurableObjectState` the registry uses: its storage. */
export interface RegistryState {
  readonly storage: RegistryStorage;
}

interface NasRecord {
  publicKeyJwk: EcPublicJwk;
  /** The last accepted `POST /codes` (or the registration); the record expires `NAS_TTL_MS` after it. */
  lastSeen: number;
  /** This NAS's codes by hash → expiry, pruned as they expire; at most `CODES_PER_NAS` live ones. */
  codes: Record<string, number>;
}

interface CodeRecord {
  nasId: string;
  routes: CodeRoutes;
  expiresAt: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Per-client sliding-window limits, checked before a request body is parsed. */
const LIMITS = {
  lookup: { max: 10, windowMs: MINUTE },
  nas: { max: 5, windowMs: HOUR },
  codes: { max: 30, windowMs: HOUR },
  unregister: { max: 60, windowMs: HOUR },
  /** Signalling WebSocket attempts, NAS and device sockets alike, counted here for every NAS id at once. */
  signal: { max: 10, windowMs: MINUTE },
  /** TURN credentials minted for one NAS (`POST /turn`), after its signature checked. */
  turn: { max: 30, windowMs: HOUR },
  /** TURN credentials minted for every NAS at once, a cap on what the Worker's key can cost. */
  turnDay: { max: 500, windowMs: DAY },
} as const;
type Route = keyof typeof LIMITS;
const ROUTES: Readonly<Record<string, Exclude<Route, 'unregister' | 'signal' | 'turn' | 'turnDay'>>> = { '/nas': 'nas', '/codes': 'codes', '/codes/lookup': 'lookup' };

/** Failed lookups allowed per hour across all clients; successful ones need a valid 60-bit code and don't count. */
const FAILED_LOOKUPS_PER_HOUR = 1_000;
/** Room for a few 3-day invites beside the 10-minute codes; codes the NAS unregisters free their place at once. */
const CODES_PER_NAS = 20;
const NAS_TTL_MS = 90 * DAY;
const MAX_ROUTE_LENGTH = 512;
const ALARM_PAGE = 500;

/** The one registry instance's name (`idFromName`). */
export const REGISTRY_NAME = 'registry';

/**
 * Paths only the Worker's own objects call (the Worker in `index.ts` never routes them from outside): the
 * Signalling object reads a NAS's key and marks a NAS seen when its socket authenticates, and the Worker counts a
 * client's signalling attempts and a NAS's TURN credentials.
 */
export const INTERNAL = {
  nasKey: '/internal/nas-key',
  nasTouch: '/internal/nas-touch',
  signalAttempt: '/internal/signal-attempt',
  turnAttempt: '/internal/turn-attempt',
} as const;

/** Storage keys: NAS public keys, codes by hash (never the code), and the rate-limit logs. */
const nasKey = (nasId: string): string => `nas:${nasId}`;
const codeKey = (codeHash: string): string => `code:${codeHash}`;
const rateKey = (route: Route, client: string): string => `rate:${route}:${client}`;
const TURN_DAY_KEY = rateKey('turnDay', 'all');
const FAILED_KEY = 'global:failed-lookups';

/** A JSON response with `status`; `body` is serialized as is. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ROUTE_LENGTH) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** A P-256 public key JWK, without a private part. */
function publicJwk(value: unknown): EcPublicJwk | null {
  if (!isObject(value) || 'd' in value) return null;
  const { kty, crv, x, y } = value;
  if (kty !== 'EC' || crv !== 'P-256' || typeof x !== 'string' || typeof y !== 'string') return null;
  if (!BASE64URL_32_BYTES.test(x) || !BASE64URL_32_BYTES.test(y)) return null;
  return { kty, crv, x, y };
}

/**
 * The rate-limit bucket of a client address: an IPv4 address as is, an IPv6 address by its /64
 * (one subscriber usually holds a whole /64), and an IPv4 address embedded in IPv6 as that IPv4 address.
 */
export function clientBucket(ip: string | null): string {
  if (!ip) return 'unknown';
  const address = ip.trim().toLowerCase().split('%')[0]!.slice(0, 64);
  if (!address.includes(':')) return address;
  if (address.includes('.')) return address.slice(address.lastIndexOf(':') + 1);
  const halves = address.split('::');
  if (halves.length > 2) return address;
  const groups = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return address;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return address;
  return `${all.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * The rendezvous Durable Object (one instance, `idFromName('registry')`): NAS public keys, pairing codes
 * by hash with their routes and expiry, and rate limits. An alarm deletes expired codes, expired NAS
 * records and stale rate-limit logs. The Worker in `index.ts` adds CORS and bounds request bodies.
 */
export class CodeRegistry {
  private readonly storage: RegistryStorage;

  constructor(state: RegistryState, _env?: unknown, private readonly now: () => number = Date.now) {
    this.storage = state.storage;
  }

  /**
   * The registry's routes, reached only through the Worker in `index.ts` (which bounds the body and adds CORS) or, for
   * the `INTERNAL` paths, from the Worker's own objects.
   *
   * - `POST /nas`: any client may register a key. 400 for a body that isn't a P-256 public key.
   * - `POST /codes` and `DELETE /codes`: only the NAS that holds the registered key, by a signature over the request's
   *   fields. 400 for a malformed body or an `expiresAt` in the past or more than `MAX_CODE_AHEAD_MS` ahead, 401 for
   *   an unknown or expired NAS or a bad signature, 409 when another NAS holds that code hash, 429 when the NAS has
   *   `CODES_PER_NAS` live codes.
   * - `POST /codes/lookup`: any client, the app with the code its user typed. 404 for an unknown or expired code.
   * - Every route: 429 once the client's address bucket (`clientBucket`) has used its window, and 405 for a method
   *   the route doesn't take.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === INTERNAL.nasKey) return this.nasKeyOf(url.searchParams.get('nasId'));
    if (url.pathname === INTERNAL.nasTouch) return this.touchNas(url.searchParams.get('nasId'));
    if (url.pathname === INTERNAL.signalAttempt) {
      const allowed = await this.allow(rateKey('signal', clientBucket(request.headers.get('CF-Connecting-IP'))), LIMITS.signal);
      return allowed ? new Response(null, { status: 204 }) : json(429, { error: 'too many requests' });
    }
    if (url.pathname === INTERNAL.turnAttempt) return this.turnAttempt(url.searchParams.get('nasId'));
    const path = ROUTES[url.pathname];
    if (path === undefined) return json(404, { error: 'not found' });
    const route: Route = path === 'codes' && request.method === 'DELETE' ? 'unregister' : path;
    if (request.method !== 'POST' && route !== 'unregister') return json(405, { error: 'method not allowed' });
    const client = clientBucket(request.headers.get('CF-Connecting-IP'));
    if (!(await this.allow(rateKey(route, client), LIMITS[route]))) return json(429, { error: 'too many requests' });
    const body = await readJson(request);
    switch (route) {
      case 'unregister':
        return this.unregisterCode(body);
      case 'nas':
        return this.registerNas(body);
      case 'codes':
        return this.registerCode(body);
      case 'lookup':
        return this.lookup(body);
    }
  }

  /** The runtime's alarm: deletes expired codes, expired NAS records and stale rate logs page by page, then wakes again for the next one. */
  async alarm(): Promise<void> {
    const now = this.now();
    const next = Math.min(
      await this.sweep<CodeRecord>('code:', now, (record) => record.expiresAt),
      await this.sweep<NasRecord>('nas:', now, (record) => record.lastSeen + NAS_TTL_MS),
      await this.sweep<number[]>('rate:', now, (hits, key) => Math.max(...hits) + windowOf(key)),
    );
    const failed = ((await this.storage.get<number[]>(FAILED_KEY)) ?? []).filter((t) => t > now - HOUR);
    if (failed.length === 0) await this.storage.delete(FAILED_KEY);
    else await this.storage.put(FAILED_KEY, failed);
    if (next !== Infinity) await this.armAlarm(next);
  }

  /** Deletes the records under `prefix` whose deadline has passed; answers the earliest deadline left. */
  private async sweep<T>(prefix: string, now: number, deadline: (value: T, key: string) => number): Promise<number> {
    let next = Infinity;
    let startAfter: string | undefined;
    for (;;) {
      const page = await this.storage.list<T>(startAfter === undefined ? { prefix, limit: ALARM_PAGE } : { prefix, limit: ALARM_PAGE, startAfter });
      for (const [key, value] of page) {
        const at = deadline(value, key);
        if (at <= now) await this.storage.delete(key);
        else next = Math.min(next, at);
        startAfter = key;
      }
      if (page.size < ALARM_PAGE) return next;
    }
  }

  /** Internal `GET /internal/nas-key?nasId=` → `{ publicKeyJwk }` of a live NAS, or 404. */
  private async nasKeyOf(nasId: string | null): Promise<Response> {
    if (!isNasId(nasId)) return json(404, { error: 'unknown nas' });
    const nas = await this.storage.get<NasRecord>(nasKey(nasId));
    if (!live(nas, this.now())) return json(404, { error: 'unknown nas' });
    return json(200, { publicKeyJwk: nas.publicKeyJwk });
  }

  /**
   * Internal `POST /internal/nas-touch?nasId=` → 204: a live NAS's signalling socket authenticated, so the NAS
   * counts as seen; a NAS that only signals (no new codes) then stays registered. 404 for an unknown or expired NAS.
   */
  private async touchNas(nasId: string | null): Promise<Response> {
    if (!isNasId(nasId)) return json(404, { error: 'unknown nas' });
    const now = this.now();
    const nas = await this.storage.get<NasRecord>(nasKey(nasId));
    if (!live(nas, now)) return json(404, { error: 'unknown nas' });
    await this.storage.put<NasRecord>(nasKey(nasId), { ...nas, lastSeen: now });
    return new Response(null, { status: 204 });
  }

  /**
   * Internal `POST /internal/turn-attempt?nasId=` → 204 and counts one minting, or 429 `{ error, scope }` when the
   * NAS's hourly limit (`scope: 'nas'`) or every NAS's daily cap (`scope: 'global'`) is reached; a refused try
   * counts against neither.
   */
  private async turnAttempt(nasId: string | null): Promise<Response> {
    if (!isNasId(nasId)) return json(400, { error: 'bad request' });
    const now = this.now();
    const recent = async (key: string, limit: { windowMs: number }): Promise<number[]> =>
      ((await this.storage.get<number[]>(key)) ?? []).filter((t) => t > now - limit.windowMs);
    const nasKeyName = rateKey('turn', nasId);
    const mine = await recent(nasKeyName, LIMITS.turn);
    if (mine.length >= LIMITS.turn.max) return json(429, { error: 'turn-rate-limited', scope: 'nas' });
    const all = await recent(TURN_DAY_KEY, LIMITS.turnDay);
    if (all.length >= LIMITS.turnDay.max) return json(429, { error: 'turn-rate-limited', scope: 'global' });
    await this.storage.put(nasKeyName, [...mine, now]);
    await this.storage.put(TURN_DAY_KEY, [...all, now]);
    await this.armAlarm(now + LIMITS.turn.windowMs);
    return new Response(null, { status: 204 });
  }

  /** `POST /nas { publicKeyJwk }` → `{ nasId }`; open to any client. The id is the key's thumbprint, so this is idempotent. 400 for a key that isn't a P-256 public JWK (or carries a private part). */
  private async registerNas(body: unknown): Promise<Response> {
    const jwk = isObject(body) ? publicJwk(body.publicKeyJwk) : null;
    if (!jwk) return json(400, { error: 'bad request' });
    try {
      await crypto.subtle.importKey('jwk', jwk, ECDSA_KEY, false, ['verify']);
    } catch {
      return json(400, { error: 'bad request' });
    }
    const nasId = await nasIdOf(jwk);
    const now = this.now();
    if (!live(await this.storage.get<NasRecord>(nasKey(nasId)), now)) {
      await this.storage.put<NasRecord>(nasKey(nasId), { publicKeyJwk: jwk, lastSeen: now, codes: {} });
      await this.armAlarm(now + NAS_TTL_MS);
    }
    return json(200, { nasId });
  }

  /** `POST /codes { nasId, codeHash, routes, expiresAt, signature }` → 204, signed by the NAS's key. */
  private async registerCode(body: unknown): Promise<Response> {
    if (!isObject(body)) return json(400, { error: 'bad request' });
    const { nasId, codeHash, routes, expiresAt, signature } = body;
    if (
      typeof nasId !== 'string' ||
      !BASE64URL_32_BYTES.test(nasId) ||
      typeof codeHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(codeHash) ||
      !isObject(routes) ||
      Object.keys(routes).some((k) => k !== 'https') ||
      (routes.https !== undefined && !isHttpUrl(routes.https)) ||
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) ||
      typeof signature !== 'string'
    ) {
      return json(400, { error: 'bad request' });
    }
    // A signed request stays valid only until its code expires, so a captured one can't be replayed later.
    if (expiresAt <= this.now() || expiresAt > this.now() + MAX_CODE_AHEAD_MS) return json(400, { error: 'bad expiry' });

    const known = await this.storage.get<NasRecord>(nasKey(nasId));
    if (!live(known, this.now())) return json(401, { error: 'unknown nas' });
    const key = await crypto.subtle.importKey('jwk', known.publicKeyJwk, ECDSA_KEY, false, ['verify']);
    const signed = { nasId, codeHash, routes: routes.https === undefined ? {} : { https: routes.https }, expiresAt };
    const sig = fromBase64url(signature);
    if (sig === null || sig.length !== 64 || !(await crypto.subtle.verify(ECDSA_SIGN, key, sig, signedMessage(signed)))) {
      return json(401, { error: 'bad signature' });
    }

    // Storage operations only from here on, so no other request interleaves with this update.
    const now = this.now();
    const nas = await this.storage.get<NasRecord>(nasKey(nasId));
    if (!live(nas, now)) return json(401, { error: 'unknown nas' });
    const existing = await this.storage.get<CodeRecord>(codeKey(codeHash));
    if (existing && existing.nasId !== nasId && existing.expiresAt > now) return json(409, { error: 'code taken' });
    const liveCodes = Object.entries(nas.codes).filter(([hash, at]) => at > now && hash !== codeHash);
    if (liveCodes.length >= CODES_PER_NAS) return json(429, { error: 'too many codes' });
    await this.storage.put<NasRecord>(nasKey(nasId), {
      publicKeyJwk: nas.publicKeyJwk,
      lastSeen: now,
      codes: Object.fromEntries([...liveCodes, [codeHash, expiresAt]]),
    });
    await this.storage.put<CodeRecord>(codeKey(codeHash), { nasId, routes: signed.routes, expiresAt });
    await this.armAlarm(expiresAt);
    return new Response(null, { status: 204 });
  }

  /**
   * `DELETE /codes { nasId, codeHash, signature }` → 204, signed by the NAS's key over `unregisterMessage`. Idempotent;
   * it removes the code only when that NAS registered it, and answers the same either way.
   */
  private async unregisterCode(body: unknown): Promise<Response> {
    if (!isObject(body)) return json(400, { error: 'bad request' });
    const { nasId, codeHash, signature } = body;
    if (typeof nasId !== 'string' || !BASE64URL_32_BYTES.test(nasId) || typeof codeHash !== 'string' || !/^[0-9a-f]{64}$/.test(codeHash) || typeof signature !== 'string') {
      return json(400, { error: 'bad request' });
    }
    const known = await this.storage.get<NasRecord>(nasKey(nasId));
    if (!live(known, this.now())) return json(401, { error: 'unknown nas' });
    const key = await crypto.subtle.importKey('jwk', known.publicKeyJwk, ECDSA_KEY, false, ['verify']);
    const sig = fromBase64url(signature);
    if (sig === null || sig.length !== 64 || !(await crypto.subtle.verify(ECDSA_SIGN, key, sig, unregisterMessage({ nasId, codeHash })))) {
      return json(401, { error: 'bad signature' });
    }

    // Storage operations only from here on, so no other request interleaves with this update.
    const nas = await this.storage.get<NasRecord>(nasKey(nasId));
    if (!live(nas, this.now())) return json(401, { error: 'unknown nas' });
    const existing = await this.storage.get<CodeRecord>(codeKey(codeHash));
    if (existing?.nasId === nasId) await this.storage.delete(codeKey(codeHash));
    if (codeHash in nas.codes) {
      const { [codeHash]: _gone, ...codes } = nas.codes;
      await this.storage.put<NasRecord>(nasKey(nasId), { ...nas, codes });
    }
    return new Response(null, { status: 204 });
  }

  /**
   * `POST /codes/lookup { code }` → `{ nasId, routes }`; never anything for an unknown or expired code.
   * Failed lookups share an hourly budget: once it is spent they answer 429, while valid codes still resolve.
   */
  private async lookup(body: unknown): Promise<Response> {
    if (!isObject(body) || typeof body.code !== 'string' || body.code.length > 64) return json(400, { error: 'bad request' });
    const now = this.now();
    const hash = await codeHashOf(body.code);
    const record = hash === null ? undefined : await this.storage.get<CodeRecord>(codeKey(hash));
    if (record && record.expiresAt > now) {
      // Every registered NAS keeps a signalling socket, so every code can be reached over WebRTC.
      const answer: CodeLookup = { nasId: record.nasId, routes: { ...record.routes, webrtc: { nasId: record.nasId } } };
      return json(200, answer);
    }
    if (!(await this.allow(FAILED_KEY, { max: FAILED_LOOKUPS_PER_HOUR, windowMs: HOUR }))) return json(429, { error: 'too many lookups' });
    return json(404, { error: 'unknown code' });
  }

  /** A sliding-window log under `key`: records this try unless `max` tries fell within `windowMs` already. */
  private async allow(key: string, limit: { max: number; windowMs: number }): Promise<boolean> {
    const now = this.now();
    const hits = ((await this.storage.get<number[]>(key)) ?? []).filter((t) => t > now - limit.windowMs);
    if (hits.length >= limit.max) return false;
    hits.push(now);
    await this.storage.put(key, hits);
    await this.armAlarm(now + limit.windowMs);
    return true;
  }

  /** Moves the alarm earlier, never later. */
  private async armAlarm(time: number): Promise<void> {
    const current = await this.storage.getAlarm();
    if (current === null || current > time) await this.storage.setAlarm(time);
  }
}

function live(nas: NasRecord | undefined, now: number): nas is NasRecord {
  return nas !== undefined && nas.lastSeen + NAS_TTL_MS > now;
}

function windowOf(rateKey: string): number {
  return LIMITS[rateKey.split(':')[1] as Route]?.windowMs ?? HOUR;
}

/** The request's JSON body (the Worker has already bounded its size), or undefined when it isn't JSON. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await request.text()) as unknown;
  } catch {
    return undefined;
  }
}
