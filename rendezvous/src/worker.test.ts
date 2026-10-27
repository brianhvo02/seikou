import { beforeEach, describe, expect, it } from 'vitest';
import { CodeRegistry, clientBucket } from './code-registry';
import worker from './index';
import type { Env } from './index';
import { fireAlarm, memoryState } from './memory-state';
import type { MemoryStorage } from './memory-state';
import { base64url, codeHashOf, signedMessage, unregisterMessage } from './protocol';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const CODE = 'K7QM4XP2R9TD';
/** Shared with server/src/codes.test.ts: both runtimes must hash a code identically. */
const CODE_HASH = '0f54f555d41af4fe0469424a47ffcbfb19a84d3629a0cbc0ffa8385557ea6dbf';
const APP = 'https://bluray.pages.dev';
const ROUTES = { https: 'https://nas.example/bluray/api/' };

let clock: number;
let storage: MemoryStorage;
let registry: CodeRegistry;
let env: Env;
/** The requests the Worker passed to the Signalling Durable Object, with the name of the instance. */
let signalled: { name: string; request: Request }[];

beforeEach(() => {
  clock = 1_800_000_000_000;
  const state = memoryState();
  storage = state.storage;
  registry = new CodeRegistry(state, undefined, () => clock);
  env = {
    CODE_REGISTRY: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ fetch: (request: Request) => registry.fetch(request) }),
    },
    SIGNALLING: {
      idFromName: (name: string) => ({ name }),
      get: (id: object) => ({
        fetch: async (request: Request) => {
          signalled.push({ name: (id as { name: string }).name, request });
          return new Response(null, { status: 200, headers: { 'X-Signalling': '1' } });
        },
      }),
    },
  };
  signalled = [];
});

/** A distinct code hash per number. */
const hashOf = (n: number): string => n.toString(16).padStart(64, '0');

/** The stored keys under `prefix`, sorted. */
const keys_ = (prefix: string): string[] => [...storage.data.keys()].filter((k) => k.startsWith(prefix)).sort();

function call(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(
    new Request(`https://rendezvous.example${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

function lookup(code: string, ip = '203.0.113.7'): Promise<Response> {
  return call('/codes/lookup', { code }, { 'CF-Connecting-IP': ip, Origin: APP });
}

async function nasKey(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
}

async function registerNas(keys: CryptoKeyPair): Promise<string> {
  const { kty, crv, x, y } = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey;
  const res = await call('/nas', { publicKeyJwk: { kty, crv, x, y } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { nasId: string }).nasId;
}

async function signedCode(
  keys: CryptoKeyPair,
  fields: { nasId: string; codeHash: string; routes: { https?: string }; expiresAt: number },
): Promise<Record<string, unknown>> {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, signedMessage(fields));
  return { ...fields, signature: base64url(new Uint8Array(signature)) };
}

async function registerCode(keys: CryptoKeyPair, nasId: string, expiresAt = clock + 10 * MINUTE, codeHash = CODE_HASH): Promise<Response> {
  return call('/codes', await signedCode(keys, { nasId, codeHash, routes: ROUTES, expiresAt }));
}

async function unregisterCode(keys: CryptoKeyPair, nasId: string, codeHash = CODE_HASH): Promise<Response> {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, unregisterMessage({ nasId, codeHash }));
  return callDelete({ nasId, codeHash, signature: base64url(new Uint8Array(signature)) });
}

function callDelete(body: unknown): Promise<Response> {
  return worker.fetch(
    new Request('https://rendezvous.example/codes', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    env,
  );
}

describe('protocol', () => {
  it('hashes a code as hex SHA-256 of its normalized form (shared test vector)', async () => {
    expect(await codeHashOf('k7qm-4xp2-r9td')).toBe(CODE_HASH);
    expect(await codeHashOf('not a code')).toBeNull();
  });
});

describe('rendezvous', () => {
  it('finds a NAS by a code typed lower-case with dashes', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    expect(nasId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await registerCode(keys, nasId)).status).toBe(204);

    const res = await lookup('k7qm-4xp2-r9td');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nasId, routes: { ...ROUTES, webrtc: { nasId } } });
    // A lookup doesn't consume the code; the NAS's redeem does.
    expect((await lookup(CODE)).status).toBe(200);
  });

  it('gives the same id when a NAS registers its key again', async () => {
    const keys = await nasKey();
    expect(await registerNas(keys)).toBe(await registerNas(keys));
  });

  it('rejects a bad signature with 401', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    const body = await signedCode(keys, { nasId, codeHash: CODE_HASH, routes: ROUTES, expiresAt: clock + 10 * MINUTE });
    expect((await call('/codes', { ...body, routes: { https: 'https://evil.example/' } })).status).toBe(401);
    const other = await signedCode(await nasKey(), { nasId, codeHash: CODE_HASH, routes: ROUTES, expiresAt: clock + 10 * MINUTE });
    expect((await call('/codes', other)).status).toBe(401);
    expect((await lookup(CODE)).status).toBe(404);
  });

  it('rejects a code from an unknown NAS with 401', async () => {
    const keys = await nasKey();
    expect((await registerCode(keys, 'A'.repeat(43))).status).toBe(401);
  });

  it('rejects an expiry in the past or more than 3 days and 1 hour ahead, so a captured request cannot be replayed later', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    const DAY = 24 * 60 * MINUTE;
    expect((await registerCode(keys, nasId, clock - 1)).status).toBe(400);
    expect((await registerCode(keys, nasId, clock + 3 * DAY + 120 * MINUTE)).status).toBe(400);
    expect((await registerCode(keys, nasId, clock + 3 * DAY + 60 * MINUTE + 1)).status).toBe(400);
    expect((await registerCode(keys, nasId, clock + 3 * DAY)).status).toBe(204);
    expect((await registerCode(keys, nasId, clock + 3 * DAY + 60 * MINUTE)).status).toBe(204);
  });

  it("won't let one NAS take over another NAS's code", async () => {
    const a = await nasKey();
    const b = await nasKey();
    const nasA = await registerNas(a);
    const nasB = await registerNas(b);
    expect((await registerCode(a, nasA)).status).toBe(204);
    expect((await registerCode(b, nasB)).status).toBe(409);
    expect(await (await lookup(CODE)).json()).toEqual({ nasId: nasA, routes: { ...ROUTES, webrtc: { nasId: nasA } } });
  });

  it('answers 404 for an unknown code or an expired one, and the alarm deletes expired codes', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    await registerCode(keys, nasId, clock + 10 * MINUTE);
    expect(storage.alarm).toBe(clock + 10 * MINUTE);
    expect((await lookup('ZZZZ-ZZZZ-ZZZZ')).status).toBe(404);
    expect((await lookup('not a code')).status).toBe(404);

    clock += 10 * MINUTE;
    expect((await lookup(CODE, '198.51.100.1')).status).toBe(404);
    await fireAlarm(storage, registry);
    expect(keys_('code:')).toEqual([]);
  });

  it('answers 429 to the 11th lookup from one IP within a minute, and lets it through a minute later', async () => {
    for (let i = 0; i < 10; i++) expect((await lookup('ZZZZ-ZZZZ-ZZZZ')).status).toBe(404);
    const limited = await lookup('ZZZZ-ZZZZ-ZZZZ');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect((await lookup('ZZZZ-ZZZZ-ZZZZ', '203.0.113.8')).status).toBe(404);
    clock += MINUTE;
    expect((await lookup('ZZZZ-ZZZZ-ZZZZ')).status).toBe(404);
  });

  it('counts only failed lookups against the hourly budget: the 1,001st failure is 429, a valid code still resolves', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    for (let i = 0; i < 1000; i++) {
      clock += 500;
      expect((await lookup('ZZZZ-ZZZZ-ZZZZ', `10.0.${i >> 8}.${i & 255}`)).status).toBe(404);
    }
    expect((await registerCode(keys, nasId)).status).toBe(204);
    for (let i = 0; i < 20; i++) expect((await lookup(CODE, `10.1.0.${i}`)).status).toBe(200);
    expect((await lookup('ZZZZ-ZZZZ-ZZZZ', '192.0.2.1')).status).toBe(429);
    expect((await lookup(CODE, '192.0.2.1')).status).toBe(200);
    clock += 60 * MINUTE - 1000 * 500 + 500;
    expect((await lookup('ZZZZ-ZZZZ-ZZZZ', '192.0.2.2')).status).toBe(404);
  });

  it('buckets IPv6 clients by /64', async () => {
    for (let i = 1; i <= 10; i++) expect((await lookup('ZZZZ-ZZZZ-ZZZZ', `2001:db8:1:2::${i}`)).status).toBe(404);
    expect((await lookup('ZZZZ-ZZZZ-ZZZZ', '2001:0db8:0001:0002:ffff:1:2:3')).status).toBe(429);
    expect((await lookup('ZZZZ-ZZZZ-ZZZZ', '2001:db8:1:3::1')).status).toBe(404);
    expect(clientBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientBucket('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(clientBucket(null)).toBe('unknown');
  });

  it('limits POST /nas to 5 and POST /codes to 30 per client per hour, before parsing', async () => {
    for (let i = 0; i < 5; i++) expect((await call('/nas', {})).status).toBe(400);
    expect((await call('/nas', {})).status).toBe(429);
    expect((await call('/nas', {}, { 'CF-Connecting-IP': '198.51.100.9' })).status).toBe(400);
    for (let i = 0; i < 30; i++) expect((await call('/codes', {})).status).toBe(400);
    expect((await call('/codes', {})).status).toBe(429);
    clock += 60 * MINUTE;
    expect((await call('/nas', {})).status).toBe(400);
    expect((await call('/codes', {})).status).toBe(400);
  });

  it('allows at most 20 live codes per NAS', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    for (let i = 0; i < 20; i++) expect((await registerCode(keys, nasId, clock + (5 + i) * MINUTE, hashOf(i))).status).toBe(204);
    expect((await registerCode(keys, nasId, clock + 30 * MINUTE, hashOf(20))).status).toBe(429);
    // Registering a live code again is not a new one.
    expect((await registerCode(keys, nasId, clock + 10 * MINUTE, hashOf(19))).status).toBe(204);
    clock += 5 * MINUTE;
    expect((await registerCode(keys, nasId, clock + 10 * MINUTE, hashOf(20))).status).toBe(204);
  });

  it('frees a place under the cap when the NAS unregisters a code', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    for (let i = 0; i < 20; i++) expect((await registerCode(keys, nasId, clock + 3 * DAY, hashOf(i))).status).toBe(204);
    expect((await registerCode(keys, nasId, clock + 3 * DAY, hashOf(20))).status).toBe(429);
    expect((await unregisterCode(keys, nasId, hashOf(3))).status).toBe(204);
    expect((await registerCode(keys, nasId, clock + 3 * DAY, hashOf(20))).status).toBe(204);
  });

  it('unregisters a code signed by its NAS, idempotently', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    expect((await registerCode(keys, nasId)).status).toBe(204);
    expect((await unregisterCode(keys, nasId)).status).toBe(204);
    expect((await lookup(CODE)).status).toBe(404);
    expect(keys_('code:')).toEqual([]);
    expect((await unregisterCode(keys, nasId)).status).toBe(204);
  });

  it("won't let one NAS unregister another NAS's code", async () => {
    const a = await nasKey();
    const b = await nasKey();
    const nasA = await registerNas(a);
    const nasB = await registerNas(b);
    expect((await registerCode(a, nasA)).status).toBe(204);
    expect((await unregisterCode(b, nasB)).status).toBe(204);
    expect((await lookup(CODE)).status).toBe(200);
    // B's key over A's id: a bad signature
    expect((await unregisterCode(b, nasA)).status).toBe(401);
    expect((await lookup(CODE)).status).toBe(200);
  });

  it('refuses a registration signature replayed as an unregistration', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    const registration = await signedCode(keys, { nasId, codeHash: CODE_HASH, routes: ROUTES, expiresAt: clock + 10 * MINUTE });
    expect((await call('/codes', registration)).status).toBe(204);
    expect((await callDelete({ nasId, codeHash: CODE_HASH, signature: registration.signature })).status).toBe(401);
    expect((await callDelete(registration)).status).toBe(401);
    expect((await lookup(CODE)).status).toBe(200);
    expect((await callDelete({ nasId, codeHash: 'x' })).status).toBe(400);
  });

  it('expires a NAS 90 days after its last code, each code refreshing it', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    clock += 80 * DAY;
    expect((await registerCode(keys, nasId)).status).toBe(204);
    clock += 80 * DAY;
    expect((await registerCode(keys, nasId, clock + 10 * MINUTE, hashOf(1))).status).toBe(204);
    clock += 90 * DAY;
    await fireAlarm(storage, registry);
    expect(keys_('nas:')).toEqual([]);
    expect((await registerCode(keys, nasId, clock + 10 * MINUTE, hashOf(2))).status).toBe(401);
    expect(await registerNas(keys)).toBe(nasId);
    expect((await registerCode(keys, nasId, clock + 10 * MINUTE, hashOf(2))).status).toBe(204);
  });

  it('re-arms the alarm for the next expiry, page by page, and never moves an earlier alarm later', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    const start = clock;
    await registerCode(keys, nasId, start + 8 * MINUTE, hashOf(8));
    await registerCode(keys, nasId, start + 5 * MINUTE, hashOf(5));
    await registerCode(keys, nasId, start + 12 * MINUTE, hashOf(12));
    expect(storage.alarm).toBe(start + 5 * MINUTE);
    for (let i = 0; i < 600; i++) await storage.put(`code:${'f'.repeat(60)}${i.toString(16).padStart(4, '0')}`, { nasId, routes: {}, expiresAt: start + 1 });

    clock = start + 5 * MINUTE;
    await fireAlarm(storage, registry);
    expect(keys_('code:')).toEqual([`code:${hashOf(8)}`, `code:${hashOf(12)}`]);
    expect(storage.alarm).toBe(start + 8 * MINUTE);
    clock = start + 8 * MINUTE;
    await fireAlarm(storage, registry);
    expect(storage.alarm).toBe(start + 12 * MINUTE);
    clock = start + 12 * MINUTE;
    await fireAlarm(storage, registry);
    expect(keys_('code:')).toEqual([]);
    // What's left: the /nas and /codes rate logs, stale an hour after their last request.
    expect(storage.alarm).toBe(start + 60 * MINUTE);
  });

  it('deletes stale per-client logs and prunes the failed-lookup log in the alarm', async () => {
    await lookup('ZZZZ-ZZZZ-ZZZZ', '203.0.113.50');
    clock += 30_000;
    await lookup('ZZZZ-ZZZZ-ZZZZ', '203.0.113.51');
    expect(keys_('rate:')).toEqual(['rate:lookup:203.0.113.50', 'rate:lookup:203.0.113.51']);
    clock += 30_000;
    await fireAlarm(storage, registry);
    expect(keys_('rate:')).toEqual(['rate:lookup:203.0.113.51']);
    expect(storage.alarm).toBe(clock + 30_000);
    clock += 60 * MINUTE;
    await fireAlarm(storage, registry);
    expect(keys_('rate:')).toEqual([]);
    expect(keys_('global:')).toEqual([]);
  });

  it('refuses a body over 4 KiB with 413 before the registry sees it', async () => {
    const res = await call('/codes/lookup', { code: CODE, pad: 'x'.repeat(4096) });
    expect(res.status).toBe(413);
    expect(storage.data.size).toBe(0);
    expect((await call('/codes/lookup', { code: CODE, pad: 'x'.repeat(4000) })).status).toBe(404);
  });

  it('rejects a /nas key with a private part', async () => {
    const keys = await nasKey();
    const jwk = (await crypto.subtle.exportKey('jwk', keys.privateKey)) as JsonWebKey;
    expect((await call('/nas', { publicKeyJwk: jwk })).status).toBe(400);
  });

  it('rejects a captured POST /codes replayed after its code expired', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    const body = await signedCode(keys, { nasId, codeHash: CODE_HASH, routes: ROUTES, expiresAt: clock + 10 * MINUTE });
    expect((await call('/codes', body)).status).toBe(204);
    clock += 10 * MINUTE;
    await fireAlarm(storage, registry);
    expect((await call('/codes', body)).status).toBe(400);
    expect((await lookup(CODE)).status).toBe(404);
  });

  it('stores code hashes only, never codes', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    await registerCode(keys, nasId);
    await lookup('k7qm-4xp2-r9td');
    const dump = JSON.stringify([...storage.data]);
    expect(dump).toContain(CODE_HASH);
    expect(dump).not.toMatch(/K7QM-?4XP2-?R9TD/i);
  });

  it('rejects malformed requests with 400 and unknown routes with 404', async () => {
    expect((await call('/nas', { publicKeyJwk: { kty: 'EC', crv: 'P-384', x: 'a', y: 'b' } })).status).toBe(400);
    expect((await call('/codes', { nasId: 1 })).status).toBe(400);
    expect((await call('/codes/lookup', 'K7QM4XP2R9TD')).status).toBe(400);
    expect((await call('/elsewhere', {})).status).toBe(404);
    const get = await worker.fetch(new Request('https://rendezvous.example/codes/lookup'), env);
    expect(get.status).toBe(405);
    expect(get.headers.get('Allow')).toBe('POST, OPTIONS');
    const deleteLookup = await worker.fetch(new Request('https://rendezvous.example/codes/lookup', { method: 'DELETE' }), env);
    expect(deleteLookup.status).toBe(405);
    expect((await worker.fetch(new Request('https://rendezvous.example/codes', { method: 'PUT' }), env)).headers.get('Allow')).toBe('POST, DELETE, OPTIONS');
  });
});

describe('signalling routes', () => {
  const NAS_ID = 'N'.repeat(43);

  function upgrade(path: string, ip = '203.0.113.7', headers: Record<string, string> = { Upgrade: 'websocket' }): Promise<Response> {
    return worker.fetch(new Request(`https://rendezvous.example${path}`, { headers: { ...headers, 'CF-Connecting-IP': ip } }), env);
  }

  it('routes WebSocket upgrades on /signal/nas and /signal/device to the Signalling object of that NAS', async () => {
    const nas = await upgrade(`/signal/nas?nasId=${NAS_ID}`);
    expect(nas.headers.get('X-Signalling')).toBe('1');
    expect((await upgrade(`/signal/device?nasId=${NAS_ID}`, '203.0.113.8', { upgrade: 'WebSocket' })).headers.get('X-Signalling')).toBe('1');
    expect(signalled.map((s) => [s.name, new URL(s.request.url).pathname])).toEqual([
      [NAS_ID, '/signal/nas'],
      [NAS_ID, '/signal/device'],
    ]);
  });

  it('refuses a request that is not an upgrade with 426, and a malformed NAS id with 400', async () => {
    expect((await upgrade(`/signal/device?nasId=${NAS_ID}`, '203.0.113.7', {})).status).toBe(426);
    expect((await upgrade('/signal/device?nasId=short')).status).toBe(400);
    expect((await upgrade('/signal/device')).status).toBe(400);
    expect((await upgrade(`/signal/device?nasId=${'*'.repeat(43)}`)).status).toBe(400);
    const post = await worker.fetch(new Request(`https://rendezvous.example/signal/nas?nasId=${NAS_ID}`, { method: 'POST', headers: { Upgrade: 'websocket' } }), env);
    expect(post.status).toBe(405);
    expect(signalled).toEqual([]);
  });

  it('allows 10 connection attempts per minute per IP, across NAS ids and both roles', async () => {
    for (let i = 0; i < 10; i++) expect((await upgrade(`/signal/${i % 2 ? 'nas' : 'device'}?nasId=${String(i).repeat(43)}`)).status).toBe(200);
    expect((await upgrade(`/signal/device?nasId=${NAS_ID}`)).status).toBe(429);
    expect((await upgrade(`/signal/device?nasId=${NAS_ID}`, '198.51.100.3')).status).toBe(200);
    expect(signalled).toHaveLength(11);
    clock += MINUTE;
    expect((await upgrade(`/signal/device?nasId=${NAS_ID}`)).status).toBe(200);
  });

  it('never routes the registry\'s internal paths from outside', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    expect((await worker.fetch(new Request(`https://rendezvous.example/internal/nas-key?nasId=${nasId}`), env)).status).toBe(404);
    expect((await call('/internal/signal-attempt', {})).status).toBe(404);
    // The registry itself answers the key to the Signalling object.
    const res = await registry.fetch(new Request(`https://registry.internal/internal/nas-key?nasId=${nasId}`));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { publicKeyJwk: { kty: string } }).publicKeyJwk.kty).toBe('EC');
    expect((await registry.fetch(new Request(`https://registry.internal/internal/nas-key?nasId=${'Z'.repeat(43)}`))).status).toBe(404);
  });
});

describe('CORS', () => {
  it.each([APP, 'https://fix-x.bluray.pages.dev', 'http://localhost:5173', 'http://localhost:4173'])('allows %s', async (origin) => {
    const res = await call('/codes/lookup', { code: CODE }, { Origin: origin });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(res.headers.get('Vary')).toBe('Origin');
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
  });

  it.each(['https://evil.pages.dev', 'https://bluray.pages.dev.evil.com', 'https://evil-bluray.pages.dev', 'https://bluray-web.pages.dev'])('gives no Allow-Origin to %s', async (origin) => {
    const res = await call('/codes/lookup', { code: CODE }, { Origin: origin });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('answers a preflight for an app origin', async () => {
    const res = await worker.fetch(
      new Request('https://rendezvous.example/codes/lookup', {
        method: 'OPTIONS',
        headers: { Origin: APP, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
      }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('600');
  });
});

describe('NAS_IDS allowlist', () => {
  const upgrade = (path: string, ip = '203.0.113.7'): Promise<Response> =>
    worker.fetch(new Request(`https://rendezvous.example${path}`, { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': ip } }), env);
  const refusal = { error: 'nas-not-allowed' };

  it('with NAS_IDS unset any NAS registers', async () => {
    delete env.NAS_IDS;
    expect(await registerNas(await nasKey())).toMatch(/^[A-Za-z0-9_-]{43}$/);
    env.NAS_IDS = ' , ';
    expect(await registerNas(await nasKey())).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('with NAS_IDS set a NAS off the list gets 403 nas-not-allowed, without counting against the limits', async () => {
    env.NAS_IDS = 'L'.repeat(43);
    const { kty, crv, x, y } = (await crypto.subtle.exportKey('jwk', (await nasKey()).publicKey)) as JsonWebKey;
    for (let i = 0; i < 8; i++) {
      const res = await call('/nas', { publicKeyJwk: { kty, crv, x, y } });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(refusal);
    }
    expect(keys_('')).toEqual([]);
    // a malformed body is still a 400, listed or not
    expect((await call('/nas', { publicKeyJwk: 1 })).status).toBe(400);
    // the refused tries left this client's budget whole
    const keys = await nasKey();
    env.NAS_IDS = undefined;
    await registerNas(keys);
  });

  it('an allowed NAS keeps lookup, signalling and TURN', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    env.NAS_IDS = `${'L'.repeat(43)}, ${nasId}`;
    expect((await registerNas(keys))).toBe(nasId);
    expect((await registerCode(keys, nasId)).status).toBe(204);
    expect((await lookup(CODE)).status).toBe(200);
    expect((await upgrade(`/signal/nas?nasId=${nasId}`)).status).toBe(200);
    expect((await upgrade(`/signal/device?nasId=${nasId}`)).status).toBe(200);
  });

  it('a NAS registered before NAS_IDS was set is refused at lookup (404) and signalling (403) once it is set', async () => {
    const keys = await nasKey();
    const nasId = await registerNas(keys);
    expect((await registerCode(keys, nasId)).status).toBe(204);
    expect((await lookup(CODE)).status).toBe(200);
    env.NAS_IDS = 'L'.repeat(43);
    const res = await lookup(CODE);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown code' });
    for (const kind of ['nas', 'device']) {
      const refused = await upgrade(`/signal/${kind}?nasId=${nasId}`);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual(refusal);
    }
    expect(signalled).toEqual([]);
  });
});
