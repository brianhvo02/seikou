/*
 * java.lang.StrictMath natives of the BD-J virtual machine.
 *
 * exp and IEEEremainder are ported from fdlibm 5.3's e_exp.c and e_remainder.c, which the JDK's StrictMath uses:
 *   Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *   Developed at SunSoft, a Sun Microsystems, Inc. business.
 *   Permission to use, copy, modify, and distribute this software is freely granted, provided that this notice
 *   is preserved.
 * The other functions map onto JS Math, as DoppioJVM's src/natives/java_lang.ts does (MIT; see src/bdj/NOTICE).
 *
 * Copyright (C) 2026 Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { NativeTable } from './index';

const words = new DataView(new ArrayBuffer(8));
const hi = (x: number): number => {
  words.setFloat64(0, x);
  return words.getInt32(0);
};
const lo = (x: number): number => {
  words.setFloat64(0, x);
  return words.getUint32(4);
};
const withHi = (x: number, h: number): number => {
  words.setFloat64(0, x);
  words.setInt32(0, h);
  return words.getFloat64(0);
};

const HUGE = 1.0e300;
const TWOM1000 = 9.33263618503218878990e-302;
const O_THRESHOLD = 7.09782712893383973096e2;
const U_THRESHOLD = -7.45133219101941108420e2;
const LN2HI = [6.93147180369123816490e-1, -6.93147180369123816490e-1];
const LN2LO = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
const HALF = [0.5, -0.5];
const INVLN2 = 1.44269504088896338700;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.65339022054652515390e-6;
const P5 = 4.13813679705723846039e-8;

/** fdlibm __ieee754_exp (e_exp.c). */
export function fdlibmExp(x: number): number {
  let hx = hi(x);
  const xsb = (hx >>> 31) & 1;
  hx &= 0x7fffffff;
  let hiPart = 0;
  let loPart = 0;
  let k = 0;
  if (hx >= 0x40862e42) {
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | lo(x)) !== 0) return x + x;
      return xsb === 0 ? x : 0.0;
    }
    if (x > O_THRESHOLD) return HUGE * HUGE;
    if (x < U_THRESHOLD) return TWOM1000 * TWOM1000;
  }
  if (hx > 0x3fd62e42) {
    if (hx < 0x3ff0a2b2) {
      hiPart = x - LN2HI[xsb]!;
      loPart = LN2LO[xsb]!;
      k = 1 - xsb - xsb;
    } else {
      k = Math.trunc(INVLN2 * x + HALF[xsb]!);
      const t = k;
      hiPart = x - t * LN2HI[0]!;
      loPart = t * LN2LO[0]!;
    }
    x = hiPart - loPart;
  } else if (hx < 0x3e300000) {
    if (HUGE + x > 1) return 1 + x;
  } else {
    k = 0;
  }
  const t = x * x;
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2.0) - x);
  const y = 1 - (loPart - (x * c) / (2.0 - c) - hiPart);
  if (k >= -1021) return withHi(y, hi(y) + (k << 20));
  return withHi(y, hi(y) + ((k + 1000) << 20)) * TWOM1000;
}

/** fdlibm __ieee754_remainder (e_remainder.c); JS `%` is C's fmod, exact as __ieee754_fmod is. */
export function fdlibmRemainder(x: number, p: number): number {
  let hx = hi(x);
  const lx = lo(x);
  let hp = hi(p);
  const lp = lo(p);
  const sx = hx & 0x80000000;
  hp &= 0x7fffffff;
  hx &= 0x7fffffff;
  if ((hp | lp) === 0) return (x * p) / (x * p);
  if (hx >= 0x7ff00000 || (hp >= 0x7ff00000 && ((hp - 0x7ff00000) | lp) !== 0)) return (x * p) / (x * p);
  if (hp <= 0x7fdfffff) x = x % (p + p);
  if (((hx - hp) | (lx - lp)) === 0) return 0 * x;
  x = Math.abs(x);
  p = Math.abs(p);
  if (hp < 0x00200000) {
    if (x + x > p) {
      x -= p;
      if (x + x >= p) x -= p;
    }
  } else {
    const pHalf = 0.5 * p;
    if (x > pHalf) {
      x -= p;
      if (x >= pHalf) x -= p;
    }
  }
  return withHi(x, hi(x) ^ sx);
}

const d = (f: (x: number) => number) => (_ctx: unknown, x: unknown): number => f(x as number);
const dd = (f: (x: number, y: number) => number) => (_ctx: unknown, x: unknown, y: unknown): number => f(x as number, y as number);

/** Registers the java.lang.StrictMath natives: exp and IEEEremainder from fdlibm, the others onto JS Math. */
export function registerStrictMathNatives(table: NativeTable): void {
  table.register({
    'java/lang/StrictMath.exp(D)D': d(fdlibmExp),
    // The rest map onto JS Math as DoppioJVM does; V8 implements these with fdlibm ports, so most agree bit for bit.
    'java/lang/StrictMath.sin(D)D': d(Math.sin),
    'java/lang/StrictMath.cos(D)D': d(Math.cos),
    'java/lang/StrictMath.tan(D)D': d(Math.tan),
    'java/lang/StrictMath.asin(D)D': d(Math.asin),
    'java/lang/StrictMath.acos(D)D': d(Math.acos),
    'java/lang/StrictMath.atan(D)D': d(Math.atan),
    'java/lang/StrictMath.log(D)D': d(Math.log),
    'java/lang/StrictMath.log10(D)D': d(Math.log10),
    'java/lang/StrictMath.sqrt(D)D': d(Math.sqrt),
    'java/lang/StrictMath.cbrt(D)D': d(Math.cbrt),
    'java/lang/StrictMath.IEEEremainder(DD)D': dd(fdlibmRemainder),
    'java/lang/StrictMath.atan2(DD)D': dd(Math.atan2),
    'java/lang/StrictMath.pow(DD)D': dd(Math.pow),
    'java/lang/StrictMath.sinh(D)D': d(Math.sinh),
    'java/lang/StrictMath.cosh(D)D': d(Math.cosh),
    'java/lang/StrictMath.tanh(D)D': d(Math.tanh),
    'java/lang/StrictMath.hypot(DD)D': dd(Math.hypot),
    'java/lang/StrictMath.expm1(D)D': d(Math.expm1),
    'java/lang/StrictMath.log1p(D)D': d(Math.log1p),
  });
}
