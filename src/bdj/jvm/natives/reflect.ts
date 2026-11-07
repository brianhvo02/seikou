/*
 * Original code for bluray-web: reflection natives of the BD-J virtual machine (Class members, Method.invoke,
 * Constructor.newInstance, java.lang.reflect.Array, Proxy, sun.reflect.Reflection and ConstantPool).
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { Invoke, ThrowResult } from '../interpreter';
import type { NativeResult } from '../interpreter';
import { ACC_PRIVATE, ACC_PUBLIC, externalName, retrying, selectMethod } from '../loader';
import type { JClass, JField, JMethod } from '../loader';
import type { MemberInfo } from '../classfile';
import type { Jvm } from '../jvm';
import type { JThread } from '../threads';
import type { JArray, JObject, JValue } from '../values';
import type { NativeTable } from './index';
import { classOf } from './lang';
import { box, boxedType, byteArray, internalName, jsStr, throwConstructed, unbox, widen } from './util';

const FIELD_MODIFIERS = 0x50df;
const METHOD_MODIFIERS = 0x1dff;
const JVM_ACC_WRITTEN_FLAGS = 0x7fff;

const methodLists = new WeakMap<JClass, JMethod[]>();

/** A class's methods in class-file order; a Method's or Constructor's slot indexes this list. */
export function methodList(c: JClass): JMethod[] {
  let list = methodLists.get(c);
  if (!list) methodLists.set(c, (list = [...c.methods.values()]));
  return list;
}

function memberInfo(c: JClass, slot: number): MemberInfo {
  return c.file!.methods[slot]!;
}

function fieldInfo(f: JField): MemberInfo {
  return f.cls.file!.fields.find((m) => m.name === f.name && m.desc === f.desc)!;
}

/** The class a field or parameter descriptor names, resolved from `from` (may throw LoadPending). */
export function typeOf(jvm: Jvm, from: JClass, desc: string): JClass {
  const c = desc.charCodeAt(0);
  if (c === 0x4c) return jvm.loader.resolveClass(from, desc.slice(1, -1));
  if (c === 0x5b) return jvm.loader.resolveClass(from, desc);
  return jvm.loader.primitive(desc as 'I');
}

const str = (jvm: Jvm, s: string | null): JObject | null => (s === null ? null : jvm.heap.newString(s));

function classArray(jvm: Jvm, classes: readonly JClass[]): JArray {
  return jvm.newArray(jvm.bootClass('java/lang/Class'), classes.map((c) => jvm.mirror(c)));
}

export function newField(jvm: Jvm, f: JField): JObject {
  const info = fieldInfo(f);
  const o = jvm.heap.newObject(jvm.bootClass('java/lang/reflect/Field'));
  jvm.setField(o, 'clazz', 'Ljava/lang/Class;', jvm.mirror(f.cls));
  jvm.setField(o, 'slot', 'I', f.slot);
  jvm.setField(o, 'name', 'Ljava/lang/String;', jvm.heap.intern(f.name));
  jvm.setField(o, 'type', 'Ljava/lang/Class;', jvm.mirror(typeOf(jvm, f.cls, f.desc)));
  jvm.setField(o, 'modifiers', 'I', f.access & FIELD_MODIFIERS);
  jvm.setField(o, 'signature', 'Ljava/lang/String;', str(jvm, info.signature));
  jvm.setField(o, 'annotations', '[B', byteArray(jvm, info.annotations));
  return o;
}

/** The JField behind a java.lang.reflect.Field. */
export function fieldOf(jvm: Jvm, o: JObject): JField | null {
  const c = classOf(jvm.getField(o, 'clazz', 'Ljava/lang/Class;'));
  const slot = jvm.getField(o, 'slot', 'I') as number;
  const isStatic = ((jvm.getField(o, 'modifiers', 'I') as number) & 0x0008) !== 0;
  for (const f of c.declaredFields) if (f.slot === slot && f.isStatic === isStatic) return f;
  return null;
}

export function newExecutable(jvm: Jvm, m: JMethod): JObject {
  const c = m.cls;
  const slot = methodList(c).indexOf(m);
  const info = memberInfo(c, slot);
  const ctor = m.name === '<init>';
  const o = jvm.heap.newObject(jvm.bootClass(ctor ? 'java/lang/reflect/Constructor' : 'java/lang/reflect/Method'));
  jvm.setField(o, 'clazz', 'Ljava/lang/Class;', jvm.mirror(c));
  jvm.setField(o, 'slot', 'I', slot);
  jvm.setField(o, 'parameterTypes', '[Ljava/lang/Class;', classArray(jvm, m.argTypes.map((a) => typeOf(jvm, c, a))));
  jvm.setField(o, 'exceptionTypes', '[Ljava/lang/Class;', classArray(jvm, info.exceptions.map((e) => jvm.loader.resolveClass(c, e))));
  jvm.setField(o, 'modifiers', 'I', m.access & METHOD_MODIFIERS);
  jvm.setField(o, 'signature', 'Ljava/lang/String;', str(jvm, info.signature));
  jvm.setField(o, 'annotations', '[B', byteArray(jvm, info.annotations));
  jvm.setField(o, 'parameterAnnotations', '[B', byteArray(jvm, info.parameterAnnotations));
  if (!ctor) {
    jvm.setField(o, 'name', 'Ljava/lang/String;', jvm.heap.intern(m.name));
    jvm.setField(o, 'returnType', 'Ljava/lang/Class;', jvm.mirror(typeOf(jvm, c, m.returnType)));
    jvm.setField(o, 'annotationDefault', '[B', byteArray(jvm, info.annotationDefault));
  }
  return o;
}

/** The JMethod behind a java.lang.reflect.Method or Constructor. */
export function methodOf(jvm: Jvm, o: JObject): JMethod {
  const c = classOf(jvm.getField(o, 'clazz', 'Ljava/lang/Class;'));
  return methodList(c)[jvm.getField(o, 'slot', 'I') as number]!;
}

function declaredMethods(jvm: Jvm, self: JValue, publicOnly: JValue, ctors: boolean): NativeResult {
  const c = classOf(self);
  const list = methodList(c).filter(
    (m) => (ctors ? m.name === '<init>' : m.name !== '<init>' && m.name !== '<clinit>') && (!publicOnly || (m.access & ACC_PUBLIC) !== 0),
  );
  const type = jvm.bootClass(ctors ? 'java/lang/reflect/Constructor' : 'java/lang/reflect/Method');
  return retrying(() => jvm.newArray(type, list.map((m) => newExecutable(jvm, m))));
}

/** Unboxes and checks reflective arguments against the parameter types, as Reflection::invoke does. */
function convertArgs(jvm: Jvm, m: JMethod, args: JValue): JValue[] | ThrowResult {
  const given = args === null ? [] : ((args as JArray).data as (JObject | null)[]);
  if (given.length !== m.argTypes.length) return jvm.throwNew('java/lang/IllegalArgumentException', 'wrong number of arguments');
  const out: JValue[] = [];
  for (let i = 0; i < given.length; i++) {
    const type = m.argTypes[i]!;
    const v = given[i]!;
    if (type.length === 1) {
      const p = unbox(v, type);
      if (p === undefined) return jvm.throwNew('java/lang/IllegalArgumentException', 'argument type mismatch');
      out.push(p);
    } else {
      if (v !== null && !v.cls.isSubclassOf(typeOf(jvm, m.cls, type))) {
        return jvm.throwNew('java/lang/IllegalArgumentException', 'argument type mismatch');
      }
      out.push(v);
    }
  }
  return out;
}

const wrapTarget =
  (jvm: Jvm, t: JThread) =>
  (e: JObject): NativeResult =>
    throwConstructed(jvm, t, 'java/lang/reflect/InvocationTargetException', '(Ljava/lang/Throwable;)V', [e]);

function invoke0(jvm: Jvm, t: JThread, mobj: JValue, obj: JValue, args: JValue): NativeResult {
  const m = methodOf(jvm, mobj as JObject);
  return retrying(() => {
    const converted = convertArgs(jvm, m, args);
    if (converted instanceof ThrowResult) return converted;
    const done = (ret: JValue | undefined): JValue => box(jvm, m.returnType, ret);
    if (m.isStatic) return jvm.withInit(t, m.cls, () => new Invoke(m, converted, done, wrapTarget(jvm, t)));
    if (obj === null) return jvm.throwNew('java/lang/NullPointerException');
    const recv = obj as JObject;
    if (!recv.cls.isSubclassOf(m.cls)) return jvm.throwNew('java/lang/IllegalArgumentException', 'object is not an instance of declaring class');
    let target = m;
    if ((m.access & ACC_PRIVATE) === 0) {
      if (m.cls.isInterface) target = selectMethod(recv.cls, m) ?? m;
      else if (m.vtableIndex >= 0) target = recv.cls.vtable[m.vtableIndex] ?? m;
    }
    if (target.isAbstract) return jvm.throwNew('java/lang/AbstractMethodError', `${externalName(recv.cls.name)}.${m.name}${m.desc}`);
    return new Invoke(target, [recv, ...converted], done, wrapTarget(jvm, t));
  });
}

function newInstance0(jvm: Jvm, t: JThread, cobj: JValue, args: JValue): NativeResult {
  const m = methodOf(jvm, cobj as JObject);
  return retrying(() => {
    const converted = convertArgs(jvm, m, args);
    if (converted instanceof ThrowResult) return converted;
    return jvm.withInit(t, m.cls, () => {
      const o = jvm.heap.newObject(m.cls);
      return new Invoke(m, [o, ...converted], () => o, wrapTarget(jvm, t));
    });
  });
}

function checkArray(jvm: Jvm, arr: JValue): JArray | ThrowResult {
  if (arr === null) return jvm.throwNew('java/lang/NullPointerException');
  if (!(arr as JObject).cls.componentType) return jvm.throwNew('java/lang/IllegalArgumentException', 'Argument is not an array');
  return arr as JArray;
}

function element(jvm: Jvm, arr: JValue, i: JValue): { a: JArray; type: string; i: number } | ThrowResult {
  const a = checkArray(jvm, arr);
  if (a instanceof ThrowResult) return a;
  const n = i as number;
  if (n < 0 || n >= a.data.length) return jvm.throwNew('java/lang/ArrayIndexOutOfBoundsException');
  return { a, type: a.cls.componentType!.descriptor, i: n };
}

function getAs(jvm: Jvm, arr: JValue, i: JValue, to: string): NativeResult {
  const e = element(jvm, arr, i);
  if (e instanceof ThrowResult) return e;
  if (e.type.length !== 1) return jvm.throwNew('java/lang/IllegalArgumentException', 'Argument is not an array of primitive type');
  const v = widen(e.a.data[e.i]!, e.type, to);
  return v === undefined ? jvm.throwNew('java/lang/IllegalArgumentException', 'argument type mismatch') : v;
}

function setAs(jvm: Jvm, arr: JValue, i: JValue, v: JValue, from: string): NativeResult {
  const e = element(jvm, arr, i);
  if (e instanceof ThrowResult) return e;
  const w = e.type.length === 1 ? widen(v, from, e.type) : undefined;
  if (w === undefined) return jvm.throwNew('java/lang/IllegalArgumentException', 'argument type mismatch');
  (e.a.data as JValue[])[e.i] = w;
  return undefined;
}

function newArrayOf(jvm: Jvm, component: JValue, dims: readonly number[]): NativeResult {
  if (component === null) return jvm.throwNew('java/lang/NullPointerException');
  let c = classOf(component);
  if (c.descriptor === 'V') return jvm.throwNew('java/lang/IllegalArgumentException');
  if (dims.some((n) => n < 0)) return jvm.throwNew('java/lang/NegativeArraySizeException');
  let depth = dims.length;
  for (let e: JClass | null = c; e?.componentType; e = e.componentType) depth++;
  if (depth > 255) return jvm.throwNew('java/lang/IllegalArgumentException');
  for (let k = 0; k < dims.length; k++) c = jvm.loader.arrayOf(c);
  const make = (cls: JClass, d: number): JArray => {
    const arr = jvm.heap.newArray(cls, dims[d]!);
    if (d + 1 < dims.length) for (let k = 0; k < arr.data.length; k++) (arr.data as JObject[])[k] = make(cls.componentType!, d + 1);
    return arr;
  };
  return make(c, 0);
}

/** Frames Reflection.getCallerClass passes over: Method.invoke and the method accessors (HotSpot's security walk). */
function ignoredFrame(jvm: Jvm, m: JMethod): boolean {
  if (m.cls.name === 'java/lang/reflect/Method' && m.name === 'invoke') return true;
  const accessor = jvm.loader.loadBoot('sun/reflect/MethodAccessorImpl');
  return accessor !== null && m.cls.isSubclassOf(accessor);
}

function cpEntryOf(jvm: Jvm, cp: JValue, index: JValue): { c: JClass; e: NonNullable<NonNullable<JClass['file']>['cp'][number]> } | ThrowResult {
  const c = classOf(cp);
  const e = c.file?.cp[index as number];
  if (!e) return jvm.throwNew('java/lang/IllegalArgumentException', 'Wrong type at constant pool index');
  return { c, e };
}

function cpValue(jvm: Jvm, cp: JValue, index: JValue, tag: string): NativeResult {
  const r = cpEntryOf(jvm, cp, index);
  if (r instanceof ThrowResult) return r;
  if (r.e.tag !== tag) return jvm.throwNew('java/lang/IllegalArgumentException', 'Wrong type at constant pool index');
  return (r.e as { value: JValue }).value;
}

function cpUtf8(c: JClass, i: number): string {
  const e = c.file!.cp[i];
  return e?.tag === 'utf8' ? e.value : '';
}

function cpMember(jvm: Jvm, cp: JValue, index: JValue, field: boolean): NativeResult {
  const r = cpEntryOf(jvm, cp, index);
  if (r instanceof ThrowResult) return r;
  const { c, e } = r;
  if (field ? e.tag !== 'fieldref' : e.tag !== 'methodref' && e.tag !== 'imethodref') {
    return jvm.throwNew('java/lang/IllegalArgumentException', 'Wrong type at constant pool index');
  }
  const ref = e as { cls: number; nat: number };
  const owner = c.file!.cp[ref.cls] as { name: number };
  const nat = c.file!.cp[ref.nat] as { name: number; desc: number };
  return retrying(() => {
    const o = jvm.loader.resolveClass(c, cpUtf8(c, owner.name));
    const name = cpUtf8(c, nat.name);
    const desc = cpUtf8(c, nat.desc);
    if (field) {
      const f = o.findField(name, desc);
      return f ? newField(jvm, f) : jvm.throwNew('java/lang/NoSuchFieldError', name);
    }
    const m = o.findMethod(name, desc) ?? o.findInterfaceMethod(name, desc);
    return m ? newExecutable(jvm, m) : jvm.throwNew('java/lang/NoSuchMethodError', name);
  });
}

export function registerReflectNatives(table: NativeTable): void {
  table.register({
    'java/lang/Class.getDeclaredFields0(Z)[Ljava/lang/reflect/Field;': (ctx, self, publicOnly) => {
      const jvm = ctx.jvm;
      const fields = [...classOf(self).declaredFields].filter((f) => !publicOnly || (f.access & ACC_PUBLIC) !== 0);
      return retrying(() => jvm.newArray(jvm.bootClass('java/lang/reflect/Field'), fields.map((f) => newField(jvm, f))));
    },
    'java/lang/Class.getDeclaredMethods0(Z)[Ljava/lang/reflect/Method;': (ctx, self, publicOnly) => declaredMethods(ctx.jvm, self, publicOnly, false),
    'java/lang/Class.getDeclaredConstructors0(Z)[Ljava/lang/reflect/Constructor;': (ctx, self, publicOnly) =>
      declaredMethods(ctx.jvm, self, publicOnly, true),
    'java/lang/Class.getRawAnnotations()[B': (ctx, self) => byteArray(ctx.jvm, classOf(self).file?.annotations ?? null),
    'java/lang/Class.getRawTypeAnnotations()[B': () => null,
    'java/lang/Class.getConstantPool()Lsun/reflect/ConstantPool;': (ctx, self) => {
      const cp = ctx.jvm.heap.newObject(ctx.jvm.bootClass('sun/reflect/ConstantPool'));
      ctx.jvm.setField(cp, 'constantPoolOop', 'Ljava/lang/Object;', self);
      return cp;
    },
    'java/lang/reflect/Executable.getParameters0()[Ljava/lang/reflect/Parameter;': () => null,
    'java/lang/reflect/Executable.getTypeAnnotationBytes0()[B': () => null,
    'java/lang/reflect/Field.getTypeAnnotationBytes0()[B': () => null,

    // Frame 0 is getCallerClass itself, frame 1 the caller-sensitive method that called it.
    'sun/reflect/Reflection.getCallerClass()Ljava/lang/Class;': (ctx) => {
      const frames = ctx.thread.frames;
      for (let i = frames.length - 3; i >= 0; i--) {
        const m = frames[i]!.method;
        if (!ignoredFrame(ctx.jvm, m)) return ctx.jvm.mirror(m.cls);
      }
      return null;
    },
    'sun/reflect/Reflection.getCallerClass(I)Ljava/lang/Class;': (ctx, depth) => {
      const jvm = ctx.jvm;
      const list: JClass[] = [];
      const frames = ctx.thread.frames;
      for (let i = frames.length - 1; i >= 0; i--) if (!ignoredFrame(jvm, frames[i]!.method)) list.push(frames[i]!.method.cls);
      const c = list[depth as number];
      return c ? jvm.mirror(c) : null;
    },
    'sun/reflect/Reflection.getClassAccessFlags(Ljava/lang/Class;)I': (_ctx, c) => classOf(c).access & JVM_ACC_WRITTEN_FLAGS,

    'sun/reflect/NativeMethodAccessorImpl.invoke0(Ljava/lang/reflect/Method;Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/Object;': (ctx, m, obj, args) =>
      invoke0(ctx.jvm, ctx.thread, m, obj, args),
    'sun/reflect/NativeConstructorAccessorImpl.newInstance0(Ljava/lang/reflect/Constructor;[Ljava/lang/Object;)Ljava/lang/Object;': (ctx, c, args) =>
      newInstance0(ctx.jvm, ctx.thread, c, args),

    'java/lang/reflect/Array.getLength(Ljava/lang/Object;)I': (ctx, arr) => {
      const a = checkArray(ctx.jvm, arr);
      return a instanceof ThrowResult ? a : a.data.length;
    },
    'java/lang/reflect/Array.get(Ljava/lang/Object;I)Ljava/lang/Object;': (ctx, arr, i) => {
      const e = element(ctx.jvm, arr, i);
      if (e instanceof ThrowResult) return e;
      return e.type.length === 1 ? box(ctx.jvm, e.type, e.a.data[e.i]!) : (e.a.data[e.i] as JValue);
    },
    'java/lang/reflect/Array.getBoolean(Ljava/lang/Object;I)Z': (ctx, a, i) => getAs(ctx.jvm, a, i, 'Z'),
    'java/lang/reflect/Array.getByte(Ljava/lang/Object;I)B': (ctx, a, i) => getAs(ctx.jvm, a, i, 'B'),
    'java/lang/reflect/Array.getChar(Ljava/lang/Object;I)C': (ctx, a, i) => getAs(ctx.jvm, a, i, 'C'),
    'java/lang/reflect/Array.getShort(Ljava/lang/Object;I)S': (ctx, a, i) => getAs(ctx.jvm, a, i, 'S'),
    'java/lang/reflect/Array.getInt(Ljava/lang/Object;I)I': (ctx, a, i) => getAs(ctx.jvm, a, i, 'I'),
    'java/lang/reflect/Array.getLong(Ljava/lang/Object;I)J': (ctx, a, i) => getAs(ctx.jvm, a, i, 'J'),
    'java/lang/reflect/Array.getFloat(Ljava/lang/Object;I)F': (ctx, a, i) => getAs(ctx.jvm, a, i, 'F'),
    'java/lang/reflect/Array.getDouble(Ljava/lang/Object;I)D': (ctx, a, i) => getAs(ctx.jvm, a, i, 'D'),
    'java/lang/reflect/Array.set(Ljava/lang/Object;ILjava/lang/Object;)V': (ctx, arr, i, v) => {
      const jvm = ctx.jvm;
      const e = element(jvm, arr, i);
      if (e instanceof ThrowResult) return e;
      if (e.type.length !== 1) {
        if (v !== null && !(v as JObject).cls.isSubclassOf(e.a.cls.componentType!)) {
          return jvm.throwNew('java/lang/IllegalArgumentException', 'array element type mismatch');
        }
        (e.a.data as JValue[])[e.i] = v;
        return undefined;
      }
      const from = v === null ? null : boxedType(v as JObject);
      const w = from === null ? undefined : unbox(v, e.type);
      if (w === undefined) return jvm.throwNew('java/lang/IllegalArgumentException', 'argument type mismatch');
      (e.a.data as JValue[])[e.i] = w;
      return undefined;
    },
    'java/lang/reflect/Array.setBoolean(Ljava/lang/Object;IZ)V': (ctx, a, i, v) => setAs(ctx.jvm, a, i, v, 'Z'),
    'java/lang/reflect/Array.setByte(Ljava/lang/Object;IB)V': (ctx, a, i, v) => setAs(ctx.jvm, a, i, v, 'B'),
    'java/lang/reflect/Array.setChar(Ljava/lang/Object;IC)V': (ctx, a, i, v) => setAs(ctx.jvm, a, i, v, 'C'),
    'java/lang/reflect/Array.setShort(Ljava/lang/Object;IS)V': (ctx, a, i, v) => setAs(ctx.jvm, a, i, v, 'S'),
    'java/lang/reflect/Array.setInt(Ljava/lang/Object;II)V': (ctx, a, i, v) => setAs(ctx.jvm, a, i, v, 'I'),
    'java/lang/reflect/Array.setLong(Ljava/lang/Object;IJ)V': (ctx, a, i, v) => setAs(ctx.jvm, a, i, v, 'J'),
    'java/lang/reflect/Array.setFloat(Ljava/lang/Object;IF)V': (ctx, a, i, v) => setAs(ctx.jvm, a, i, v, 'F'),
    'java/lang/reflect/Array.setDouble(Ljava/lang/Object;ID)V': (ctx, a, i, v) => setAs(ctx.jvm, a, i, v, 'D'),
    'java/lang/reflect/Array.newArray(Ljava/lang/Class;I)Ljava/lang/Object;': (ctx, c, n) => newArrayOf(ctx.jvm, c, [n as number]),
    'java/lang/reflect/Array.multiNewArray(Ljava/lang/Class;[I)Ljava/lang/Object;': (ctx, c, dims) => {
      if (dims === null) return ctx.jvm.throwNew('java/lang/NullPointerException');
      const d = [...((dims as JArray).data as Int32Array)];
      if (d.length === 0) return ctx.jvm.throwNew('java/lang/IllegalArgumentException', 'Empty dimensions array');
      return newArrayOf(ctx.jvm, c, d);
    },

    'java/lang/reflect/Proxy.defineClass0(Ljava/lang/ClassLoader;Ljava/lang/String;[BII)Ljava/lang/Class;': (ctx, loader, name, b, off, len) => {
      const jvm = ctx.jvm;
      const data = (b as JArray).data as Int8Array;
      const bytes = new Uint8Array(data.buffer, data.byteOffset + (off as number), len as number).slice();
      const internal = internalName(jsStr(jvm, name));
      return retrying(() => jvm.mirror(jvm.loader.define(internal, bytes, loader as JObject | null, null)));
    },

    'sun/reflect/ConstantPool.getSize0(Ljava/lang/Object;)I': (_ctx, _self, cp) => classOf(cp).file?.cp.length ?? 0,
    'sun/reflect/ConstantPool.getClassAt0(Ljava/lang/Object;I)Ljava/lang/Class;': (ctx, _self, cp, i) => {
      const r = cpEntryOf(ctx.jvm, cp, i);
      if (r instanceof ThrowResult) return r;
      if (r.e.tag !== 'class') return ctx.jvm.throwNew('java/lang/IllegalArgumentException', 'Wrong type at constant pool index');
      const name = cpUtf8(r.c, r.e.name);
      return retrying(() => ctx.jvm.mirror(ctx.jvm.loader.resolveClass(r.c, name)));
    },
    'sun/reflect/ConstantPool.getClassAtIfLoaded0(Ljava/lang/Object;I)Ljava/lang/Class;': (ctx, _self, cp, i) => {
      const r = cpEntryOf(ctx.jvm, cp, i);
      if (r instanceof ThrowResult) return r;
      if (r.e.tag !== 'class') return ctx.jvm.throwNew('java/lang/IllegalArgumentException', 'Wrong type at constant pool index');
      const c = ctx.jvm.loader.findLoaded(r.c.loader, cpUtf8(r.c, r.e.name));
      return c ? ctx.jvm.mirror(c) : null;
    },
    'sun/reflect/ConstantPool.getMethodAt0(Ljava/lang/Object;I)Ljava/lang/reflect/Member;': (ctx, _self, cp, i) => cpMember(ctx.jvm, cp, i, false),
    'sun/reflect/ConstantPool.getMethodAtIfLoaded0(Ljava/lang/Object;I)Ljava/lang/reflect/Member;': (ctx, _self, cp, i) => cpMember(ctx.jvm, cp, i, false),
    'sun/reflect/ConstantPool.getFieldAt0(Ljava/lang/Object;I)Ljava/lang/reflect/Field;': (ctx, _self, cp, i) => cpMember(ctx.jvm, cp, i, true),
    'sun/reflect/ConstantPool.getFieldAtIfLoaded0(Ljava/lang/Object;I)Ljava/lang/reflect/Field;': (ctx, _self, cp, i) => cpMember(ctx.jvm, cp, i, true),
    'sun/reflect/ConstantPool.getMemberRefInfoAt0(Ljava/lang/Object;I)[Ljava/lang/String;': (ctx, _self, cp, i) => {
      const jvm = ctx.jvm;
      const r = cpEntryOf(jvm, cp, i);
      if (r instanceof ThrowResult) return r;
      if (r.e.tag !== 'fieldref' && r.e.tag !== 'methodref' && r.e.tag !== 'imethodref') {
        return jvm.throwNew('java/lang/IllegalArgumentException', 'Wrong type at constant pool index');
      }
      const owner = r.c.file!.cp[r.e.cls] as { name: number };
      const nat = r.c.file!.cp[r.e.nat] as { name: number; desc: number };
      return jvm.newArray(
        jvm.bootClass('java/lang/String'),
        [cpUtf8(r.c, owner.name), cpUtf8(r.c, nat.name), cpUtf8(r.c, nat.desc)].map((s) => jvm.heap.newString(s)),
      );
    },
    'sun/reflect/ConstantPool.getIntAt0(Ljava/lang/Object;I)I': (ctx, _self, cp, i) => cpValue(ctx.jvm, cp, i, 'int'),
    'sun/reflect/ConstantPool.getLongAt0(Ljava/lang/Object;I)J': (ctx, _self, cp, i) => cpValue(ctx.jvm, cp, i, 'long'),
    'sun/reflect/ConstantPool.getFloatAt0(Ljava/lang/Object;I)F': (ctx, _self, cp, i) => cpValue(ctx.jvm, cp, i, 'float'),
    'sun/reflect/ConstantPool.getDoubleAt0(Ljava/lang/Object;I)D': (ctx, _self, cp, i) => cpValue(ctx.jvm, cp, i, 'double'),
    'sun/reflect/ConstantPool.getStringAt0(Ljava/lang/Object;I)Ljava/lang/String;': (ctx, _self, cp, i) => {
      const r = cpEntryOf(ctx.jvm, cp, i);
      if (r instanceof ThrowResult) return r;
      if (r.e.tag !== 'string') return ctx.jvm.throwNew('java/lang/IllegalArgumentException', 'Wrong type at constant pool index');
      return ctx.jvm.heap.intern(cpUtf8(r.c, r.e.utf8));
    },
    'sun/reflect/ConstantPool.getUTF8At0(Ljava/lang/Object;I)Ljava/lang/String;': (ctx, _self, cp, i) => {
      const r = cpEntryOf(ctx.jvm, cp, i);
      if (r instanceof ThrowResult) return r;
      if (r.e.tag !== 'utf8') return ctx.jvm.throwNew('java/lang/IllegalArgumentException', 'Wrong type at constant pool index');
      return ctx.jvm.heap.intern(r.e.value);
    },
  });
}
