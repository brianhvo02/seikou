import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NativeTable, registerBootstrapNatives, registerJdkNatives, registerSchedulerNatives } from './index';
import type { BdjHost } from '../../host';
import { registerLibblurayNatives } from './libbluray';
import { fdlibmExp, fdlibmRemainder } from './strictmath';

function table(): NativeTable {
  const t = new NativeTable();
  registerBootstrapNatives(t);
  registerSchedulerNatives(t);
  registerJdkNatives(t);
  registerLibblurayNatives(t, {} as BdjHost);
  return t;
}

describe('JDK natives', () => {
  it('implements every native natives.txt lists', () => {
    const listed = readFileSync(fileURLToPath(new URL('../../../../../tests/bdj/natives.txt', import.meta.url)), 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    const keys = new Set(table().keys);
    const missing = listed.filter((k) => !keys.has(k));
    const byPackage: Record<string, string[]> = {};
    for (const k of missing) (byPackage[k.slice(0, k.lastIndexOf('/'))] ??= []).push(k);
    expect(byPackage).toEqual({});
  });

  it('StrictMath.exp is fdlibm, not JS Math', () => {
    expect(fdlibmExp(1)).toBe(2.7182818284590455);
    expect(fdlibmExp(0)).toBe(1);
    expect(fdlibmExp(-1)).toBe(0.36787944117144233);
    expect(fdlibmExp(710)).toBe(Infinity);
    expect(fdlibmExp(-746)).toBe(0);
    expect(fdlibmExp(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(fdlibmExp(NaN)).toBeNaN();
    expect(fdlibmExp(1e-300)).toBe(1);
  });

  it('StrictMath.IEEEremainder is fdlibm: x - p*n with n the nearest integer to x/p, ties to even', () => {
    expect(fdlibmRemainder(5, 3)).toBe(-1);
    expect(fdlibmRemainder(-5, 3)).toBe(1);
    expect(fdlibmRemainder(3, 2)).toBe(-1);
    expect(fdlibmRemainder(5, 2)).toBe(1);
    expect(fdlibmRemainder(7.5, 2)).toBe(-0.5);
    expect(Object.is(fdlibmRemainder(-6, 3), -0)).toBe(true);
    expect(Object.is(fdlibmRemainder(6, -3), 0)).toBe(true);
    expect(fdlibmRemainder(1, Infinity)).toBe(1);
    expect(fdlibmRemainder(1, 0)).toBeNaN();
    expect(fdlibmRemainder(Infinity, 1)).toBeNaN();
    expect(fdlibmRemainder(1, NaN)).toBeNaN();
    expect(fdlibmRemainder(3 * 2 ** -1070, 2 * 2 ** -1070)).toBe(-(2 ** -1070));
  });
});
