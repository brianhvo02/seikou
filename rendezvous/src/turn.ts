/**
 * `POST /turn`: TURN credentials for the Cloudflare relay (see `docs/superpowers/specs/2026-10-18-webrtc-people-design.md`), minted only at a NAS's signed request. The
 * Worker knows nothing about devices; the NAS checks the device and its own relay switch before it asks. The
 * Cloudflare TURN key id and API token are Worker secrets (`wrangler secret put TURN_KEY_ID` and
 * `TURN_KEY_API_TOKEN`), never in the repo, and never in a response or a log line.
 *
 * Anyone can register a key (`POST /nas`), so a signature alone proves nothing about who pays: the Worker mints only
 * for the NAS ids in the secret `TURN_NAS_IDS` (comma-separated; `node server.mjs nas-id` on the NAS prints its id),
 * and for nobody while it is unset or empty. Each NAS may mint 30 times an hour and all of them 500 times a day
 * (counted by the registry, `INTERNAL.turnAttempt`).
 *
 * Cloudflare's endpoint, as its docs describe it (checked 2026-10-19,
 * developers.cloudflare.com/realtime/turn/generate-credentials/): `POST
 * https://rtc.live.cloudflare.com/v1/turn/keys/<key id>/credentials/generate-ice-servers` with
 * `Authorization: Bearer <API token>` and `{"ttl": <seconds>}`, answering 201 with `{"iceServers": [...]}`.
 */
import type { EcPublicJwk } from '@seikou/nas/nas-api';
import { boundedBody } from './body';
import { INTERNAL, REGISTRY_NAME, json } from './code-registry';
import type { RegistryNamespace } from './index';
import { ECDSA_KEY, ECDSA_SIGN, TURN_MAX_SKEW_MS, TURN_TTL_SECONDS, fromBase64url, iceServersOf, isNasId, turnRequestMessage } from './protocol';

/** The base of Cloudflare's TURN key API; the key id and `/credentials/generate-ice-servers` follow it. */
export const CLOUDFLARE_TURN_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys';

/** The bindings and secrets `turnRoute` reads. */
export interface TurnEnv {
  CODE_REGISTRY: RegistryNamespace;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** The NAS ids allowed to mint, comma-separated. */
  TURN_NAS_IDS?: string;
  /** The Worker-wide allowlist (`nasIdAllowlist`); a NAS off it gets no credentials either. */
  NAS_IDS?: string;
}

/** `turnRoute`'s side effects, replaced in tests. */
export interface TurnDeps {
  fetch: typeof fetch;
  now: () => number;
}

const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * The NAS ids of a comma-separated allowlist (`NAS_IDS`): a set, or null when it is unset or has no ids, meaning
 * the Worker is open to every NAS (a self-hoster's own Worker).
 */
export function nasIdAllowlist(raw: string | undefined): ReadonlySet<string> | null {
  const ids = new Set((raw ?? '').split(',').map((id) => id.trim()).filter((id) => id !== ''));
  return ids.size === 0 ? null : ids;
}

/** The NAS ids on the `TURN_NAS_IDS` allowlist. */
export function turnNasIds(value: string | undefined): ReadonlySet<string> {
  return nasIdAllowlist(value) ?? new Set();
}

/**
 * `POST /turn {nasId, ts, signature}` → 200 `{iceServers}`. Only a NAS may call it, proving itself by a signature with
 * its registered key (`turnRequestMessage`); the Worker never sees a device. Refusals: 400 for a malformed body, 503
 * `turn-not-configured` without the key secrets or while `TURN_NAS_IDS` is empty, 401 `unauthorized` for a `ts` more than
 * `TURN_MAX_SKEW_MS` from the Worker's clock, an unknown or expired NAS or a bad signature, 403 `turn-not-allowed` for a
 * NAS not in `TURN_NAS_IDS` and 403 `nas-not-allowed` for one not in `NAS_IDS`, 429 `turn-rate-limited` past the hourly
 * per-NAS or daily Worker-wide limit (`scope` says which), 502 `turn-upstream` when Cloudflare fails or answers
 * something unusable.
 */
export async function turnRoute(request: Request, env: TurnEnv, deps: TurnDeps): Promise<Response> {
  if (request.method !== 'POST') {
    const response = json(405, { error: 'method not allowed' });
    response.headers.set('Allow', 'POST');
    return response;
  }
  const keyId = env.TURN_KEY_ID;
  const token = env.TURN_KEY_API_TOKEN;
  const allowed = turnNasIds(env.TURN_NAS_IDS);
  if (!keyId || !token || allowed.size === 0) {
    await request.body?.cancel();
    return json(503, { error: 'turn-not-configured' });
  }
  const body = await jsonBody(request);
  if (body === null) return json(400, { error: 'bad request' });
  const { nasId, ts, signature } = body;
  if (!isNasId(nasId) || typeof ts !== 'number' || !Number.isSafeInteger(ts) || typeof signature !== 'string') return json(400, { error: 'bad request' });
  if (Math.abs(deps.now() - ts) > TURN_MAX_SKEW_MS) return json(401, { error: 'unauthorized' });
  if (!allowed.has(nasId)) return json(403, { error: 'turn-not-allowed' });
  if (!nasAllowed(env.NAS_IDS, nasId)) return json(403, { error: 'nas-not-allowed' });
  if (!(await verifiedByNas(env.CODE_REGISTRY, nasId, ts, signature))) return json(401, { error: 'unauthorized' });
  const attempt = await counted(env.CODE_REGISTRY, nasId);
  if (attempt !== null) return attempt;

  let iceServers: unknown;
  try {
    const res = await deps.fetch(`${CLOUDFLARE_TURN_BASE}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return json(502, { error: 'turn-upstream', status: res.status });
    }
    iceServers = ((await res.json()) as { iceServers?: unknown }).iceServers;
  } catch {
    return json(502, { error: 'turn-upstream' });
  }
  const servers = iceServersOf(iceServers);
  if (servers === null) return json(502, { error: 'turn-upstream' });
  return json(200, { iceServers: servers });
}

/** Whether `NAS_IDS` lets `nasId` use this Worker: always while it is unset. */
export function nasAllowed(raw: string | undefined, nasId: string): boolean {
  const list = nasIdAllowlist(raw);
  return list === null || list.has(nasId);
}

/** The body as a JSON object of at most `MAX_BODY_BYTES` (`boundedBody`), or null. */
async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const bytes = await boundedBody(request).catch(() => null);
  if (bytes === null) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Counts one minting for `nasId` with the registry: null when it may go ahead, else the registry's 429. */
async function counted(registry: RegistryNamespace, nasId: string): Promise<Response | null> {
  const res = await registry
    .get(registry.idFromName(REGISTRY_NAME))
    .fetch(new Request(`https://registry.internal${INTERNAL.turnAttempt}?nasId=${encodeURIComponent(nasId)}`, { method: 'POST' }));
  if (res.status === 204) return null;
  const body = res.status === 429 ? ((await res.json()) as unknown) : (await res.body?.cancel(), { error: 'turn-rate-limited' });
  return json(429, body);
}

/** Whether a live NAS's registered key made `signature` over `turnRequestMessage({ nasId, ts })`. */
async function verifiedByNas(registry: RegistryNamespace, nasId: string, ts: number, signature: string): Promise<boolean> {
  const sig = fromBase64url(signature);
  if (sig === null || sig.length !== 64) return false;
  const res = await registry
    .get(registry.idFromName(REGISTRY_NAME))
    .fetch(new Request(`https://registry.internal${INTERNAL.nasKey}?nasId=${encodeURIComponent(nasId)}`));
  if (res.status !== 200) {
    await res.body?.cancel();
    return false;
  }
  const { publicKeyJwk } = (await res.json()) as { publicKeyJwk: EcPublicJwk };
  try {
    const key = await crypto.subtle.importKey('jwk', publicKeyJwk, ECDSA_KEY, false, ['verify']);
    return await crypto.subtle.verify(ECDSA_SIGN, key, sig, turnRequestMessage({ nasId, ts }));
  } catch {
    return false;
  }
}
