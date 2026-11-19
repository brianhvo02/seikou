/*
 * Original code for Seikou: the object heap of the BD-J virtual machine. The JS garbage collector reclaims objects.
 *
 * Copyright (C) 2026 Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import type { JClass } from './loader';
import type { Monitor } from './threads';
import type { Jvm } from './jvm';
import type { ArrayData, JArray, JObject, JValue } from './values';

class Obj implements JObject {
  monitor: Monitor | null = null;
  hash = 0;
  nativeData: unknown = null;
  constructor(
    readonly cls: JClass,
    readonly fields: JValue[],
  ) {}
}

const NO_FIELDS: JValue[] = [];

class Arr implements JArray {
  readonly fields = NO_FIELDS;
  monitor: Monitor | null = null;
  hash = 0;
  nativeData: unknown = null;
  constructor(
    readonly cls: JClass,
    readonly data: ArrayData,
  ) {}
}

/** Zeroed element storage for `length` elements of the component type `componentDescriptor` (see `ArrayData`). */
export function newArrayData(componentDescriptor: string, length: number): ArrayData {
  switch (componentDescriptor) {
    case 'Z':
    case 'B':
      return new Int8Array(length);
    case 'C':
      return new Uint16Array(length);
    case 'S':
      return new Int16Array(length);
    case 'I':
      return new Int32Array(length);
    case 'F':
      return new Float32Array(length);
    case 'D':
      return new Float64Array(length);
    case 'J':
      return new BigInt64Array(length);
    default:
      return new Array<JObject | null>(length).fill(null);
  }
}

/**
 * Allocates objects, arrays and strings, keeps the string intern table and gives identity hashes. One per JVM, used on
 * the BD-J worker only. There is no collector of its own: an unreachable object is reclaimed by the JS engine.
 */
export class Heap {
  private readonly interned = new Map<string, JObject>();
  private hashState = 0x2545f491;
  private stringValueSlot = -1;

  constructor(private readonly jvm: Jvm) {}

  /** A new instance of `cls` with every field at its default; no constructor runs and `cls` is not initialized here. */
  newObject(cls: JClass): JObject {
    return new Obj(cls, cls.fieldTemplate.slice());
  }

  /** `cls` is an array class; the caller has checked that `length` is not negative. */
  newArray(cls: JClass, length: number): JArray {
    return new Arr(cls, newArrayData(cls.componentType!.descriptor, length));
  }

  /**
   * A new java.lang.String holding the UTF-16 code units of `s`. Throws a JS Error when java/lang/String is not on the
   * boot class path.
   */
  newString(s: string): JObject {
    const loader = this.jvm.loader;
    const chars = new Uint16Array(s.length);
    for (let i = 0; i < s.length; i++) chars[i] = s.charCodeAt(i);
    const str = this.newObject(this.stringClass());
    str.fields[this.stringValueSlot] = new Arr(loader.arrayOf(loader.primitive('C')), chars);
    return str;
  }

  /** The interned java.lang.String for `s`, made on first use; string literals (`ldc`) resolve to these (§5.1). */
  intern(s: string): JObject {
    let str = this.interned.get(s);
    if (!str) {
      str = this.newString(s);
      this.interned.set(s, str);
    }
    return str;
  }

  /** String.intern: the interned string equal to `str`, which becomes the interned one if there is none yet. */
  internObject(str: JObject): JObject {
    const s = this.jsString(str)!;
    const hit = this.interned.get(s);
    if (hit) return hit;
    this.interned.set(s, str);
    return str;
  }

  /** Object.clone: a shallow copy with a fresh monitor and identity hash; VM data goes along, as HotSpot's injected fields do. */
  clone(o: JObject): JObject {
    if ('data' in o) return new Arr(o.cls, (o as JArray).data.slice());
    const c = new Obj(o.cls, o.fields.slice());
    c.nativeData = o.nativeData;
    return c;
  }

  /** The text of a java.lang.String; null for a null reference or a string whose value array is null. */
  jsString(str: JObject | null): string | null {
    if (str === null) return null;
    this.stringClass();
    const value = str.fields[this.stringValueSlot] as JArray | null;
    if (!value) return null;
    const chars = value.data as Uint16Array;
    let out = '';
    for (let i = 0; i < chars.length; i += 8192) out += String.fromCharCode(...chars.subarray(i, i + 8192));
    return out;
  }

  /**
   * Object.hashCode's identity hash, from a xorshift generator, kept on the object once given. Never 0 and 31 bits
   * wide, as HotSpot's identity hashes are.
   */
  identityHash(o: JObject): number {
    if (o.hash === 0) {
      let x = this.hashState;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this.hashState = x;
      o.hash = x & 0x7fffffff || 1;
    }
    return o.hash;
  }

  private stringClass(): JClass {
    const cls = this.jvm.loader.loadBoot('java/lang/String');
    if (!cls) throw new Error('java/lang/String is not on the boot class path');
    if (this.stringValueSlot < 0) this.stringValueSlot = cls.declaredField('value', '[C')!.slot;
    return cls;
  }
}
