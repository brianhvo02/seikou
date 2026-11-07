/*
 * Original code for bluray-web: intrinsics for the arithmetic under jar signature checks, which the JDK runs on every
 * signed disc jar: sun.security.provider.SHA.implCompress0 (one SHA-1 block over the W and state fields) and
 * java.math.BigInteger.implMulAdd (a multiply-accumulate row of RSA's modPow). Both implement the specified algorithm
 * (FIPS 180-4's SHA-1 compression; schoolbook multi-word multiply-accumulate); checked against the class library by the
 * equivalence tests (tests/bdj/intrinsics.test.ts), int for int.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { JArray, JObject } from '../../values';
import { DECLINE, perClass, slotOf } from './common';
import type { IntrinsicFn } from './common';

const shaSlots = perClass((cls) => ({ W: slotOf(cls, 'W', '[I'), state: slotOf(cls, 'state', '[I') }));

/**
 * SHA.implCompress0(byte[] buf, int ofs): its arguments are unused (implCompressCheck has already filled W[0..15]);
 * expands W[16..79], runs the 80 rounds and adds into state[0..4].
 */
const shaCompress: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const fields = (stack[base] as JObject).fields;
  const s = shaSlots(m.cls);
  const wArr = fields[s.W] as JArray | null;
  const stateArr = fields[s.state] as JArray | null;
  if (wArr === null || stateArr === null || wArr.data.length < 80 || stateArr.data.length < 5) return DECLINE;
  const W = wArr.data as Int32Array;
  const state = stateArr.data as Int32Array;
  for (let t = 16; t <= 79; t++) {
    const temp = W[t - 3]! ^ W[t - 8]! ^ W[t - 14]! ^ W[t - 16]!;
    W[t] = (temp << 1) | (temp >>> 31);
  }
  let a = state[0]!;
  let b = state[1]!;
  let c = state[2]!;
  let d = state[3]!;
  let e = state[4]!;
  for (let i = 0; i < 80; i++) {
    const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
    const k = i < 20 ? 1518500249 : i < 40 ? 1859775393 : i < 60 ? -1894007588 : -899497514;
    const temp = (((a << 5) | (a >>> 27)) + f + e + W[i]! + k) | 0;
    e = d;
    d = c;
    c = (b << 30) | (b >>> 2);
    b = a;
    a = temp;
  }
  state[0] = (state[0]! + a) | 0;
  state[1] = (state[1]! + b) | 0;
  state[2] = (state[2]! + c) | 0;
  state[3] = (state[3]! + d) | 0;
  state[4] = (state[4]! + e) | 0;
  return undefined;
};

const TWO_32 = 4294967296;

/**
 * BigInteger.implMulAdd(int[] out, int[] in, int offset, int len, int k) (static): out[...] += in[...] * k from the
 * least significant word, as unsigned 32-bit words with a carry; returns the carry. The 64-bit products are split into
 * 16-bit halves so every step is exact in doubles.
 */
export const mulAdd: IntrinsicFn = (_jvm, _t, _m, stack, base) => {
  const outArr = stack[base] as JArray | null;
  const inArr = stack[base + 1] as JArray | null;
  let offset = stack[base + 2] as number;
  const len = stack[base + 3] as number;
  const k = (stack[base + 4] as number) >>> 0;
  if (outArr === null) return DECLINE;
  const out = outArr.data as Int32Array;
  offset = (out.length - offset - 1) | 0;
  if (len > 0 && (inArr === null || len > inArr.data.length || offset >= out.length || offset - len + 1 < 0)) return DECLINE;
  const input = len > 0 ? (inArr!.data as Int32Array) : null;
  const kl = k & 0xffff;
  const kh = k >>> 16;
  let carry = 0;
  for (let j = len - 1; j >= 0; j--) {
    const a = input![j]! >>> 0;
    const al = a & 0xffff;
    const ah = a >>> 16;
    const mid = ah * kl + al * kh; // < 2^33
    const x = al * kl + (out[offset]! >>> 0) + carry + (mid % 65536) * 65536; // < 2^34
    const low = x % TWO_32;
    carry = ah * kh + Math.floor(mid / 65536) + Math.floor(x / TWO_32); // the product's high word: < 2^32
    out[offset--] = low;
  }
  return carry | 0;
};

export const cryptoIntrinsics: Readonly<Record<string, IntrinsicFn>> = {
  'sun/security/provider/SHA.implCompress0([BI)V': shaCompress,
  'java/math/BigInteger.implMulAdd([I[IIII)I': mulAdd,
};
