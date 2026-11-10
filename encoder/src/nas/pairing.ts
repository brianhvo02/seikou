// SPDX-License-Identifier: LGPL-3.0-or-later
import { webcrypto } from 'node:crypto';
import type { CodeLookup } from '@seikou/nas/nas-api';
import { normalizeCode } from '@seikou/nas/pairing-code';
import { errorOfBody, hostOf, jsonPost, NasError, reach } from './client';
import { readNasPairing, removeNasFetched, writeNasPairing, type NasPairingFile } from './nas-store';

// Pairing the encoder with the NAS as an owner device, from a typed code and address or a pairing link, the way
// Seikou's app pairs: a new P-256 key, then `pair/redeem` with the code. The key is kept (extractable, as a JWK in
// `nas.json`) because the encoder signs a new session at each start.

/** What the user gave: a typed code with the NAS's address, or a pairing link. */
export interface PairingInput {
  readonly code?: string;
  readonly base?: string;
  readonly link?: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost']);

/**
 * `base` as the NAS API base the encoder keeps: an `https:` URL (or, for tests, `http:` on 127.0.0.1 or localhost)
 * with no user, query or fragment, ending in `/api/`; a base that ends in `/api` gets its slash. Anything else throws
 * `NasError('bad-address')`.
 */
export function checkNasBase(base: string): string {
  let url: URL;
  try {
    url = new URL(base.trim());
  } catch {
    throw new NasError('bad-address', null, 'That is not a web address. The NAS address looks like https://nas.example/bluray/api/.');
  }
  const local = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new NasError('bad-address', null, 'The NAS address must start with https:// (the NAS speaks HTTPS through its proxy).');
  if (url.username !== '' || url.password !== '') throw new NasError('bad-address', null, 'The NAS address must not carry a user name or password.');
  url.search = '';
  url.hash = '';
  let path = url.pathname;
  if (!path.endsWith('/')) path += '/';
  if (!path.endsWith('/api/')) throw new NasError('bad-address', null, 'The NAS address ends in /api/, such as https://nas.example/bluray/api/.');
  url.pathname = path;
  return url.href;
}

/** A rendezvous Worker's base as a pairing link names it: https (or http on 127.0.0.1 or localhost), no trailing slash. */
function checkWorker(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new NasError('bad-address', null, "The pairing link's rendezvous address is not a web address.");
  }
  const local = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if ((url.protocol !== 'https:' && !local) || url.username !== '' || url.password !== '') {
    throw new NasError('bad-address', null, "The pairing link's rendezvous address must start with https://.");
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** The code as the NAS takes it; a malformed code throws `NasError('http', 400)`, which the route answers as `bad-code`. */
function checkCode(raw: string | null | undefined): string {
  const code = raw === null || raw === undefined ? null : normalizeCode(raw);
  if (code === null) throw new NasError('http', 400, 'That is not a pairing code: it has 12 letters and digits, like K7QM-4XP2-R9TD.', 'bad-code');
  return code;
}

/**
 * A typed code with an address, or a pairing link (`?pair=<code>&nas=<base>` or `&rv=<worker>`; the Worker's
 * `POST codes/lookup` gives the base). Throws `NasError('bad-address')` for an address the encoder may not use or a
 * link with neither, and `NasError('http', 400)` for a malformed code.
 */
export function parsePairingInput(input: PairingInput): { code: string; base: string } | { code: string; rendezvous: string } {
  if (input.link !== undefined && input.link.trim() !== '') {
    let url: URL;
    try {
      url = new URL(input.link.trim());
    } catch {
      throw new NasError('bad-address', null, 'That is not a pairing link. Paste the whole link the NAS showed, or type the code and address.');
    }
    const code = checkCode(url.searchParams.get('pair'));
    const nas = url.searchParams.get('nas');
    if (nas !== null) return { code, base: checkNasBase(nas) };
    const rv = url.searchParams.get('rv');
    if (rv !== null) return { code, rendezvous: checkWorker(rv) };
    throw new NasError('bad-address', null, 'The pairing link names no NAS. Type the code and the NAS address instead.');
  }
  const code = checkCode(input.code);
  if (input.base === undefined || input.base.trim() === '') throw new NasError('bad-address', null, "Type the NAS's address, such as https://nas.example/bluray/api/.");
  return { code, base: checkNasBase(input.base) };
}

/** The NAS base a rendezvous Worker gives for `code`. */
async function lookUp(worker: string, code: string, fetchImpl: typeof fetch): Promise<string> {
  const host = hostOf(worker);
  const res = await reach(fetchImpl, `${worker}/codes/lookup`, jsonPost({ code }), host);
  if (!res.ok) {
    const error = await errorOfBody(res);
    if (res.status === 404 || res.status === 400) throw new NasError('http', 400, `${host} knows no such pairing code. Check it, or ask for a new one.`, error);
    throw new NasError('unreachable', res.status, `${host} answered ${res.status} when looking the code up.`, error);
  }
  const found = (await res.json()) as CodeLookup;
  if (typeof found.routes?.https !== 'string') throw new NasError('unreachable', null, 'The NAS has no HTTPS address, which the encoder needs. Type its address with the code instead.');
  return checkNasBase(found.routes.https);
}

/**
 * Pairs the encoder with the NAS as `deviceName` and saves the pairing in `<dataDir>/nas.json`, replacing any earlier
 * one (whose fetched files are removed with it). A code for a person who is not an owner throws `NasError('not-owner')`
 * and saves nothing; the NAS refusing the code throws `NasError('http')` with its status (401 for an unknown, used or
 * expired code).
 */
export async function pairWithNas(dataDir: string, input: PairingInput, deviceName: string, fetchImpl: typeof fetch = fetch): Promise<NasPairingFile> {
  const parsed = parsePairingInput(input);
  const base = 'base' in parsed ? parsed.base : await lookUp(parsed.rendezvous, parsed.code, fetchImpl);
  const host = hostOf(base);
  const key = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const { kty, crv, x, y } = await webcrypto.subtle.exportKey('jwk', key.publicKey);
  const res = await reach(fetchImpl, `${base}pair/redeem`, jsonPost({ code: parsed.code, deviceName, publicKeyJwk: { kty, crv, x, y } }), host);
  if (!res.ok) {
    const error = await errorOfBody(res);
    if (res.status === 401) throw new NasError('http', 401, `${host} refused the code: it is unknown, used or more than 10 minutes old. Ask for a new one.`, error);
    if (res.status === 429) throw new NasError('http', 429, `${host} has had too many wrong codes. Wait a minute and try again.`, error);
    throw new NasError('http', res.status, `${host} answered ${res.status} to the pairing.`, error);
  }
  const answer = (await res.json()) as { deviceId: string; personId: string; personName?: string; owner: boolean };
  if (!answer.owner) {
    throw new NasError('not-owner', null, `That code is for a person who is not an owner of ${host}. The encoder needs an owner code: make one in Seikou's admin screen as an owner.`);
  }
  const privateKeyJwk = await webcrypto.subtle.exportKey('jwk', key.privateKey);
  const pairing: NasPairingFile = {
    base,
    deviceId: answer.deviceId,
    personId: answer.personId,
    personName: answer.personName ?? '',
    privateKeyJwk,
    pairedAt: new Date().toISOString(),
  };
  const replacing = (await readNasPairing(dataDir)) !== null;
  // the new pairing goes in first (renamed over the old file), so a failure here never leaves the encoder unpaired
  await writeNasPairing(dataDir, pairing);
  if (replacing) await removeNasFetched(dataDir);
  return pairing;
}
