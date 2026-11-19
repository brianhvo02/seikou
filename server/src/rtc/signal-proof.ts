// SPDX-License-Identifier: LGPL-3.0-or-later
import { SIGNAL_TICKET_TTL_MS, encodeTicket, offerProofMessage, signalTicketMessage } from '../../../rendezvous/src/protocol';
import type { Auth, PairingCode } from '../auth';

/** What the proof checks need of `Auth`: the paired devices' keys and the live codes. */
export type ProofAuth = Pick<Auth, 'signedBy' | 'codes'>;

/** Whether `signature` is a string by paired device `deviceId` over `message`; any other value is no proof. */
export function deviceSigned(auth: ProofAuth, deviceId: unknown, message: Uint8Array, signature: unknown): boolean {
  return typeof deviceId === 'string' && typeof signature === 'string' && auth.signedBy(deviceId, message, signature) !== null;
}

/** The live code (not spent, not expired) whose hash is `hash`, or null; anything but a string is null. */
export function liveCode(auth: ProofAuth, hash: unknown): PairingCode | null {
  if (typeof hash !== 'string') return null;
  return auth.codes().find((c) => c.hash === hash) ?? null;
}

/**
 * Checks the proof a device sent with its `offer` on the signalling socket `sid`: `{ deviceId, signature }` (a paired
 * device's signature over `offerProofMessage({ sid })`) gives `device:<id>`, and `{ codeHash }` of a live code, plain
 * or invite, gives `code:<hash>`. Anything else is null, and the NAS answers that offer `unauthorized`.
 */
export function checkOfferProof(auth: ProofAuth, sid: string, proof: unknown): string | null {
  if (typeof proof !== 'object' || proof === null || Array.isArray(proof)) return null;
  const { deviceId, signature, codeHash } = proof as Record<string, unknown>;
  if (deviceId !== undefined || signature !== undefined) {
    return deviceSigned(auth, deviceId, offerProofMessage({ sid }), signature) ? `device:${deviceId as string}` : null;
  }
  const code = liveCode(auth, codeHash);
  return code === null ? null : `code:${code.hash}`;
}

/** What `ticketIssuer` needs: the NAS's rendezvous key, its id (null without a rendezvous) and the clock. */
export interface TicketIssuerOptions {
  /** The base64url raw r || s ECDSA P-256 SHA-256 signature by the NAS's registered key (`RendezvousClient.sign`). */
  sign(message: Uint8Array<ArrayBuffer>): Promise<string>;
  /** This NAS's rendezvous id; null when it has no rendezvous, and then no ticket is issued. */
  nasId: string | null;
  /** The clock in milliseconds since the epoch. */
  now(): number;
}

/**
 * Issues a paired device's signalling ticket, valid `SIGNAL_TICKET_TTL_MS` (90 days), encoded for the device to store
 * and send with its socket upgrade; `me` and `pair/redeem` give it out. Null without a rendezvous id, and null when
 * signing fails, which is logged the first time only, so the answer it rides on still succeeds.
 */
export function ticketIssuer(opts: TicketIssuerOptions): (deviceId: string) => Promise<string | null> {
  let logged = false;
  return async (deviceId) => {
    const { nasId } = opts;
    if (nasId === null) return null;
    const exp = opts.now() + SIGNAL_TICKET_TTL_MS;
    try {
      const signature = await opts.sign(signalTicketMessage({ nasId, deviceId, exp }));
      return encodeTicket({ nasId, deviceId, exp, signature });
    } catch (err) {
      if (!logged) console.error('signalling: a ticket could not be signed; answering without one', err);
      logged = true;
      return null;
    }
  };
}

/** The ticket `issue` gives `deviceId`, or null without an issuer or when it throws. */
export async function signalTicketFor(issue: ((deviceId: string) => Promise<string | null>) | undefined, deviceId: string): Promise<string | null> {
  if (issue === undefined) return null;
  try {
    return await issue(deviceId);
  } catch {
    return null;
  }
}
