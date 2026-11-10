// SPDX-License-Identifier: LGPL-3.0-or-later
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { readBody } from '../../../server/src/http';
import { hostOf, NasClient, NasError } from '../nas/client';
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

/**
 * The NAS routes:
 *
 *   GET    /api/nas        `{ paired: false }`, or `{ paired: true, host, personName, reachable, encodes }`
 *   POST   /api/nas/pair   body `{ code, base }` or `{ link }`; the same answer, or 400 `bad-address`, `bad-code` or
 *                          `bad-request`, 409 `not-owner`, 429 `too-many-tries`, 502 `unreachable`, 413 `too-large`
 *   DELETE /api/nas        `{ paired: false }`: forgets the pairing here (the NAS still lists the device)
 */
export const nasRoutes: RouteTable = [
  ['GET', /^\/api\/nas$/, async (_req, res, _m, app) => json(res, 200, await nasStatus(app.nas.client))],
  ['POST', /^\/api\/nas\/pair$/, (req, res, _m, app) => pair(req, res, app)],
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
