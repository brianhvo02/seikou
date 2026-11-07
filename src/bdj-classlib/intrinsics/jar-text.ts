/*
 * Intrinsics and loop hooks for the text and byte scanning the JDK does while it opens, verifies and mounts a signed
 * disc jar (manifest lines, manifest sections, attribute names, java.security, file paths), and that a disc's own
 * start-up code does reading its data files (DataInputStream over a ByteArrayInputStream), with the HashMap sizing and
 * BigInteger word helpers (and the one BigInteger(String) uses) that the jar signature check runs: the start-up path of a BD-J disc. Each does what its Java
 * code does, or declines to it.
 *
 * Derived from OpenJDK 8 (the class library in src/bdj-classlib/rt-bdj.jar, whose source is named in
 * src/bdj-classlib/NOTICE); see NOTICE in this directory.
 * Copyright (c) 1995, 2013, Oracle and/or its affiliates. All rights reserved.
 * Modified for bluray-web (2026).
 *
 * This code is free software; you can redistribute it and/or modify it under the terms of the GNU General Public
 * License version 2 only, as published by the Free Software Foundation, with the Classpath Exception (see LICENSE and
 * ASSEMBLY_EXCEPTION in src/bdj-classlib/).
 *
 * SPDX-License-Identifier: GPL-2.0-only WITH Classpath-exception-2.0
 */

import type { JClass } from '../../bdj/jvm/loader';
import type { Jvm } from '../../bdj/jvm/jvm';
import type { JArray, JObject, JValue } from '../../bdj/jvm/values';
import { DECLINE, monitorFree, perClass, slotOf } from '../../bdj/jvm/natives/intrinsics/common';
import { mulAdd } from '../../bdj/jvm/natives/intrinsics/crypto';
import type { IntrinsicFn, LoopHook, LoopHookFn } from '../../bdj/jvm/natives/intrinsics/common';

const stringValue = perClass((cls) => slotOf(cls, 'value', '[C'));

/** The chars of a java.lang.String, or null (a null string, or one without its value). */
function chars(s: JValue | undefined): Uint16Array | null {
  if (s === null || s === undefined || typeof s !== 'object' || !('fields' in s)) return null;
  const v = s.fields[stringValue(s.cls)] as JArray | null;
  return v === null ? null : (v.data as Uint16Array);
}

const readyClasses = new WeakMap<Jvm, Map<string, JClass>>();

/** Whether a boot class is initialised, so a static call into it that the bytecode makes has nothing else to do. */
function ready(jvm: Jvm, name: string): boolean {
  let byName = readyClasses.get(jvm);
  if (!byName) readyClasses.set(jvm, (byName = new Map()));
  let c = byName.get(name);
  if (!c) {
    const loaded = jvm.loader.loadBoot(name);
    if (!loaded) return false;
    byName.set(name, (c = loaded));
  }
  return c.state === 'initialized';
}

// ---- java.util.jar.Manifest$FastInputStream.readLine(byte[], int, int) ----

/**
 * The scan for the end of the line, hooked at its goto (pc 103) with locals 4 = tbuf, 8 = tpos, 9 = maxpos:
 *   while (tpos < maxpos && tbuf[tpos++] != '\n') ;
 * Exits to pc 106.
 */
const fastReadLineScan: LoopHookFn = (_jvm, _t, _m, locals) => {
  const bufArr = locals[4] as JArray | null;
  let tpos = locals[8] as number;
  const maxpos = locals[9] as number;
  if (bufArr === null) return DECLINE;
  const buf = bufArr.data as Int8Array;
  if (tpos < 0 || maxpos > buf.length) return DECLINE; // the bytecode throws (or reads) where the hook would not
  while (tpos < maxpos && buf[tpos++] !== 10);
  locals[8] = tpos;
  return 106;
};

const fastStreamSlots = perClass((cls) => ({ buf: slotOf(cls, 'buf', '[B'), count: slotOf(cls, 'count', 'I'), pos: slotOf(cls, 'pos', 'I') }));

/**
 * The whole of readLine(byte[] b, int off, int len) when the buffer holds the line (up to its '\n', or len bytes):
 * those bytes are copied to b and pos moves past them; returns how many. When the buffer would need refilling first,
 * or the bytecode would throw, it runs instead.
 */
const fastReadLine: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const self = stack[base] as JObject;
  const bArr = stack[base + 1] as JArray | null;
  const off = stack[base + 2] as number;
  const len = stack[base + 3] as number;
  if (len <= 0) return 0; // the loop does not run
  const s = fastStreamSlots(m.cls);
  const bufArr = self.fields[s.buf] as JArray | null;
  const count = self.fields[s.count] as number;
  const pos = self.fields[s.pos] as number;
  if (bufArr === null || bArr === null) return DECLINE;
  const buf = bufArr.data as Int8Array;
  const avail = count - pos;
  if (avail <= 0 || pos < 0 || count > buf.length) return DECLINE; // fill() first
  const n = Math.min(len, avail);
  let tpos = pos;
  while (tpos < pos + n && buf[tpos++] !== 10);
  const got = tpos - pos;
  // the line goes on past the buffer: the bytecode refills it and loops
  if (buf[tpos - 1] !== 10 && got < len) return DECLINE;
  const out = bArr.data as Int8Array;
  if (off < 0 || off + got > out.length) return DECLINE; // System.arraycopy throws
  out.set(buf.subarray(pos, tpos), off);
  self.fields[s.pos] = tpos;
  return got;
};

// ---- java.util.Properties$LineReader.readLine() ----

const lineReaderSlots = perClass((cls) => ({
  inOff: slotOf(cls, 'inOff', 'I'),
  inLimit: slotOf(cls, 'inLimit', 'I'),
  inStream: slotOf(cls, 'inStream', 'Ljava/io/InputStream;'),
  inByteBuf: slotOf(cls, 'inByteBuf', '[B'),
  lineBuf: slotOf(cls, 'lineBuf', '[C'),
}));

/**
 * The path of an ordinary character, hooked at its goto back to the loop head (pc 344), reached with the character in
 * lineBuf and skipLF (local 8), skipWhiteSpace (3), isNewLine (5) and precedingBackslash (7) all false; locals 1 = len,
 * 2 = c. Takes the next characters from inByteBuf while each is ordinary (not '\n', '\r' or '\\') and fits in lineBuf
 * without growing it, as the loop does:
 *   c = (char) (0xff & inByteBuf[inOff++]); lineBuf[len++] = c; precedingBackslash = false;
 * and goes back to the loop head (pc 21) for the first one that is not, or when inByteBuf needs refilling.
 */
const lineReaderChars: LoopHookFn = (_jvm, _t, m, locals) => {
  const self = locals[0] as JObject;
  const s = lineReaderSlots(m.cls);
  const f = self.fields;
  if (f[s.inStream] === null) return DECLINE; // a Reader's chars: left to the bytecode
  const inArr = f[s.inByteBuf] as JArray | null;
  const lineArr = f[s.lineBuf] as JArray | null;
  if (inArr === null || lineArr === null) return DECLINE;
  const inBuf = inArr.data as Int8Array;
  const line = lineArr.data as Uint16Array;
  let inOff = f[s.inOff] as number;
  const inLimit = f[s.inLimit] as number;
  let len = locals[1] as number;
  let c = locals[2] as number;
  if (inOff < 0 || len < 0) return DECLINE;
  const limit = Math.min(inLimit, inBuf.length);
  while (inOff < limit && len < line.length - 1) {
    const next = inBuf[inOff]! & 0xff;
    if (next === 10 || next === 13 || next === 92) break;
    c = next;
    line[len++] = c;
    inOff++;
  }
  f[s.inOff] = inOff;
  locals[1] = len;
  locals[2] = c;
  return 21;
};

// ---- sun.security.util.ManifestDigester.findSection(int, Position) ----

const digesterSlots = perClass((cls) => ({ rawBytes: slotOf(cls, 'rawBytes', '[B') }));

/**
 * The scan over a section's bytes, hooked at the loop's goto back to its head (pc 172), reached with i (local 3)
 * advanced; locals 4 = len, 7 = allBlank, 9 = c. Skips the bytes that are neither '\n' nor '\r', as the loop's default
 * case does:
 *   c = rawBytes[i]; allBlank = false; i++;
 * and goes back to the loop head (pc 23) at the first line end, or at len.
 */
const findSectionScan: LoopHookFn = (_jvm, _t, m, locals) => {
  const rawArr = (locals[0] as JObject).fields[digesterSlots(m.cls).rawBytes] as JArray | null;
  if (rawArr === null) return DECLINE;
  const raw = rawArr.data as Int8Array;
  let i = locals[3] as number;
  const len = locals[4] as number;
  if (i < 0) return DECLINE;
  const limit = Math.min(len, raw.length);
  const start = i;
  let c = locals[9] as number;
  while (i < limit) {
    const b = raw[i]!;
    if (b === 10 || b === 13) break;
    c = b;
    i++;
  }
  if (i > start) {
    locals[7] = 0;
    locals[9] = c;
  }
  locals[3] = i;
  return 23;
};

// ---- java.lang.String(byte[] ascii, int hibyte, int offset, int count) ----

/**
 * The copy for hibyte 0, hooked at its goto (pc 49) with locals 1 = ascii, 3 = offset, 5 = value, 6 = i:
 *   while (i-- > 0) value[i] = (char) (ascii[i + offset] & 0xff);
 * Exits to pc 52 (i is then -1).
 */
const asciiStringCopy: LoopHookFn = (_jvm, _t, _m, locals) => {
  const asciiArr = locals[1] as JArray | null;
  const offset = locals[3] as number;
  const valueArr = locals[5] as JArray | null;
  const i = locals[6] as number;
  if (asciiArr === null || valueArr === null) return DECLINE;
  const ascii = asciiArr.data as Int8Array;
  const value = valueArr.data as Uint16Array;
  if (i < 0 || i > value.length || offset < 0 || offset + i > ascii.length) return DECLINE;
  for (let k = i - 1; k >= 0; k--) value[k] = ascii[k + offset]! & 0xff;
  locals[6] = -1;
  return 52;
};

// ---- java.io.DataInputStream.readUTF(DataInput) ----

/**
 * The ASCII run, hooked at its goto (pc 131) with locals 1 = utflen, 2 = bytearr, 3 = chararr, 4 = c, 7 = count,
 * 8 = chararr_count:
 *   while (count < utflen) { c = bytearr[count] & 0xff; if (c > 127) break; count++; chararr[chararr_count++] = (char) c; }
 * Exits to pc 134.
 */
const utfAsciiRun: LoopHookFn = (_jvm, _t, _m, locals) => {
  const utflen = locals[1] as number;
  const bytesArr = locals[2] as JArray | null;
  const charsArr = locals[3] as JArray | null;
  let count = locals[7] as number;
  let cc = locals[8] as number;
  if (bytesArr === null || charsArr === null) return DECLINE;
  const bytes = bytesArr.data as Int8Array;
  const out = charsArr.data as Uint16Array;
  if (count < 0 || cc < 0 || utflen > bytes.length || cc + (utflen - count) > out.length) return DECLINE;
  let c = locals[4] as number;
  while (count < utflen) {
    const b = bytes[count]! & 0xff;
    c = b;
    if (b > 127) break;
    count++;
    out[cc++] = b;
  }
  locals[4] = c;
  locals[7] = count;
  locals[8] = cc;
  return 134;
};

// ---- sun.nio.cs.UTF_8$Decoder.decodeArrayLoop(ByteBuffer, CharBuffer) ----

/**
 * The ASCII run, hooked at its goto (pc 103) with locals 3 = sa, 4 = sp, 6 = da, 7 = dp, 9 = dlASCII:
 *   while (dp < dlASCII && sa[sp] >= 0) da[dp++] = (char) sa[sp++];
 * Exits to pc 106.
 */
const utf8AsciiRun: LoopHookFn = (_jvm, _t, _m, locals) => {
  const saArr = locals[3] as JArray | null;
  const daArr = locals[6] as JArray | null;
  let sp = locals[4] as number;
  let dp = locals[7] as number;
  const end = locals[9] as number;
  if (saArr === null || daArr === null) return DECLINE;
  const sa = saArr.data as Int8Array;
  const da = daArr.data as Uint16Array;
  if (sp < 0 || dp < 0 || end > da.length || sp + (end - dp) > sa.length) return DECLINE;
  while (dp < end && sa[sp]! >= 0) da[dp++] = sa[sp++]!;
  locals[4] = sp;
  locals[7] = dp;
  return 106;
};

// ---- java.io.DataInputStream over a java.io.ByteArrayInputStream ----

const filterSlots = perClass((cls) => ({ in: slotOf(cls, 'in', 'Ljava/io/InputStream;') }));
const byteStreamSlots = perClass((cls) => ({ buf: slotOf(cls, 'buf', '[B'), pos: slotOf(cls, 'pos', 'I'), count: slotOf(cls, 'count', 'I') }));
const byteStreamClasses = new WeakMap<Jvm, JClass>();

/**
 * The next n bytes of a DataInputStream's `in` when it is the class library's own ByteArrayInputStream (not a subclass,
 * whose read() could differ), its monitor free (each read() is synchronized; with no other owner or entrant, entering
 * and leaving it is invisible) and n bytes are there: their position in buf, and pos moves past them. Otherwise null,
 * with nothing changed.
 */
function takeBytes(jvm: Jvm, t: Parameters<IntrinsicFn>[1], self: JObject, n: number): { readonly buf: Int8Array; readonly at: number } | null {
  const input = self.fields[filterSlots(self.cls).in] as JObject | null;
  if (input === null) return null;
  let bais = byteStreamClasses.get(jvm);
  if (!bais) {
    const c = jvm.loader.loadBoot('java/io/ByteArrayInputStream');
    if (!c) return null;
    byteStreamClasses.set(jvm, (bais = c));
  }
  if (input.cls !== bais || !monitorFree(t, input)) return null;
  const s = byteStreamSlots(bais);
  const bufArr = input.fields[s.buf] as JArray | null;
  const pos = input.fields[s.pos] as number;
  const count = input.fields[s.count] as number;
  if (bufArr === null || pos < 0 || pos + n > count || pos + n > bufArr.data.length) return null;
  input.fields[s.pos] = pos + n;
  return { buf: bufArr.data as Int8Array, at: pos };
}

/** DataInputStream.readInt(): four read() calls, big-endian. */
const readInt: IntrinsicFn = (jvm, t, _m, stack, base) => {
  const got = takeBytes(jvm, t, stack[base] as JObject, 4);
  if (got === null) return DECLINE;
  const { buf, at } = got;
  return (buf[at]! << 24) | ((buf[at + 1]! & 255) << 16) | ((buf[at + 2]! & 255) << 8) | (buf[at + 3]! & 255);
};

/** DataInputStream.readUnsignedShort(): two read() calls, big-endian. */
const readUnsignedShort: IntrinsicFn = (jvm, t, _m, stack, base) => {
  const got = takeBytes(jvm, t, stack[base] as JObject, 2);
  if (got === null) return DECLINE;
  return ((got.buf[got.at]! & 255) << 8) | (got.buf[got.at + 1]! & 255);
};

// ---- full-method intrinsics ----

/**
 * java.util.jar.JarFile.match(char[] src, byte[] b, int[] lastOcc, int[] optoSft): the Boyer-Moore search for a
 * lower-case ASCII pattern in a manifest.
 */
const jarMatch: IntrinsicFn = (jvm, _t, _m, stack, base) => {
  const srcArr = stack[base + 1] as JArray | null;
  const bArr = stack[base + 2] as JArray | null;
  const lastArr = stack[base + 3] as JArray | null;
  const sftArr = stack[base + 4] as JArray | null;
  if (srcArr === null || bArr === null || lastArr === null || sftArr === null || !ready(jvm, 'java/lang/Math')) return DECLINE;
  const src = srcArr.data as Uint16Array;
  const b = bArr.data as Int8Array;
  const lastOcc = lastArr.data as Int32Array;
  const optoSft = sftArr.data as Int32Array;
  const len = src.length;
  // lastOcc is indexed by c & 0x7f, optoSft by j < len: either too short would throw in the bytecode
  if (lastOcc.length < 128 || optoSft.length < len) return DECLINE;
  const last = b.length - len;
  let i = 0;
  next: while (i <= last) {
    for (let j = len - 1; j >= 0; j--) {
      let c = b[i + j]! & 0xffff; // (char) of a byte: sign-extended, then the low 16 bits
      c = ((c - 65) | (90 - c)) >= 0 ? (c + 32) & 0xffff : c;
      if (c !== src[j]) {
        const shift = Math.max(j + 1 - lastOcc[c & 0x7f]!, optoSft[j]!);
        // a shift that is not forward could index before b or never end: the bytecode runs it
        if (shift <= 0) return DECLINE;
        i += shift;
        continue next;
      }
    }
    return 1;
  }
  return 0;
};

/** java.io.UnixFileSystem.normalize(String): a path with no "//" and no trailing '/' is returned as it is. */
const unixNormalize: IntrinsicFn = (_jvm, _t, _m, stack, base) => {
  const path = chars(stack[base + 1]);
  if (path === null) return DECLINE;
  let prev = 0;
  for (let i = 0; i < path.length; i++) {
    const c = path[i]!;
    if (prev === 47 && c === 47) return DECLINE; // the bytecode builds the normalized path
    prev = c;
  }
  return prev === 47 ? DECLINE : (stack[base + 1] as JObject);
};

/** sun.misc.ASCIICaseInsensitiveComparator.lowerCaseHashCode(String). */
const lowerCaseHashCode: IntrinsicFn = (_jvm, _t, _m, stack, base) => {
  const s = chars(stack[base]);
  if (s === null) return DECLINE;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    h = (Math.imul(31, h) + (((c - 65) | (90 - c)) >= 0 ? c + 32 : c)) | 0;
  }
  return h;
};

/** java.util.jar.Attributes$Name.isValid(String): 1 to 70 chars, each a-z, A-Z, 0-9, '_' or '-'. */
const attributeNameValid: IntrinsicFn = (_jvm, _t, _m, stack, base) => {
  const s = chars(stack[base]);
  if (s === null) return DECLINE;
  if (s.length > 70 || s.length === 0) return 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const valid = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 45;
    if (!valid) return 0;
  }
  return 1;
};

/**
 * sun.security.provider.ByteArrayAccess.b2iBig(byte[] in, int inOfs, int[] out, int outOfs, int len): len bytes as
 * big-endian ints, whichever of its paths (Unsafe or bytes) the class takes, as they give the same ints.
 */
const b2iBig: IntrinsicFn = (_jvm, _t, _m, stack, base) => {
  const inArr = stack[base] as JArray | null;
  const inOfs = stack[base + 1] as number;
  const outArr = stack[base + 2] as JArray | null;
  const outOfs = stack[base + 3] as number;
  const len = stack[base + 4] as number;
  if (inArr === null || outArr === null) return DECLINE;
  const src = inArr.data as Int8Array;
  const out = outArr.data as Int32Array;
  // the bounds check that throws, and a length the loops would not end on a word boundary of
  if (inOfs < 0 || src.length - inOfs < len || outOfs < 0 || out.length - outOfs < ((len / 4) | 0)) return DECLINE;
  if (len <= 0) return undefined; // no word to convert, on every path
  if ((len & 3) !== 0) return DECLINE;
  for (let i = inOfs, o = outOfs, end = inOfs + len; i < end; i += 4, o++) {
    out[o] = (src[i]! << 24) | ((src[i + 1]! & 255) << 16) | ((src[i + 2]! & 255) << 8) | (src[i + 3]! & 255);
  }
  return undefined;
};

const hashMapStringSlots = perClass((cls) => ({ value: slotOf(cls, 'value', '[C'), hash: slotOf(cls, 'hash', 'I') }));
const stringClasses = new WeakMap<Jvm, JClass>();

/**
 * java.util.HashMap.hash(Object key) for a null key or a String: key.hashCode() (String's, computed and cached as
 * String.hashCode does) spread as h ^ (h >>> 16). Any other key's hashCode() may be overridden: left to the bytecode.
 */
const hashMapHash: IntrinsicFn = (jvm, _t, _m, stack, base) => {
  const key = stack[base] as JObject | null;
  if (key === null) return 0;
  let str = stringClasses.get(jvm);
  if (!str) {
    const c = jvm.loader.loadBoot('java/lang/String');
    if (!c) return DECLINE;
    stringClasses.set(jvm, (str = c));
  }
  if (key.cls !== str) return DECLINE;
  const s = hashMapStringSlots(str);
  let h = key.fields[s.hash] as number;
  if (h === 0) {
    const valueArr = key.fields[s.value] as JArray | null;
    if (valueArr === null) return DECLINE;
    const value = valueArr.data as Uint16Array;
    for (let i = 0; i < value.length; i++) h = (Math.imul(31, h) + value[i]!) | 0;
    if (value.length > 0) key.fields[s.hash] = h;
  }
  return h ^ (h >>> 16);
};

const equalBytesSlots = perClass((cls) => ({ b: slotOf(cls, 'b', '[B'), hash: slotOf(cls, 'hash', 'I') }));

/** sun.security.util.Cache$EqualByteArray.hashCode(): the cached hash, or b.length + 1 + 37 * each unsigned byte. */
const equalBytesHash: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const self = stack[base] as JObject;
  const s = equalBytesSlots(m.cls);
  let h = self.fields[s.hash] as number;
  if (h !== 0) return h;
  const bArr = self.fields[s.b] as JArray | null;
  if (bArr === null) return DECLINE;
  const b = bArr.data as Int8Array;
  h = b.length + 1;
  for (let i = 0; i < b.length; i++) h = (h + (b[i]! & 255) * 37) | 0;
  self.fields[s.hash] = h;
  return h;
};

/** java.util.HashMap.tableSizeFor(int cap): the power of two at or above cap, between 1 and 2^30. */
const tableSizeFor: IntrinsicFn = (_jvm, _t, _m, stack, base) => {
  let n = ((stack[base] as number) - 1) | 0;
  n |= n >>> 1;
  n |= n >>> 2;
  n |= n >>> 4;
  n |= n >>> 8;
  n |= n >>> 16;
  return n < 0 ? 1 : n >= 1073741824 ? 1073741824 : n + 1;
};

/**
 * java.math.BigInteger.mulAdd(int[] out, int[] in, int offset, int len, int k): implMulAddCheck's checks (any that would
 * throw is left to the bytecode), then implMulAdd (the engine's intrinsic, which may itself decline).
 */
const checkedMulAdd: IntrinsicFn = (jvm, t, m, stack, base) => {
  const out = stack[base] as JArray | null;
  const input = stack[base + 1] as JArray | null;
  const offset = stack[base + 2] as number;
  const len = stack[base + 3] as number;
  if (out === null || input === null) return DECLINE;
  if (len > input.data.length || offset < 0 || offset > out.data.length - 1 || len > out.data.length - offset) return DECLINE;
  return mulAdd(jvm, t, m, stack, base);
};

/**
 * java.math.BigInteger.addOne(int[] a, int offset, int mlen, int carry): adds carry into the word mlen + offset from the
 * end of a and ripples the carry up through at most mlen more words; returns the carry out (0 or 1).
 */
const addOne: IntrinsicFn = (_jvm, _t, _m, stack, base) => {
  const aArr = stack[base] as JArray | null;
  let mlen = stack[base + 2] as number;
  const carry = stack[base + 3] as number;
  if (aArr === null) return DECLINE;
  const a = aArr.data as Int32Array;
  let offset = (a.length - 1 - mlen - (stack[base + 1] as number)) | 0;
  if (offset < 0 || offset >= a.length) return DECLINE; // the first access throws
  const sum = (a[offset]! >>> 0) + (carry >>> 0);
  a[offset] = sum % 4294967296;
  if (sum < 4294967296) return 0;
  while (--mlen >= 0) {
    if (--offset < 0) return 1;
    a[offset] = (a[offset]! + 1) | 0;
    if (a[offset] !== 0) return 0;
  }
  return 1;
};

/**
 * java.math.BigInteger.destructiveMulAdd(int[] x, int y, int z) (static), which BigInteger(String) runs per digit
 * group: x = x * y + z, x a big-endian magnitude of unsigned 32-bit words, y and z unsigned words; the carry out of
 * the top word is dropped. The 64-bit products are split into 16-bit halves so every step is exact in doubles.
 */
const destructiveMulAdd: IntrinsicFn = (_jvm, _t, _m, stack, base) => {
  const xArr = stack[base] as JArray | null;
  if (xArr === null || xArr.data.length === 0) return DECLINE; // the bytecode throws
  const x = xArr.data as Int32Array;
  const y = (stack[base + 1] as number) >>> 0;
  const z = (stack[base + 2] as number) >>> 0;
  const yl = y & 0xffff;
  const yh = y >>> 16;
  const len = x.length;
  let carry = 0;
  for (let i = len - 1; i >= 0; i--) {
    const a = x[i]! >>> 0;
    const al = a & 0xffff;
    const ah = a >>> 16;
    const mid = ah * yl + al * yh; // < 2^33
    const lo = al * yl + carry + (mid % 65536) * 65536; // < 2^34
    x[i] = lo % 4294967296;
    carry = ah * yh + Math.floor(mid / 65536) + Math.floor(lo / 4294967296); // < 2^32
  }
  let sum = (x[len - 1]! >>> 0) + z;
  x[len - 1] = sum % 4294967296;
  carry = Math.floor(sum / 4294967296);
  for (let i = len - 2; i >= 0; i--) {
    sum = (x[i]! >>> 0) + carry;
    x[i] = sum % 4294967296;
    carry = Math.floor(sum / 4294967296);
  }
  return undefined;
};

export const jarTextIntrinsics: Readonly<Record<string, IntrinsicFn>> = {
  'java/util/HashMap.tableSizeFor(I)I': tableSizeFor,
  'java/math/BigInteger.mulAdd([I[IIII)I': checkedMulAdd,
  'java/math/BigInteger.addOne([IIII)I': addOne,
  'java/math/BigInteger.destructiveMulAdd([III)V': destructiveMulAdd,
  'sun/security/util/Cache$EqualByteArray.hashCode()I': equalBytesHash,
  'java/util/jar/Manifest$FastInputStream.readLine([BII)I': fastReadLine,
  'java/util/HashMap.hash(Ljava/lang/Object;)I': hashMapHash,
  'java/util/jar/JarFile.match([C[B[I[I)Z': jarMatch,
  'java/io/UnixFileSystem.normalize(Ljava/lang/String;)Ljava/lang/String;': unixNormalize,
  'sun/misc/ASCIICaseInsensitiveComparator.lowerCaseHashCode(Ljava/lang/String;)I': lowerCaseHashCode,
  'java/util/jar/Attributes$Name.isValid(Ljava/lang/String;)Z': attributeNameValid,
  'sun/security/provider/ByteArrayAccess.b2iBig([BI[III)V': b2iBig,
  'java/io/DataInputStream.readInt()I': readInt,
  'java/io/DataInputStream.readUnsignedShort()I': readUnsignedShort,
};

export const jarTextLoopHooks: Readonly<Record<string, readonly LoopHook[]>> = {
  'java/util/jar/Manifest$FastInputStream.readLine([BII)I': [{ pc: 103, checksum: 0xfe57840d, fn: fastReadLineScan }],
  'java/util/Properties$LineReader.readLine()I': [{ pc: 344, checksum: 0xe3e61dac, fn: lineReaderChars }],
  'sun/security/util/ManifestDigester.findSection(ILsun/security/util/ManifestDigester$Position;)Z': [{ pc: 172, checksum: 0x975d2329, fn: findSectionScan }],
  'java/lang/String.<init>([BIII)V': [{ pc: 49, checksum: 0x3d821ff7, fn: asciiStringCopy }],
  'java/io/DataInputStream.readUTF(Ljava/io/DataInput;)Ljava/lang/String;': [{ pc: 131, checksum: 0x1f86d47c, fn: utfAsciiRun }],
  'sun/nio/cs/UTF_8$Decoder.decodeArrayLoop(Ljava/nio/ByteBuffer;Ljava/nio/CharBuffer;)Ljava/nio/charset/CoderResult;': [{ pc: 103, checksum: 0x27f11f71, fn: utf8AsciiRun }],
};
