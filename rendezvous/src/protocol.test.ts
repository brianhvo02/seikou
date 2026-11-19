// SPDX-License-Identifier: LGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { base64url, decodeTicket, encodeTicket, offerProofMessage, turnProofMessage } from './protocol';

const enc = (s: string): string => base64url(new TextEncoder().encode(s));

describe('signalling wire pieces', () => {
  it('offer and TURN proof messages differ for the same sid', () => {
    expect(offerProofMessage({ sid: 's1' })).not.toEqual(turnProofMessage({ sid: 's1', ts: 0 }));
    expect(new TextDecoder().decode(offerProofMessage({ sid: 's1' }))).toBe('{"type":"offer","sid":"s1"}');
  });

  it('a ticket survives encode and decode', () => {
    const ticket = { nasId: 'n', deviceId: 'd', exp: 123456, signature: 'sig' };
    expect(decodeTicket(encodeTicket(ticket))).toEqual(ticket);
  });

  it('decodeTicket refuses junk', () => {
    expect(decodeTicket('%%%')).toBeNull();
    expect(decodeTicket(enc('[]'))).toBeNull();
    expect(decodeTicket(enc(JSON.stringify({ nasId: 'n', deviceId: 'd', exp: 'x', signature: 's' })))).toBeNull();
    expect(decodeTicket('a'.repeat(1025))).toBeNull();
  });
});
