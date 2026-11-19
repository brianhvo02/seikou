// SPDX-License-Identifier: LGPL-3.0-or-later
import type { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ECDSA_KEY, ECDSA_SIGN, SIGNAL_TICKET_TTL_MS, base64url, decodeTicket, fromBase64url, offerProofMessage, signalTicketMessage, turnProofMessage,
} from '../../../rendezvous/src/protocol';
import { Auth } from '../auth';
import { codeHash } from '../codes';
import { Store } from '../store';
import { checkOfferProof, ticketIssuer } from './signal-proof';

// Every name here is made up.

type JsonWebKey = webcrypto.JsonWebKey;

const SID = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_SID = 'BBBBBBBBBBBBBBBBBBBBBB';

let tmp: string;
let clock: number;
let auth: Auth;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'signal-proof-'));
  clock = Date.UTC(2026, 10, 19, 12);
  auth = new Auth(new Store(join(tmp, 'data')), () => clock);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function pairedDevice(): Promise<{ deviceId: string; sign: (m: Uint8Array<ArrayBuffer>) => Promise<string> }> {
  const pair = await crypto.subtle.generateKey(ECDSA_KEY, false, ['sign', 'verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const { code } = auth.createCode({ newPerson: { name: 'Mika', owner: false } });
  const device = auth.redeem(code, 'Phone', jwk)!;
  const sign = async (m: Uint8Array<ArrayBuffer>) => base64url(new Uint8Array(await crypto.subtle.sign(ECDSA_SIGN, pair.privateKey, m)));
  return { deviceId: device.id, sign };
}

describe('checkOfferProof', () => {
  it("gives device:<id> for a paired device's signature over the offer message", async () => {
    const { deviceId, sign } = await pairedDevice();
    const signature = await sign(offerProofMessage({ sid: SID }));
    expect(checkOfferProof(auth, SID, { deviceId, signature })).toBe(`device:${deviceId}`);
  });

  it('refuses the signature for another sid, a TURN proof, an unknown device and no proof', async () => {
    const { deviceId, sign } = await pairedDevice();
    const signature = await sign(offerProofMessage({ sid: SID }));
    expect(checkOfferProof(auth, OTHER_SID, { deviceId, signature })).toBeNull();
    const turn = await sign(turnProofMessage({ sid: SID, ts: clock }));
    expect(checkOfferProof(auth, SID, { deviceId, signature: turn })).toBeNull();
    expect(checkOfferProof(auth, SID, { deviceId: 'nobody', signature })).toBeNull();
    for (const proof of [undefined, null, 'x', [], {}, { deviceId }, { signature }, { codeHash: 7 }]) {
      expect(checkOfferProof(auth, SID, proof)).toBeNull();
    }
  });

  it("gives code:<hash> for a live code's hash, plain or invite, and null once it is spent or expired", () => {
    const owner = auth.firstOwnerPerson();
    const plain = auth.createCode({ personId: owner.id });
    const invite = auth.createCode({ personId: owner.id }, { invite: true });
    const plainHash = codeHash(plain.code);
    const inviteHash = codeHash(invite.code);
    expect(checkOfferProof(auth, SID, { codeHash: plainHash })).toBe(`code:${plainHash}`);
    expect(checkOfferProof(auth, SID, { codeHash: inviteHash })).toBe(`code:${inviteHash}`);
    expect(checkOfferProof(auth, SID, { codeHash: 'f'.repeat(64) })).toBeNull();
    clock = plain.record.expiresAt;
    expect(checkOfferProof(auth, SID, { codeHash: plainHash })).toBeNull();
    expect(checkOfferProof(auth, SID, { codeHash: inviteHash })).toBe(`code:${inviteHash}`);
  });
});

describe('ticketIssuer', () => {
  it('signs a ticket the Worker can read and verify, valid for 90 days', async () => {
    const nas = await crypto.subtle.generateKey(ECDSA_KEY, false, ['sign', 'verify']);
    const sign = async (m: Uint8Array<ArrayBuffer>) => base64url(new Uint8Array(await crypto.subtle.sign(ECDSA_SIGN, nas.privateKey, m)));
    const issue = ticketIssuer({ sign, nasId: 'N'.repeat(43), now: () => clock });
    const text = await issue('device-1');
    expect(typeof text).toBe('string');
    const ticket = decodeTicket(text!)!;
    expect(ticket).toEqual({ nasId: 'N'.repeat(43), deviceId: 'device-1', exp: clock + SIGNAL_TICKET_TTL_MS, signature: expect.any(String) });
    const message = signalTicketMessage({ nasId: ticket.nasId, deviceId: ticket.deviceId, exp: ticket.exp });
    expect(await crypto.subtle.verify(ECDSA_SIGN, nas.publicKey, fromBase64url(ticket.signature)!, message)).toBe(true);
  });

  it('gives null without a rendezvous id', async () => {
    const sign = vi.fn(async () => 'sig');
    expect(await ticketIssuer({ sign, nasId: null, now: () => clock })('device-1')).toBeNull();
    expect(sign).not.toHaveBeenCalled();
  });

  it('gives null, and logs only the first time, when signing fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const issue = ticketIssuer({ sign: async () => Promise.reject(new Error('no key')), nasId: 'N'.repeat(43), now: () => clock });
    expect(await issue('device-1')).toBeNull();
    expect(await issue('device-2')).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
