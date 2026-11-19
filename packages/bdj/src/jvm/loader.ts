/*
 * Original code for Seikou: class loading, linking and initialisation of the BD-J virtual machine (JVM
 * specification §5.3 to §5.5).
 *
 * Copyright (C) 2026 Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { ClassFormatError, UnsupportedClassVersionError, parseClassFile } from './classfile';
import type { ClassFile, CodeAttr } from './classfile';
import type { ZipArchive } from './zip';
import { JavaThrowable, defaultValue, isWide } from './values';
import type { JObject, JValue } from './values';
import type { JThread } from './threads';
import type { Jvm } from './jvm';
import { Invoke, ThrowResult, andThen } from './interpreter';
import type { NativeResult, Tiny } from './interpreter';
import type { NativeFn } from './natives/index';
import type { IntrinsicFn, LoopHook, LoopHookFn } from './natives/intrinsics/index';
import { HOOKED_GOTO, codeChecksum } from './natives/intrinsics/common';

/** access_flags bit: declared public (JVM Specification, Java SE 8, §4.1, §4.5, §4.6). */
export const ACC_PUBLIC = 0x0001;
/** access_flags bit: declared private (§4.5, §4.6). */
export const ACC_PRIVATE = 0x0002;
/** access_flags bit: declared protected (§4.5, §4.6). */
export const ACC_PROTECTED = 0x0004;
/** access_flags bit: declared static (§4.5, §4.6). */
export const ACC_STATIC = 0x0008;
/** access_flags bit: declared final (§4.1, §4.5, §4.6). */
export const ACC_FINAL = 0x0010;
/** access_flags bit of a method: declared synchronized (§4.6). The same bit is ACC_SUPER on a class (§4.1). */
export const ACC_SYNCHRONIZED = 0x0020;
/** access_flags bit of a method: declared native (§4.6). */
export const ACC_NATIVE = 0x0100;
/** access_flags bit of a class: an interface (§4.1). */
export const ACC_INTERFACE = 0x0200;
/** access_flags bit: an abstract class (§4.1) or method (§4.6). */
export const ACC_ABSTRACT = 0x0400;

/**
 * Where a class is in its life (§5.3 to §5.5). A class from a class file is `linked` as soon as it is defined (there
 * is no verification, and preparation is done then), so `loaded` is not used; array and primitive classes are
 * `initialized` from the start. `erroneous` is a class whose initialiser failed (§5.5 steps 10 to 12).
 */
export type ClassState = 'loaded' | 'linked' | 'initializing' | 'initialized' | 'erroneous';

/** A field of a linked class (§4.5), laid out when the class is defined (preparation, §5.4.2). */
export interface JField {
  /** The class that declares it. */
  readonly cls: JClass;
  readonly name: string;
  /** The field descriptor (§4.3.2). */
  readonly desc: string;
  /** The field's access_flags. */
  readonly access: number;
  /** Index into the object's `fields` (instance) or the class's `staticValues` (static). */
  readonly slot: number;
  readonly isStatic: boolean;
  /** A long or double, which takes two operand-stack slots. */
  readonly wide: boolean;
}

/** A method of a linked class (§4.6), with what the interpreter caches on it. */
export interface JMethod {
  /** The class that declares it. */
  readonly cls: JClass;
  readonly name: string;
  /** The method descriptor (§4.3.3). */
  readonly desc: string;
  /** The method's access_flags. */
  readonly access: number;
  /** The bytecode, with any loop-hooked gotos rewritten; null for abstract and native methods. */
  readonly code: CodeAttr | null;
  /** Local-variable slots the arguments take, including `this`. */
  readonly argSlots: number;
  /** The parameters' field descriptors, in order. */
  readonly argTypes: readonly string[];
  /** The return descriptor, `V` for void. */
  readonly returnType: string;
  /** The method's index in its class's vtable; -1 for static, private and initialiser methods and interface methods. */
  vtableIndex: number;
  readonly isStatic: boolean;
  /** Declared native, or a Java method the native table replaces (NativeTable.replace). */
  readonly isNative: boolean;
  readonly isAbstract: boolean;
  readonly isSynchronized: boolean;
  /** The native table key, 'java/lang/Object.hashCode()I'. */
  readonly nativeKey: string;
  /** The native function, looked up in the native table on the first call. */
  native: NativeFn | undefined;
  /** A JS fast path the interpreter tries before the bytecode (natives/intrinsics); it may decline. */
  readonly intrinsic?: IntrinsicFn | undefined;
  /** Loop hooks (natives/intrinsics) by the pc of the goto they replace in `code`. */
  readonly loopHooks?: ReadonlyMap<number, LoopHookFn> | undefined;
  /** The interpreter's frameless shape of a trivial method (null: none; undefined: not known yet). */
  tiny?: Tiny | null | undefined;
  /** Null-filled locals and operand stack a new frame copies (the interpreter's cache). */
  frameTemplate?: { readonly locals: readonly JValue[]; readonly stack: readonly JValue[] } | undefined;
  /** Per invokedynamic instruction (by pc), the linked call site. */
  callSites?: Map<number, JMethod>;
}

/**
 * Splits a method descriptor (§4.3.3) into its parameter descriptors and return descriptor:
 * `(ILjava/lang/String;)V` gives `['I', 'Ljava/lang/String;']` and `V`. Throws ClassFormatError on an unterminated
 * class name; other malformed descriptors are not detected.
 */
export function parseMethodDescriptor(desc: string): { args: string[]; ret: string } {
  const args: string[] = [];
  let i = 1;
  while (desc.charCodeAt(i) !== 0x29) {
    const start = i;
    while (desc.charCodeAt(i) === 0x5b) i++;
    i = desc.charCodeAt(i) === 0x4c ? desc.indexOf(';', i) + 1 : i + 1;
    if (i <= start) throw new ClassFormatError(`bad method descriptor ${desc}`);
    args.push(desc.slice(start, i));
  }
  return { args, ret: desc.slice(i + 1) };
}

/** 'java/lang/String' → 'java.lang.String', as Class.getName prints it. */
export const externalName = (name: string): string => name.replace(/\//g, '.');

/**
 * A copy of a method's code with each hooked goto rewritten to HOOKED_GOTO; the hooks were written for this exact
 * bytecode, so any other code is a build error.
 */
function hookedCode(key: string, code: CodeAttr, hooks: readonly LoopHook[]): CodeAttr {
  const bytes = code.code.slice();
  for (const h of hooks) {
    if (codeChecksum(code.code) !== h.checksum || bytes[h.pc] !== 0xa7) {
      throw new Error(`loop hook ${key}@${h.pc} does not match the bytecode (checksum ${codeChecksum(code.code).toString(16)})`);
    }
    bytes[h.pc] = HOOKED_GOTO;
  }
  return { ...code, code: bytes };
}

const packageOf = (name: string): string => name.slice(0, Math.max(0, name.lastIndexOf('/')));

interface JClassInit {
  readonly name: string;
  readonly file: ClassFile | null;
  readonly superClass: JClass | null;
  readonly interfaces: readonly JClass[];
  readonly loader: JObject | null;
  readonly protectionDomain: JObject | null;
  readonly componentType: JClass | null;
  readonly primitive: boolean;
  /** For primitive classes, whose name is 'int' but descriptor 'I'. */
  readonly descriptor?: string;
  /** java/lang/Object, which interface method resolution searches (interfaces have no superclass here). */
  readonly objectClass: JClass | null;
  /** Native-table keys of Java methods the VM implements natively instead of running their bytecode. */
  readonly replaced?: ReadonlySet<string>;
  /** Intrinsics by native-table key: Java methods with a JS fast path that falls back to their bytecode. */
  readonly intrinsics?: ReadonlyMap<string, IntrinsicFn>;
  /** Loop hooks by native-table key. */
  readonly loopHooks?: ReadonlyMap<string, readonly LoopHook[]>;
}

/**
 * A loaded and linked class, array class or primitive class, with its fields laid out, its vtable built and its
 * constant-pool resolutions cached. Classes are identified by name and defining loader (§5.3).
 */
export class JClass {
  /** The internal name (`java/lang/String`, `[I`), or `int` and the like for a primitive class. */
  readonly name: string;
  /** The parsed class file; null for array and primitive classes. */
  readonly file: ClassFile | null;
  /** Null for java/lang/Object, interfaces and primitive classes. */
  readonly superClass: JClass | null;
  /** The direct superinterfaces. */
  readonly interfaces: readonly JClass[];
  /** The defining Java class loader; null for the bootstrap loader. */
  readonly loader: JObject | null;
  /** The ProtectionDomain the class was defined with, for AccessController; null for boot classes. */
  readonly protectionDomain: JObject | null;
  state: ClassState = 'linked';
  /** The thread running the initialiser while `initializing`. */
  initThread: JThread | null = null;
  /** The exception the failed initialiser threw, once `erroneous`. */
  initError: JObject | null = null;
  /** Every instance field, the superclass's first, in slot order. */
  readonly instanceFields: readonly JField[];
  /** The values of the class's own static fields, by slot. */
  readonly staticValues: JValue[];
  /** Virtual methods by vtable index, for invokevirtual; empty for interfaces. */
  readonly vtable: JMethod[];
  /** The declared methods, keyed by name and descriptor (`toString()Ljava/lang/String;`). */
  readonly methods: ReadonlyMap<string, JMethod>;
  /** The java.lang.Class instance, made by Jvm.mirror on first use. */
  mirror: JObject | null = null;
  /** Class.setSigners. */
  signers: JObject | null = null;
  /** The component class of an array class; null otherwise. */
  readonly componentType: JClass | null;
  readonly isInterface: boolean;
  readonly isPrimitive: boolean;
  /** The class's access_flags; public, final and abstract for array and primitive classes. */
  readonly access: number;
  /** The field descriptor naming this class: 'I', '[I', 'Ljava/lang/String;'. */
  readonly descriptor: string;
  /** Per constant-pool index, the resolved class, field, method or interned string. */
  readonly resolved: unknown[];
  /** Initial `fields` of a new instance. */
  readonly fieldTemplate: readonly JValue[];
  /** The array class whose components are this class, once created. */
  arrayType: JClass | null = null;
  /** Receiver-class dispatch cache for interface methods. */
  readonly dispatch = new Map<JMethod, JMethod>();
  private readonly declared = new Map<string, JField>();
  private readonly objectClass: JClass | null;
  private ifaceSet: Set<JClass> | null = null;
  private supersToInit: readonly JClass[] | null = null;

  constructor(init: JClassInit) {
    this.name = init.name;
    this.file = init.file;
    this.superClass = init.superClass;
    this.interfaces = init.interfaces;
    this.loader = init.loader;
    this.protectionDomain = init.protectionDomain;
    this.componentType = init.componentType;
    this.isPrimitive = init.primitive;
    this.objectClass = init.objectClass;
    const file = init.file;
    this.access = file ? file.access : ACC_PUBLIC | ACC_FINAL | ACC_ABSTRACT;
    this.isInterface = file !== null && (file.access & ACC_INTERFACE) !== 0;
    this.descriptor = init.descriptor ?? (init.componentType ? init.name : `L${init.name};`);
    this.resolved = file ? new Array<unknown>(file.cp.length) : [];
    if (!file) this.state = 'initialized';

    const instanceFields = init.superClass ? [...init.superClass.instanceFields] : [];
    const template = init.superClass ? [...init.superClass.fieldTemplate] : [];
    const staticValues: JValue[] = [];
    for (const f of file?.fields ?? []) {
      const isStatic = (f.access & ACC_STATIC) !== 0;
      const slot = isStatic ? staticValues.length : template.length;
      const field: JField = { cls: this, name: f.name, desc: f.desc, access: f.access, slot, isStatic, wide: isWide(f.desc) };
      this.declared.set(f.name + f.desc, field);
      if (isStatic) staticValues.push(defaultValue(f.desc));
      else {
        instanceFields.push(field);
        template.push(defaultValue(f.desc));
      }
    }
    this.instanceFields = instanceFields;
    this.fieldTemplate = template;
    this.staticValues = staticValues;

    const methods = new Map<string, JMethod>();
    for (const m of file?.methods ?? []) {
      const { args, ret } = parseMethodDescriptor(m.desc);
      const isStatic = (m.access & ACC_STATIC) !== 0;
      let argSlots = isStatic ? 0 : 1;
      for (const a of args) argSlots += isWide(a) ? 2 : 1;
      const key = `${init.name}.${m.name}${m.desc}`;
      // intrinsics and loop hooks are written for the class library's own classes, never for a disc's class that
      // happens to have the same name
      const boot = init.loader === null;
      const hooks = boot ? init.loopHooks?.get(key) : undefined;
      methods.set(m.name + m.desc, {
        cls: this,
        name: m.name,
        desc: m.desc,
        access: m.access,
        code: hooks && m.code ? hookedCode(key, m.code, hooks) : m.code,
        argSlots,
        argTypes: args,
        returnType: ret,
        vtableIndex: -1,
        isStatic,
        isNative: (m.access & ACC_NATIVE) !== 0 || init.replaced?.has(`${init.name}.${m.name}${m.desc}`) === true,
        isAbstract: (m.access & ACC_ABSTRACT) !== 0,
        isSynchronized: (m.access & ACC_SYNCHRONIZED) !== 0,
        nativeKey: `${init.name}.${m.name}${m.desc}`,
        native: undefined,
        intrinsic: boot ? init.intrinsics?.get(key) : undefined,
        loopHooks: hooks ? new Map(hooks.map((h) => [h.pc, h.fn])) : undefined,
        frameTemplate: undefined,
        tiny: undefined,
      });
    }
    this.methods = methods;
    this.vtable = this.isInterface ? [] : this.buildVtable(methods);
    for (const key of init.replaced ?? []) {
      if (!key.startsWith(`${init.name}.`)) continue;
      // A replacement whose key no longer names a Java method would silently leave the bytecode running.
      const m = methods.get(key.slice(init.name.length + 1));
      if (!m?.code) throw new Error(`replaced native ${key} names no method with code in ${init.name}`);
    }
    for (const key of init.loader === null ? (init.intrinsics?.keys() ?? []) : []) {
      if (!key.startsWith(`${init.name}.`)) continue;
      // An intrinsic whose key no longer names a Java method would silently stop applying; one on a synchronized
      // method would skip its monitor.
      const m = methods.get(key.slice(init.name.length + 1));
      if (!m?.code || m.isSynchronized) throw new Error(`intrinsic ${key} names no unsynchronized method with code in ${init.name}`);
    }
  }

  /** Overriding (§5.4.5) by name and descriptor; a package-private method is overridden only from its runtime package. */
  private buildVtable(methods: ReadonlyMap<string, JMethod>): JMethod[] {
    const vtable = this.superClass ? [...this.superClass.vtable] : [];
    const byKey = new Map<string, number[]>();
    vtable.forEach((m, i) => {
      const k = m.name + m.desc;
      const list = byKey.get(k);
      if (list) list.push(i);
      else byKey.set(k, [i]);
    });
    for (const m of methods.values()) {
      if (m.isStatic || (m.access & ACC_PRIVATE) !== 0 || m.name === '<init>' || m.name === '<clinit>') continue;
      for (const i of byKey.get(m.name + m.desc) ?? []) {
        const sm = vtable[i]!;
        if ((sm.access & (ACC_PUBLIC | ACC_PROTECTED)) !== 0 || this.samePackage(sm.cls)) {
          vtable[i] = m;
          if (m.vtableIndex < 0) m.vtableIndex = i;
        }
      }
      if (m.vtableIndex < 0) {
        m.vtableIndex = vtable.length;
        vtable.push(m);
      }
    }
    return vtable;
  }

  /** Whether both classes are in the same runtime package (§5.3): the same defining loader and package name. */
  samePackage(other: JClass): boolean {
    return this.loader === other.loader && packageOf(this.name) === packageOf(other.name);
  }

  /** Every superinterface, direct or not, of this class, its superclasses and their interfaces. */
  allInterfaces(): ReadonlySet<JClass> {
    if (!this.ifaceSet) {
      const set = new Set<JClass>(this.superClass?.allInterfaces());
      for (const i of this.interfaces) {
        set.add(i);
        for (const j of i.allInterfaces()) set.add(j);
      }
      this.ifaceSet = set;
    }
    return this.ifaceSet;
  }

  /** Assignability as checkcast and instanceof define it (§6.5), including interfaces and arrays. */
  isSubclassOf(other: JClass): boolean {
    if (this === other) return true;
    if (other.isPrimitive || this.isPrimitive) return false;
    if (other.isInterface) return this.allInterfaces().has(other);
    if (other.superClass === null && !other.componentType) return true; // java/lang/Object
    if (this.componentType) {
      const a = this.componentType;
      const b = other.componentType;
      if (!b) return false;
      return a.isPrimitive || b.isPrimitive ? a === b : a.isSubclassOf(b);
    }
    for (let c = this.superClass; c; c = c.superClass) if (c === other) return true;
    return false;
  }

  /** Method resolution (§5.4.3.3): this class, its superclasses, then the maximally specific superinterface method. */
  findMethod(name: string, desc: string): JMethod | null {
    const key = name + desc;
    for (let c: JClass | null = this; c; c = c.superClass) {
      const m = c.methods.get(key);
      if (m) return m;
    }
    return maximallySpecific(this.allInterfaces(), key, true);
  }

  /** Interface method resolution (§5.4.3.4): this interface, public methods of Object, then superinterfaces. */
  findInterfaceMethod(name: string, desc: string): JMethod | null {
    const key = name + desc;
    const own = this.methods.get(key);
    if (own) return own;
    const om = this.objectClass?.methods.get(key);
    if (om && (om.access & ACC_PUBLIC) !== 0 && !om.isStatic) return om;
    return maximallySpecific(this.allInterfaces(), key, true);
  }

  /** Field resolution (§5.4.3.2): this class, its superinterfaces, then its superclasses in turn; null when none declares it. */
  findField(name: string, desc: string): JField | null {
    const key = name + desc;
    for (let c: JClass | null = this; c; c = c.superClass) {
      const f = c.declared.get(key);
      if (f) return f;
      for (const i of c.interfaces) {
        const g = i.findField(name, desc);
        if (g) return g;
      }
    }
    return null;
  }

  /** A field this class itself declares, static or not. */
  declaredField(name: string, desc: string): JField | undefined {
    return this.declared.get(name + desc);
  }

  /** The fields this class itself declares, in class-file order. */
  get declaredFields(): IterableIterator<JField> {
    return this.declared.values();
  }

  /** The superclass and the superinterfaces with non-abstract instance methods, initialised before this class (§5.5 step 7). */
  get initSupers(): readonly JClass[] {
    if (!this.supersToInit) {
      const list: JClass[] = [];
      if (!this.isInterface) {
        if (this.superClass) list.push(this.superClass);
        const seen = new Set<JClass>();
        const visit = (i: JClass): void => {
          for (const j of i.interfaces) visit(j);
          if (seen.has(i)) return;
          seen.add(i);
          for (const m of i.methods.values()) {
            if (!m.isStatic && !m.isAbstract) {
              list.push(i);
              break;
            }
          }
        };
        for (const i of this.interfaces) visit(i);
      }
      this.supersToInit = list;
    }
    return this.supersToInit;
  }
}

/** The one non-abstract candidate that no other candidate overrides; else, when allowed, any abstract candidate. */
function maximallySpecific(ifaces: ReadonlySet<JClass>, key: string, allowAbstract: boolean): JMethod | null {
  const found: JMethod[] = [];
  let abstract: JMethod | null = null;
  for (const i of ifaces) {
    const m = i.methods.get(key);
    if (!m || (m.access & (ACC_PRIVATE | ACC_STATIC)) !== 0) continue;
    if (m.isAbstract) abstract ??= m;
    else found.push(m);
  }
  const specific = found.filter((m) => !found.some((n) => n !== m && n.cls.isSubclassOf(m.cls)));
  if (specific.length === 1) return specific[0]!;
  return allowAbstract ? (specific[0] ?? abstract) : null;
}

/**
 * Method selection for invokeinterface and for interface methods reached by invokevirtual, as those instructions
 * describe it (§6.5): the receiver's class and its superclasses, then the maximally specific superinterface method.
 * Null when there is none (the caller throws AbstractMethodError). Cached per receiver class.
 */
export function selectMethod(receiver: JClass, resolved: JMethod): JMethod | null {
  const hit = receiver.dispatch.get(resolved);
  if (hit) return hit;
  const key = resolved.name + resolved.desc;
  let selected: JMethod | null = null;
  for (let c: JClass | null = receiver; c && !selected; c = c.superClass) {
    const m = c.methods.get(key);
    if (m && !m.isStatic) selected = m;
  }
  selected ??= maximallySpecific(receiver.allInterfaces(), key, false);
  if (selected) receiver.dispatch.set(resolved, selected);
  return selected;
}

/** The boot class path: jars searched in order, the first holding an entry wins. */
export class ClassPath {
  constructor(private readonly jars: readonly ZipArchive[]) {}

  /** The bytes of a class file such as `java/lang/Object.class`; null when no jar has it. */
  find(classFileName: string): Uint8Array | null {
    return this.findResource(classFileName);
  }

  /** The bytes of a jar entry by its path in the jar; null when no jar has it. Throws ZipError on a corrupt entry. */
  findResource(name: string): Uint8Array | null {
    for (const jar of this.jars) {
      const data = jar.read(name);
      if (data) return data;
    }
    return null;
  }
}

/**
 * Thrown by class resolution from a class a Java class loader defined, when that loader has not loaded the name yet:
 * the caller runs `work` (the loader's loadClass) and then retries what it was doing.
 */
export class LoadPending {
  constructor(readonly work: NativeResult) {}
}

/** Runs `fn`, and again after each class load it has to wait for. */
export function retrying(fn: () => NativeResult): NativeResult {
  try {
    return fn();
  } catch (e) {
    if (e instanceof LoadPending) return andThen(e.work, () => retrying(fn));
    throw e;
  }
}

const PRIMITIVE_NAMES = { I: 'int', J: 'long', F: 'float', D: 'double', Z: 'boolean', B: 'byte', C: 'char', S: 'short', V: 'void' } as const;
type PrimitiveCode = keyof typeof PRIMITIVE_NAMES;

/**
 * Loads, links and initialises classes (§5.3 to §5.5): the bootstrap loader over the boot class path, classes Java
 * class loaders define, array and primitive classes, and the record of which loader initiated which name. One per
 * JVM. Its errors are Java exceptions thrown as JavaThrowable; resolution through a Java class loader throws
 * LoadPending.
 */
export class Loader {
  private readonly boot = new Map<string, JClass>();
  /** Per Java class loader, the classes it defined or initiated loading of (§5.3). */
  private readonly byLoader = new Map<JObject, Map<string, JClass>>();
  private readonly defining = new Set<string>();
  private readonly primitives = new Map<string, JClass>();
  private anonymousCount = 0;
  /** Classes defined from class files, and the class-file bytes they keep (memory accounting). */
  private definedClasses = 0;
  private classFileBytes = 0;
  private overBudget = false;

  constructor(
    private readonly jvm: Jvm,
    readonly bootPath: ClassPath,
  ) {}

  /** Bootstrap loading (§5.3.1); null when the class path has no such class. Throws ClassFormatError and the like for a bad class file. */
  loadBoot(name: string): JClass | null {
    const hit = this.boot.get(name);
    if (hit) return hit;
    if (name.charCodeAt(0) === 0x5b) {
      const component = this.bootComponent(name.slice(1));
      return component ? this.arrayOf(component) : null;
    }
    const bytes = this.bootPath.find(`${name}.class`);
    return bytes ? this.define(name, bytes, null, null) : null;
  }

  private bootComponent(desc: string): JClass | null {
    const c = desc.charCodeAt(0);
    if (c === 0x4c) return this.loadBoot(desc.slice(1, -1));
    if (c === 0x5b) return this.loadBoot(desc);
    return desc.length === 1 && desc in PRIMITIVE_NAMES && desc !== 'V' ? this.primitive(desc as PrimitiveCode) : null;
  }

  /**
   * Resolves a class name as seen from `from` (§5.4.3.1); throws NoClassDefFoundError, or LoadPending when
   * `from`'s Java class loader has to be asked first.
   */
  resolveClass(from: JClass, name: string): JClass {
    return this.resolveIn(from.loader, name);
  }

  /** The class `loader` has defined or loaded under `name`, if any; arrays of such classes too. */
  findLoaded(loader: JObject | null, name: string): JClass | null {
    if (loader === null) return this.boot.get(name) ?? null;
    if (name.charCodeAt(0) === 0x5b) {
      const component = this.componentIn(loader, name.slice(1), false);
      return component ? this.arrayOf(component) : null;
    }
    return this.byLoader.get(loader)?.get(name) ?? null;
  }

  /** Resolution in a given loader's name space (null: the bootstrap loader). */
  resolveIn(loader: JObject | null, name: string): JClass {
    if (loader === null) {
      const c = this.loadBoot(name);
      if (!c) throw this.error('java/lang/NoClassDefFoundError', name);
      return c;
    }
    if (name.charCodeAt(0) === 0x5b) return this.arrayOf(this.componentIn(loader, name.slice(1), true)!);
    const hit = this.byLoader.get(loader)?.get(name);
    if (hit) return hit;
    throw new LoadPending(this.loadVia(loader, name, true));
  }

  private componentIn(loader: JObject, desc: string, resolve: boolean): JClass | null {
    const c = desc.charCodeAt(0);
    if (c === 0x4c) {
      const inner = desc.slice(1, -1);
      return resolve ? this.resolveIn(loader, inner) : this.findLoaded(loader, inner);
    }
    if (c === 0x5b) return resolve ? this.resolveIn(loader, desc) : this.findLoaded(loader, desc);
    if (desc.length === 1 && desc in PRIMITIVE_NAMES && desc !== 'V') return this.primitive(desc as PrimitiveCode);
    throw this.error('java/lang/NoClassDefFoundError', `[${desc}`);
  }

  /**
   * Asks a Java class loader for a class (`loader.loadClass(name)`) and records the loader as an initiating loader of
   * the result. For resolution, a ClassNotFoundException becomes NoClassDefFoundError, as in HotSpot.
   */
  loadVia(loader: JObject, name: string, forResolution: boolean): NativeResult {
    const base = this.loadBoot('java/lang/ClassLoader')!.methods.get('loadClass(Ljava/lang/String;)Ljava/lang/Class;')!;
    const target = loader.cls.vtable[base.vtableIndex] ?? base;
    return new Invoke(
      target,
      [loader, this.jvm.heap.newString(externalName(name))],
      (ret) => {
        if (ret === null || ret === undefined) return this.jvm.throwNew('java/lang/NoClassDefFoundError', name);
        this.record(loader, name, (ret as JObject).nativeData as JClass);
        return ret;
      },
      (e) => {
        const cnfe = this.loadBoot('java/lang/ClassNotFoundException');
        if (forResolution && cnfe && e.cls.isSubclassOf(cnfe)) {
          const ncdfe = this.jvm.throwNew('java/lang/NoClassDefFoundError', name);
          this.jvm.setField(ncdfe.exception, 'cause', 'Ljava/lang/Throwable;', e);
          return ncdfe;
        }
        return new ThrowResult(e);
      },
    );
  }

  private record(loader: JObject, name: string, c: JClass): void {
    let map = this.byLoader.get(loader);
    if (!map) this.byLoader.set(loader, (map = new Map()));
    map.set(name, c);
  }

  /**
   * Defines a class (§5.3.5) in `loader` (null: the bootstrap loader). Throws NoClassDefFoundError when the file
   * names another class, LinkageError on a second definition, ClassCircularityError, IncompatibleClassChangeError and
   * the class-file errors; the superclass and interfaces are resolved through `loader`, so this may throw LoadPending.
   */
  define(name: string, bytes: Uint8Array, loader: JObject | null, protectionDomain: JObject | null): JClass {
    const file = this.parse(name, bytes);
    if (file.name !== name) throw this.error('java/lang/NoClassDefFoundError', `${name} (wrong name: ${file.name})`);
    if (this.findDefined(loader, name)) throw this.error('java/lang/LinkageError', `duplicate class definition for name: "${name}"`);
    const cls = this.link(file, loader, protectionDomain);
    if (loader === null) this.boot.set(name, cls);
    else this.record(loader, name, cls);
    this.setConstants(cls);
    this.counted(file);
    return cls;
  }

  /**
   * Unsafe.defineAnonymousClass: a class no loader finds by name, in the host's loader; `patches` replace
   * constant-pool entries (for a String entry the object ldc pushes, for a Class entry a mirror).
   */
  defineAnonymous(host: JClass, bytes: Uint8Array, patches: readonly (JObject | null)[] | null): JClass {
    const file = this.parse('anonymous class', bytes);
    const cls = this.link(file, host.loader, host.protectionDomain, `${file.name}/${++this.anonymousCount}`);
    // No loader finds the class by name, so its own Class entries resolve to it directly.
    file.cp.forEach((e, i) => {
      if (e?.tag === 'class' && file.cp[e.name]?.tag === 'utf8' && (file.cp[e.name] as { value: string }).value === file.name) cls.resolved[i] = cls;
    });
    for (let i = 0; patches && i < patches.length; i++) {
      const p = patches[i];
      if (!p) continue;
      cls.resolved[i] = file.cp[i]?.tag === 'class' && p.cls.name === 'java/lang/Class' ? p.nativeData : p;
    }
    this.setConstants(cls);
    this.counted(file);
    return cls;
  }

  /** Classes defined so far and the bytes of their class files they keep (Jvm.memoryStats). */
  get classStats(): { readonly classes: number; readonly retainedBytes: number } {
    return { classes: this.definedClasses, retainedBytes: this.classFileBytes };
  }

  private counted(file: ClassFile): void {
    this.definedClasses++;
    this.classFileBytes += file.retainedBytes;
    const budget = this.jvm.opts.classBytesBudget ?? Infinity;
    if (this.classFileBytes > budget && !this.overBudget) {
      this.overBudget = true;
      const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
      this.jvm.opts.warn?.(`BD-J: classes keep ${mb(this.classFileBytes)} MB of class files, over the memory budget of ${mb(budget)} MB`);
    }
  }

  /** The name a class file declares; ClassFormatError if it does not parse. */
  className(bytes: Uint8Array): string {
    return this.parse('class', bytes).name;
  }

  private findDefined(loader: JObject | null, name: string): JClass | undefined {
    const c = loader === null ? this.boot.get(name) : this.byLoader.get(loader)?.get(name);
    return c && c.loader === loader ? c : undefined;
  }

  private parse(name: string, bytes: Uint8Array): ClassFile {
    try {
      return parseClassFile(bytes);
    } catch (e) {
      if (e instanceof UnsupportedClassVersionError) throw this.error('java/lang/UnsupportedClassVersionError', `${name}: ${e.message}`);
      if (e instanceof ClassFormatError) throw this.error('java/lang/ClassFormatError', `${e.message} in class file ${name}`);
      throw e;
    }
  }

  private link(file: ClassFile, loader: JObject | null, protectionDomain: JObject | null, key = file.name): JClass {
    const name = file.name;
    // Per thread, as HotSpot's placeholders are: another thread may be defining the same class at the same time.
    const thread = this.jvm.currentThread?.id ?? -1;
    const busy = `${thread}:${loader === null ? '' : this.jvm.heap.identityHash(loader)}:${key}`;
    if (this.defining.has(busy)) throw this.error('java/lang/ClassCircularityError', name);
    this.defining.add(busy);
    let superClass: JClass | null = null;
    let interfaces: JClass[];
    try {
      if (file.superName !== null) {
        superClass = this.resolveIn(loader, file.superName);
        if (superClass.isInterface) {
          throw this.error('java/lang/IncompatibleClassChangeError', `class ${externalName(name)} has interface ${externalName(superClass.name)} as super class`);
        }
      }
      interfaces = file.interfaces.map((n) => {
        const i = this.resolveIn(loader, n);
        if (!i.isInterface) {
          throw this.error('java/lang/IncompatibleClassChangeError', `class ${externalName(name)} can not implement ${externalName(n)}, because it is not an interface`);
        }
        return i;
      });
    } catch (e) {
      // The class stays busy while its loader fetches a supertype, so a chain that comes back to it is circular.
      if (e instanceof LoadPending) {
        const done = (): void => void this.defining.delete(busy);
        throw new LoadPending(andThen(e.work, (r) => (done(), r), (x) => (done(), new ThrowResult(x))));
      }
      this.defining.delete(busy);
      throw e;
    }
    this.defining.delete(busy);
    const isInterface = (file.access & ACC_INTERFACE) !== 0;
    const objectClass = name === 'java/lang/Object' ? null : this.objectClass();
    return new JClass({
      name,
      file,
      superClass: isInterface ? null : superClass,
      interfaces,
      loader,
      protectionDomain,
      componentType: null,
      primitive: false,
      objectClass,
      replaced: this.jvm.natives.replaced,
      intrinsics: this.jvm.natives.intrinsics,
      loopHooks: this.jvm.natives.loopHooks,
    });
  }

  private setConstants(cls: JClass): void {
    const file = cls.file!;
    for (const f of file.fields) {
      const field = cls.declaredField(f.name, f.desc);
      if (field?.isStatic && f.constantValue !== null) cls.staticValues[field.slot] = this.constant(cls, f.constantValue);
    }
  }

  private constant(cls: JClass, index: number): JValue {
    const cp = cls.file!.cp;
    const e = cp[index];
    switch (e?.tag) {
      case 'int':
      case 'float':
      case 'long':
      case 'double':
        return e.value;
      case 'string': {
        const u = cp[e.utf8];
        if (u?.tag === 'utf8') return this.jvm.heap.intern(u.value);
        break;
      }
    }
    throw this.error('java/lang/ClassFormatError', `bad ConstantValue index ${index} in class file ${cls.name}`);
  }

  private objectClass(): JClass {
    const o = this.loadBoot('java/lang/Object');
    if (!o) throw new Error('java/lang/Object is not on the boot class path');
    return o;
  }

  /** The array class of `component` (§5.3.3), made once and kept on the component class. */
  arrayOf(component: JClass): JClass {
    if (component.arrayType) return component.arrayType;
    const iface = (n: string): JClass => {
      const c = this.loadBoot(n);
      if (!c) throw new Error(`${n} is not on the boot class path`);
      return c;
    };
    const object = this.objectClass();
    const cls = new JClass({
      name: `[${component.descriptor}`,
      file: null,
      superClass: object,
      interfaces: [iface('java/lang/Cloneable'), iface('java/io/Serializable')],
      loader: component.loader,
      protectionDomain: null,
      componentType: component,
      primitive: false,
      objectClass: object,
    });
    component.arrayType = cls;
    return cls;
  }

  /** The primitive class for a descriptor letter (`I` gives `int`), as `int.class` stands for it. */
  primitive(code: PrimitiveCode): JClass {
    let cls = this.primitives.get(code);
    if (!cls) {
      cls = new JClass({
        name: PRIMITIVE_NAMES[code],
        file: null,
        superClass: null,
        interfaces: [],
        loader: null,
        protectionDomain: null,
        componentType: null,
        primitive: true,
        descriptor: code,
        objectClass: null,
      });
      this.primitives.set(code, cls);
    }
    return cls;
  }

  /**
   * Class initialisation (§5.5). Null when the class is ready for this thread now; otherwise the work to do
   * (an Invoke chain running the initialisers, a wait for the thread initialising it, or the exception), after which
   * the caller retries.
   */
  initialize(t: JThread, c: JClass): NativeResult | null {
    switch (c.state) {
      case 'initialized':
        return null;
      case 'initializing':
        if (c.initThread === t) return null;
        return this.jvm.threads.awaitInit(t, c);
      case 'erroneous':
        return this.jvm.throwNew('java/lang/NoClassDefFoundError', `Could not initialize class ${externalName(c.name)}`);
    }
    c.state = 'initializing';
    c.initThread = t;
    return this.initFrom(t, c, 0);
  }

  private initFrom(t: JThread, c: JClass, from: number): NativeResult {
    const supers = c.initSupers;
    for (let i = from; i < supers.length; i++) {
      const r = this.initialize(t, supers[i]!);
      if (r !== null && r !== undefined) {
        return andThen(r, () => this.initFrom(t, c, i), (e) => this.initFailed(c, e));
      }
    }
    const clinit = c.methods.get('<clinit>()V');
    if (!clinit) return this.initDone(c);
    return new Invoke(clinit, [], () => this.initDone(c), (e) => this.initFailed(c, this.initError(e)));
  }

  private initDone(c: JClass): undefined {
    c.state = 'initialized';
    c.initThread = null;
    this.jvm.threads.initFinished(c);
    return undefined;
  }

  private initFailed(c: JClass, e: JObject): ThrowResult {
    c.state = 'erroneous';
    c.initThread = null;
    c.initError = e;
    this.jvm.threads.initFinished(c);
    return new ThrowResult(e);
  }

  private initError(e: JObject): JObject {
    const error = this.loadBoot('java/lang/Error');
    if (error && e.cls.isSubclassOf(error)) return e;
    const wrapper = this.jvm.throwNew('java/lang/ExceptionInInitializerError').exception;
    this.jvm.setField(wrapper, 'exception', 'Ljava/lang/Throwable;', e);
    return wrapper;
  }

  private error(cls: string, message: string): JavaThrowable {
    return new JavaThrowable(this.jvm.throwNew(cls, message).exception);
  }
}
