// SPDX-License-Identifier: LGPL-3.0-or-later
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { readBody } from '../../../server/src/http';
import { hostOf, jsonPost, NasClient, NasError } from '../nas/client';
import { nasLibraryOf } from '../nas/nas-library';
import { removeNasPairing } from '../nas/nas-store';
import { pairWithNas, type PairingInput } from '../nas/pairing';
import { httpError, json, type AppContext, type RouteTable } from './http';

// The page's view of the NAS pairing: whether the encoder is paired, with whom, and whether the NAS answers; pairing
// with a code or link, and unpairing. No answer carries the device key or a session token.

const MAX_BODY = 16 * 1024;
/** How long the status waits for the NAS's `me` and `encodes/status`. */
const STATUS_TIMEOUT_MS = 5_000;
/** The NAS refuses a device name over 100 characters. */
const MAX_DEVICE_NAME = 100;
/** How long a title lookup may take: the NAS gives up on a source after 10 s. */
const LOOKUP_TIMEOUT_MS = 15_000;
/** The NAS refuses an own title's name over 200 characters. */
const MAX_TITLE_NAME = 200;

/** Whether the NAS keeps encodes: its `ENCODES_DIR` is set (`ready`), not set, or unknown (the NAS did not answer). */
export type NasEncodesState = 'ready' | 'not-configured' | 'unknown';

/** What `GET /api/nas` answers. */
export type NasStatus =
  | { readonly paired: false }
  | {
      readonly paired: true;
      readonly host: string;
      readonly personName: string;
      readonly reachable: boolean;
      readonly encodes: NasEncodesState;
    };

/** The name the encoder pairs as, which Seikou's admin screen lists: `Seikou encoder on <host name>`. */
export function encoderDeviceName(host = hostname()): string {
  return `Seikou encoder on ${host}`.slice(0, MAX_DEVICE_NAME);
}

/** The status of `client`, asking the NAS now (`me` and `encodes/status`, 5 s at most). */
export async function nasStatus(client: NasClient | null): Promise<NasStatus> {
  if (client === null) return { paired: false };
  const signal = AbortSignal.timeout(STATUS_TIMEOUT_MS);
  const [me, encodes] = await Promise.all([
    client.me({ signal }).catch(() => null),
    client.request('encodes/status', { signal }).then(
      async (res): Promise<NasEncodesState> => {
        if (res.status === 404) {
          await res.body?.cancel();
          return 'not-configured';
        }
        if (!res.ok) {
          await res.body?.cancel();
          return 'unknown';
        }
        const body = (await res.json()) as { configured?: unknown };
        return body.configured === false ? 'not-configured' : 'ready';
      },
    ).catch((): NasEncodesState => 'unknown'),
  ]);
  return { paired: true, host: hostOf(client.base), personName: me?.personName ?? client.personName, reachable: me !== null, encodes: me === null ? 'unknown' : encodes };
}

/** The pairing input of a request body, or null when it is not `{ code, base }` or `{ link }` of strings. */
function inputOf(body: unknown): PairingInput | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { code, base, link } = body as Record<string, unknown>;
  if (typeof link === 'string') return { link };
  if (typeof code === 'string' && typeof base === 'string') return { code, base };
  return null;
}

/** Answers a failed pairing: `bad-address` 400, the NAS refusing the code `bad-code` 400, `not-owner` 409, `unreachable` 502. */
function pairingError(res: ServerResponse, err: unknown): void {
  if (!(err instanceof NasError)) throw err;
  switch (err.code) {
    case 'bad-address':
      return httpError(res, 400, 'bad-address', err.message);
    case 'not-owner':
      return httpError(res, 409, 'not-owner', err.message);
    case 'http':
      if (err.status === 400 || err.status === 401 || err.status === 404) return httpError(res, 400, 'bad-code', err.message);
      if (err.status === 429) return httpError(res, 429, 'too-many-tries', err.message);
      return httpError(res, 502, 'unreachable', err.message);
    default:
      return httpError(res, 502, 'unreachable', err.message);
  }
}

async function pair(req: IncomingMessage, res: ServerResponse, app: AppContext): Promise<void> {
  const bytes = await readBody(req, MAX_BODY);
  if (bytes === null) {
    res.setHeader('Connection', 'close');
    return httpError(res, 413, 'too-large', 'That request is too large.');
  }
  let input: PairingInput | null = null;
  try {
    input = inputOf(JSON.parse(bytes.toString('utf8')));
  } catch {
    // not JSON
  }
  if (input === null) return httpError(res, 400, 'bad-request', 'The body must be { code, base } or { link }.');
  let client: NasClient | null;
  try {
    client = await serially(app, async () => {
      await pairWithNas(app.dataDir, input, encoderDeviceName());
      return replaceClient(app, await NasClient.load(app.dataDir));
    });
  } catch (err) {
    return pairingError(res, err);
  }
  // the newly paired NAS's discs, for the Library
  void nasLibraryOf(app).scan();
  json(res, 200, await nasStatus(client));
}

/** The pairing change running or last run, per app: pairing and unpairing run one after the other, never interleaved. */
const changes = new WeakMap<AppContext, Promise<unknown>>();

/** Runs `change` after the app's earlier pairing changes have settled. */
function serially<T>(app: AppContext, change: () => Promise<T>): Promise<T> {
  const run = (changes.get(app) ?? Promise.resolve()).then(change, change);
  changes.set(app, run.catch(() => {}));
  return run;
}

/** Installs `client` (or none), closing the one it replaces so a job still holding it stops. */
function replaceClient(app: AppContext, client: NasClient | null): NasClient | null {
  if (app.nas.client !== client) {
    app.nas.client?.close();
    nasLibraryOf(app).forget();
  }
  app.nas.client = client;
  return client;
}

/** The longest search text the NAS accepts. */
const MAX_QUERY = 200;
const SOURCES = ['anilist', 'tmdb', 'own'] as const;
const KINDS = ['series', 'movie'] as const;
/** The most seasons the NAS accepts for an own series. */
const MAX_SEASONS = 1000;

/**
 * Answers a failed NAS call: no client or a NAS that forgot this device `nas-not-paired` 409, a NAS that is not an
 * owner's `not-owner` 409, the NAS's own 429 and 503 as they are (with their `Retry-After`), no answer `unreachable` 502,
 * anything else `nas-error` 502.
 */
function nasCallError(res: ServerResponse, err: unknown): void {
  if (!(err instanceof NasError)) throw err;
  if (err.code === 'unauthorized') return httpError(res, 409, 'nas-not-paired', 'The NAS no longer knows this app. Pair it again in Settings.');
  if (err.code === 'http' && err.status === 403) return httpError(res, 409, 'not-owner', 'This app is not an owner device of the NAS.');
  if (err.code === 'http' && (err.status === 429 || err.status === 503)) {
    if (err.retryAfter !== null) res.setHeader('Retry-After', err.retryAfter);
    return httpError(res, err.status, err.error ?? (err.status === 429 ? 'too-many-lookups' : 'source-unreachable'), err.message);
  }
  if (err.code === 'unreachable') return httpError(res, 502, 'unreachable', err.message);
  return httpError(res, 502, 'nas-error', err.message);
}

function pairedClient(res: ServerResponse, app: AppContext): NasClient | null {
  if (app.nas.client !== null) return app.nas.client;
  httpError(res, 409, 'nas-not-paired', 'This app is not paired with a NAS. Pair it in Settings first.');
  return null;
}

/** Thrown into a queued lookup whose caller went away before its turn. */
class Dropped extends Error {}

/** The lookups waiting for or running on a client: the NAS allows one in flight per device, so they run one after the other. */
const lookupLine = new WeakMap<NasClient, Promise<unknown>>();
/** Without a `Retry-After`, how long to wait before the one retry after `lookup-busy`. */
const BUSY_WAIT_MS = 500;
/** The longest `Retry-After` the retry honours. */
const BUSY_WAIT_MAX_MS = 5_000;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Runs `admin/lookup` for `query` behind the lookups already waiting on `client` (first come, first served), so this
 * app never has two in flight. A lookup whose `gone` signal aborts before its turn is dropped unsent, so a search the
 * page gave up on spends none of the NAS's 20 a minute. After `lookup-busy` (another client of this device may be mid
 * lookup) it tries once more, after the `Retry-After` when there is one, else 500 ms.
 */
function queuedLookup(client: NasClient, query: string, gone: AbortSignal): Promise<{ titles: unknown }> {
  const send = (): Promise<{ titles: unknown }> => client.json<{ titles: unknown }>(`admin/lookup?${query}`, { signal: AbortSignal.any([gone, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]) });
  const turn = async (): Promise<{ titles: unknown }> => {
    if (gone.aborted) throw new Dropped();
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof NasError) || err.status !== 429 || err.error !== 'lookup-busy') throw err;
      const seconds = Number(err.retryAfter);
      await sleep(Number.isFinite(seconds) && err.retryAfter !== null ? Math.min(seconds * 1000, BUSY_WAIT_MAX_MS) : BUSY_WAIT_MS, gone);
      if (gone.aborted) throw new Dropped();
      return send();
    }
  };
  const run = (lookupLine.get(client) ?? Promise.resolve()).then(turn, turn);
  lookupLine.set(client, run.catch(() => {}));
  return run;
}

/** `GET /api/nas/lookup?q=&source=`: the NAS's `admin/lookup`, one at a time. */
async function lookup(req: IncomingMessage, res: ServerResponse, app: AppContext): Promise<void> {
  const client = pairedClient(res, app);
  if (client === null) return;
  const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const q = params.get('q')?.trim() ?? '';
  const source = SOURCES.find((s) => s === params.get('source'));
  if (q === '' || q.length > MAX_QUERY || source === undefined) return httpError(res, 400, 'bad-request', 'Give q (1 to 200 characters) and source (anilist, tmdb or own).');
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) gone.abort();
  });
  try {
    const answer = await queuedLookup(client, new URLSearchParams({ q, source }).toString(), gone.signal);
    json(res, 200, { titles: Array.isArray(answer.titles) ? answer.titles : [] });
  } catch (err) {
    if (err instanceof Dropped || gone.signal.aborted) return;
    nasCallError(res, err);
  }
}

/** `POST /api/nas/own-titles`: the NAS's `admin/titles`, for a title no source has. */
async function createOwnTitle(req: IncomingMessage, res: ServerResponse, app: AppContext): Promise<void> {
  const client = pairedClient(res, app);
  if (client === null) return;
  const bytes = await readBody(req, MAX_BODY);
  if (bytes === null) {
    res.setHeader('Connection', 'close');
    return httpError(res, 413, 'too-large', 'That request is too large.');
  }
  let body: unknown = null;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    // not JSON
  }
  const { kind, name, seasons } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const k = KINDS.find((x) => x === kind);
  const n = typeof name === 'string' ? name.trim() : '';
  const count = seasons ?? null;
  const countOk = count === null || (typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= MAX_SEASONS);
  if (k === undefined || n === '' || n.length > MAX_TITLE_NAME || !countOk || (k === 'movie' && count !== null)) {
    return httpError(res, 400, 'bad-request', 'Give kind (series or movie), a name and, for a series, its number of seasons.');
  }
  try {
    json(res, 200, await client.json('admin/titles', jsonPost({ kind: k, name: n, seasons: count }, AbortSignal.timeout(LOOKUP_TIMEOUT_MS))));
  } catch (err) {
    nasCallError(res, err);
  }
}

/**
 * The NAS routes:
 *
 *   GET    /api/nas        `{ paired: false }`, or `{ paired: true, host, personName, reachable, encodes }`
 *   POST   /api/nas/pair   body `{ code, base }` or `{ link }`; the same answer, or 400 `bad-address`, `bad-code` or
 *                          `bad-request`, 409 `not-owner`, 429 `too-many-tries`, 502 `unreachable`, 413 `too-large`
 *   DELETE /api/nas        `{ paired: false }`: forgets the pairing here (the NAS still lists the device)
 *   GET    /api/nas/lookup?q=&source=anilist|tmdb|own   `{ titles: TitleSummary[] }`, the NAS's `admin/lookup`; 400 `bad-request`,
 *                          409 `nas-not-paired` or `not-owner`, 429 and 503 (`source-unreachable`) as the NAS answered, 502 `unreachable`
 *   POST   /api/nas/own-titles   body `{ kind: 'series' | 'movie', name, seasons }`; the NAS's `OwnTitle` (`admin/titles`); the same errors
 */
export const nasRoutes: RouteTable = [
  ['GET', /^\/api\/nas$/, async (_req, res, _m, app) => json(res, 200, await nasStatus(app.nas.client))],
  ['POST', /^\/api\/nas\/pair$/, (req, res, _m, app) => pair(req, res, app)],
  ['GET', /^\/api\/nas\/lookup$/, (req, res, _m, app) => lookup(req, res, app)],
  ['POST', /^\/api\/nas\/own-titles$/, (req, res, _m, app) => createOwnTitle(req, res, app)],
  [
    'DELETE',
    /^\/api\/nas$/,
    async (_req, res, _m, app) => {
      await serially(app, async () => {
        await removeNasPairing(app.dataDir);
        replaceClient(app, null);
      });
      json(res, 200, { paired: false });
    },
  ],
];
