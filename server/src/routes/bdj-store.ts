import type { IncomingMessage } from 'node:http';
import { LockHeldError } from '@seikou/titles/atomic-json';
import type { Auth } from '../auth';
import { parseScope, StoreError } from '../bdj-store';
import type { BdjStore } from '../bdj-store';
import { json, readBody } from '../http';
import type { Handler, Response } from '../http';
import { requestDevice } from './titles';

const PREFIX = '/api/bdj-store/';
/** The request body was not read to its end, so the connection can't carry another request. */
const CLOSE = { Connection: 'close' };

const quota = (limit: 'scope' | 'person', headers: Record<string, string> = {}): Response => json(507, { error: 'quota', limit }, headers);
const precondition = (): Response => json(412, { error: 'precondition-failed' });
const personChanged = (headers: Record<string, string> = {}): Response => json(409, { error: 'person-changed' }, headers);

/**
 * `X-Bdj-Person`: the person the client means to write for. Null when absent (no check). A device moved to another
 * person between the client's `GET me` and its write is refused instead of landing one person's saves in another's.
 */
function expectedPerson(req: IncomingMessage): string | null {
  const raw = req.headers['x-bdj-person'];
  return typeof raw === 'string' ? raw.trim() : null;
}

/** `If-Match`: `*`, or one quoted etag (its bare value); null when absent; undefined when malformed. */
function ifMatch(req: IncomingMessage): string | null | undefined {
  const raw = req.headers['if-match']?.trim();
  if (raw === undefined) return null;
  if (raw === '*') return '*';
  const m = /^"([^"]+)"$/.exec(raw);
  return m ? m[1]! : undefined;
}

/** A StoreError as its answer (spec §5); anything else is rethrown. */
function storeFailure(err: unknown): Response {
  if (err instanceof StoreError) {
    switch (err.code) {
      case 'precondition':
        return precondition();
      case 'quota-scope':
        return quota('scope');
      case 'quota-person':
        return quota('person');
      case 'bad-archive':
        return json(400, { error: 'bad-archive' });
    }
  }
  // another writer of the scope held its lock for the whole wait
  if (err instanceof LockHeldError) return json(503, { error: 'busy' }, { 'Retry-After': '1' });
  throw err;
}

/**
 * `GET`, `PUT` and `DELETE /api/bdj-store/<scope>` (spec §5): the token's own person's BD-J saved data, one ustar
 * snapshot per scope, under quoted ETags. Behind `requireToken`; the token may come as `Authorization: Bearer` or `t=`.
 */
export function bdjStoreRoutes(auth: Auth, store: BdjStore): Handler {
  return async (req, url) => {
    const path = url.pathname;
    if (path !== PREFIX.slice(0, -1) && !path.startsWith(PREFIX)) return null;
    const method = req.method;
    if (method !== 'GET' && method !== 'PUT' && method !== 'DELETE') return json(405, { error: 'method not allowed' }, { Allow: 'GET, PUT, DELETE' });
    const device = requestDevice(auth, req.headers.authorization, url);
    if (!device) return json(401, { error: 'unauthorized' });
    const scope = parseScope(path.slice(PREFIX.length));
    if (scope === null) return json(400, { error: 'bad-scope' }, method === 'PUT' ? CLOSE : {});
    const person = device.personId;
    const expected = method === 'GET' ? null : expectedPerson(req);
    if (expected !== null && expected !== person) return personChanged(method === 'PUT' ? CLOSE : {});

    if (method === 'GET') {
      const { etag, body } = store.get(person, scope);
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/x-tar',
          'Content-Length': String(body.length),
          'Cache-Control': 'no-store',
          ...(etag === null ? {} : { ETag: `"${etag}"` }),
        },
        body,
      };
    }

    const match = ifMatch(req);
    if (match === undefined) return json(400, { error: 'bad-if-match' }, method === 'PUT' ? CLOSE : {});
    // `If-Match: *` stands for whatever snapshot is there; with none, it fails
    const resolve = (m: string): string | null => (m === '*' ? store.get(person, scope).etag : m);

    if (method === 'DELETE') {
      if (match === null) return json(428, { error: 'precondition-required' });
      const etag = resolve(match);
      if (etag === null) return precondition();
      try {
        store.delete(person, scope, etag);
      } catch (err) {
        return storeFailure(err);
      }
      return { status: 204 };
    }

    const noneMatch = req.headers['if-none-match']?.trim() === '*';
    if (match === null && !noneMatch) return json(428, { error: 'precondition-required' }, CLOSE);
    const body = await readBody(req, store.scopeLimit);
    if (body === null) return quota('scope', CLOSE);
    // the device may have moved while the body arrived: from here to the write nothing yields
    if (expected !== null && requestDevice(auth, req.headers.authorization, url)?.personId !== expected) return personChanged();
    let cond: { ifMatch?: string; ifNoneMatch?: boolean };
    if (match !== null) {
      const etag = resolve(match);
      if (etag === null) return precondition();
      cond = { ifMatch: etag };
    } else {
      cond = { ifNoneMatch: true };
    }
    try {
      const { etag } = store.put(person, scope, body, cond);
      return { status: 200, headers: { ETag: `"${etag}"` } };
    } catch (err) {
      return storeFailure(err);
    }
  };
}
