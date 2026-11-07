/*
 * The C string scanning that libass's parsers rely on (skip_spaces, strtoll, its own strtod), over JS strings with
 * index cursors, so ports read like the C.
 *
 * Ported from libass 0.17.5 (ass_utils.h, ass_utils.c, ass_strtod.c, ass_string.h): skip_spaces, rskip_spaces,
 * mystrtoi32, mystrtod, ass_strtod, ass_isspace, ass_isdigit, ass_strcasecmp. libass is ISC-licensed; see src/engine/NOTICE.
 * Modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

/** A position in a string, advanced by the scanning functions as libass advances its char pointers. */
export interface Cursor { s: string; i: number }

export const cursor = (s: string, i = 0): Cursor => ({ s, i });
export const ch = (c: Cursor, off = 0): string => c.s[c.i + off] ?? '';

export const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
export const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/** skip_spaces: blanks and tabs only. */
export function skipSpaces(c: Cursor): void {
  while (ch(c) === ' ' || ch(c) === '\t') c.i++;
}

/** rskip_spaces: the end index after dropping trailing blanks and tabs, not before `limit`. */
export function rskipSpaces(s: string, end: number, limit: number): number {
  while (end > limit && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
  return end;
}

/** ASCII case-insensitive comparison (ass_strcasecmp). */
export const strcaseeq = (a: string, b: string): boolean => a.length === b.length && a.toLowerCase() === b.toLowerCase();
export const startsWithCase = (s: string, prefix: string, at = 0): boolean => s.substr(at, prefix.length).toLowerCase() === prefix.toLowerCase();

const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

function digitValue(c: string, base: number): number {
  const code = c.charCodeAt(0);
  let d = -1;
  if (code >= 48 && code <= 57) d = code - 48;
  else if (code >= 97 && code <= 122) d = code - 87;
  else if (code >= 65 && code <= 90) d = code - 55;
  return d >= 0 && d < base ? d : -1;
}

/** C strtoll: leading isspace, sign, optional 0x for base 16; saturates; returns null when no digits were read (cursor untouched). */
export function strtoll(c: Cursor, base: number): number | null {
  let i = c.i;
  const s = c.s;
  while (isSpace(s[i] ?? '')) i++;
  let neg = false;
  if (s[i] === '+' || s[i] === '-') neg = s[i++] === '-';
  if (base === 16 && s[i] === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X') && digitValue(s[i + 2] ?? '', 16) >= 0) i += 2;
  const start = i;
  let v = 0n;
  while (i < s.length && digitValue(s[i]!, base) >= 0) v = v * BigInt(base) + BigInt(digitValue(s[i++]!, base));
  if (i === start) return null;
  c.i = i;
  const limit = neg ? 9223372036854775808n : 9223372036854775807n;
  if (v > limit) v = limit;
  return Number(neg ? -v : v);
}

/** mystrtoi32: strtoll clamped to int32; false (and *res unset) when nothing was read. */
export function mystrtoi32(c: Cursor, base: number): number | null {
  const v = strtoll(c, base);
  return v === null ? null : Math.min(INT32_MAX, Math.max(INT32_MIN, v));
}

const MAX_EXPONENT = 511;
const POWERS_OF_10 = [10, 100, 1e4, 1e8, 1e16, 1e32, 1e64, 1e128, 1e256];
const NEG_POW_OF_10 = [0.1, 0.01, 1e-4, 1e-8, 1e-16, 1e-32, 1e-64, 1e-128, 1e-256];
const DBL_MAX_10_EXP = 308;
const DBL_MIN_10_EXP = -307;

/** ass_strtod: libass's own strtod (Tcl's), exact rounding behaviour included. Advances the cursor past what it read. */
export function assStrtod(c: Cursor): number {
  const s = c.s;
  let p = c.i;
  while (isSpace(s[p] ?? '')) p++;
  let sign = false;
  if (s[p] === '-') { sign = true; p++; } else if (s[p] === '+') p++;

  let decPt = -1;
  let leadZeros = -1;
  let mantSize = 0;
  for (; ; mantSize++) {
    const d = s[p] ?? '';
    if (!isDigit(d)) {
      if (d !== '.' || decPt !== -1) break;
      decPt = mantSize;
    } else if (d !== '0' && leadZeros === -1) leadZeros = mantSize;
    p++;
  }
  if (leadZeros === -1) leadZeros = mantSize;
  const pExp = p;
  p -= mantSize - leadZeros;
  if (decPt === -1) decPt = mantSize;
  else {
    mantSize -= 1;
    if (decPt < leadZeros) leadZeros -= 1;
  }
  if (mantSize - leadZeros > 18) mantSize = leadZeros + 18;
  let fracExpSign: boolean;
  let fracExp: number;
  if (decPt < mantSize) { fracExpSign = true; fracExp = mantSize - decPt; } else { fracExpSign = false; fracExp = decPt - mantSize; }

  let fraction: number;
  if (mantSize === 0) {
    c.i = c.i; // nothing read: endPtr = string
    return sign ? -0 : 0;
  }
  mantSize -= leadZeros;
  let m = mantSize;
  let frac1 = 0;
  for (; m > 9; m--) {
    let d = s[p++]!;
    if (d === '.') d = s[p++]!;
    frac1 = 10 * frac1 + (d.charCodeAt(0) - 48);
  }
  let frac2 = 0;
  for (; m > 0; m--) {
    let d = s[p++]!;
    if (d === '.') d = s[p++]!;
    frac2 = 10 * frac2 + (d.charCodeAt(0) - 48);
  }
  fraction = 1.0e9 * frac1 + frac2;

  p = pExp;
  let exp = 0;
  let expSign: boolean;
  let overflow = false;
  if (s[p] === 'E' || s[p] === 'e') {
    p++;
    if (s[p] === '-') { expSign = true; p++; } else { if (s[p] === '+') p++; expSign = false; }
    const expLimit = expSign === fracExpSign
      ? (MAX_EXPONENT < fracExp ? 0 : Math.floor((MAX_EXPONENT - fracExp) / 10))
      : Math.floor(fracExp / 10) + Math.floor(((fracExp % 10) + MAX_EXPONENT) / 10);
    while (isDigit(s[p] ?? '')) {
      if (exp > expLimit) {
        do p++; while (isDigit(s[p] ?? ''));
        overflow = true;
        break;
      }
      exp = exp * 10 + (s.charCodeAt(p) - 48);
      p++;
    }
    if (!overflow) {
      if (expSign === fracExpSign) exp = fracExp + exp;
      else if (fracExp <= exp) exp = exp - fracExp;
      else { exp = fracExp - exp; expSign = fracExpSign; }
    }
  } else {
    exp = fracExp;
    expSign = fracExpSign;
  }
  if (overflow || exp > MAX_EXPONENT) exp = MAX_EXPONENT;

  let table = POWERS_OF_10;
  if (!(exp <= DBL_MAX_10_EXP || !expSign)) {
    if (exp > -DBL_MIN_10_EXP) {
      exp -= mantSize;
      let dblExp = 1.0;
      for (let k = 0, n = mantSize; n !== 0; n >>= 1, k++) if (n & 1) dblExp *= POWERS_OF_10[k]!;
      fraction /= dblExp;
    }
    table = NEG_POW_OF_10;
    expSign = false;
  }
  let dblExp = 1.0;
  for (let k = 0; exp !== 0; exp = Math.floor(exp / 2), k++) if (exp & 1) dblExp *= table[k] ?? Infinity;
  fraction = expSign ? fraction / dblExp : fraction * dblExp;
  c.i = p;
  return sign ? -fraction : fraction;
}

/** mystrtod: ass_strtod, and whether anything was read. */
export function mystrtod(c: Cursor): number | null {
  const start = c.i;
  const v = assStrtod(c);
  return c.i === start ? null : v;
}

/** ass_atof */
export const atof = (s: string): number => assStrtod(cursor(s));
