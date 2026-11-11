/*
 * java.lang.invoke in the BD-J virtual machine: MethodHandleNatives, the signature-polymorphic MethodHandle methods,
 * invokedynamic call sites and the MethodType and MethodHandle constants of ldc.
 *
 * The linkage follows DoppioJVM (MIT; see src/bdj/NOTICE): call sites and constants are linked through the JDK's
 * own MethodHandleNatives.linkCallSite, linkMethod, linkMethodHandleConstant and findMethodHandleType, and a
 * MemberName carries its VM target. Unlike Doppio, LambdaForms are not compiled to bytecode: LambdaForm.compileToBytecode
 * is replaced by a native that gives the form an entry point standing for itself, and invokeBasic evaluates a form's
 * names here in JS, one Java call at a time, with unboxed values. The JDK's InvokerBytecodeGenerator never runs.
 *
 * Copyright (C) 2026 Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { Invoke, Suspend, ThrowResult, andThen } from '../interpreter';
import type { NativeResult } from '../interpreter';
import { ACC_PRIVATE, externalName, parseMethodDescriptor, retrying, selectMethod } from '../loader';
import type { JClass, JField, JMethod } from '../loader';
import type { Jvm } from '../jvm';
import type { JThread } from '../threads';
import { isWide } from '../values';
import type { JArray, JObject, JValue } from '../values';
import type { NativeContext, NativeFn, NativeTable } from './index';
import { classOf } from './lang';
import { fieldOf, methodList, methodOf, typeOf } from './reflect';
import { staticFieldBase } from './unsafe';
import { box, jsStr, method, unbox } from './util';

const MH = 'java/lang/invoke/MethodHandle';
const MN = 'java/lang/invoke/MemberName';
const MHN = 'java/lang/invoke/MethodHandleNatives';

const IS_METHOD = 0x00010000;
const IS_CONSTRUCTOR = 0x00020000;
const IS_FIELD = 0x00040000;
const IS_TYPE = 0x00080000;
const CALLER_SENSITIVE = 0x00100000;
const ALL_KINDS = IS_METHOD | IS_CONSTRUCTOR | IS_FIELD | IS_TYPE;
const REF_SHIFT = 24;

const REF_getField = 1;
const REF_getStatic = 2;
const REF_putField = 3;
const REF_putStatic = 4;
const REF_invokeVirtual = 5;
const REF_invokeStatic = 6;
const REF_invokeSpecial = 7;
const REF_newInvokeSpecial = 8;
const REF_invokeInterface = 9;

/** JVM_RECOGNIZED_METHOD_MODIFIERS and JVM_RECOGNIZED_FIELD_MODIFIERS. */
const METHOD_MODIFIERS = 0x1dff;
const FIELD_MODIFIERS = 0x50df;

const GENERIC = '([Ljava/lang/Object;)Ljava/lang/Object;';
const LINKERS: Readonly<Record<string, number>> = {
  linkToStatic: REF_invokeStatic,
  linkToSpecial: REF_invokeSpecial,
  linkToVirtual: REF_invokeVirtual,
  linkToInterface: REF_invokeInterface,
};

/** The VM target of a MemberName (its nativeData), as HotSpot's injected vmtarget. */
class MethodTarget {
  constructor(readonly method: JMethod) {}
}

class FieldTarget {
  constructor(readonly field: JField) {}
}

/** The entry point compileToBytecode gives a LambdaForm: invoking it evaluates the form. */
class FormEntry {
  constructor(readonly form: JObject) {}
}

/** Instance-field slots of the java.lang.invoke classes, looked up once per VM. */
const slotCache = new WeakMap<Jvm, Map<string, number>>();

function slot(jvm: Jvm, cls: string, name: string, desc: string): number {
  let map = slotCache.get(jvm);
  if (!map) slotCache.set(jvm, (map = new Map()));
  const key = `${cls}.${name}`;
  let s = map.get(key);
  if (s === undefined) {
    const f = jvm.bootClass(cls).findField(name, desc);
    if (!f || f.isStatic) throw new Error(`${cls} has no field ${name} ${desc}`);
    map.set(key, (s = f.slot));
  }
  return s;
}

const get = (jvm: Jvm, o: JObject, cls: string, name: string, desc: string): JValue => o.fields[slot(jvm, cls, name, desc)]!;

function set(jvm: Jvm, o: JObject, cls: string, name: string, desc: string, v: JValue): void {
  o.fields[slot(jvm, cls, name, desc)] = v;
}

const mnFlags = (jvm: Jvm, mn: JObject): number => get(jvm, mn, MN, 'flags', 'I') as number;

function npe(jvm: Jvm): ThrowResult {
  return jvm.throwNew('java/lang/NullPointerException');
}

function internalError(jvm: Jvm, message: string): ThrowResult {
  return jvm.throwNew('java/lang/InternalError', message);
}

/** The descriptor of a MemberName's type: a MethodType, a Class (a field), a descriptor String or {rtype, ptypes}. */
function typeDescriptor(jvm: Jvm, type: JObject): string {
  switch (type.cls.name) {
    case 'java/lang/String':
      return jsStr(jvm, type);
    case 'java/lang/Class':
      return classOf(type).descriptor;
    case 'java/lang/invoke/MethodType': {
      const r = get(jvm, type, 'java/lang/invoke/MethodType', 'rtype', 'Ljava/lang/Class;') as JObject;
      const p = get(jvm, type, 'java/lang/invoke/MethodType', 'ptypes', '[Ljava/lang/Class;') as JArray;
      return `(${(p.data as JObject[]).map((c) => classOf(c).descriptor).join('')})${classOf(r).descriptor}`;
    }
    default: {
      const parts = (type as JArray).data as JObject[];
      const p = parts[1] as JArray;
      return `(${(p.data as JObject[]).map((c) => classOf(c).descriptor).join('')})${classOf(parts[0]!).descriptor}`;
    }
  }
}

/** Skips one element_value of an annotation (JVM §4.7.16.1) and returns the position after it. */
function skipElement(b: Uint8Array, p: number): number {
  const tag = String.fromCharCode(b[p]!);
  p++;
  if (tag === 'e') return p + 4;
  if (tag === '@') return skipAnnotation(b, p);
  if (tag === '[') {
    let n = (b[p]! << 8) | b[p + 1]!;
    p += 2;
    while (n-- > 0) p = skipElement(b, p);
    return p;
  }
  return p + 2;
}

function skipAnnotation(b: Uint8Array, p: number): number {
  let n = (b[p + 2]! << 8) | b[p + 3]!;
  p += 4;
  while (n-- > 0) p = skipElement(b, p + 2);
  return p;
}

/** @CallerSensitive, which HotSpot honours on classes of the boot class path. */
function isCallerSensitive(m: JMethod): boolean {
  const c = m.cls;
  if (c.loader !== null || !c.file) return false;
  const info = c.file.methods[methodList(c).indexOf(m)];
  const b = info?.annotations;
  if (!b) return false;
  let n = (b[0]! << 8) | b[1]!;
  let p = 2;
  while (n-- > 0) {
    const e = c.file.cp[(b[p]! << 8) | b[p + 1]!];
    if (e?.tag === 'utf8' && e.value === 'Lsun/reflect/CallerSensitive;') return true;
    p = skipAnnotation(b, p);
  }
  return false;
}

/** Fills in a MemberName for a method or constructor (MethodHandles::init_method_MemberName's contract). */
function initMethod(jvm: Jvm, mn: JObject, m: JMethod, refKind: number): void {
  const kind = m.name === '<init>' ? IS_CONSTRUCTOR : IS_METHOD;
  let flags = kind | (refKind << REF_SHIFT) | (m.access & METHOD_MODIFIERS);
  if (isCallerSensitive(m)) flags |= CALLER_SENSITIVE;
  set(jvm, mn, MN, 'clazz', 'Ljava/lang/Class;', jvm.mirror(m.cls));
  set(jvm, mn, MN, 'flags', 'I', flags);
  mn.nativeData = new MethodTarget(m);
}

function initField(jvm: Jvm, mn: JObject, f: JField, refKind: number): void {
  set(jvm, mn, MN, 'clazz', 'Ljava/lang/Class;', jvm.mirror(f.cls));
  set(jvm, mn, MN, 'flags', 'I', IS_FIELD | (refKind << REF_SHIFT) | (f.access & FIELD_MODIFIERS));
  mn.nativeData = new FieldTarget(f);
}

function setNameAndType(jvm: Jvm, mn: JObject, name: string, desc: string): void {
  set(jvm, mn, MN, 'name', 'Ljava/lang/String;', jvm.heap.intern(name));
  set(jvm, mn, MN, 'type', 'Ljava/lang/Object;', jvm.heap.intern(desc));
}

function isSignaturePolymorphic(m: JMethod): boolean {
  return m.cls.name === MH && m.desc === GENERIC && (m.access & 0x0180) === 0x0180;
}

/** The signature-polymorphic method `name` that `owner` or a superclass declares (JVM §5.4.3.3), if any. */
function polymorphicMethod(owner: JClass, name: string): JMethod | null {
  for (let c: JClass | null = owner; c; c = c.superClass) {
    if (c.name !== MH) continue;
    const m = c.methods.get(name + GENERIC);
    return m && isSignaturePolymorphic(m) ? m : null;
  }
  return null;
}

/** Method selection for a receiver, as invokevirtual and invokeinterface do it. */
function select(recv: JObject, m: JMethod): JMethod {
  if (m.isStatic || m.access & ACC_PRIVATE || m.name === '<init>') return m;
  if (m.cls.isInterface) return selectMethod(recv.cls, m) ?? m;
  if (m.vtableIndex >= 0) return recv.cls.vtable[m.vtableIndex] ?? m;
  return m;
}

const same = (v: JValue | undefined): JValue | undefined => v;

/** Performs a member's reference kind on `args` (JVM §5.4.3.5's bytecode behaviours). */
function callMember(ctx: NativeContext, refKind: number, target: MethodTarget | FieldTarget, args: readonly JValue[]): NativeResult {
  const jvm = ctx.jvm;
  if (target instanceof FieldTarget) {
    const f = target.field;
    if (f.isStatic) {
      return jvm.withInit(ctx.thread, f.cls, () => {
        if (refKind === REF_putStatic) {
          f.cls.staticValues[f.slot] = args[0]!;
          return undefined;
        }
        return f.cls.staticValues[f.slot]!;
      });
    }
    const o = args[0] as JObject | null;
    if (o === null) return npe(jvm);
    if (refKind === REF_putField) {
      o.fields[f.slot] = args[1]!;
      return undefined;
    }
    return o.fields[f.slot]!;
  }
  const m = target.method;
  switch (refKind) {
    case REF_invokeStatic:
      return jvm.withInit(ctx.thread, m.cls, () => new Invoke(m, args, same));
    case REF_newInvokeSpecial:
      return jvm.withInit(ctx.thread, m.cls, () => {
        const o = jvm.heap.newObject(m.cls);
        return new Invoke(m, [o, ...args], () => o);
      });
    case REF_invokeSpecial:
      if (args[0] === null) return npe(jvm);
      return new Invoke(m, args, same);
    case REF_invokeInterface: {
      // As invokeinterface: the receiver must implement the interface, and selection must find a method.
      const recv = args[0] as JObject | null;
      if (recv === null) return npe(jvm);
      if (!recv.cls.isSubclassOf(m.cls)) {
        return jvm.throwNew('java/lang/IncompatibleClassChangeError', `Class ${externalName(recv.cls.name)} does not implement the requested interface ${externalName(m.cls.name)}`);
      }
      const target = m.cls.isInterface ? selectMethod(recv.cls, m) : select(recv, m);
      if (!target || target.isAbstract) return jvm.throwNew('java/lang/AbstractMethodError', `${externalName(recv.cls.name)}.${m.name}${m.desc}`);
      return new Invoke(target, args, same);
    }
    default: {
      const recv = args[0] as JObject | null;
      if (recv === null) return npe(jvm);
      return new Invoke(select(recv, m), args, same);
    }
  }
}

/** A Name argument of a LambdaForm: the value of name `i`. */
class Ref {
  constructor(readonly i: number) {}
}

type Callee = (ctx: NativeContext, args: JValue[]) => NativeResult;

interface Step {
  readonly fn: JObject;
  args: (Ref | JValue)[];
  call: Callee | null;
}

/** A LambdaForm's names, read once (its nativeData). */
class CompiledForm {
  constructor(
    readonly arity: number,
    readonly result: number,
    readonly steps: readonly Step[],
  ) {}
}

const LF = 'java/lang/invoke/LambdaForm';
const NAME = 'java/lang/invoke/LambdaForm$Name';
const NF = 'java/lang/invoke/LambdaForm$NamedFunction';

function compileForm(jvm: Jvm, form: JObject): CompiledForm {
  const arity = get(jvm, form, LF, 'arity', 'I') as number;
  const result = get(jvm, form, LF, 'result', 'I') as number;
  const names = (get(jvm, form, LF, 'names', `[L${NAME};`) as JArray).data as JObject[];
  const nameClass = jvm.bootClass(NAME);
  const steps: Step[] = [];
  for (let i = arity; i < names.length; i++) {
    const n = names[i]!;
    const args = ((get(jvm, n, NAME, 'arguments', '[Ljava/lang/Object;') as JArray).data as (JObject | null)[]).map((a) =>
      a !== null && a.cls === nameClass ? new Ref(get(jvm, a, NAME, 'index', 'S') as number) : a,
    );
    steps.push({ fn: get(jvm, n, NAME, 'function', `L${NF};`) as JObject, args, call: null });
  }
  return new CompiledForm(arity, result, steps);
}

/** A constant argument for a primitive parameter is a wrapper, as LambdaForm.interpretName passes it. */
function unboxConstants(step: Step, types: readonly string[]): void {
  step.args = step.args.map((a, i) => {
    if (a instanceof Ref || a === null || typeof a !== 'object') return a;
    const t = types[i];
    return t && t.length === 1 ? (unbox(a, t) ?? a) : a;
  });
}

function calleeOf(jvm: Jvm, step: Step): Callee {
  const member = get(jvm, step.fn, NF, 'member', `L${MN};`) as JObject | null;
  if (member === null) {
    const handle = get(jvm, step.fn, NF, 'resolvedHandle', `L${MH};`) as JObject | null;
    if (handle === null) return (ctx) => internalError(ctx.jvm, 'LambdaForm name without a function');
    return (ctx, a) => invokeBasic(ctx, handle, a);
  }
  const clazz = get(jvm, member, MN, 'clazz', 'Ljava/lang/Class;') as JObject | null;
  if (clazz !== null && classOf(clazz).name === MH) {
    const name = jsStr(jvm, get(jvm, member, MN, 'name', 'Ljava/lang/String;'));
    if (name === 'invokeBasic') return (ctx, a) => invokeBasic(ctx, a[0] as JObject | null, a.slice(1));
    const link = LINKERS[name];
    if (link !== undefined) return (ctx, a) => linkTo(ctx, link, a);
  }
  const target = member.nativeData;
  if (!(target instanceof MethodTarget || target instanceof FieldTarget)) {
    return (ctx) => internalError(ctx.jvm, `unresolved LambdaForm function ${jsStr(jvm, get(jvm, member, MN, 'name', 'Ljava/lang/String;'))}`);
  }
  const refKind = (mnFlags(jvm, member) >>> REF_SHIFT) & 0xf;
  if (target instanceof MethodTarget) {
    const m = target.method;
    unboxConstants(step, refKind === REF_newInvokeSpecial || m.isStatic ? m.argTypes : ['L', ...m.argTypes]);
  }
  return (ctx, a) => callMember(ctx, refKind, target, a);
}

/** Evaluates a LambdaForm on its arguments (LambdaForm.interpretWithArguments, in JS). */
function interpret(ctx: NativeContext, form: JObject, args: readonly JValue[]): NativeResult {
  let c = form.nativeData;
  if (!(c instanceof CompiledForm)) form.nativeData = c = compileForm(ctx.jvm, form);
  const compiled = c as CompiledForm;
  if (args.length !== compiled.arity) return internalError(ctx.jvm, `LambdaForm arity ${compiled.arity}, called with ${args.length}`);
  const values: JValue[] = args.slice();
  const steps = compiled.steps;
  const run = (from: number): NativeResult => {
    for (let i = from; i < steps.length; i++) {
      const s = steps[i]!;
      const call = (s.call ??= calleeOf(ctx.jvm, s));
      const r = call(
        ctx,
        s.args.map((a) => (a instanceof Ref ? values[a.i]! : a)),
      );
      if (r instanceof Invoke || r instanceof Suspend || r instanceof ThrowResult) {
        return andThen(r, (v) => {
          values[compiled.arity + i] = v ?? null;
          return run(i + 1);
        });
      }
      values[compiled.arity + i] = r ?? null;
    }
    return compiled.result < 0 ? undefined : values[compiled.result];
  };
  return run(0);
}

/** MethodHandle.invokeBasic: runs the handle's form, the handle first (Doppio src/opcodes.ts invokebasic). */
function invokeBasic(ctx: NativeContext, handle: JObject | null, args: readonly JValue[]): NativeResult {
  if (handle === null) return npe(ctx.jvm);
  return interpret(ctx, get(ctx.jvm, handle, MH, 'form', `L${LF};`) as JObject, [handle, ...args]);
}

/** MethodHandle.linkTo*: the trailing MemberName names the target (Doppio src/opcodes.ts linktospecial, linktovirtual). */
function linkTo(ctx: NativeContext, refKind: number, args: readonly JValue[]): NativeResult {
  const mn = args[args.length - 1] as JObject | null;
  if (mn === null) return npe(ctx.jvm);
  const target = mn.nativeData;
  if (!(target instanceof MethodTarget)) return internalError(ctx.jvm, 'linkTo* with an unresolved MemberName');
  return callMember(ctx, refKind, target, args.slice(0, -1));
}

/** Calls what a linker MemberName (from linkCallSite or linkMethod) stands for. */
function invokeLinked(ctx: NativeContext, mn: JObject, args: readonly JValue[]): NativeResult {
  const target = mn.nativeData;
  if (target instanceof FormEntry) return interpret(ctx, target.form, args);
  if (target instanceof MethodTarget) return callMember(ctx, REF_invokeStatic, target, args);
  return internalError(ctx.jvm, 'linked MemberName without a target');
}

/** A native method object standing for a signature-polymorphic call or a call site, typed by the call's descriptor. */
function syntheticMethod(cls: JClass, name: string, desc: string, isStatic: boolean, fn: NativeFn): JMethod {
  const { args, ret } = parseMethodDescriptor(desc);
  let argSlots = isStatic ? 0 : 1;
  for (const a of args) argSlots += isWide(a) ? 2 : 1;
  return {
    cls,
    name,
    desc,
    access: 0x0111 | (isStatic ? 0x0008 : 0),
    code: null,
    argSlots,
    argTypes: args,
    returnType: ret,
    vtableIndex: -1,
    isStatic,
    isNative: true,
    isAbstract: false,
    isSynchronized: false,
    nativeKey: `${cls.name}.${name}${desc}`,
    native: fn,
    intrinsic: undefined,
    loopHooks: undefined,
    frameTemplate: undefined,
    tiny: undefined,
  };
}

/** Drops the value of a call whose descriptor returns void. */
function typed(ret: string, r: NativeResult): NativeResult {
  return ret === 'V' ? andThen(r, () => undefined) : r;
}

function callJava(jvm: Jvm, t: JThread, cls: string, key: string, args: readonly JValue[]): NativeResult {
  const c = jvm.bootClass(cls);
  return jvm.withInit(t, c, () => new Invoke(method(c, key), args, same));
}

/** A MethodType for a descriptor, resolved from `from` (Doppio src/util.ts createMethodType). */
function methodType(jvm: Jvm, t: JThread, from: JClass, desc: string): NativeResult {
  return retrying(() => {
    const { args, ret } = parseMethodDescriptor(desc);
    const r = typeOf(jvm, from, ret);
    const ps = args.map((a) => jvm.mirror(typeOf(jvm, from, a)));
    return callJava(jvm, t, MHN, 'findMethodHandleType(Ljava/lang/Class;[Ljava/lang/Class;)Ljava/lang/invoke/MethodType;', [
      jvm.mirror(r),
      jvm.newArray(jvm.bootClass('java/lang/Class'), ps),
    ]);
  });
}

function cpUtf8(cls: JClass, index: number): string {
  const e = cls.file!.cp[index];
  if (e?.tag !== 'utf8') throw new Error(`constant ${index} of ${cls.name} is not a Utf8`);
  return e.value;
}

function cpNat(cls: JClass, index: number): { name: string; desc: string } {
  const e = cls.file!.cp[index];
  if (e?.tag !== 'nat') throw new Error(`constant ${index} of ${cls.name} is not a NameAndType`);
  return { name: cpUtf8(cls, e.name), desc: cpUtf8(cls, e.desc) };
}

/** Resolves a CONSTANT_MethodHandle (JVM §5.4.3.5) through linkMethodHandleConstant (Doppio src/ConstantPool.ts MethodHandle.resolve). */
function methodHandleConstant(jvm: Jvm, t: JThread, cls: JClass, index: number): NativeResult {
  const e = cls.file!.cp[index];
  if (e?.tag !== 'mhandle') throw new Error(`constant ${index} of ${cls.name} is not a MethodHandle`);
  const ref = cls.file!.cp[e.ref];
  if (ref?.tag !== 'fieldref' && ref?.tag !== 'methodref' && ref?.tag !== 'imethodref') {
    return jvm.throwNew('java/lang/ClassFormatError', `bad MethodHandle constant ${index}`);
  }
  const owner = cls.file!.cp[ref.cls];
  if (owner?.tag !== 'class') return jvm.throwNew('java/lang/ClassFormatError', `bad MethodHandle constant ${index}`);
  const { name, desc } = cpNat(cls, ref.nat);
  return retrying(() => {
    const defc = jvm.loader.resolveClass(cls, cpUtf8(cls, owner.name));
    const type = ref.tag === 'fieldref' ? jvm.mirror(typeOf(jvm, cls, desc)) : methodType(jvm, t, cls, desc);
    return andThen(type, (ty) =>
      callJava(jvm, t, MHN, 'linkMethodHandleConstant(Ljava/lang/Class;ILjava/lang/Class;Ljava/lang/String;Ljava/lang/Object;)Ljava/lang/invoke/MethodHandle;', [
        jvm.mirror(cls),
        e.kind,
        jvm.mirror(defc),
        jvm.heap.intern(name),
        ty ?? null,
      ]),
    );
  });
}

/**
 * ldc of a MethodType or MethodHandle constant: resolves it into `cls.resolved[index]`, where the instruction finds it
 * when it runs again.
 */
export function resolveConstant(jvm: Jvm, t: JThread, cls: JClass, index: number): NativeResult {
  const e = cls.file!.cp[index];
  const r = e?.tag === 'mtype' ? methodType(jvm, t, cls, cpUtf8(cls, e.desc)) : methodHandleConstant(jvm, t, cls, index);
  return andThen(r, (v) => {
    cls.resolved[index] ??= v;
    return undefined;
  });
}

/** A bootstrap method's static argument, as ldc would push it, primitives boxed (Doppio src/ConstantPool.ts getArguments). */
function staticArgument(jvm: Jvm, t: JThread, cls: JClass, index: number): NativeResult {
  const e = cls.file!.cp[index];
  switch (e?.tag) {
    case 'int':
      return box(jvm, 'I', e.value);
    case 'float':
      return box(jvm, 'F', e.value);
    case 'long':
      return box(jvm, 'J', e.value);
    case 'double':
      return box(jvm, 'D', e.value);
    case 'string':
      return jvm.heap.intern(cpUtf8(cls, e.utf8));
    case 'class':
      return retrying(() => jvm.mirror(jvm.loader.resolveClass(cls, cpUtf8(cls, e.name))));
    case 'mtype':
    case 'mhandle': {
      const hit = cls.resolved[index];
      if (hit) return hit as JObject;
      return andThen(resolveConstant(jvm, t, cls, index), () => cls.resolved[index] as JObject);
    }
    default:
      return jvm.throwNew('java/lang/ClassFormatError', `bad bootstrap argument ${index} in ${cls.name}`);
  }
}

/** Collects `n` results of `fn` in order. */
function collect(n: number, fn: (i: number) => NativeResult, k: (values: JValue[]) => NativeResult): NativeResult {
  const out: JValue[] = [];
  const step = (i: number): NativeResult =>
    i >= n
      ? k(out)
      : andThen(fn(i), (v) => {
          out.push(v ?? null);
          return step(i + 1);
        });
  return step(0);
}

/**
 * Links the invokedynamic instruction at `pc` of `m` (JVM §5.4.3.6, §6.5 invokedynamic) through
 * MethodHandleNatives.linkCallSite, and records its call site in `m.callSites` (Doppio src/ConstantPool.ts
 * InvokeDynamic.constructCallSiteObject). The first call site linked wins if threads race.
 */
export function linkCallSite(jvm: Jvm, t: JThread, m: JMethod, pc: number, index: number): NativeResult {
  const cls = m.cls;
  const e = cls.file!.cp[index];
  if (e?.tag !== 'indy') return jvm.throwNew('java/lang/ClassFormatError', `constant ${index} is not an InvokeDynamic`);
  const bsm = cls.file!.bootstrapMethods[e.bsm];
  if (!bsm) return jvm.throwNew('java/lang/ClassFormatError', `no bootstrap method ${e.bsm} in ${cls.name}`);
  const { name, desc } = cpNat(cls, e.nat);
  const bsmHandle = staticArgument(jvm, t, cls, bsm.ref);
  return andThen(bsmHandle, (handle) =>
    collect(bsm.args.length, (i) => staticArgument(jvm, t, cls, bsm.args[i]!), (statics) =>
      andThen(methodType(jvm, t, cls, desc), (type) => {
        const object = jvm.bootClass('java/lang/Object');
        const appendix = jvm.newArray(object, [null]);
        const info = statics.length === 0 ? null : jvm.newArray(object, statics);
        return andThen(
          callJava(jvm, t, MHN, 'linkCallSite(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/invoke/MemberName;', [
            jvm.mirror(cls),
            handle ?? null,
            jvm.heap.intern(name),
            type ?? null,
            info,
            appendix,
          ]),
          (mn) => {
            const extra = (appendix.data as (JObject | null)[])[0]!;
            const linker = mn as JObject;
            const { ret } = parseMethodDescriptor(desc);
            const site = syntheticMethod(jvm.bootClass(MH), 'invokeExact', desc, true, (ctx, ...args) =>
              typed(ret, invokeLinked(ctx, linker, extra === null ? args : [...args, extra])),
            );
            m.callSites ??= new Map();
            if (!m.callSites.has(pc)) m.callSites.set(pc, site);
            return undefined;
          },
        );
      }),
    ),
  );
}

/**
 * The method a Methodref to a signature-polymorphic method resolves to, for one call site with descriptor `desc`
 * (Doppio src/ClassData.ts signaturePolymorphicAwareMethodLookup, src/opcodes.ts invokehandle). invoke and
 * invokeExact link once, through MethodHandleNatives.linkMethod (Doppio src/ConstantPool.ts
 * MethodReference.resolveMemberName).
 */
export function signaturePolymorphic(jvm: Jvm, caller: JClass, owner: JClass, name: string, desc: string): JMethod | null {
  if (name !== 'invoke' && name !== 'invokeExact' && name !== 'invokeBasic' && LINKERS[name] === undefined) return null;
  const generic = polymorphicMethod(owner, name);
  if (!generic) return null;
  const { ret } = parseMethodDescriptor(desc);
  const cls = generic.cls;
  if (name === 'invokeBasic') {
    return syntheticMethod(cls, name, desc, false, (ctx, handle, ...args) => typed(ret, invokeBasic(ctx, handle as JObject | null, args)));
  }
  const link = LINKERS[name];
  if (link !== undefined) return syntheticMethod(cls, name, desc, true, (ctx, ...args) => typed(ret, linkTo(ctx, link, args)));
  let linker: JObject | null = null;
  let extra: JObject | null = null;
  const run = (ctx: NativeContext, args: readonly JValue[]): NativeResult =>
    typed(ret, invokeLinked(ctx, linker!, extra === null ? args : [...args, extra]));
  return syntheticMethod(cls, name, desc, false, (ctx, ...args) => {
    if (linker) return run(ctx, args);
    const t = ctx.thread;
    const appendix = jvm.newArray(jvm.bootClass('java/lang/Object'), [null]);
    return andThen(methodType(jvm, t, caller, desc), (type) =>
      andThen(
        callJava(jvm, t, MHN, 'linkMethod(Ljava/lang/Class;ILjava/lang/Class;Ljava/lang/String;Ljava/lang/Object;[Ljava/lang/Object;)Ljava/lang/invoke/MemberName;', [
          jvm.mirror(caller),
          REF_invokeVirtual,
          jvm.mirror(cls),
          jvm.heap.intern(name),
          type ?? null,
          appendix,
        ]),
        (mn) => {
          if (!linker) {
            linker = mn as JObject;
            extra = (appendix.data as (JObject | null)[])[0]!;
          }
          return run(ctx, args);
        },
      ),
    );
  });
}

/** The basic-type descriptor of a LambdaForm: its parameter names' types and its result's. */
function formDescriptor(jvm: Jvm, form: JObject): string {
  const arity = get(jvm, form, LF, 'arity', 'I') as number;
  const result = get(jvm, form, LF, 'result', 'I') as number;
  const names = (get(jvm, form, LF, 'names', `[L${NAME};`) as JArray).data as JObject[];
  const BT = 'java/lang/invoke/LambdaForm$BasicType';
  const char = (n: JObject): string => {
    const c = String.fromCharCode(get(jvm, get(jvm, n, NAME, 'type', `L${BT};`) as JObject, BT, 'btChar', 'C') as number);
    return c === 'L' ? 'Ljava/lang/Object;' : c;
  };
  return `(${names.slice(0, arity).map(char).join('')})${result < 0 ? 'V' : char(names[result]!)}`;
}

/** Resolves a MemberName's method or field (MethodHandleNatives.resolve's contract), written from the JVM specification. */
function resolve(ctx: NativeContext, self: JValue): NativeResult {
  const jvm = ctx.jvm;
  const mn = self as JObject;
  const clazz = get(jvm, mn, MN, 'clazz', 'Ljava/lang/Class;') as JObject | null;
  const nameObj = get(jvm, mn, MN, 'name', 'Ljava/lang/String;') as JObject | null;
  const type = get(jvm, mn, MN, 'type', 'Ljava/lang/Object;') as JObject | null;
  if (clazz === null || nameObj === null || type === null) return jvm.throwNew('java/lang/IllegalArgumentException', 'nothing to resolve');
  const defc = classOf(clazz);
  const name = jsStr(jvm, nameObj);
  const desc = typeDescriptor(jvm, type);
  const flags = mnFlags(jvm, mn);
  const refKind = (flags >>> REF_SHIFT) & 0xf;
  switch (flags & ALL_KINDS) {
    case IS_METHOD:
    case IS_CONSTRUCTOR: {
      let m: JMethod | null;
      if ((flags & ALL_KINDS) === IS_CONSTRUCTOR) m = defc.methods.get(name + desc) ?? null;
      else m = (defc.isInterface ? defc.findInterfaceMethod(name, desc) : defc.findMethod(name, desc)) ?? polymorphicMethod(defc, name);
      if (!m || (m.name === '<init>') !== ((flags & ALL_KINDS) === IS_CONSTRUCTOR)) {
        return jvm.throwNew('java/lang/NoSuchMethodError', `${externalName(defc.name)}.${name}${desc}`);
      }
      if (m.isStatic !== (refKind === REF_invokeStatic)) {
        return jvm.throwNew('java/lang/IncompatibleClassChangeError', `${externalName(defc.name)}.${name}${desc}`);
      }
      initMethod(jvm, mn, m, refKind);
      return mn;
    }
    case IS_FIELD: {
      const f = defc.findField(name, desc);
      if (!f) return jvm.throwNew('java/lang/NoSuchFieldError', name);
      if (f.isStatic !== (refKind === REF_getStatic || refKind === REF_putStatic)) {
        return jvm.throwNew('java/lang/IncompatibleClassChangeError', `${externalName(defc.name)}.${name}`);
      }
      initField(jvm, mn, f, refKind);
      return mn;
    }
    default:
      return jvm.throwNew('java/lang/LinkageError', `MemberName of kind ${flags & ALL_KINDS} cannot be resolved`);
  }
}

/** MethodHandleNatives.init from a reflective Method, Constructor or Field, written from the JDK's contract. */
function init(ctx: NativeContext, self: JValue, ref: JValue): NativeResult {
  const jvm = ctx.jvm;
  const mn = self as JObject;
  const r = ref as JObject | null;
  if (r === null) return npe(jvm);
  switch (r.cls.name) {
    case 'java/lang/reflect/Method': {
      const m = methodOf(jvm, r);
      initMethod(jvm, mn, m, m.isStatic ? REF_invokeStatic : m.cls.isInterface ? REF_invokeInterface : REF_invokeVirtual);
      return undefined;
    }
    case 'java/lang/reflect/Constructor':
      initMethod(jvm, mn, methodOf(jvm, r), REF_invokeSpecial);
      return undefined;
    case 'java/lang/reflect/Field': {
      const f = fieldOf(jvm, r);
      if (!f) return internalError(jvm, 'init: unknown field');
      initField(jvm, mn, f, f.isStatic ? REF_getStatic : REF_getField);
      return undefined;
    }
    default:
      return internalError(jvm, `MemberName from a ${externalName(r.cls.name)}`);
  }
}

/** MethodHandleNatives.getMembers: the class's own members of the kinds asked for (Doppio src/natives/java_lang.ts). */
function getMembers(ctx: NativeContext, defc: JValue, matchName: JValue, matchSig: JValue, matchFlags: JValue, _caller: JValue, skip: JValue, results: JValue): NativeResult {
  const jvm = ctx.jvm;
  const c = classOf(defc);
  const name = matchName === null ? null : jsStr(jvm, matchName);
  const sig = matchSig === null ? null : jsStr(jvm, matchSig);
  const flags = matchFlags as number;
  const out = (results as JArray).data as (JObject | null)[];
  let matched = 0;
  const add = (fill: (mn: JObject) => void): void => {
    const i = matched - (skip as number);
    matched++;
    if (i >= 0 && i < out.length && out[i]) fill(out[i]!);
  };
  for (const m of methodList(c)) {
    const ctor = m.name === '<init>';
    if (m.name === '<clinit>' || !(flags & (ctor ? IS_CONSTRUCTOR : IS_METHOD))) continue;
    if ((name !== null && name !== m.name) || (sig !== null && sig !== m.desc)) continue;
    add((mn) => {
      initMethod(jvm, mn, m, m.isStatic ? REF_invokeStatic : ctor ? REF_invokeSpecial : c.isInterface ? REF_invokeInterface : REF_invokeVirtual);
      setNameAndType(jvm, mn, m.name, m.desc);
    });
  }
  if (flags & IS_FIELD) {
    for (const f of c.declaredFields) {
      if ((name !== null && name !== f.name) || (sig !== null && sig !== f.desc)) continue;
      add((mn) => {
        initField(jvm, mn, f, f.isStatic ? REF_getStatic : REF_getField);
        setNameAndType(jvm, mn, f.name, f.desc);
      });
    }
  }
  return matched - (skip as number);
}

/** LambdaForm.compileToBytecode: an entry point that evaluates the form, instead of a class spun with ASM. */
function compileToBytecode(ctx: NativeContext, self: JValue): NativeResult {
  const jvm = ctx.jvm;
  const form = self as JObject;
  const current = get(jvm, form, LF, 'vmentry', `L${MN};`) as JObject | null;
  if (current?.nativeData instanceof FormEntry) return current;
  const mn = jvm.heap.newObject(jvm.bootClass(MN));
  set(jvm, mn, MN, 'clazz', 'Ljava/lang/Class;', jvm.mirror(jvm.bootClass(LF)));
  set(jvm, mn, MN, 'flags', 'I', IS_METHOD | (REF_invokeStatic << REF_SHIFT) | 0x0008);
  setNameAndType(jvm, mn, 'interpret', formDescriptor(jvm, form));
  mn.nativeData = new FormEntry(form);
  set(jvm, form, LF, 'vmentry', `L${MN};`, mn);
  set(jvm, form, LF, 'isCompiled', 'Z', 1);
  return mn;
}

const unsupported = (ctx: NativeContext): NativeResult =>
  ctx.jvm.throwNew('java/lang/UnsupportedOperationException', `${ctx.method.name} cannot be invoked reflectively`);

export function registerInvokeNatives(table: NativeTable): void {
  table.replace({ 'java/lang/invoke/LambdaForm.compileToBytecode()Ljava/lang/invoke/MemberName;': compileToBytecode });
  table.register({
    'java/lang/invoke/MethodHandleNatives.registerNatives()V': () => undefined,
    // Doppio: 0 for every constant, which leaves GuardWithTest counting off.
    'java/lang/invoke/MethodHandleNatives.getConstant(I)I': () => 0,
    // Only MethodHandleNatives.verifyConstants (an assertion) asks; a null name ends its loop.
    'java/lang/invoke/MethodHandleNatives.getNamedCon(I[Ljava/lang/Object;)I': () => 0,
    'java/lang/invoke/MethodHandleNatives.init(Ljava/lang/invoke/MemberName;Ljava/lang/Object;)V': init,
    'java/lang/invoke/MethodHandleNatives.expand(Ljava/lang/invoke/MemberName;)V': (ctx, self) => {
      const jvm = ctx.jvm;
      const mn = self as JObject;
      const t = mn.nativeData;
      const member = t instanceof MethodTarget ? t.method : t instanceof FieldTarget ? t.field : null;
      if (!member) return jvm.throwNew('java/lang/IllegalArgumentException', 'nothing to expand');
      if (get(jvm, mn, MN, 'clazz', 'Ljava/lang/Class;') === null) set(jvm, mn, MN, 'clazz', 'Ljava/lang/Class;', jvm.mirror(member.cls));
      if (get(jvm, mn, MN, 'name', 'Ljava/lang/String;') === null) set(jvm, mn, MN, 'name', 'Ljava/lang/String;', jvm.heap.intern(member.name));
      if (get(jvm, mn, MN, 'type', 'Ljava/lang/Object;') === null) set(jvm, mn, MN, 'type', 'Ljava/lang/Object;', jvm.heap.intern(member.desc));
      return undefined;
    },
    'java/lang/invoke/MethodHandleNatives.resolve(Ljava/lang/invoke/MemberName;Ljava/lang/Class;)Ljava/lang/invoke/MemberName;': (ctx, self) =>
      retrying(() => resolve(ctx, self)),
    'java/lang/invoke/MethodHandleNatives.getMembers(Ljava/lang/Class;Ljava/lang/String;Ljava/lang/String;ILjava/lang/Class;I[Ljava/lang/invoke/MemberName;)I':
      getMembers,
    // Field offsets are slots, as for Unsafe (Doppio src/natives/java_lang.ts objectFieldOffset, staticFieldOffset, staticFieldBase).
    'java/lang/invoke/MethodHandleNatives.objectFieldOffset(Ljava/lang/invoke/MemberName;)J': (ctx, self) => fieldOffset(ctx, self),
    'java/lang/invoke/MethodHandleNatives.staticFieldOffset(Ljava/lang/invoke/MemberName;)J': (ctx, self) => fieldOffset(ctx, self),
    'java/lang/invoke/MethodHandleNatives.staticFieldBase(Ljava/lang/invoke/MemberName;)Ljava/lang/Object;': (ctx, self) => {
      const t = (self as JObject).nativeData;
      if (!(t instanceof FieldTarget)) return ctx.jvm.throwNew('java/lang/IllegalStateException', 'not a resolved field');
      return staticFieldBase(ctx.jvm, t.field.cls);
    },
    // {vmindex, vmtarget}: the class for a field, the MemberName itself for a method (Doppio src/natives/java_lang.ts).
    'java/lang/invoke/MethodHandleNatives.getMemberVMInfo(Ljava/lang/invoke/MemberName;)Ljava/lang/Object;': (ctx, self) => {
      const jvm = ctx.jvm;
      const mn = self as JObject;
      const t = mn.nativeData;
      const index = t instanceof FieldTarget ? BigInt(t.field.slot) : t instanceof MethodTarget ? BigInt(t.method.vtableIndex) : -1n;
      const target = t instanceof FieldTarget ? get(jvm, mn, MN, 'clazz', 'Ljava/lang/Class;') : mn;
      return jvm.newArray(jvm.bootClass('java/lang/Object'), [box(jvm, 'J', index), target]);
    },
    'java/lang/invoke/MethodHandleNatives.setCallSiteTargetNormal(Ljava/lang/invoke/CallSite;Ljava/lang/invoke/MethodHandle;)V': (ctx, site, target) =>
      setTarget(ctx, site, target),
    'java/lang/invoke/MethodHandleNatives.setCallSiteTargetVolatile(Ljava/lang/invoke/CallSite;Ljava/lang/invoke/MethodHandle;)V': (ctx, site, target) =>
      setTarget(ctx, site, target),
    // Signature-polymorphic calls never reach these: only reflection does (Doppio src/natives/java_lang.ts).
    'java/lang/invoke/MethodHandle.invoke([Ljava/lang/Object;)Ljava/lang/Object;': unsupported,
    'java/lang/invoke/MethodHandle.invokeExact([Ljava/lang/Object;)Ljava/lang/Object;': unsupported,
  });
}

function fieldOffset(ctx: NativeContext, self: JValue): NativeResult {
  const t = (self as JObject).nativeData;
  if (!(t instanceof FieldTarget)) return ctx.jvm.throwNew('java/lang/IllegalStateException', 'not a resolved field');
  return BigInt(t.field.slot);
}

function setTarget(ctx: NativeContext, site: JValue, target: JValue): NativeResult {
  if (site === null) return npe(ctx.jvm);
  set(ctx.jvm, site as JObject, 'java/lang/invoke/CallSite', 'target', `L${MH};`, target);
  return undefined;
}
