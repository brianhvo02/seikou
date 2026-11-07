import { describe, expect, it } from 'vitest';
import { assStrtod, cursor, mystrtod, mystrtoi32, rskipSpaces, skipSpaces } from './cstr';

describe('assStrtod', () => {
  it('reads decimals, exponents and stops where C would', () => {
    const c = cursor('  -2.5e2xyz');
    expect(assStrtod(c)).toBe(-250);
    expect(c.i).toBe(8);
    expect(assStrtod(cursor('.5'))).toBe(0.5);
    expect(assStrtod(cursor('7.'))).toBe(7);
    expect(assStrtod(cursor('1e400'))).toBe(Infinity);
    expect(assStrtod(cursor('1e-400'))).toBe(0);
  });

  it('reads nothing from a non-number', () => {
    expect(mystrtod(cursor('abc'))).toBeNull();
    expect(mystrtod(cursor('-'))).toBeNull();
    const c = cursor('e5');
    expect(mystrtod(c)).toBeNull();
    expect(c.i).toBe(0);
  });

  it('agrees with Number() on ordinary values', () => {
    for (const s of ['0', '1', '2.25', '100', '0.1', '123.456', '3e-3', '99999999999999999999']) expect(assStrtod(cursor(s))).toBe(Number(s));
  });
});

describe('mystrtoi32', () => {
  it('reads with a sign, saturates to int32 and leaves the cursor on failure', () => {
    expect(mystrtoi32(cursor(' -42,'), 10)).toBe(-42);
    expect(mystrtoi32(cursor('99999999999'), 10)).toBe(0x7fffffff);
    expect(mystrtoi32(cursor('ff'), 16)).toBe(255);
    expect(mystrtoi32(cursor('0x1F'), 16)).toBe(31);
    const c = cursor('x1');
    expect(mystrtoi32(c, 10)).toBeNull();
    expect(c.i).toBe(0);
  });
});

describe('spaces', () => {
  it('skips blanks and tabs only, both ways', () => {
    const c = cursor(' \t\nx');
    skipSpaces(c);
    expect(c.i).toBe(2);
    expect(rskipSpaces('ab \t', 4, 0)).toBe(2);
    expect(rskipSpaces('  ', 2, 1)).toBe(1);
  });
});
