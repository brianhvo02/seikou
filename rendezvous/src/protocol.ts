/**
 * The rendezvous protocol's shared pieces, used by the Worker and by the NAS's client
 * (`server/src/rendezvous-client.ts`). WebCrypto only, so both runtimes run the same code.
 */
import { normalizeCode } from '@seikou/nas/pairing-code';
import type { CodeRegistration, EcPublicJwk } from '@seikou/nas/nas-api';

/** WebCrypto parameters for importing and generating the NAS's P-256 ECDSA keys. */
export const ECDSA_KEY = { name: 'ECDSA', namedCurve: 'P-256' } as const;
/** WebCrypto parameters for ECDSA signatures: SHA-256, in WebCrypto's raw r || s form (64 bytes). */
export const ECDSA_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** A code's `expiresAt` may be at most this far ahead; invites live 3 days, the hour absorbs clock skew. */
export const MAX_CODE_AHEAD_MS = 3 * 24 * 60 * 60_000 + 60 * 60_000;

/** RFC 4648 base64url of `bytes` without padding. */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The bytes of an unpadded base64url string, or null when it holds a character outside the alphabet or isn't valid base64. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** Hex SHA-256 of the normalized code (the same value as the server's `codeHash`); null for a string that isn't a code. */
export async function codeHashOf(code: string): Promise<string | null> {
  const normalized = normalizeCode(code);
  if (normalized === null) return null;
  return Array.from(await sha256(normalized), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The NAS id: the key's RFC 7638 JWK thumbprint, so registering the same key twice gives the same id. */
export async function nasIdOf(jwk: EcPublicJwk): Promise<string> {
  return base64url(await sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
}

/**
 * The bytes a NAS signs for `DELETE /codes`. The leading type tag (which the `POST /codes` message lacks) keeps a
 * registration's signature from verifying as an unregistration, and the reverse.
 */
export function unregisterMessage(fields: { nasId: string; codeHash: string }): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(JSON.stringify({ type: 'unregister-code', codeHash: fields.codeHash, nasId: fields.nasId })));
}

/** The bytes a NAS signs for `POST /codes`: every field but `signature`, in a fixed order. */
export function signedMessage(fields: Omit<CodeRegistration, 'signature'>): Uint8Array<ArrayBuffer> {
  const routes = fields.routes.https === undefined ? {} : { https: fields.routes.https };
  return new Uint8Array(new TextEncoder().encode(JSON.stringify({ codeHash: fields.codeHash, expiresAt: fields.expiresAt, nasId: fields.nasId, routes })));
}

/** A NAS id: base64url of a SHA-256 (`nasIdOf`). */
export function isNasId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/*
 * WebRTC signalling: `GET /signal/nas?nasId=` (the NAS's socket) and `GET /signal/device?nasId=` (a device's),
 * both WebSocket upgrades to the NAS's `Signalling` Durable Object. Messages are JSON text with a type field `t`.
 */

/** The largest signalling message, in UTF-8 bytes; a device that sends more is closed, a NAS's is dropped. */
export const SIGNAL_MAX_MESSAGE_BYTES = 16 * 1024;

/** The close codes and reasons the Worker uses on signalling sockets. */
export const SIGNAL_CLOSE = {
  /** A device socket while no authenticated NAS socket is live, or once the NAS's socket goes. */
  nasOffline: { code: 4404, reason: 'nas-offline' },
  /** A NAS socket another authenticated NAS socket replaced. */
  replaced: { code: 4409, reason: 'replaced' },
  /** A device message of an unknown type, not JSON, or binary; a NAS message before auth that isn't `auth`. */
  badMessage: { code: 1008, reason: 'bad-message' },
  /** A message over `SIGNAL_MAX_MESSAGE_BYTES`. */
  tooBig: { code: 1009, reason: 'too-big' },
  /** A NAS's `auth` signature didn't verify, or the NAS id is unknown or expired. */
  badAuth: { code: 1008, reason: 'bad-auth' },
  /** A NAS socket that didn't answer its challenge within 10 s of opening. */
  authTimeout: { code: 1008, reason: 'auth-timeout' },
  /** A device socket that sent more than `SIGNAL_DEVICE_MESSAGES` messages. */
  tooManyMessages: { code: 1008, reason: 'too-many-messages' },
  /** A device socket `SIGNAL_DEVICE_LIFETIME_MS` after it opened. */
  expired: { code: 4408, reason: 'expired' },
  /** A device socket while `SIGNAL_DEVICES_PER_NAS` are already open to that NAS. */
  busy: { code: 4429, reason: 'busy' },
} as const;

/** A device socket is closed this long after it opens: signalling is only for setting a connection up. */
export const SIGNAL_DEVICE_LIFETIME_MS = 60_000;
/** The messages a device socket may send; the next one closes it. */
export const SIGNAL_DEVICE_MESSAGES = 64;
/** Device sockets open to one NAS at once. */
export const SIGNAL_DEVICES_PER_NAS = 32;

/** The types a device may send; the Worker forwards them to the NAS with the device's `sid` added. */
export const DEVICE_SIGNAL_TYPES = ['offer', 'candidate', 'turn-request'] as const;
/** The types a NAS may send once authenticated; the Worker forwards them to the device `sid` names, without `sid`. */
export const NAS_SIGNAL_TYPES = ['answer', 'candidate', 'turn-response'] as const;
/** One of `DEVICE_SIGNAL_TYPES`. */
export type DeviceSignalType = (typeof DEVICE_SIGNAL_TYPES)[number];
/** One of `NAS_SIGNAL_TYPES`. */
export type NasSignalType = (typeof NAS_SIGNAL_TYPES)[number];

/** Worker → NAS, first on a NAS socket. */
export interface SignalChallenge {
  readonly t: 'challenge';
  readonly nonce: string;
}

/** NAS → Worker: the base64url P-256 signature over `signalAuthMessage({ nasId, nonce })`. */
export interface SignalAuth {
  readonly t: 'auth';
  readonly signature: string;
}

/**
 * NAS → Worker on its authenticated socket, every `SIGNAL_PING_INTERVAL_MS`, sent as exactly `SIGNAL_PING_MESSAGE`:
 * the runtime answers `SIGNAL_PONG_MESSAGE` on that socket itself (the Durable Object's WebSocket auto-response), so a
 * heartbeat never wakes the hibernating object, and nothing is forwarded. Any socket that sends those exact bytes gets
 * the pong, authenticated or not; a pong carries nothing. A NAS that gets no pong within `SIGNAL_PONG_TIMEOUT_MS`
 * reconnects.
 */
export interface SignalPing {
  readonly t: 'ping';
}

/** The Worker runtime's answer to `SignalPing`, sent as exactly `SIGNAL_PONG_MESSAGE`. */
export interface SignalPong {
  readonly t: 'pong';
}

/** The heartbeat's bytes, matched byte for byte by the auto-response: never re-serialize them. */
export const SIGNAL_PING_MESSAGE = '{"t":"ping"}';
/** The heartbeat answer's bytes (see `SIGNAL_PING_MESSAGE`). */
export const SIGNAL_PONG_MESSAGE = '{"t":"pong"}';

/** How often a NAS sends `SIGNAL_PING_MESSAGE` on its authenticated socket, in milliseconds. */
export const SIGNAL_PING_INTERVAL_MS = 25_000;
/** How long a NAS waits for the pong before it reconnects, in milliseconds. */
export const SIGNAL_PONG_TIMEOUT_MS = 10_000;

/** Device → Worker. */
export interface DeviceSignal {
  readonly t: DeviceSignalType;
  readonly [field: string]: unknown;
}

/** Worker → NAS: a device's message with the device socket's id. */
export interface DeviceSignalForNas extends DeviceSignal {
  readonly sid: string;
}

/** NAS → Worker, addressed to a device socket by `sid`. */
export interface NasSignal {
  readonly t: NasSignalType;
  readonly sid: string;
  readonly [field: string]: unknown;
}

/** Worker → device: a NAS's message without `sid`. */
export interface NasSignalForDevice {
  readonly t: NasSignalType;
  readonly [field: string]: unknown;
}

/**
 * The bytes a NAS signs to authenticate its signalling socket. The type tag keeps a code registration's or an
 * unregistration's signature from verifying here, and the reverse.
 */
export function signalAuthMessage(fields: { nasId: string; nonce: string }): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(JSON.stringify({ type: 'signal-nas', nasId: fields.nasId, nonce: fields.nonce })));
}

/**
 * Worker → device, first on an accepted device socket: the socket's id, which a paired device signs into its
 * `turn-request` proof (`turnProofMessage`) so the proof can't be replayed from another socket.
 */
export interface SignalHello {
  readonly t: 'hello';
  readonly sid: string;
}

/*
 * The relay (design in `docs/superpowers/specs/2026-10-18-webrtc-people-design.md`). A device that can't connect directly asks the NAS for TURN servers over signalling
 * (`TurnRequest`); the NAS checks the device, the relay's switch and its allowance, asks the Worker for
 * credentials (`POST /turn`, signed with the NAS key) and answers `TurnResponse`.
 */

/** An ICE server as `RTCPeerConnection` takes it. */
export interface IceServerInfo {
  readonly urls: string | readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

/** A device proof's `ts` and a NAS's `POST /turn` `ts` must be within this of the checker's clock. */
export const TURN_MAX_SKEW_MS = 60_000;
/** TURN credentials last this long (seconds). */
export const TURN_TTL_SECONDS = 3_600;

/**
 * Device → NAS (through the Worker, which adds `sid`). A paired device proves itself with `signature`: base64url of
 * its P-256 key's raw r || s ECDSA SHA-256 signature over `turnProofMessage({ sid, ts })`, `ts` its clock in ms. An
 * unpaired device redeeming an invite sends the invite code's hash (`codeHashOf`) instead.
 */
export type TurnRequest =
  | { readonly t: 'turn-request'; readonly deviceId: string; readonly ts: number; readonly signature: string }
  | { readonly t: 'turn-request'; readonly inviteHash: string };

/**
 * Why a device gets no TURN servers: the relay is switched off, its free allowance for the month is used up
 * (`resetsOn` then names the UTC date it resets), the device or invite didn't check out, or the credentials
 * couldn't be had (the Worker has no TURN key, or Cloudflare failed).
 */
export type TurnRefusal = 'off' | 'limit' | 'unauthorized' | 'unavailable';

/** NAS → device (the NAS adds `sid`, which the Worker strips). */
export type TurnResponse =
  | { readonly t: 'turn-response'; readonly iceServers: readonly IceServerInfo[] }
  | { readonly t: 'turn-response'; readonly iceServers: readonly []; readonly reason: TurnRefusal; readonly resetsOn?: string };

/** The bytes a paired device signs for a `turn-request` on the socket `sid`. */
export function turnProofMessage(fields: { sid: string; ts: number }): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(JSON.stringify({ type: 'turn', sid: fields.sid, ts: fields.ts })));
}

/** NAS → Worker, `POST /turn`: `signature` is over `turnRequestMessage({ nasId, ts })`. */
export interface TurnCredentialsRequest {
  readonly nasId: string;
  readonly ts: number;
  readonly signature: string;
}

/** The bytes a NAS signs for `POST /turn`; the type tag keeps any other signed message from verifying here. */
export function turnRequestMessage(fields: { nasId: string; ts: number }): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(JSON.stringify({ type: 'turn-credentials', nasId: fields.nasId, ts: fields.ts })));
}

/** The ICE servers in an untrusted JSON value: at most 8, each with 1 to 16 string urls (and string credentials if any); null otherwise. */
export function iceServersOf(value: unknown): IceServerInfo[] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const out: IceServerInfo[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { urls, username, credential } = entry as Record<string, unknown>;
    const list = typeof urls === 'string' ? [urls] : urls;
    if (!Array.isArray(list) || list.length === 0 || list.length > 16 || !list.every((u) => typeof u === 'string' && u.length <= 512)) return null;
    if ((username !== undefined && typeof username !== 'string') || (credential !== undefined && typeof credential !== 'string')) return null;
    out.push({ urls: list as string[], ...(username === undefined ? {} : { username }), ...(credential === undefined ? {} : { credential }) });
  }
  return out;
}
