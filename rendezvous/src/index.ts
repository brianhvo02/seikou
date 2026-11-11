/**
 * `bluray-rendezvous`, the Worker: turns a pairing code into "this NAS and how to reach it".
 * The NAS registers its key (`POST /nas`) and signed code hashes (`POST /codes`, server to server), and unregisters
 * a code it no longer needs (`DELETE /codes`, signed);
 * the app looks a typed code up (`POST /codes/lookup`, CORS for the app's origins).
 * WebRTC signalling: the NAS (`GET /signal/nas?nasId=`) and devices (`GET /signal/device?nasId=`) open WebSockets
 * to that NAS's `Signalling` object, after a per-client attempt limit the registry keeps.
 * The relay: the NAS asks for TURN credentials (`POST /turn`, signed, server to server; `turn.ts`).
 */
import { PREFLIGHT_MAX_AGE, corsHeaders } from '@seikou/nas/cors-policy';
import { boundedBody } from './body';
import { INTERNAL, REGISTRY_NAME, json } from './code-registry';
import { isNasId, nasIdOf } from './protocol';
import { nasAllowed, turnRoute } from './turn';

export { CodeRegistry } from './code-registry';
export { Signalling } from './signalling';

/** The part of `DurableObjectNamespace` the Worker uses. */
export interface RegistryNamespace {
  idFromName(name: string): object;
  get(id: object): { fetch(request: Request): Promise<Response> };
}

/** The Worker's bindings and secrets, as Cloudflare passes them to `fetch`. */
export interface Env {
  CODE_REGISTRY: RegistryNamespace;
  SIGNALLING: RegistryNamespace;
  /** Worker secrets for the Cloudflare relay; `POST /turn` answers 503 without them. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** The NAS ids `POST /turn` mints for, comma-separated (a Worker secret); unset or empty, it mints for none. */
  TURN_NAS_IDS?: string;
  /**
   * The NAS ids this Worker serves, comma-separated (a Worker secret). Unset or empty, it is open to any NAS, as a
   * self-hoster's own Worker is; set, `POST /nas`, lookup, signalling and `/turn` refuse every other NAS.
   */
  NAS_IDS?: string;
}

const NOT_ALLOWED = { error: 'nas-not-allowed' };

const ROUTES = new Set(['/nas', '/codes', '/codes/lookup']);
const SIGNAL_ROUTES = new Set(['/signal/nas', '/signal/device']);

const PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Methods': 'POST',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': PREFLIGHT_MAX_AGE,
};

async function route(request: Request, env: Env): Promise<Response> {
  if (!ROUTES.has(new URL(request.url).pathname)) return json(404, { error: 'not found' });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
  const path = new URL(request.url).pathname;
  // DELETE /codes is the NAS unregistering a code, server to server (no CORS preflight allows it)
  if (request.method !== 'POST' && !(request.method === 'DELETE' && path === '/codes')) {
    const response = json(405, { error: 'method not allowed' });
    response.headers.set('Allow', path === '/codes' ? 'POST, DELETE, OPTIONS' : 'POST, OPTIONS');
    return response;
  }
  const body = await boundedBody(request);
  if (body === null) return json(413, { error: 'body too large' });
  const headers = new Headers(request.headers);
  headers.delete('Content-Length');
  // Refused before the registry sees the request, so it counts against no limit and stores nothing.
  if (path === '/nas' && env.NAS_IDS !== undefined && !(await nasRegistrationAllowed(body, env.NAS_IDS))) return json(403, NOT_ALLOWED);
  const registry = env.CODE_REGISTRY;
  const answer = await registry.get(registry.idFromName(REGISTRY_NAME)).fetch(new Request(request.url, { method: request.method, headers, body }));
  if (path === '/codes/lookup' && env.NAS_IDS !== undefined && answer.status === 200) {
    // A code of a NAS off the list reads as an unknown one (a NAS registered before the list was set).
    const found = (await answer.clone().json().catch(() => null)) as { nasId?: unknown } | null;
    if (typeof found?.nasId === 'string' && !nasAllowed(env.NAS_IDS, found.nasId)) {
      await answer.body?.cancel();
      return json(404, { error: 'unknown code' });
    }
  }
  return answer;
}

/**
 * Whether the key in a `POST /nas` body has an id on the list. A body that doesn't hold a key goes on to the
 * registry, which answers 400.
 */
async function nasRegistrationAllowed(body: Uint8Array | ArrayBuffer | null, raw: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array())) as { publicKeyJwk?: { kty?: string; crv?: string; x?: string; y?: string } };
    const jwk = parsed.publicKeyJwk;
    if (typeof jwk?.kty !== 'string' || typeof jwk.crv !== 'string' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return true;
    return nasAllowed(raw, await nasIdOf({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } as Parameters<typeof nasIdOf>[0]));
  } catch {
    return true;
  }
}

/**
 * A signalling WebSocket upgrade: checked, counted against the client's attempts, then handed to the NAS's
 * Signalling object. Its 101 response goes back as it is (copying it would drop the socket).
 */
async function signal(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') {
    const response = json(405, { error: 'method not allowed' });
    response.headers.set('Allow', 'GET');
    return response;
  }
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json(426, { error: 'expected a WebSocket upgrade' });
  const nasId = new URL(request.url).searchParams.get('nasId');
  if (!isNasId(nasId)) return json(400, { error: 'bad request' });
  if (!nasAllowed(env.NAS_IDS, nasId)) return json(403, NOT_ALLOWED);
  const registry = env.CODE_REGISTRY;
  const attempt = await registry.get(registry.idFromName(REGISTRY_NAME)).fetch(
    new Request(`https://registry.internal${INTERNAL.signalAttempt}`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') ?? '' },
    }),
  );
  await attempt.body?.cancel();
  if (attempt.status !== 204) return json(429, { error: 'too many requests' });
  const signalling = env.SIGNALLING;
  return signalling.get(signalling.idFromName(nasId)).fetch(request);
}

/** The Worker's entry point: routes by path and adds CORS to every answer but a signalling upgrade and `/turn`. */
export default {
  /**
   * Routes: `POST /nas`, `POST /codes`, `DELETE /codes` and `POST /codes/lookup` (to the registry; 404 for another
   * path, 405 for another method, 413 for a body over `MAX_BODY_BYTES`, 403 `nas-not-allowed` on `POST /nas` for a
   * key whose NAS id is off `NAS_IDS`, and 404 `unknown code` from the lookup for a code of such a NAS); `GET /signal/nas` and `GET /signal/device` (WebSocket upgrades: 426 without the upgrade header, 400
   * for a bad `nasId`, 403 `nas-not-allowed`, 429 past the per-address attempt limit); `POST /turn` (see `turnRoute`).
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (SIGNAL_ROUTES.has(path)) return signal(request, env);
    if (path === '/turn') return turnRoute(request, env, { fetch: (input, init) => fetch(input, init), now: Date.now });
    const answer = await route(request, env);
    // A Durable Object's response has immutable headers; copy it to add CORS.
    const response = new Response(answer.body, answer);
    for (const [name, value] of Object.entries(corsHeaders(request.headers.get('Origin')))) response.headers.set(name, value);
    return response;
  },
};
