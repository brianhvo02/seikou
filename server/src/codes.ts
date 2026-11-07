import { createHash } from 'node:crypto';
import { PAIRING_ALPHABET, PAIRING_CODE_LENGTH, formatCode, normalizeCode } from '@seikou/nas/pairing-code';

export { PAIRING_ALPHABET, formatCode, normalizeCode };

/** Where a code is registered so a device can find this NAS from the code alone (Task 5's rendezvous client). */
export interface CodeRegistrar {
  registerCode(codeHash: string, routes: { https: string }, expiresAt: number): Promise<void>;
  /** Takes a code the NAS no longer needs (spent or withdrawn) off the service, freeing its place under the per-NAS cap. */
  unregisterCode(codeHash: string): Promise<void>;
}

/** Unregisters codes in the background, best effort: a failure is logged, and the code still expires on its own. */
export function unregisterCodes(registrar: CodeRegistrar | undefined, hashes: readonly string[]): void {
  if (!registrar) return;
  for (const hash of hashes) {
    registrar.unregisterCode(hash).catch((err: unknown) => console.error('rendezvous unregistration failed', err));
  }
}

/** A fresh code; 32 symbols divide 256, so masking each byte is unbiased (60 bits in all). */
export function newCode(random: (n: number) => Uint8Array): string {
  return Array.from(random(PAIRING_CODE_LENGTH), (byte) => PAIRING_ALPHABET[byte & 31]).join('');
}

/** Hex SHA-256 of the normalized code. Throws on a string that isn't a code. */
export function codeHash(code: string): string {
  const normalized = normalizeCode(code);
  if (normalized === null) throw new Error('not a pairing code');
  return createHash('sha256').update(normalized).digest('hex');
}

/** What the QR encodes and the app opens straight into pairing. It names the Worker (`rv`) or, without one, this server (`nas`), so the app needs no built-in address. */
export function pairingLink(code: string, o: { appUrl: string; publicBase: string; rendezvousUrl: string | undefined }): string {
  const route = o.rendezvousUrl === undefined ? `nas=${encodeURIComponent(o.publicBase)}` : `rv=${encodeURIComponent(o.rendezvousUrl)}`;
  return `${o.appUrl}?pair=${normalizeCode(code) ?? code}&${route}`;
}
