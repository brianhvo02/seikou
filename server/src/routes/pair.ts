import type { webcrypto } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { p256PublicJwk } from '../auth';
import type { Auth } from '../auth';
import { codeHash, unregisterCodes } from '../codes';
import type { CodeRegistrar } from '../codes';
import { HttpError, json, readJson, viaChannel } from '../http';
import type { Handler } from '../http';

type JsonWebKey = webcrypto.JsonWebKey;

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;
const MAX_DEVICE_NAME = 100;

/** A slot taken from a {@link FailureLimiter}: `fail()` keeps it as a failure, `release()` gives it back. Settles once. */
export interface Attempt {
  fail(): void;
  release(): void;
}

/**
 * Counts failures per key over a sliding window. An attempt holds a slot from admission until it settles,
 * so concurrent attempts can't all slip past the limit while their bodies are still being read.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly limit = MAX_FAILURES,
    private readonly windowMs = FAILURE_WINDOW_MS,
  ) {
    setInterval(() => this.prune(), windowMs).unref();
  }

  /** A slot for one attempt, or null when recent failures plus attempts in flight reach the limit. */
  admit(key: string): Attempt | null {
    if (this.recentFailures(key) + (this.pending.get(key) ?? 0) >= this.limit) return null;
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    let settled = false;
    const settle = (failed: boolean): void => {
      if (settled) return;
      settled = true;
      const left = (this.pending.get(key) ?? 1) - 1;
      if (left > 0) this.pending.set(key, left);
      else this.pending.delete(key);
      if (failed) this.failures.set(key, [...(this.failures.get(key) ?? []), this.now()]);
    };
    return { fail: () => settle(true), release: () => settle(false) };
  }

  /** Failures within the window, not counting attempts in flight. */
  recentFailures(key: string): number {
    const since = this.now() - this.windowMs;
    const recent = (this.failures.get(key) ?? []).filter((t) => t > since);
    if (recent.length === 0) this.failures.delete(key);
    else this.failures.set(key, recent);
    return recent.length;
  }

  /** Forgets keys whose failures have all left the window. */
  prune(): void {
    for (const key of [...this.failures.keys()]) this.recentFailures(key);
  }

  /** Keys still remembered, for tests. */
  get size(): number {
    return this.failures.size;
  }
}

/**
 * Whether a peer address is the reverse proxy: `proxy` is an IP or a hostname (Caddy's container name),
 * resolved once here. `null` (TRUSTED_PROXY unset or empty) and a name that doesn't resolve trust nobody.
 */
export async function trustedProxy(
  proxy: string | null,
  lookup: (host: string) => Promise<{ address: string }[]> = (host) => dnsLookup(host, { all: true }),
): Promise<(address: string) => boolean> {
  let addresses: string[];
  if (proxy === null) {
    addresses = [];
  } else if (isIP(proxy)) {
    addresses = [proxy];
  } else {
    try {
      addresses = (await lookup(proxy)).map((a) => a.address);
    } catch (err) {
      console.error(`TRUSTED_PROXY "${proxy}" does not resolve; ignoring X-Forwarded-For`, err);
      addresses = [];
    }
  }
  const trusted = new Set(addresses.map(unmapped));
  return (address) => trusted.has(unmapped(address));
}

const unmapped = (address: string): string => (address.startsWith('::ffff:') ? address.slice(7) : address);

/** The client's address: the first `X-Forwarded-For` entry when the peer is the trusted proxy, else the peer. */
export function clientAddress(req: IncomingMessage, trustProxy: (address: string) => boolean): string {
  const peer = req.socket.remoteAddress ?? '';
  if (!trustProxy(peer)) return peer;
  const first = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim();
  return first || peer;
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value === '') throw new HttpError(400, 'bad request');
  return value;
}

async function readObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJson(req);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'bad request');
  return body as Record<string, unknown>;
}

const unauthorized = () => json(401, { error: 'unauthorized' });

/**
 * `POST /api/pair/redeem {code, deviceName, publicKeyJwk}` (a device's P-256 public key; 200 `{deviceId, owner, personId,
 * personName}`), `POST /api/session/challenge {deviceId}` (200 `{challenge}`) and `POST /api/session {deviceId, challenge,
 * signature}` (200 the session): the only routes open to unpaired devices. A wrong code is 401 `invalid code`; after ten
 * failures from one client address in a minute (attempts in flight count too) the next is 429 `too many tries` with `Retry-After: 60`; a malformed body is
 * 400 `bad request`; an unknown device, challenge or signature is 401 `unauthorized`.
 */
export function pairRoutes(auth: Auth, opts: { now: () => number; trustProxy: (address: string) => boolean; registrar?: CodeRegistrar }): Handler {
  const limiter = new FailureLimiter(opts.now);
  return async (req, url) => {
    if (req.method !== 'POST') return null;
    switch (url.pathname) {
      case '/api/pair/redeem': {
        const client = clientAddress(req, opts.trustProxy);
        const tooMany = () => json(429, { error: 'too many tries' }, { 'Retry-After': String(FAILURE_WINDOW_MS / 1000) });
        const attempt = limiter.admit(client);
        if (!attempt) return tooMany();
        try {
          const body = await readObject(req);
          const code = str(body, 'code');
          const deviceName = str(body, 'deviceName').trim();
          if (deviceName === '' || deviceName.length > MAX_DEVICE_NAME || !p256PublicJwk(body.publicKeyJwk)) {
            throw new HttpError(400, 'bad request');
          }
          if (limiter.recentFailures(client) >= MAX_FAILURES) return tooMany();
          const device = auth.redeem(code, deviceName, body.publicKeyJwk as JsonWebKey);
          if (!device) {
            attempt.fail();
            return json(401, { error: 'invalid code' });
          }
          // the code is spent: free its place with the rendezvous service
          unregisterCodes(opts.registrar, [codeHash(code)]);
          return json(200, { deviceId: device.id, owner: device.owner, personId: device.personId, personName: device.personName });
        } finally {
          attempt.release();
        }
      }
      case '/api/session/challenge': {
        const challenge = auth.challenge(str(await readObject(req), 'deviceId'));
        return challenge ? json(200, { challenge }) : unauthorized();
      }
      case '/api/session': {
        const body = await readObject(req);
        const deviceId = str(body, 'deviceId');
        const session = auth.startSession(deviceId, str(body, 'challenge'), str(body, 'signature'));
        if (!session) return unauthorized();
        // a data channel's session is noted by the rtc layer, which knows whether it is relayed
        if (!viaChannel(req)) auth.noteRoute(deviceId, 'https');
        return json(200, session);
      }
      default:
        return null;
    }
  };
}
