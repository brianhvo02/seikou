import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TURN_MAX_SKEW_MS, turnProofMessage } from '../../../rendezvous/src/protocol';
import type { IceServerInfo, TurnRefusal } from '../../../rendezvous/src/protocol';
import { isCode, replaceAtomically } from '@seikou/titles/atomic-json';
import type { Auth } from '../auth';

/** Cloudflare's free relay allowance a month (1,000 GB, shared by TURN and its SFU; checked 2026-10-19). */
export const FREE_BYTES = 1e12;

/** The owner's two relay switches. */
export interface RelaySettings {
  /** Whether devices may be handed TURN credentials at all. */
  enabled: boolean;
  /** Whether relaying may go on past the free allowance (and so cost money). */
  allowPaid: boolean;
}

/** This month's relayed bytes against the free allowance. */
export interface RelayUsage {
  /** Bytes relayed this UTC month, an estimate. */
  usedBytes: number;
  /** The free allowance in bytes (`FREE_BYTES`). */
  freeBytes: number;
  /** The UTC date usage next resets: the 1st of next month, `YYYY-MM-DD`. */
  resetsOn: string;
}

interface RelayFile extends RelaySettings {
  /** The UTC month `usedBytes` counts, `YYYY-MM`. */
  month: string;
  usedBytes: number;
}

/** `YYYY-MM` of `ms`, UTC. */
function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** `YYYY-MM-DD` of the 1st of the month after `ms`, UTC. */
function nextFirstOf(ms: number): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

/**
 * The relay's owner settings and this month's relayed bytes, kept in `<dataDir>/relay.json` (replaced atomically).
 * Off by default. Usage is the NAS's own estimate: bytes both ways on connections it classed as
 * relayed, sampled from werift's counters; Cloudflare's analytics would need another token.
 */
export class RelayState {
  private readonly file: string;
  private state: RelayFile;

  constructor(
    private readonly dataDir: string,
    private readonly now: () => number,
  ) {
    this.file = join(dataDir, 'relay.json');
    this.state = this.load();
  }

  /** The owner's current switches. */
  settings(): RelaySettings {
    const { enabled, allowPaid } = this.state;
    return { enabled, allowPaid };
  }

  /** Changes the named switches and saves the file. */
  set(change: Partial<RelaySettings>): void {
    this.state = {
      ...this.current(),
      ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
      ...(change.allowPaid === undefined ? {} : { allowPaid: change.allowPaid }),
    };
    this.save();
  }

  /** Adds relayed bytes to this month's count; anything but a positive count is ignored. */
  addBytes(n: number): void {
    if (!Number.isFinite(n) || n < 1) return;
    const current = this.current();
    this.state = { ...current, usedBytes: current.usedBytes + Math.floor(n) };
    this.save();
  }

  /** This month's bytes (zero once a new UTC month starts) with the allowance and the reset date. */
  usage(): RelayUsage {
    return { usedBytes: this.current().usedBytes, freeBytes: FREE_BYTES, resetsOn: nextFirstOf(this.now()) };
  }

  /** Whether a new relayed session may start: the relay is on, and under the free allowance unless paid use is allowed. */
  mayRelay(): boolean {
    const { enabled, allowPaid, usedBytes } = this.current();
    return enabled && (allowPaid || usedBytes < FREE_BYTES);
  }

  /** The state with a past month's bytes forgotten (`YYYY-MM` strings compare in date order). */
  private current(): RelayFile {
    // Only a later month resets: a clock stepped back across the boundary keeps the count.
    const month = monthOf(this.now());
    return month > this.state.month ? { ...this.state, month, usedBytes: 0 } : this.state;
  }

  private load(): RelayFile {
    const fresh: RelayFile = { enabled: false, allowPaid: false, month: monthOf(this.now()), usedBytes: 0 };
    let raw: Partial<RelayFile>;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a JSON object');
      raw = parsed as Partial<RelayFile>;
    } catch (err) {
      // An unreadable or corrupt file starts fresh, the relay off, rather than stopping the server.
      if (!isCode(err, 'ENOENT')) console.error(`relay: ${this.file} could not be read; starting with the relay off`, err);
      return fresh;
    }
    return {
      enabled: raw.enabled === true,
      allowPaid: raw.allowPaid === true,
      month: typeof raw.month === 'string' && /^\d{4}-\d{2}$/.test(raw.month) ? raw.month : fresh.month,
      usedBytes: typeof raw.usedBytes === 'number' && Number.isFinite(raw.usedBytes) && raw.usedBytes >= 0 ? raw.usedBytes : 0,
    };
  }

  private save(): void {
    mkdirSync(this.dataDir, { recursive: true });
    replaceAtomically(this.file, JSON.stringify(this.state));
  }
}

/** What a device's `turn-request` gets: servers, or none and why. */
export type TurnAnswer = { iceServers: IceServerInfo[] } | { iceServers: []; reason: TurnRefusal; resetsOn?: string };

/** What `turnResponder` needs. */
export interface TurnResponderOptions {
  /** The relay's switches and allowance. */
  relay: RelayState;
  /** Checks a paired device's signature and the live invite codes. */
  auth: Auth;
  /** Fresh TURN credentials from the rendezvous Worker (`RendezvousClient.turnServers`). */
  credentials: () => Promise<IceServerInfo[]>;
  /** The clock in milliseconds since the epoch. */
  now: () => number;
  /**
   * Called with the addresses the handed-out TURN urls' hosts resolve to, for the socket `sid` (`RtcPeers.noteTurnServers`),
   * so a connection from one of them counts as relayed even when the device hides its relay candidates.
   */
  onServers?: (sid: string, addresses: string[]) => void;
  /** Resolves a host name to all its addresses; `dns.promises.lookup(host, { all: true })` by default. */
  lookup?: (host: string) => Promise<string[]>;
}

/** Authenticated `turn-request`s one device, or one invite hash, may make in `TURN_REQUEST_WINDOW_MS`. */
export const TURN_REQUESTS_PER_HOUR = 10;
const TURN_REQUEST_WINDOW_MS = 60 * 60_000;

/** The host of each `turn:` or `turns:` url (RFC 7065), IPv6 brackets dropped. */
export function turnHosts(servers: readonly IceServerInfo[]): string[] {
  const hosts = new Set<string>();
  for (const server of servers) {
    for (const url of typeof server.urls === 'string' ? [server.urls] : server.urls) {
      const m = /^turns?:(\[[^\]]+\]|[^:?\s]+)/i.exec(url);
      if (m) hosts.add(m[1]!.replace(/^\[|\]$/g, ''));
    }
  }
  return [...hosts];
}

async function lookupAll(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true })).map((a) => a.address);
}

/**
 * Answers a device's `turn-request` on the signalling socket `sid` (spec 2026-10-18-webrtc-people-design). The device must check out first, so
 * a stranger learns nothing about the relay: a paired device by its signature over `turnProofMessage({ sid, ts })`
 * with `ts` within 60 s, or an unpaired one by the hash of a live invite code. Each device and each invite gets at
 * most 10 checked requests an hour; past that it is answered `unauthorized` too (no new reason). Then the relay must
 * be on and, unless paid use is allowed, under its free allowance.
 */
export function turnResponder(opts: TurnResponderOptions): (sid: string, request: Record<string, unknown>) => Promise<TurnAnswer> {
  const lookup = opts.lookup ?? lookupAll;
  const recent = new Map<string, number[]>();
  const refuse = (reason: TurnRefusal, resetsOn?: string): TurnAnswer => ({ iceServers: [], reason, ...(resetsOn === undefined ? {} : { resetsOn }) });
  /** The rate-limit key of a request that checks out, or null. */
  const checkedKey = (sid: string, request: Record<string, unknown>): string | null => {
    const { deviceId, ts, signature, inviteHash } = request;
    if (typeof deviceId === 'string' && typeof ts === 'number' && typeof signature === 'string') {
      if (!Number.isSafeInteger(ts) || Math.abs(opts.now() - ts) > TURN_MAX_SKEW_MS) return null;
      return opts.auth.signedBy(deviceId, turnProofMessage({ sid, ts }), signature) === null ? null : `device:${deviceId}`;
    }
    if (typeof inviteHash === 'string' && opts.auth.codes().some((c) => c.invite && c.hash === inviteHash)) return `invite:${inviteHash}`;
    return null;
  };
  /** Counts a request for `key`; false once it has had its 10 this hour. Only checked requests count, so a forger can't use up a device's. */
  const allowed = (key: string): boolean => {
    const now = opts.now();
    for (const [k, times] of recent) {
      const kept = times.filter((t) => t > now - TURN_REQUEST_WINDOW_MS);
      if (kept.length === 0) recent.delete(k);
      else recent.set(k, kept);
    }
    const times = recent.get(key) ?? [];
    if (times.length >= TURN_REQUESTS_PER_HOUR) return false;
    recent.set(key, [...times, now]);
    return true;
  };
  return async (sid, request) => {
    const key = checkedKey(sid, request);
    if (key === null || !allowed(key)) return refuse('unauthorized');
    const { relay } = opts;
    if (!relay.settings().enabled) return refuse('off');
    if (!relay.mayRelay()) return refuse('limit', relay.usage().resetsOn);
    let iceServers: IceServerInfo[];
    try {
      iceServers = await opts.credentials();
    } catch (err) {
      console.error('relay: TURN credentials could not be had', err);
      return refuse('unavailable');
    }
    if (opts.onServers) {
      const resolved = await Promise.all(
        turnHosts(iceServers).map((host) =>
          lookup(host).catch((err: unknown) => {
            console.error(`relay: ${host} could not be resolved`, err);
            return [];
          }),
        ),
      );
      opts.onServers(sid, [...new Set(resolved.flat())]);
    }
    return { iceServers };
  };
}
