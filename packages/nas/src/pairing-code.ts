/** NAS pairing codes, shared by the server and the app: 12 characters of Crockford base32, shown `XXXX-XXXX-XXXX`. */

export const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const PAIRING_CODE_LENGTH = 12;

const VALID = new RegExp(`^[${PAIRING_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

/** Upper-cases, drops dashes and spaces, reads O as 0 and I or L as 1; null unless that leaves 12 valid characters. */
export function normalizeCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return VALID.test(code) ? code : null;
}

/** 'K7QM4XP2R9TD' → 'K7QM-4XP2-R9TD'. */
export function formatCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? '';
}
