/*
 * sun.misc.Unsafe natives of the BD-J virtual machine.
 *
 * The addressing scheme follows DoppioJVM's src/natives/sun_misc.ts (MIT; see src/bdj/NOTICE): a field's offset
 * is its slot, an array element's offset is its index (base offset 0, index scale 1), and staticFieldBase is a plain
 * Object standing for the class's statics (getFieldInfo, staticFieldBase). Off-heap memory is a map of malloc'd
 * blocks (allocateMemory, freeMemory, getByte(J), putLong(JJ)...).
 *
 * Copyright (C) 2026 Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { ThrowResult } from '../interpreter';
import type { NativeResult } from '../interpreter';
import { externalName, retrying } from '../loader';
import type { JClass } from '../loader';
import type { Jvm } from '../jvm';
import { JThread } from '../threads';
import type { JArray, JObject, JValue } from '../values';
import type { NativeContext, NativeTable } from './index';
import { classOf } from './lang';
import { internalName, jsStr, none, withMonitor } from './util';

/** The nativeData of a staticFieldBase object. */
class StaticBase {
  constructor(readonly cls: JClass) {}
}

interface Block {
  readonly base: bigint;
  readonly view: DataView;
}

/** The object Unsafe.staticFieldBase returns for a class: static field offsets are relative to it. */
export function staticFieldBase(jvm: Jvm, cls: JClass): JObject {
  const base = jvm.heap.newObject(jvm.bootClass('java/lang/Object'));
  base.nativeData = new StaticBase(cls);
  return base;
}

/** Off-heap blocks per VM. */
const memories = new WeakMap<Jvm, { blocks: Map<bigint, Block>; next: bigint }>();

function memory(jvm: Jvm): { blocks: Map<bigint, Block>; next: bigint } {
  let m = memories.get(jvm);
  if (!m) memories.set(jvm, (m = { blocks: new Map(), next: 0x10000n }));
  return m;
}

/** The off-heap block holding `size` bytes at `address`, and the offset of the address in it. */
export function offHeap(jvm: Jvm, address: bigint, size: number): { view: DataView; offset: number } | null {
  for (const b of memory(jvm).blocks.values()) {
    if (address >= b.base && address + BigInt(size) <= b.base + BigInt(b.view.byteLength)) return { view: b.view, offset: Number(address - b.base) };
  }
  return null;
}

type Kind = 'Z' | 'B' | 'C' | 'S' | 'I' | 'J' | 'F' | 'D' | 'L';
const SIZES: Readonly<Record<Kind, number>> = { Z: 1, B: 1, C: 2, S: 2, I: 4, J: 8, F: 4, D: 8, L: 8 };

function readView(v: DataView, o: number, k: Kind): JValue {
  switch (k) {
    case 'Z':
    case 'B':
      return v.getInt8(o);
    case 'C':
      return v.getUint16(o, true);
    case 'S':
      return v.getInt16(o, true);
    case 'I':
      return v.getInt32(o, true);
    case 'J':
    case 'L':
      return v.getBigInt64(o, true);
    case 'F':
      return v.getFloat32(o, true);
    case 'D':
      return v.getFloat64(o, true);
  }
}

function writeView(v: DataView, o: number, k: Kind, x: JValue): void {
  switch (k) {
    case 'Z':
    case 'B':
      return v.setInt8(o, x as number);
    case 'C':
      return v.setUint16(o, x as number, true);
    case 'S':
      return v.setInt16(o, x as number, true);
    case 'I':
      return v.setInt32(o, x as number, true);
    case 'J':
    case 'L':
      return v.setBigInt64(o, x as bigint, true);
    case 'F':
      return v.setFloat32(o, x as number, true);
    case 'D':
      return v.setFloat64(o, x as number, true);
  }
}

/** A byte[] read as a wider type (Unsafe.getLong on a byte array), little-endian like x86. */
function byteView(a: JArray): DataView {
  const d = a.data as Int8Array;
  return new DataView(d.buffer, d.byteOffset, d.byteLength);
}

function get(jvm: Jvm, o: JValue, offset: bigint, k: Kind): JValue {
  if (o === null) {
    const b = offHeap(jvm, offset, SIZES[k]);
    if (!b) throw new Error(`Unsafe: bad address ${offset}`);
    return readView(b.view, b.offset, k);
  }
  const obj = o as JObject;
  const i = Number(offset);
  if (obj.cls.componentType) {
    const a = obj as JArray;
    if (a.data instanceof Int8Array && SIZES[k] > 1) return readView(byteView(a), i, k);
    return a.data[i]!;
  }
  if (obj.nativeData instanceof StaticBase) return obj.nativeData.cls.staticValues[i]!;
  return obj.fields[i]!;
}

function put(jvm: Jvm, o: JValue, offset: bigint, k: Kind, v: JValue): undefined {
  if (o === null) {
    const b = offHeap(jvm, offset, SIZES[k]);
    if (!b) throw new Error(`Unsafe: bad address ${offset}`);
    writeView(b.view, b.offset, k, v);
    return undefined;
  }
  const obj = o as JObject;
  const i = Number(offset);
  if (obj.cls.componentType) {
    const a = obj as JArray;
    if (a.data instanceof Int8Array && SIZES[k] > 1) writeView(byteView(a), i, k, v);
    else (a.data as JValue[])[i] = v;
  } else if (obj.nativeData instanceof StaticBase) obj.nativeData.cls.staticValues[i] = v;
  else obj.fields[i] = v;
  return undefined;
}

function cas(jvm: Jvm, o: JValue, offset: JValue, k: Kind, expected: JValue, x: JValue): number {
  if (get(jvm, o, offset as bigint, k) !== expected) return 0;
  put(jvm, o, offset as bigint, k, x);
  return 1;
}

/** A field's offset is its slot in the object's fields or the class's statics. */
function fieldSlot(ctx: NativeContext, f: JValue): bigint {
  return BigInt(ctx.jvm.getField(f as JObject, 'slot', 'I') as number);
}

function accessors(): Record<string, (ctx: NativeContext, ...a: JValue[]) => NativeResult> {
  const out: Record<string, (ctx: NativeContext, ...a: JValue[]) => NativeResult> = {};
  const types: [string, Kind, string][] = [
    ['Boolean', 'Z', 'Z'],
    ['Byte', 'B', 'B'],
    ['Char', 'C', 'C'],
    ['Short', 'S', 'S'],
    ['Int', 'I', 'I'],
    ['Long', 'J', 'J'],
    ['Float', 'F', 'F'],
    ['Double', 'D', 'D'],
    ['Object', 'L', 'Ljava/lang/Object;'],
  ];
  for (const [name, k, d] of types) {
    const getter = (ctx: NativeContext, _self: JValue, o: JValue, off: JValue): NativeResult => get(ctx.jvm, o, off as bigint, k);
    const setter = (ctx: NativeContext, _self: JValue, o: JValue, off: JValue, v: JValue): NativeResult => put(ctx.jvm, o, off as bigint, k, v);
    out[`sun/misc/Unsafe.get${name}(Ljava/lang/Object;J)${d}`] = getter;
    out[`sun/misc/Unsafe.get${name}Volatile(Ljava/lang/Object;J)${d}`] = getter;
    out[`sun/misc/Unsafe.put${name}(Ljava/lang/Object;J${d})V`] = setter;
    out[`sun/misc/Unsafe.put${name}Volatile(Ljava/lang/Object;J${d})V`] = setter;
    if (k === 'I' || k === 'J' || k === 'L') out[`sun/misc/Unsafe.putOrdered${name}(Ljava/lang/Object;J${d})V`] = setter;
    if (k !== 'Z' && k !== 'L') {
      out[`sun/misc/Unsafe.get${name}(J)${d}`] = (ctx, _self, addr) => get(ctx.jvm, null, addr as bigint, k);
      out[`sun/misc/Unsafe.put${name}(J${d})V`] = (ctx, _self, addr, v) => put(ctx.jvm, null, addr as bigint, k, v);
    }
  }
  return out;
}

/**
 * Registers the sun.misc.Unsafe natives: field, array and off-heap accessors (volatile and ordered forms are the plain
 * ones, since green threads never run in parallel), compare-and-swap, offsets, memory blocks, park and unpark, class
 * definition and allocation, on the addressing scheme above.
 */
export function registerUnsafeNatives(table: NativeTable): void {
  table.register(accessors());
  table.register({
    'sun/misc/Unsafe.registerNatives()V': none,
    'sun/misc/Unsafe.getAddress(J)J': (ctx, _self, addr) => get(ctx.jvm, null, addr as bigint, 'J'),
    'sun/misc/Unsafe.putAddress(JJ)V': (ctx, _self, addr, v) => put(ctx.jvm, null, addr as bigint, 'J', v),
    'sun/misc/Unsafe.compareAndSwapInt(Ljava/lang/Object;JII)Z': (ctx, _self, o, off, e, x) => cas(ctx.jvm, o, off, 'I', e, x),
    'sun/misc/Unsafe.compareAndSwapLong(Ljava/lang/Object;JJJ)Z': (ctx, _self, o, off, e, x) => cas(ctx.jvm, o, off, 'J', e, x),
    'sun/misc/Unsafe.compareAndSwapObject(Ljava/lang/Object;JLjava/lang/Object;Ljava/lang/Object;)Z': (ctx, _self, o, off, e, x) =>
      cas(ctx.jvm, o, off, 'L', e, x),
    'sun/misc/Unsafe.objectFieldOffset(Ljava/lang/reflect/Field;)J': (ctx, _self, f) => fieldSlot(ctx, f),
    'sun/misc/Unsafe.staticFieldOffset(Ljava/lang/reflect/Field;)J': (ctx, _self, f) => fieldSlot(ctx, f),
    'sun/misc/Unsafe.staticFieldBase(Ljava/lang/reflect/Field;)Ljava/lang/Object;': (ctx, _self, f) =>
      staticFieldBase(ctx.jvm, classOf(ctx.jvm.getField(f as JObject, 'clazz', 'Ljava/lang/Class;'))),
    'sun/misc/Unsafe.arrayBaseOffset(Ljava/lang/Class;)I': () => 0,
    'sun/misc/Unsafe.arrayIndexScale(Ljava/lang/Class;)I': () => 1,
    'sun/misc/Unsafe.addressSize()I': () => 8,
    'sun/misc/Unsafe.pageSize()I': () => 4096,
    'sun/misc/Unsafe.allocateMemory(J)J': (ctx, _self, size) => {
      const n = Number(size as bigint);
      if (n < 0) return ctx.jvm.throwNew('java/lang/IllegalArgumentException');
      const mem = memory(ctx.jvm);
      const base = mem.next;
      mem.next += BigInt((n + 15) & ~15) + 16n;
      mem.blocks.set(base, { base, view: new DataView(new ArrayBuffer(n)) });
      return base;
    },
    'sun/misc/Unsafe.reallocateMemory(JJ)J': (ctx, _self, addr, size) => {
      const mem = memory(ctx.jvm);
      const n = Number(size as bigint);
      const old = mem.blocks.get(addr as bigint);
      const base = mem.next;
      mem.next += BigInt((n + 15) & ~15) + 16n;
      const view = new DataView(new ArrayBuffer(n));
      if (old) {
        new Uint8Array(view.buffer).set(new Uint8Array(old.view.buffer, 0, Math.min(n, old.view.byteLength)));
        mem.blocks.delete(addr as bigint);
      }
      mem.blocks.set(base, { base, view });
      return base;
    },
    'sun/misc/Unsafe.freeMemory(J)V': (ctx, _self, addr) => {
      memory(ctx.jvm).blocks.delete(addr as bigint);
      return undefined;
    },
    'sun/misc/Unsafe.setMemory(Ljava/lang/Object;JJB)V': (ctx, _self, o, off, bytes, value) => {
      for (let i = 0n; i < (bytes as bigint); i++) put(ctx.jvm, o, (off as bigint) + i, 'B', value);
      return undefined;
    },
    'sun/misc/Unsafe.copyMemory(Ljava/lang/Object;JLjava/lang/Object;JJ)V': (ctx, _self, src, so, dst, d0, bytes) => {
      const n = Number(bytes as bigint);
      const tmp: JValue[] = [];
      for (let i = 0; i < n; i++) tmp.push(get(ctx.jvm, src, (so as bigint) + BigInt(i), 'B'));
      for (let i = 0; i < n; i++) put(ctx.jvm, dst, (d0 as bigint) + BigInt(i), 'B', tmp[i]!);
      return undefined;
    },
    'sun/misc/Unsafe.ensureClassInitialized(Ljava/lang/Class;)V': (ctx, _self, c) => {
      if (c === null) return ctx.jvm.throwNew('java/lang/NullPointerException');
      return ctx.jvm.withInit(ctx.thread, classOf(c), () => undefined);
    },
    'sun/misc/Unsafe.shouldBeInitialized(Ljava/lang/Class;)Z': (_ctx, _self, c) => (classOf(c).state === 'initialized' ? 0 : 1),
    'sun/misc/Unsafe.allocateInstance(Ljava/lang/Class;)Ljava/lang/Object;': (ctx, _self, c) => {
      const cls = classOf(c);
      if (cls.isInterface || cls.componentType || cls.isPrimitive || cls.access & 0x0400) {
        return ctx.jvm.throwNew('java/lang/InstantiationException', externalName(cls.name));
      }
      return ctx.jvm.withInit(ctx.thread, cls, () => ctx.jvm.heap.newObject(cls));
    },
    'sun/misc/Unsafe.defineClass(Ljava/lang/String;[BIILjava/lang/ClassLoader;Ljava/security/ProtectionDomain;)Ljava/lang/Class;': (
      ctx,
      _self,
      name,
      b,
      off,
      len,
      loader,
      pd,
    ) => {
      const data = (b as JArray).data as Int8Array;
      const bytes = new Uint8Array(data.buffer, data.byteOffset + (off as number), len as number).slice();
      const internal = name === null ? ctx.jvm.loader.className(bytes) : internalName(jsStr(ctx.jvm, name));
      return retrying(() => ctx.jvm.mirror(ctx.jvm.loader.define(internal, bytes, loader as JObject | null, pd as JObject | null)));
    },
    'sun/misc/Unsafe.defineAnonymousClass(Ljava/lang/Class;[B[Ljava/lang/Object;)Ljava/lang/Class;': (ctx, _self, host, b, patches) => {
      if (host === null || b === null) return ctx.jvm.throwNew('java/lang/NullPointerException');
      const data = (b as JArray).data as Int8Array;
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.length).slice();
      const p = patches === null ? null : ((patches as JArray).data as (JObject | null)[]);
      return retrying(() => ctx.jvm.mirror(ctx.jvm.loader.defineAnonymous(classOf(host), bytes, p)));
    },
    'sun/misc/Unsafe.throwException(Ljava/lang/Throwable;)V': (ctx, _self, e) =>
      e === null ? ctx.jvm.throwNew('java/lang/NullPointerException') : new ThrowResult(e as JObject),
    'sun/misc/Unsafe.park(ZJ)V': (ctx, _self, absolute, time) => ctx.jvm.threads.park(ctx.thread, absolute !== 0, time as bigint),
    'sun/misc/Unsafe.unpark(Ljava/lang/Object;)V': (ctx, _self, thread) => {
      const t = thread === null ? null : (thread as JObject).nativeData;
      if (t instanceof JThread && t.state !== 'terminated') ctx.jvm.threads.unpark(t);
      return undefined;
    },
    'sun/misc/Unsafe.monitorEnter(Ljava/lang/Object;)V': (ctx, _self, o) =>
      o === null ? ctx.jvm.throwNew('java/lang/NullPointerException') : withMonitor(ctx.jvm, ctx.thread, o as JObject, none),
    'sun/misc/Unsafe.monitorExit(Ljava/lang/Object;)V': (ctx, _self, o) => {
      ctx.jvm.threads.monitorExit(ctx.thread, o as JObject);
      return undefined;
    },
    'sun/misc/Unsafe.tryMonitorEnter(Ljava/lang/Object;)Z': (ctx, _self, o) => {
      const m = (o as JObject).monitor;
      if (m && m.owner !== null && m.owner !== ctx.thread) return 0;
      return ctx.jvm.threads.monitorEnter(ctx.thread, o as JObject) ? 1 : 0;
    },
    'sun/misc/Unsafe.getLoadAverage([DI)I': () => -1,
    'sun/misc/Unsafe.fullFence()V': none,
    'sun/misc/Unsafe.loadFence()V': none,
    'sun/misc/Unsafe.storeFence()V': none,
  });
}
