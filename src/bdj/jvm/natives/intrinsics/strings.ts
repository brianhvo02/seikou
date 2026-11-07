/*
 * Original code for bluray-web: intrinsics for the java.lang.String methods (and the UTF-8 decoder's ASCII case,
 * StringBuilder.append(String) and Integer.parseInt) that the JDK's jar, manifest and class handling calls hundreds of
 * thousands of times while a disc starts. Each implements the specified Java API behaviour (the java.lang.String,
 * StringBuilder, Integer, Character and UTF-8 Javadoc); checked against the class library by the
 * equivalence tests (tests/bdj/intrinsics.test.ts). Anything else (a supplementary code point, a non-ASCII byte, an
 * index the bytecode would throw on) declines to that bytecode.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { JClass } from '../../loader';
import type { Jvm } from '../../jvm';
import type { JArray, JObject } from '../../values';
import { DECLINE, perClass, slotOf } from './common';
import type { IntrinsicFn } from './common';

const stringSlots = perClass((cls) => ({ value: slotOf(cls, 'value', '[C'), hash: slotOf(cls, 'hash', 'I') }));

const readyClasses = new WeakMap<Jvm, Map<string, JClass>>();

/** Whether a boot class is initialised, so a static call into it that the bytecode makes has nothing else to do. */
function classReady(jvm: Jvm, name: string): boolean {
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

/** Whether java.lang.Math is initialised, so a call of Math.min that the bytecode makes has nothing else to do. */
const mathReady = (jvm: Jvm): boolean => classReady(jvm, 'java/lang/Math');

/** The chars of a String (its value field), or null. */
const chars = (s: JObject, slot: number): Uint16Array | null => (s.fields[slot] as JArray | null)?.data as Uint16Array | null;

/** String.hashCode(): the cached hash, or 31-based over the chars, cached when computed. */
const hashCode: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const self = stack[base] as JObject;
  const s = stringSlots(m.cls);
  let h = self.fields[s.hash] as number;
  if (h !== 0) return h;
  const value = chars(self, s.value);
  if (value === null) return DECLINE;
  if (value.length === 0) return 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(31, h) + value[i]!) | 0;
  self.fields[s.hash] = h;
  return h;
};

/** String.charAt(int). */
const charAt: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const value = chars(stack[base] as JObject, stringSlots(m.cls).value);
  const i = stack[base + 1] as number;
  if (value === null || i < 0 || i >= value.length) return DECLINE;
  return value[i]!;
};

/** String.equals(Object): the same object, or a String with the same chars. */
const equals: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const self = stack[base] as JObject;
  const other = stack[base + 1] as JObject | null;
  if (self === other) return 1;
  if (other === null || other.cls !== m.cls) return 0; // String is final: instanceof String is this class
  const s = stringSlots(m.cls);
  const a = chars(self, s.value);
  const b = chars(other, s.value);
  if (a === null || b === null) return DECLINE;
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return 0;
  return 1;
};

/** String.indexOf(int ch, int fromIndex), for a ch below the supplementary range. */
const indexOf: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const value = chars(stack[base] as JObject, stringSlots(m.cls).value);
  const ch = stack[base + 1] as number;
  let from = stack[base + 2] as number;
  if (value === null) return DECLINE;
  if (from < 0) from = 0;
  else if (from >= value.length) return -1;
  if (ch >= 0x10000) return DECLINE;
  for (let i = from; i < value.length; i++) if (value[i] === ch) return i;
  return -1;
};

/** String.lastIndexOf(int ch, int fromIndex), for a ch below the supplementary range. */
const lastIndexOf: IntrinsicFn = (jvm, _t, m, stack, base) => {
  const value = chars(stack[base] as JObject, stringSlots(m.cls).value);
  const ch = stack[base + 1] as number;
  const from = stack[base + 2] as number;
  if (ch >= 0x10000) return DECLINE;
  if (value === null || !mathReady(jvm)) return DECLINE;
  for (let i = Math.min(from, value.length - 1); i >= 0; i--) if (value[i] === ch) return i;
  return -1;
};

/** String.startsWith(String prefix, int toffset). */
const startsWith: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const s = stringSlots(m.cls);
  const value = chars(stack[base] as JObject, s.value);
  const prefix = stack[base + 1] as JObject | null;
  const toffset = stack[base + 2] as number;
  if (value === null || prefix === null) return DECLINE;
  const pa = chars(prefix, s.value);
  if (pa === null) return DECLINE;
  if (toffset < 0 || toffset > value.length - pa.length) return 0;
  for (let i = 0; i < pa.length; i++) if (value[toffset + i] !== pa[i]) return 0;
  return 1;
};

/** UTF_8.Decoder.decode(byte[] sa, int sp, int len, char[] da) when every byte is ASCII and da has room: a copy. */
const utf8Decode: IntrinsicFn = (jvm, _t, _m, stack, base) => {
  const saArr = stack[base + 1] as JArray | null;
  const sp = stack[base + 2] as number;
  const len = stack[base + 3] as number;
  const daArr = stack[base + 4] as JArray | null;
  if (saArr === null || daArr === null || !mathReady(jvm)) return DECLINE;
  if (len <= 0) {
    // nothing to copy unless sp + len wraps past sp, in which case the bytecode reads (and throws)
    return ((sp + len) | 0) <= sp ? 0 : DECLINE;
  }
  const sa = saArr.data as Int8Array;
  const da = daArr.data as Uint16Array;
  if (sp < 0 || sp + len > sa.length || len > da.length) return DECLINE;
  for (let i = 0; i < len; i++) if (sa[sp + i]! < 0) return DECLINE;
  for (let i = 0; i < len; i++) da[i] = sa[sp + i]!;
  return len;
};

/** String.getChars(int srcBegin, int srcEnd, char[] dst, int dstBegin). */
const getChars: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const value = chars(stack[base] as JObject, stringSlots(m.cls).value);
  const begin = stack[base + 1] as number;
  const end = stack[base + 2] as number;
  const dstArr = stack[base + 3] as JArray | null;
  const at = stack[base + 4] as number;
  if (value === null || dstArr === null || begin < 0 || end > value.length || begin > end) return DECLINE;
  const dst = dstArr.data as Uint16Array;
  if (at < 0 || at + (end - begin) > dst.length) return DECLINE; // System.arraycopy throws
  dst.set(value.subarray(begin, end), at);
  return undefined;
};

const builderSlots = perClass((cls) => ({ value: slotOf(cls, 'value', '[C'), count: slotOf(cls, 'count', 'I') }));

/**
 * AbstractStringBuilder.append(String) and StringBuilder.append(String), when the chars fit in the builder's array as
 * it is (no null to append as "null", no growth): the chars are copied after the builder's; returns the builder.
 */
const appendString: IntrinsicFn = (_jvm, _t, m, stack, base) => {
  const self = stack[base] as JObject;
  const str = stack[base + 1] as JObject | null;
  if (str === null) return DECLINE;
  const src = chars(str, stringSlots(str.cls).value);
  const b = builderSlots(m.cls);
  const valueArr = self.fields[b.value] as JArray | null;
  const count = self.fields[b.count] as number;
  if (src === null || valueArr === null || count < 0) return DECLINE;
  const value = valueArr.data as Uint16Array;
  if (count + src.length > value.length) return DECLINE; // the array grows first
  value.set(src, count);
  self.fields[b.count] = count + src.length;
  return self;
};

/** Character.digit(int, int) of an ASCII code point; -1 when it is not a digit in `radix` (or radix is out of range). */
function asciiDigit(c: number, radix: number): number {
  if (radix < 2 || radix > 36) return -1;
  let d = -1;
  if (c >= 48 && c <= 57) d = c - 48;
  else if (c >= 97 && c <= 122) d = c - 87;
  else if (c >= 65 && c <= 90) d = c - 55;
  return d < radix ? d : -1;
}

/**
 * Integer.parseInt(String s, int radix) (and parseInt(String), radix 10) of a valid ASCII number: an optional sign and
 * digits whose value fits an int. Anything the bytecode would reject (null, a bad radix, a stray char, an overflow) or
 * could read differently (a non-ASCII char, which Character.digit may take as a digit) is left to it.
 */
const parseIntWith =
  (fixedRadix: number | null): IntrinsicFn =>
  (jvm, _t, _m, stack, base) => {
    const str = stack[base] as JObject | null;
    const radix = fixedRadix ?? (stack[base + 1] as number);
    if (str === null || radix < 2 || radix > 36) return DECLINE;
    const s = chars(str, stringSlots(str.cls).value);
    if (s === null || s.length === 0) return DECLINE;
    // the digits go through Character.digit, whose classes the bytecode would initialise
    if (!classReady(jvm, 'java/lang/Character') || !classReady(jvm, 'java/lang/CharacterData') || !classReady(jvm, 'java/lang/CharacterDataLatin1')) return DECLINE;
    let i = 0;
    let negative = false;
    const first = s[0]!;
    if (first < 48) {
      if (first === 45) negative = true;
      else if (first !== 43) return DECLINE;
      if (s.length === 1) return DECLINE;
      i = 1;
    }
    let value = 0;
    for (; i < s.length; i++) {
      const c = s[i]!;
      if (c >= 128) return DECLINE;
      const d = asciiDigit(c, radix);
      if (d < 0) return DECLINE;
      value = value * radix + d;
      if (value > 2147483648) return DECLINE;
    }
    if (negative) return -value | 0;
    return value > 2147483647 ? DECLINE : value;
  };

/** Character.digit(char, int) and Character.digit(int, int) of an ASCII code point. */
const digit: IntrinsicFn = (jvm, _t, _m, stack, base) => {
  const c = stack[base] as number;
  if (c < 0 || c >= 128) return DECLINE;
  if (!classReady(jvm, 'java/lang/CharacterData') || !classReady(jvm, 'java/lang/CharacterDataLatin1')) return DECLINE;
  return asciiDigit(c, stack[base + 1] as number);
};

/** The charset names (in any case) that Charset.forName takes for UTF-8 and that the intrinsic below accepts. */
const UTF8_NAMES = new Set(['utf-8', 'utf8']);

/**
 * new String(byte[] bytes, int offset, int length, String charsetName) for UTF-8 and ASCII bytes: each byte is its
 * char. Everything else (another charset, a non-ASCII byte, bounds the constructor rejects) is left to the bytecode,
 * as is the first decode of all (before StringCoding and the UTF-8 decoder are initialised). StringCoding's
 * per-thread decoder cache is not touched: it only spares later decodes a lookup.
 */
const stringFromUtf8: IntrinsicFn = (jvm, _t, m, stack, base) => {
  const self = stack[base] as JObject;
  const bytesArr = stack[base + 1] as JArray | null;
  const offset = stack[base + 2] as number;
  const length = stack[base + 3] as number;
  const name = stack[base + 4] as JObject | null;
  if (bytesArr === null || name === null || offset < 0 || length < 0 || offset > bytesArr.data.length - length) return DECLINE;
  const n = chars(name, stringSlots(name.cls).value);
  if (n === null || n.length > 5) return DECLINE;
  if (!UTF8_NAMES.has(String.fromCharCode(...n).toLowerCase())) return DECLINE;
  if (!classReady(jvm, 'java/lang/StringCoding') || !classReady(jvm, 'java/lang/StringCoding$StringDecoder') || !classReady(jvm, 'sun/nio/cs/UTF_8')) return DECLINE;
  const bytes = bytesArr.data as Int8Array;
  for (let i = offset; i < offset + length; i++) if (bytes[i]! < 0) return DECLINE;
  const value = jvm.heap.newArray(jvm.loader.arrayOf(jvm.loader.primitive('C')), length);
  (value.data as Uint16Array).set(bytes.subarray(offset, offset + length));
  self.fields[stringSlots(m.cls).value] = value;
  return undefined;
};

const localeSlots = perClass((cls) => ({ baseLocale: slotOf(cls, 'baseLocale', 'Lsun/util/locale/BaseLocale;') }));
const baseLocaleSlots = perClass((cls) => ({ language: slotOf(cls, 'language', 'Ljava/lang/String;') }));

/** The locales whose case mapping differs for ASCII letters or around them (Turkish, Azerbaijani, Lithuanian). */
const SPECIAL_CASING = new Set(['tr', 'az', 'lt']);

/**
 * String.toLowerCase(Locale) and toUpperCase(Locale) of an ASCII string: A-Z to a-z (or back), nothing else changes;
 * the string itself when nothing changes. A null locale, a non-ASCII char or a locale with its own casing rules is left
 * to the bytecode.
 */
const asciiCase =
  (upper: boolean): IntrinsicFn =>
  (jvm, _t, m, stack, base) => {
    const self = stack[base] as JObject;
    const locale = stack[base + 1] as JObject | null;
    const value = chars(self, stringSlots(m.cls).value);
    if (value === null || locale === null) return DECLINE;
    const from = upper ? 97 : 65;
    let first = -1;
    for (let i = 0; i < value.length; i++) {
      const c = value[i]!;
      if (c >= 128) return DECLINE;
      if (first < 0 && c >= from && c <= from + 25) first = i;
    }
    if (first < 0) return self;
    const baseLocale = locale.fields[localeSlots(locale.cls).baseLocale] as JObject | null;
    if (baseLocale === null) return DECLINE;
    const language = baseLocale.fields[baseLocaleSlots(baseLocale.cls).language] as JObject | null;
    const lang = language === null ? null : chars(language, stringSlots(language.cls).value);
    if (lang === null || SPECIAL_CASING.has(String.fromCharCode(...lang))) return DECLINE;
    let out = '';
    for (let i = 0; i < value.length; i++) {
      const c = value[i]!;
      out += String.fromCharCode(c >= from && c <= from + 25 ? c ^ 0x20 : c);
    }
    return jvm.heap.newString(out);
  };

export const stringIntrinsics: Readonly<Record<string, IntrinsicFn>> = {
  'java/lang/String.toLowerCase(Ljava/util/Locale;)Ljava/lang/String;': asciiCase(false),
  'java/lang/String.toUpperCase(Ljava/util/Locale;)Ljava/lang/String;': asciiCase(true),
  'java/lang/Character.digit(CI)I': digit,
  'java/lang/Character.digit(II)I': digit,
  'java/lang/String.<init>([BIILjava/lang/String;)V': stringFromUtf8,
  'java/lang/String.getChars(II[CI)V': getChars,
  'java/lang/AbstractStringBuilder.append(Ljava/lang/String;)Ljava/lang/AbstractStringBuilder;': appendString,
  'java/lang/StringBuilder.append(Ljava/lang/String;)Ljava/lang/StringBuilder;': appendString,
  'java/lang/Integer.parseInt(Ljava/lang/String;I)I': parseIntWith(null),
  'java/lang/Integer.parseInt(Ljava/lang/String;)I': parseIntWith(10),
  'java/lang/String.hashCode()I': hashCode,
  'java/lang/String.charAt(I)C': charAt,
  'java/lang/String.equals(Ljava/lang/Object;)Z': equals,
  'java/lang/String.indexOf(II)I': indexOf,
  'java/lang/String.lastIndexOf(II)I': lastIndexOf,
  'java/lang/String.startsWith(Ljava/lang/String;I)Z': startsWith,
  'sun/nio/cs/UTF_8$Decoder.decode([BII[C)I': utf8Decode,
};
