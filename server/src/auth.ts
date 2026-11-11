import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import type { webcrypto } from 'node:crypto';
import { codeHash, newCode, normalizeCode } from './codes';
import { randomId } from './store';
import type { AuthData, Store } from './store';

type JsonWebKey = webcrypto.JsonWebKey;

/** A person the NAS knows; every device and pairing code belongs to one, and owner status is the person's. */
export interface Person {
  /** Random: 22 base64url characters. */
  readonly id: string;
  /** Shown to the owner; 1 to 100 characters. */
  name: string;
  /** Whether this person's devices may use the owner routes. */
  owner: boolean;
  /** Creation time, in milliseconds since the epoch. */
  readonly createdAt: number;
  /** Made with a pairing code and not yet paired: pruned once no device and no live code is left (`pruneOrphans`). */
  pending?: true;
}

/** How a device reached the NAS: HTTPS (home network or Tailscale), a direct WebRTC channel, or one through the relay. */
export type DeviceRoute = 'https' | 'webrtc' | 'relay';

/** A device as stored: its owner status comes from its person. */
export interface StoredDevice {
  readonly id: string;
  name: string;
  personId: string;
  readonly publicKeyJwk: JsonWebKey;
  readonly pairedAt: number;
  lastSeen: number;
  /** The route of its last session; absent until one starts (and in files from before routes were noted). */
  lastRoute?: DeviceRoute;
}

/** What `verify`, `devices` and `redeem` return: the stored device with its person's name and owner status. */
export interface Device extends StoredDevice {
  readonly owner: boolean;
  readonly personName: string;
}

/** A pairing code as stored: its hash, the person it will pair a device for and its expiry. */
export interface PairingCode {
  readonly id: string;
  /** codeHash() of the code; the code itself is never stored. */
  readonly hash: string;
  /** The person the device that redeems the code joins. */
  readonly personId: string;
  /** An invite lives 3 days where a plain code lives 10 minutes. */
  readonly invite: boolean;
  /** Expiry, in milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** Whom a new pairing code is for: an existing person, or a person made together with the code. */
export type PersonRef = { personId: string } | { newPerson: { name: string; owner: boolean } };

/** An admin action would leave no device belonging to an owner. */
export class AuthConflict extends Error {
  constructor(readonly reason: 'last-owner') {
    super(reason);
    this.name = 'AuthConflict';
  }
}

/** A person, device or code the admin action names does not exist (routes answer 404). */
export class AuthNotFound extends Error {
  constructor(what = 'not found') {
    super(what);
    this.name = 'AuthNotFound';
  }
}

const CODE_TTL_MS = 10 * 60_000;
/** How long an invite code stays valid: 3 days. */
export const INVITE_TTL_MS = 3 * 24 * 60 * 60_000;
const MAX_PERSON_NAME = 100;
const CHALLENGE_TTL_MS = 60_000;
const MAX_CHALLENGES_PER_DEVICE = 5;
const SESSION_TTL_MS = 60 * 60_000;
/** WebCrypto's ECDSA P-256 signature: r || s, 32 bytes each (IEEE P1363). */
const SIGNATURE_BYTES = 64;
const BASE64URL = /^[A-Za-z0-9_-]+$/;


/** A person's name, trimmed; a RangeError (routes answer 400) unless it is 1 to 100 characters. */
function personName(raw: string): string {
  const name = raw.trim();
  if (name.length < 1 || name.length > MAX_PERSON_NAME) throw new RangeError(`a person's name is 1 to ${MAX_PERSON_NAME} characters`);
  return name;
}

/** Devices that belong to an owner person. */
function ownerDeviceCount(data: AuthData): number {
  const owners = new Set(data.people.filter((p) => p.owner).map((p) => p.id));
  return data.devices.filter((d) => owners.has(d.personId)).length;
}

/** Runs after a change to `data`: throws when it took the last owner device away. */
function keepOwner(before: number, data: AuthData): void {
  if (before > 0 && ownerDeviceCount(data) === 0) throw new AuthConflict('last-owner');
}

/** The public P-256 key as `{kty, crv, x, y}`, or null for anything else (private keys included). */
export function p256PublicJwk(jwk: unknown): JsonWebKey | null {
  if (typeof jwk !== 'object' || jwk === null || 'd' in jwk) return null;
  const { kty, crv, x, y } = jwk as Record<string, unknown>;
  if (kty !== 'EC' || crv !== 'P-256' || typeof x !== 'string' || typeof y !== 'string') return null;
  if (!BASE64URL.test(x) || !BASE64URL.test(y)) return null;
  const key = { kty, crv, x, y };
  try {
    createPublicKey({ key, format: 'jwk' });
  } catch {
    return null;
  }
  return key;
}

/**
 * Pairing codes, paired devices and session tokens.
 * A token is `base64url(deviceId.expiresAt).base64url(HMAC-SHA256(secret, first part))`.
 */
export class Auth {
  /** Outstanding challenges → their device; single use, in memory only. */
  private readonly challenges = new Map<string, { deviceId: string; expiresAt: number }>();
  private readonly goneListeners = new Set<(deviceId: string) => void>();

  constructor(
    private readonly store: Store,
    private readonly now: () => number,
  ) {
    store.secret();
  }

  /** A single-use code for a person, valid 10 minutes (3 days for an invite); only its hash is kept. A new person is made with the code. */
  createCode(person: PersonRef, opts: { invite?: boolean } = {}): { record: PairingCode; code: string; person: Person } {
    const code = newCode((n) => randomBytes(n));
    const invite = opts.invite === true;
    const now = this.now();
    const newName = 'newPerson' in person ? personName(person.newPerson.name) : null;
    return this.store.update((data) => {
      let owner: Person | undefined;
      if ('newPerson' in person) {
        owner = { id: randomId(), name: newName!, owner: person.newPerson.owner, createdAt: now, pending: true };
        data.people.push(owner);
      } else {
        owner = data.people.find((p) => p.id === person.personId);
        if (!owner) throw new AuthNotFound('unknown person');
      }
      const record: PairingCode = { id: randomId(), hash: codeHash(code), personId: owner.id, invite, expiresAt: now + (invite ? INVITE_TTL_MS : CODE_TTL_MS) };
      data.codes = [...this.live(data.codes), record];
      return { record, code, person: { ...owner } };
    });
  }

  /** Spends the code and pairs the device, or null for an unknown, used or expired code or an unusable key. */
  redeem(code: string, deviceName: string, publicKeyJwk: JsonWebKey): Device | null {
    const normalized = normalizeCode(code);
    const key = p256PublicJwk(publicKeyJwk);
    if (normalized === null || key === null) return null;
    const hash = codeHash(normalized);
    // Failed guesses don't touch the disk.
    if (!this.live(this.store.read().codes).some((c) => c.hash === hash)) return null;
    return this.store.update((data) => {
      const codes = this.live(data.codes);
      const found = codes.find((c) => c.hash === hash);
      data.codes = codes.filter((c) => c !== found);
      if (!found) return null;
      const person = data.people.find((p) => p.id === found.personId);
      if (!person) return null;
      const now = this.now();
      delete person.pending;
      const device: StoredDevice = { id: randomId(), name: deviceName.trim(), personId: person.id, publicKeyJwk: key, pairedAt: now, lastSeen: now };
      data.devices.push(device);
      return { ...device, owner: person.owner, personName: person.name };
    });
  }

  /** A random challenge for the device to sign, valid 60 s; null for an unknown device. A device holds at most 5, the oldest dropped. */
  challenge(deviceId: string): string | null {
    if (!this.device(deviceId)) return null;
    const now = this.now();
    for (const [c, entry] of this.challenges) if (entry.expiresAt <= now) this.challenges.delete(c);
    // The map keeps insertion order, so the first ones found are the oldest.
    const mine = [...this.challenges].filter(([, entry]) => entry.deviceId === deviceId);
    for (const [c] of mine.slice(0, Math.max(0, mine.length - MAX_CHALLENGES_PER_DEVICE + 1))) this.challenges.delete(c);
    const challenge = randomBytes(32).toString('base64url');
    this.challenges.set(challenge, { deviceId, expiresAt: now + CHALLENGE_TTL_MS });
    return challenge;
  }

  /**
   * A session token valid 1 hour for a device that signed `challenge` (its UTF-8 bytes) with ECDSA P-256 SHA-256;
   * `signatureB64` is base64url of the raw r || s. Each challenge is spent by the first attempt.
   */
  startSession(deviceId: string, challenge: string, signatureB64: string): { token: string; expiresAt: number } | null {
    const entry = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    if (!entry || entry.deviceId !== deviceId || this.now() >= entry.expiresAt) return null;
    if (!this.signedBy(deviceId, Buffer.from(challenge, 'utf8'), signatureB64)) return null;
    const now = this.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.store.update((data) => {
      const stored = data.devices.find((d) => d.id === deviceId);
      if (stored) stored.lastSeen = now;
    });
    const payload = Buffer.from(`${deviceId}.${expiresAt}`, 'utf8').toString('base64url');
    return { token: `${payload}.${this.mac(payload)}`, expiresAt };
  }

  /**
   * The paired device whose stored P-256 key made `signatureB64` (base64url of the raw r || s, ECDSA SHA-256) over
   * `data`, or null for an unknown device or a signature that doesn't verify.
   */
  signedBy(deviceId: string, data: Uint8Array, signatureB64: string): Device | null {
    const device = this.device(deviceId);
    if (!device || !BASE64URL.test(signatureB64)) return null;
    const signature = Buffer.from(signatureB64, 'base64url');
    if (signature.length !== SIGNATURE_BYTES) return null;
    try {
      const key = createPublicKey({ key: device.publicKeyJwk, format: 'jwk' });
      return verifySignature('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature) ? device : null;
    } catch {
      return null;
    }
  }

  /** The token's device, or null when the token is malformed, forged, expired or its device revoked. */
  verify(token: string): Device | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, mac] = parts as [string, string];
    const given = Buffer.from(mac, 'utf8');
    const expected = Buffer.from(this.mac(payload), 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const text = Buffer.from(payload, 'base64url').toString('utf8');
    const dot = text.lastIndexOf('.');
    const expiresAt = Number(text.slice(dot + 1));
    if (dot <= 0 || !Number.isSafeInteger(expiresAt) || this.now() >= expiresAt) return null;
    return this.device(text.slice(0, dot));
  }

  /** Records the route of the session `deviceId` just started; nothing for an unknown device. */
  noteRoute(deviceId: string, route: DeviceRoute): void {
    const current = this.store.read().devices.find((d) => d.id === deviceId);
    if (!current || current.lastRoute === route) return;
    this.store.update((data) => {
      const stored = data.devices.find((d) => d.id === deviceId);
      if (stored) stored.lastRoute = route;
    });
  }

  /** Calls `listener` with each device revoked, on its own or with its person; returns the way to stop. */
  onDeviceGone(listener: (deviceId: string) => void): () => void {
    this.goneListeners.add(listener);
    return () => this.goneListeners.delete(listener);
  }

  /** Throws AuthConflict('last-owner') when this is the last device of an owner. */
  revokeDevice(id: string): void {
    const found = this.store.update((data) => {
      const before = ownerDeviceCount(data);
      const had = data.devices.some((d) => d.id === id);
      data.devices = data.devices.filter((d) => d.id !== id);
      keepOwner(before, data);
      return had;
    });
    this.dropChallenges((deviceId) => deviceId === id);
    if (found) this.devicesGone([id]);
  }

  /** Every person, as copies. */
  people(): Person[] {
    return this.store.read().people.map((p) => ({ ...p }));
  }

  /** Makes a person with no devices. Throws `RangeError` unless the name is 1 to 100 characters. */
  createPerson(name: string, owner: boolean): Person {
    const person: Person = { id: randomId(), name: personName(name), owner, createdAt: this.now() };
    this.store.update((data) => {
      data.people.push(person);
    });
    return { ...person };
  }

  /**
   * Renames a person and/or changes their owner status. Throws `AuthNotFound` for an unknown person, `RangeError` for a
   * bad name, and `AuthConflict('last-owner')` when it would leave no owner device.
   */
  updatePerson(id: string, change: { name?: string; owner?: boolean }): Person {
    const name = change.name === undefined ? undefined : personName(change.name);
    return this.store.update((data) => {
      const person = data.people.find((p) => p.id === id);
      if (!person) throw new AuthNotFound('unknown person');
      const before = ownerDeviceCount(data);
      if (name !== undefined) person.name = name;
      if (change.owner !== undefined) person.owner = change.owner;
      keepOwner(before, data);
      return { ...person };
    });
  }

  /** Removes the person and revokes their devices; their saved data is the caller's to clear. */
  removePerson(id: string): void {
    const gone = new Set<string>();
    this.store.update((data) => {
      if (!data.people.some((p) => p.id === id)) throw new AuthNotFound('unknown person');
      const before = ownerDeviceCount(data);
      for (const d of data.devices) if (d.personId === id) gone.add(d.id);
      data.devices = data.devices.filter((d) => d.personId !== id);
      data.codes = data.codes.filter((c) => c.personId !== id);
      data.people = data.people.filter((p) => p.id !== id);
      keepOwner(before, data);
    });
    this.dropChallenges((deviceId) => gone.has(deviceId));
    this.devicesGone(gone);
  }

  /** Gives a device to another person (who is then no longer pending). Throws `AuthNotFound`, or `AuthConflict('last-owner')` when the move would leave no owner device. */
  moveDevice(deviceId: string, personId: string): void {
    this.store.update((data) => {
      const device = data.devices.find((d) => d.id === deviceId);
      if (!device) throw new AuthNotFound('unknown device');
      const person = data.people.find((p) => p.id === personId);
      if (!person) throw new AuthNotFound('unknown person');
      const before = ownerDeviceCount(data);
      device.personId = personId;
      delete person.pending;
      keepOwner(before, data);
    });
  }

  /** The first owner person; made, named Owner, when there is none. */
  firstOwnerPerson(): Person {
    const existing = this.store.read().people.find((p) => p.owner);
    if (existing) return { ...existing };
    return this.store.update((data) => {
      const found = data.people.find((p) => p.owner);
      if (found) return { ...found };
      const person: Person = { id: randomId(), name: 'Owner', owner: true, createdAt: this.now() };
      data.people.push(person);
      return { ...person };
    });
  }

  /**
   * Removes people made with a code that was never used (no device and no live code left), so unredeemed invites
   * don't pile up. People made on their own, people who once had a device, and owners are kept.
   */
  pruneOrphans(): void {
    const orphan = (data: AuthData): ((p: Person) => boolean) => {
      const live = new Set(this.live(data.codes).map((c) => c.personId));
      const withDevices = new Set(data.devices.map((d) => d.personId));
      return (p) => p.pending === true && !p.owner && !live.has(p.id) && !withDevices.has(p.id);
    };
    const current = this.store.read();
    if (!current.people.some(orphan(current))) return;
    this.store.update((data) => {
      const gone = orphan(data);
      data.codes = this.live(data.codes);
      data.people = data.people.filter((p) => !gone(p));
    });
  }

  /** Withdraws a pairing code by its record id; unknown ids are ignored. */
  deleteCode(id: string): void {
    this.store.update((data) => {
      data.codes = this.live(data.codes).filter((c) => c.id !== id);
    });
  }

  /** Every device with its person's name and owner status. */
  devices(): Device[] {
    const data = this.store.read();
    return data.devices.flatMap((d) => this.derive(data, d) ?? []);
  }

  /** Codes not yet used or expired. */
  codes(): PairingCode[] {
    return this.live(this.store.read().codes);
  }

  private device(id: string): Device | null {
    const data = this.store.read();
    const found = data.devices.find((d) => d.id === id);
    return found ? this.derive(data, found) : null;
  }

  private derive(data: AuthData, stored: StoredDevice): Device | null {
    const person = data.people.find((p) => p.id === stored.personId);
    return person ? { ...stored, owner: person.owner, personName: person.name } : null;
  }

  private devicesGone(ids: Iterable<string>): void {
    for (const id of ids) {
      for (const listener of [...this.goneListeners]) {
        try {
          listener(id);
        } catch (err) {
          console.error(err);
        }
      }
    }
  }

  private dropChallenges(gone: (deviceId: string) => boolean): void {
    for (const [c, entry] of this.challenges) if (gone(entry.deviceId)) this.challenges.delete(c);
  }

  private live(codes: readonly PairingCode[]): PairingCode[] {
    const now = this.now();
    return codes.filter((c) => now < c.expiresAt);
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.store.secret()).update(payload).digest('base64url');
  }
}
