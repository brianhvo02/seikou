// SPDX-License-Identifier: LGPL-3.0-or-later
import { randomBytes, type webcrypto } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The encoder's pairing with the NAS, kept in `<data>/nas.json` (mode 0600): the NAS's API base, the device the
// encoder paired as, and its private key. No session token is ever stored; a session is signed for again.

/** What `<data>/nas.json` holds. */
export interface NasPairingFile {
  /** The NAS's API base, ending in `/api/` (see `checkNasBase`). */
  readonly base: string;
  /** The device id the NAS gave at pairing. */
  readonly deviceId: string;
  /** The person (an owner) the device belongs to. */
  readonly personId: string;
  /** That person's name, as the NAS gave it at pairing. */
  readonly personName: string;
  /** The device's P-256 private key, which signs each session challenge. */
  readonly privateKeyJwk: webcrypto.JsonWebKey;
  /** When the pairing was made, as an ISO date. */
  readonly pairedAt: string;
}

const FILE = 'nas.json';

const isString = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** The pairing, or null when there is none or the file is not one (a damaged file counts as unpaired). */
export async function readNasPairing(dataDir: string): Promise<NasPairingFile | null> {
  let text: string;
  try {
    text = await readFile(join(dataDir, FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const key = p.privateKeyJwk;
  if (!isString(p.base) || !isString(p.deviceId) || !isString(p.personId) || typeof p.personName !== 'string' || !isString(p.pairedAt)) return null;
  if (typeof key !== 'object' || key === null || Array.isArray(key)) return null;
  return { base: p.base, deviceId: p.deviceId, personId: p.personId, personName: p.personName, privateKeyJwk: key as webcrypto.JsonWebKey, pairedAt: p.pairedAt };
}

/** Writes the pairing atomically (a temporary file with mode 0600, then renamed over `nas.json`). */
export async function writeNasPairing(dataDir: string, p: NasPairingFile): Promise<void> {
  const target = join(dataDir, FILE);
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  const body: NasPairingFile = {
    base: p.base,
    deviceId: p.deviceId,
    personId: p.personId,
    personName: p.personName,
    privateKeyJwk: p.privateKeyJwk,
    pairedAt: p.pairedAt,
  };
  await mkdir(dataDir, { recursive: true });
  try {
    await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/** Forgets the pairing, and with it what was fetched from that NAS: `<data>/fetch` and `<data>/nas-library.json`. */
export async function removeNasPairing(dataDir: string): Promise<void> {
  await rm(join(dataDir, FILE), { force: true });
  await removeNasFetched(dataDir);
}

/** Removes what was fetched from a NAS (`<data>/fetch` and `<data>/nas-library.json`), keeping the pairing. */
export async function removeNasFetched(dataDir: string): Promise<void> {
  await rm(join(dataDir, 'fetch'), { recursive: true, force: true });
  await rm(join(dataDir, 'nas-library.json'), { force: true });
}
