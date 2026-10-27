import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PAIRING_ALPHABET, codeHash, formatCode, newCode, normalizeCode, pairingLink } from './codes';

describe('pairing codes', () => {
  it('newCode gives 12 characters from the Crockford alphabet', () => {
    expect(PAIRING_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    for (let i = 0; i < 50; i++) {
      const code = newCode((n) => crypto.getRandomValues(new Uint8Array(n)));
      expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/);
    }
  });

  it('newCode maps each byte modulo 32 onto the alphabet', () => {
    expect(newCode((n) => Uint8Array.from({ length: n }, (_, k) => k * 3 + 64))).toBe('0369CFJNRVY1');
    expect(newCode((n) => new Uint8Array(n).fill(255))).toBe('ZZZZZZZZZZZZ');
  });

  it('normalizes case and dashes', () => {
    expect(normalizeCode('k7qm-4xp2-r9td')).toBe('K7QM4XP2R9TD');
  });

  it('reads O as 0 and I or L as 1, and drops spaces', () => {
    expect(normalizeCode('K7QM 4XP2 R9TO')).toBe('K7QM4XP2R9T0');
    expect(normalizeCode('i7ql-4xp2-r9td')).toBe('17Q14XP2R9TD');
  });

  it.each(['K7QM4XP2R9T', 'K7QM4XP2R9TDX', 'K7QM4XP2R9TU', '', 'K7QM_4XP2R9TD'])('rejects %j', (input) => {
    expect(normalizeCode(input)).toBeNull();
  });

  it('formatCode groups by four', () => {
    expect(formatCode('K7QM4XP2R9TD')).toBe('K7QM-4XP2-R9TD');
  });

  it('codeHash is the hex SHA-256 of the normalized code', () => {
    const expected = createHash('sha256').update('K7QM4XP2R9TD').digest('hex');
    expect(codeHash('K7QM4XP2R9TD')).toBe(expected);
    expect(codeHash('k7qm-4xp2-r9td')).toBe(expected);
    expect(() => codeHash('nope')).toThrow();
  });

  it('codeHash matches the rendezvous Worker on the shared test vector', () => {
    // Same vector as rendezvous/src/worker.test.ts, which hashes with WebCrypto.
    expect(codeHash('k7qm-4xp2-r9td')).toBe('0f54f555d41af4fe0469424a47ffcbfb19a84d3629a0cbc0ffa8385557ea6dbf');
  });

  it('pairingLink names the Worker when there is one, else the server itself', () => {
    const o = { appUrl: 'https://bluray.pages.dev/', publicBase: 'https://nas.example.com/bluray/api/' };
    expect(pairingLink('ABCD-2345-EFGH', { ...o, rendezvousUrl: 'https://rendezvous.example.workers.dev' })).toBe(
      'https://bluray.pages.dev/?pair=ABCD2345EFGH&rv=https%3A%2F%2Frendezvous.example.workers.dev',
    );
    expect(pairingLink('ABCD2345EFGH', { ...o, rendezvousUrl: undefined })).toBe(
      'https://bluray.pages.dev/?pair=ABCD2345EFGH&nas=https%3A%2F%2Fnas.example.com%2Fbluray%2Fapi%2F',
    );
  });
});
