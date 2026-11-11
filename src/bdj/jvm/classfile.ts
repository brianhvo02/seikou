/*
 * Original code for Seikou: Java class-file parsing (JVM specification, chapter 4).
 *
 * Copyright (C) 2026 Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

/**
 * One constant-pool entry (JVM Specification, Java SE 8, §4.4), with its references to other entries kept as pool
 * indices. Tags: Utf8 (§4.4.7, decoded from modified UTF-8), Integer and Float (§4.4.4), Long and Double (§4.4.5),
 * Class (§4.4.1, `name` the Utf8 index of its internal name), String (§4.4.3), Fieldref, Methodref and
 * InterfaceMethodref (§4.4.2, `cls` the Class index, `nat` the NameAndType index), NameAndType (§4.4.6), MethodHandle
 * (§4.4.8, `kind` the reference kind 1 to 9), MethodType (§4.4.9) and InvokeDynamic (§4.4.10, `bsm` an index into the
 * BootstrapMethods attribute, not into the pool).
 */
export type CpEntry =
  | { readonly tag: 'utf8'; readonly value: string }
  | { readonly tag: 'int'; readonly value: number }
  | { readonly tag: 'float'; readonly value: number }
  | { readonly tag: 'long'; readonly value: bigint }
  | { readonly tag: 'double'; readonly value: number }
  | { readonly tag: 'class'; readonly name: number }
  | { readonly tag: 'string'; readonly utf8: number }
  | { readonly tag: 'fieldref' | 'methodref' | 'imethodref'; readonly cls: number; readonly nat: number }
  | { readonly tag: 'nat'; readonly name: number; readonly desc: number }
  | { readonly tag: 'mhandle'; readonly kind: number; readonly ref: number }
  | { readonly tag: 'mtype'; readonly desc: number }
  | { readonly tag: 'indy'; readonly bsm: number; readonly nat: number }
  | null; // index 0 and the slot after a Long or Double, which take two entries (§4.4.5)

/**
 * One row of a Code attribute's exception_table (§4.7.3): the handler at `handlerPc` covers the bytecode offsets from
 * `startPc` (inclusive) to `endPc` (exclusive).
 */
export interface ExceptionHandler {
  /** First bytecode offset the handler covers. */
  readonly startPc: number;
  /** Bytecode offset after the last one the handler covers. */
  readonly endPc: number;
  /** Bytecode offset of the handler's first instruction. */
  readonly handlerPc: number;
  /** Constant-pool index of the class, 0 for catch-all. */
  readonly catchType: number;
}

/** A method's Code attribute (§4.7.3). Of its own attributes only LineNumberTable (§4.7.12) is kept. */
export interface CodeAttr {
  /** max_stack: the deepest the operand stack gets, in slots (a long or double takes two). */
  readonly maxStack: number;
  /** max_locals: local variable slots, parameters included (a long or double takes two). */
  readonly maxLocals: number;
  /** The bytecode, in a buffer shared with the class's other kept bytes (see `ClassFile.retainedBytes`). */
  readonly code: Uint8Array;
  readonly handlers: readonly ExceptionHandler[];
  /** The LineNumberTable (§4.7.12) as (start pc, line) pairs, flattened; empty when the method has none. */
  readonly lineNumbers: Uint16Array;
}

/** A field_info (§4.5) or method_info (§4.6) with the attributes the JVM uses; other attributes are skipped. */
export interface MemberInfo {
  /** access_flags (§4.5, §4.6): the `ACC_*` bits in `loader.ts`. */
  readonly access: number;
  readonly name: string;
  /** The field or method descriptor (§4.3.2, §4.3.3), such as `(ILjava/lang/String;)V`. */
  readonly desc: string;
  /** The Code attribute (§4.7.3); null for abstract and native methods and for fields. */
  readonly code: CodeAttr | null;
  /** Constant-pool index from the ConstantValue attribute (§4.7.2), for a static field's initial value. */
  readonly constantValue: number | null;
  /** Internal names of the classes in the Exceptions attribute (§4.7.5), the checked exceptions a method declares. */
  readonly exceptions: readonly string[];
  /** The Signature attribute (§4.7.9): the generic signature, for reflection. */
  readonly signature: string | null;
  /**
   * Raw RuntimeVisibleAnnotations (§4.7.16), RuntimeVisibleParameterAnnotations (§4.7.18) and AnnotationDefault
   * (§4.7.22) attribute bodies, as reflection hands them to Java's annotation parser.
   */
  readonly annotations: Uint8Array | null;
  readonly parameterAnnotations: Uint8Array | null;
  readonly annotationDefault: Uint8Array | null;
}

/** One entry of the BootstrapMethods attribute (§4.7.23), which `invokedynamic` call sites name. */
export interface BootstrapMethod {
  /** Constant-pool index of the bootstrap method's MethodHandle. */
  readonly ref: number;
  /** Constant-pool indices of the static arguments passed to it. */
  readonly args: readonly number[];
}

/** A parsed class file (§4.1). Class names are internal names with slashes (§4.2.1). */
export interface ClassFile {
  /** major_version: 45 to 52 (Java SE 8) are accepted. */
  readonly major: number;
  readonly minor: number;
  /** The constant pool, indexed as the class file indexes it: entry 0 is null. */
  readonly cp: readonly CpEntry[];
  /** access_flags of the class (§4.1): the `ACC_*` bits in `loader.ts`. */
  readonly access: number;
  readonly name: string;
  /** The superclass's internal name; null when super_class is 0, as it is for `java/lang/Object`. */
  readonly superName: string | null;
  readonly interfaces: readonly string[];
  readonly fields: readonly MemberInfo[];
  readonly methods: readonly MemberInfo[];
  /** The BootstrapMethods attribute (§4.7.23); empty when the class has none. */
  readonly bootstrapMethods: readonly BootstrapMethod[];
  /** The SourceFile attribute (§4.7.10), for stack traces. */
  readonly sourceFile: string | null;
  /**
   * The InnerClasses attribute (§4.7.6): each nested class, the class it is a member of (null for a local or anonymous
   * class), its simple name (null when anonymous) and its inner_class_access_flags.
   */
  readonly innerClasses: readonly {
    readonly inner: string;
    readonly outer: string | null;
    readonly name: string | null;
    readonly access: number;
  }[];
  /** The class's Signature attribute (§4.7.9). */
  readonly signature: string | null;
  /** The class's raw RuntimeVisibleAnnotations attribute body (§4.7.16). */
  readonly annotations: Uint8Array | null;
  /** EnclosingMethod (§4.7.7): the class and the NameAndType index (0 when not in a method). */
  readonly enclosingMethod: { readonly cls: string; readonly nat: number } | null;
  /**
   * Bytes of the class file the parsed class keeps (code and annotations), copied into one buffer of their own so the
   * class file itself is not kept.
   */
  readonly retainedBytes: number;
}

/** A class file that breaks the format of chapter 4: bad magic, truncation, a wrong constant type. The loader turns it into Java's `ClassFormatError`. */
export class ClassFormatError extends Error {}
/** A class file newer than major version 52 (Java SE 8). The loader turns it into Java's `UnsupportedClassVersionError`. */
export class UnsupportedClassVersionError extends Error {}

/**
 * Decodes modified UTF-8 (§4.4.7) to a JavaScript string: one-, two- and three-byte forms only, each giving one UTF-16
 * code unit, so a supplementary character arrives as its two surrogates encoded separately and NUL as `C0 80`. Throws
 * ClassFormatError on a truncated sequence or a byte that starts no form (including the four-byte form of standard
 * UTF-8). Continuation bytes are not checked.
 */
export function decodeModifiedUtf8(bytes: Uint8Array): string {
  const units: number[] = [];
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++]!;
    if (b < 0x80) units.push(b);
    else if ((b & 0xe0) === 0xc0) {
      if (i >= bytes.length) throw new ClassFormatError('truncated UTF-8 sequence');
      units.push(((b & 0x1f) << 6) | (bytes[i++]! & 0x3f));
    } else if ((b & 0xf0) === 0xe0) {
      if (i + 1 >= bytes.length) throw new ClassFormatError('truncated UTF-8 sequence');
      units.push(((b & 0x0f) << 12) | ((bytes[i]! & 0x3f) << 6) | (bytes[i + 1]! & 0x3f));
      i += 2;
    } else throw new ClassFormatError('invalid modified UTF-8 byte');
    if (units.length >= 4096) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  return out + String.fromCharCode(...units);
}

class Reader {
  private readonly view: DataView;
  pos = 0;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  }
  private need(n: number): void {
    if (this.pos + n > this.bytes.length) throw new ClassFormatError('truncated class file');
  }
  u1(): number {
    this.need(1);
    return this.bytes[this.pos++]!;
  }
  u2(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  u4(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  i4(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }
  i8(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.pos);
    this.pos += 8;
    return v;
  }
  f4(): number {
    this.need(4);
    const v = this.view.getFloat32(this.pos);
    this.pos += 4;
    return v;
  }
  f8(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }
  slice(n: number): Uint8Array {
    this.need(n);
    const s = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
}

const NO_LINES = new Uint16Array(0);

/**
 * Parts of a class file the parsed class keeps (code, annotations). parseClassFile reads them as views of the class
 * file, then copies them all into one buffer, so the class file (and the rest of the jar entry it came from) is not
 * kept alive by them.
 */
class Kept {
  private readonly parts: { readonly view: Uint8Array; readonly set: (copy: Uint8Array) => void }[] = [];
  private total = 0;

  keep(view: Uint8Array, set: (copy: Uint8Array) => void): void {
    if (view.length === 0) return;
    this.parts.push({ view, set });
    this.total += view.length;
  }

  /** Copies the kept parts into one new buffer and points their owners at the copies; returns its size. */
  compact(): number {
    if (this.total === 0) return 0;
    const out = new Uint8Array(this.total);
    let at = 0;
    for (const { view, set } of this.parts) {
      out.set(view, at);
      set(out.subarray(at, at + view.length));
      at += view.length;
    }
    return this.total;
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Parses a class file (§4.1): magic, version, constant pool (§4.4), access flags, this and super class, interfaces,
 * fields (§4.5), methods (§4.6) and the class attributes it uses (§4.7). It checks structure only (no verification,
 * §4.10). Throws ClassFormatError on a malformed file and UnsupportedClassVersionError on a version over 52. The result
 * keeps no reference to `bytes`.
 */
export function parseClassFile(bytes: Uint8Array): ClassFile {
  const r = new Reader(bytes);
  const kept = new Kept();
  if (r.u4() !== 0xcafebabe) throw new ClassFormatError('bad magic number');
  const minor = r.u2();
  const major = r.u2();
  if (major < 45) throw new ClassFormatError(`bad class file version ${major}.${minor}`);
  if (major > 52) throw new UnsupportedClassVersionError(`class file version ${major}.${minor} is not supported`);

  const cpCount = r.u2();
  if (cpCount === 0) throw new ClassFormatError('empty constant pool');
  const cp: CpEntry[] = new Array<CpEntry>(cpCount).fill(null);
  for (let i = 1; i < cpCount; i++) {
    const tag = r.u1();
    switch (tag) {
      case 1: {
        const len = r.u2();
        cp[i] = { tag: 'utf8', value: decodeModifiedUtf8(r.slice(len)) };
        break;
      }
      case 3: cp[i] = { tag: 'int', value: r.i4() }; break;
      case 4: cp[i] = { tag: 'float', value: r.f4() }; break;
      case 5:
      case 6:
        if (i + 1 >= cpCount) throw new ClassFormatError('long/double constant at the end of the pool');
        cp[i] = tag === 5 ? { tag: 'long', value: r.i8() } : { tag: 'double', value: r.f8() };
        i++;
        break;
      case 7: cp[i] = { tag: 'class', name: r.u2() }; break;
      case 8: cp[i] = { tag: 'string', utf8: r.u2() }; break;
      case 9: cp[i] = { tag: 'fieldref', cls: r.u2(), nat: r.u2() }; break;
      case 10: cp[i] = { tag: 'methodref', cls: r.u2(), nat: r.u2() }; break;
      case 11: cp[i] = { tag: 'imethodref', cls: r.u2(), nat: r.u2() }; break;
      case 12: cp[i] = { tag: 'nat', name: r.u2(), desc: r.u2() }; break;
      case 15: cp[i] = { tag: 'mhandle', kind: r.u1(), ref: r.u2() }; break;
      case 16: cp[i] = { tag: 'mtype', desc: r.u2() }; break;
      case 18: cp[i] = { tag: 'indy', bsm: r.u2(), nat: r.u2() }; break;
      default: throw new ClassFormatError(`unknown constant pool tag ${tag}`);
    }
  }

  const utf8 = (i: number): string => {
    const e = cp[i];
    if (!e || e.tag !== 'utf8') throw new ClassFormatError(`constant ${i} is not a Utf8`);
    return e.value;
  };
  const className = (i: number): string => {
    const e = cp[i];
    if (!e || e.tag !== 'class') throw new ClassFormatError(`constant ${i} is not a Class`);
    return utf8(e.name);
  };
  const optClassName = (i: number): string | null => (i === 0 ? null : className(i));
  const optUtf8 = (i: number): string | null => (i === 0 ? null : utf8(i));

  const access = r.u2();
  const name = className(r.u2());
  const superName = optClassName(r.u2());
  const interfaces: string[] = [];
  for (let n = r.u2(); n > 0; n--) interfaces.push(className(r.u2()));

  const readMembers = (): MemberInfo[] => {
    const list: MemberInfo[] = [];
    for (let n = r.u2(); n > 0; n--) {
      const macc = r.u2();
      const mname = utf8(r.u2());
      const desc = utf8(r.u2());
      let code: CodeAttr | null = null;
      let constantValue: number | null = null;
      let exceptions: string[] = [];
      let signature: string | null = null;
      let annotations: Uint8Array | null = null;
      let parameterAnnotations: Uint8Array | null = null;
      let annotationDefault: Uint8Array | null = null;
      for (let a = r.u2(); a > 0; a--) {
        const aname = utf8(r.u2());
        const len = r.u4();
        const end = r.pos + len;
        if (end > bytes.length) throw new ClassFormatError('truncated class file');
        if (aname === 'Code') code = readCode();
        else if (aname === 'ConstantValue') constantValue = r.u2();
        else if (aname === 'Exceptions') {
          exceptions = [];
          for (let k = r.u2(); k > 0; k--) exceptions.push(className(r.u2()));
        } else if (aname === 'Signature') signature = utf8(r.u2());
        else if (aname === 'RuntimeVisibleAnnotations') annotations = r.slice(len);
        else if (aname === 'RuntimeVisibleParameterAnnotations') parameterAnnotations = r.slice(len);
        else if (aname === 'AnnotationDefault') annotationDefault = r.slice(len);
        r.pos = end;
      }
      const member: Mutable<MemberInfo> = { access: macc, name: mname, desc, code, constantValue, exceptions, signature, annotations, parameterAnnotations, annotationDefault };
      if (annotations) kept.keep(annotations, (c) => (member.annotations = c));
      if (parameterAnnotations) kept.keep(parameterAnnotations, (c) => (member.parameterAnnotations = c));
      if (annotationDefault) kept.keep(annotationDefault, (c) => (member.annotationDefault = c));
      list.push(member);
    }
    return list;
  };

  const readCode = (): CodeAttr => {
    const maxStack = r.u2();
    const maxLocals = r.u2();
    const code = r.slice(r.u4());
    const handlers: ExceptionHandler[] = [];
    for (let n = r.u2(); n > 0; n--) handlers.push({ startPc: r.u2(), endPc: r.u2(), handlerPc: r.u2(), catchType: r.u2() });
    const lines: number[] = [];
    for (let a = r.u2(); a > 0; a--) {
      const aname = utf8(r.u2());
      const end = r.u4() + r.pos;
      if (end > bytes.length) throw new ClassFormatError('truncated class file');
      if (aname === 'LineNumberTable') for (let n = r.u2(); n > 0; n--) lines.push(r.u2(), r.u2());
      r.pos = end;
    }
    const attr: Mutable<CodeAttr> = { maxStack, maxLocals, code, handlers, lineNumbers: lines.length ? Uint16Array.from(lines) : NO_LINES };
    kept.keep(code, (c) => (attr.code = c));
    return attr;
  };

  const fields = readMembers();
  const methods = readMembers();

  const bootstrapMethods: BootstrapMethod[] = [];
  const innerClasses: { inner: string; outer: string | null; name: string | null; access: number }[] = [];
  let sourceFile: string | null = null;
  let signature: string | null = null;
  let annotations: Uint8Array | null = null;
  let enclosingMethod: { cls: string; nat: number } | null = null;
  for (let a = r.u2(); a > 0; a--) {
    const aname = utf8(r.u2());
    const len = r.u4();
    const end = r.pos + len;
    if (end > bytes.length) throw new ClassFormatError('truncated class file');
    if (aname === 'SourceFile') sourceFile = utf8(r.u2());
    else if (aname === 'Signature') signature = utf8(r.u2());
    else if (aname === 'RuntimeVisibleAnnotations') annotations = r.slice(len);
    else if (aname === 'EnclosingMethod') enclosingMethod = { cls: className(r.u2()), nat: r.u2() };
    else if (aname === 'BootstrapMethods') {
      for (let n = r.u2(); n > 0; n--) {
        const ref = r.u2();
        const args: number[] = [];
        for (let k = r.u2(); k > 0; k--) args.push(r.u2());
        bootstrapMethods.push({ ref, args });
      }
    } else if (aname === 'InnerClasses') {
      for (let n = r.u2(); n > 0; n--) {
        const inner = className(r.u2());
        const outer = optClassName(r.u2());
        const iname = optUtf8(r.u2());
        innerClasses.push({ inner, outer, name: iname, access: r.u2() });
      }
    }
    r.pos = end;
  }

  if (annotations) kept.keep(annotations, (c) => (annotations = c));
  const retainedBytes = kept.compact();
  return { major, minor, cp, access, name, superName, interfaces, fields, methods, bootstrapMethods, sourceFile, innerClasses, signature, annotations, enclosingMethod, retainedBytes };
}
