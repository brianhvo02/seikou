/*
 * Original code for bluray-web: Java class-file parsing (JVM specification, chapter 4).
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
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
  | null; // index 0 and the slot after long/double

export interface ExceptionHandler {
  readonly startPc: number;
  readonly endPc: number;
  readonly handlerPc: number;
  /** Constant-pool index of the class, 0 for catch-all. */
  readonly catchType: number;
}

export interface CodeAttr {
  readonly maxStack: number;
  readonly maxLocals: number;
  readonly code: Uint8Array;
  readonly handlers: readonly ExceptionHandler[];
  /** The LineNumberTable as (start pc, line) pairs, flattened. */
  readonly lineNumbers: Uint16Array;
}

export interface MemberInfo {
  readonly access: number;
  readonly name: string;
  readonly desc: string;
  readonly code: CodeAttr | null;
  /** Constant-pool index from the ConstantValue attribute. */
  readonly constantValue: number | null;
  readonly exceptions: readonly string[];
  readonly signature: string | null;
  /** Raw RuntimeVisibleAnnotations, RuntimeVisibleParameterAnnotations and AnnotationDefault, as reflection wants them. */
  readonly annotations: Uint8Array | null;
  readonly parameterAnnotations: Uint8Array | null;
  readonly annotationDefault: Uint8Array | null;
}

export interface BootstrapMethod {
  readonly ref: number;
  readonly args: readonly number[];
}

export interface ClassFile {
  readonly major: number;
  readonly minor: number;
  readonly cp: readonly CpEntry[];
  readonly access: number;
  readonly name: string;
  readonly superName: string | null;
  readonly interfaces: readonly string[];
  readonly fields: readonly MemberInfo[];
  readonly methods: readonly MemberInfo[];
  readonly bootstrapMethods: readonly BootstrapMethod[];
  readonly sourceFile: string | null;
  readonly innerClasses: readonly {
    readonly inner: string;
    readonly outer: string | null;
    readonly name: string | null;
    readonly access: number;
  }[];
  readonly signature: string | null;
  readonly annotations: Uint8Array | null;
  /** EnclosingMethod: the class and the NameAndType index (0 when not in a method). */
  readonly enclosingMethod: { readonly cls: string; readonly nat: number } | null;
  /**
   * Bytes of the class file the parsed class keeps (code and annotations), copied into one buffer of their own so the
   * class file itself is not kept.
   */
  readonly retainedBytes: number;
}

export class ClassFormatError extends Error {}
export class UnsupportedClassVersionError extends Error {}

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
