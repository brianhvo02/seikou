/*
 * Original code for bluray-web: java.lang natives of the BD-J virtual machine (Object, Class, System, Thread,
 * Throwable, String, Float, Double, Runtime, ClassLoader, Compiler, Package) and AccessController.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { Invoke, ThrowResult, andThen } from '../interpreter';
import type { NativeResult } from '../interpreter';
import { ACC_PRIVATE, ACC_PROTECTED, ACC_PUBLIC, externalName, retrying, selectMethod } from '../loader';
import type { JClass, JMethod } from '../loader';
import type { Jvm, StackTrace } from '../jvm';
import { JThread } from '../threads';
import { JavaThrowable } from '../values';
import type { JArray, JObject, JValue } from '../values';
import type { NativeTable } from './index';
import { each, internalName, jsStr, method, none, throwConstructed, virtual, withMonitor } from './util';

const ACC_FINAL = 0x0010;
const ACC_SUPER = 0x0020;
const ACC_ABSTRACT = 0x0400;
const JVM_ACC_WRITTEN_FLAGS = 0x7fff;

const bits = new DataView(new ArrayBuffer(8));

const MEMORY = 256n * 1024n * 1024n;

/** The properties HotSpot's initProperties sets, with this VM's values (java.home is the VFS's /jdk). */
export const BASE_PROPERTIES: readonly (readonly [string, string])[] = [
  ['java.home', '/jdk'],
  ['java.io.tmpdir', '/tmp'],
  ['user.dir', '/'],
  ['user.home', '/tmp'],
  ['user.name', 'bdj'],
  ['file.separator', '/'],
  ['path.separator', ':'],
  ['line.separator', '\n'],
  ['file.encoding', 'UTF-8'],
  ['sun.jnu.encoding', 'UTF-8'],
  ['os.name', 'Linux'],
  ['os.arch', 'amd64'],
  ['os.version', '0'],
  ['java.vm.name', 'bluray-web'],
  ['java.vm.version', '5b'],
  ['java.vm.specification.version', '1.8'],
  ['java.version', '1.8.0'],
  ['java.specification.version', '1.8'],
  ['java.class.version', '52.0'],
  ['sun.boot.class.path', '/boot/libbluray-j2se.jar:/boot/libbluray-awt-j2se.jar:/boot/rt-bdj.jar'],
  ['java.class.path', ''],
  ['sun.arch.data.model', '64'],
  ['java.awt.headless', 'false'],
  // Method.invoke and Constructor.newInstance stay on the native accessors instead of generating bytecode after 15
  // calls; generated accessors only pay off with a JIT.
  ['sun.reflect.inflationThreshold', '2147483647'],
];

export function classOf(o: JValue): JClass {
  return (o as JObject).nativeData as JClass;
}

/** Class.getModifiers: an inner class's InnerClasses flags, else its own, without ACC_SUPER (as HotSpot computes). */
export function classModifiers(c: JClass): number {
  if (c.isPrimitive) return ACC_PUBLIC | ACC_FINAL | ACC_ABSTRACT;
  if (c.componentType) return (classModifiers(c.componentType) & (ACC_PUBLIC | ACC_PRIVATE | ACC_PROTECTED)) | ACC_FINAL | ACC_ABSTRACT;
  let access = c.access;
  for (const ic of c.file?.innerClasses ?? []) if (ic.inner === c.name) access = ic.access;
  return access & ~ACC_SUPER & JVM_ACC_WRITTEN_FLAGS;
}

/** The source line of `pc` in `m` from its LineNumberTable; -2 for a native method, -1 when unknown. */
export function lineNumber(m: JMethod, pc: number): number {
  if (m.isNative) return -2;
  let best = -1;
  let bestPc = -1;
  const lines = m.code?.lineNumbers;
  for (let i = 0; lines && i < lines.length; i += 2) {
    const start = lines[i]!;
    if (start <= pc && start >= bestPc) {
      best = lines[i + 1]!;
      bestPc = start;
    }
  }
  return best;
}

export function stackTraceElement(jvm: Jvm, m: JMethod, pc: number): JObject {
  const e = jvm.heap.newObject(jvm.bootClass('java/lang/StackTraceElement'));
  jvm.setField(e, 'declaringClass', 'Ljava/lang/String;', jvm.heap.newString(externalName(m.cls.name)));
  jvm.setField(e, 'methodName', 'Ljava/lang/String;', jvm.heap.intern(m.name));
  const file = m.cls.file?.sourceFile;
  jvm.setField(e, 'fileName', 'Ljava/lang/String;', file ? jvm.heap.intern(file) : null);
  jvm.setField(e, 'lineNumber', 'I', lineNumber(m, pc));
  return e;
}

function threadTrace(jvm: Jvm, t: JThread | null): JArray {
  const items: JObject[] = [];
  const frames = t?.frames ?? [];
  for (let i = frames.length - 1; i >= 0; i--) items.push(stackTraceElement(jvm, frames[i]!.method, frames[i]!.pc));
  return jvm.newArray(jvm.bootClass('java/lang/StackTraceElement'), items);
}

const jthread = (o: JValue): JThread | null => {
  const d = (o as JObject).nativeData;
  return d instanceof JThread ? d : null;
};

function arraycopy(jvm: Jvm, src: JValue, srcPos: number, dst: JValue, dstPos: number, length: number): NativeResult {
  if (src === null || dst === null) return jvm.throwNew('java/lang/NullPointerException');
  const s = src as JArray;
  const d = dst as JArray;
  const sc = s.cls.componentType;
  const dc = d.cls.componentType;
  if (!sc || !dc) return jvm.throwNew('java/lang/ArrayStoreException');
  if ((sc.isPrimitive || dc.isPrimitive) && sc !== dc) return jvm.throwNew('java/lang/ArrayStoreException');
  if (length < 0 || srcPos < 0 || dstPos < 0 || srcPos + length > s.data.length || dstPos + length > d.data.length) {
    return jvm.throwNew('java/lang/ArrayIndexOutOfBoundsException');
  }
  if (length === 0) return undefined;
  if (s === d) {
    s.data.copyWithin(dstPos, srcPos, srcPos + length);
    return undefined;
  }
  if (sc.isPrimitive || sc.isSubclassOf(dc)) {
    if (Array.isArray(s.data)) {
      const sd = s.data;
      const dd = d.data as (JObject | null)[];
      for (let i = 0; i < length; i++) dd[dstPos + i] = sd[srcPos + i]!;
    } else {
      (d.data as Int32Array).set((s.data as Int32Array).subarray(srcPos, srcPos + length), dstPos);
    }
    return undefined;
  }
  const sd = s.data as (JObject | null)[];
  const dd = d.data as (JObject | null)[];
  for (let i = 0; i < length; i++) {
    const v = sd[srcPos + i]!;
    if (v !== null && !v.cls.isSubclassOf(dc)) return jvm.throwNew('java/lang/ArrayStoreException');
    dd[dstPos + i] = v;
  }
  return undefined;
}

function forName(jvm: Jvm, t: JThread, nameObj: JValue, initialize: number, loader: JObject | null): NativeResult {
  if (nameObj === null) return jvm.throwNew('java/lang/NullPointerException');
  const ext = jsStr(jvm, nameObj);
  const name = internalName(ext);
  if (ext.includes('/')) return throwCnfe(jvm, ext);
  const done = (c: JClass): NativeResult => (initialize ? jvm.withInit(t, c, () => jvm.mirror(c)) : jvm.mirror(c));
  if (loader === null) {
    const c = jvm.loader.loadBoot(name);
    return c ? done(c) : throwCnfe(jvm, ext);
  }
  const hit = jvm.loader.findLoaded(loader, name);
  if (hit) return done(hit);
  if (name.startsWith('[')) return retrying(() => done(jvm.loader.resolveIn(loader, name)));
  return andThen(jvm.loader.loadVia(loader, name, false), (m) => done(classOf(m as JObject)));
}

function throwCnfe(jvm: Jvm, name: string): NativeResult {
  const e = jvm.throwNew('java/lang/ClassNotFoundException', name);
  jvm.setField(e.exception, 'ex', 'Ljava/lang/Throwable;', null);
  return e;
}

function defineClass(jvm: Jvm, loader: JObject | null, name: JValue, b: JValue, off: number, len: number, pd: JValue): NativeResult {
  if (b === null) return jvm.throwNew('java/lang/NullPointerException');
  const data = (b as JArray).data as Int8Array;
  if (off < 0 || len < 0 || off + len > data.length) return jvm.throwNew('java/lang/ArrayIndexOutOfBoundsException');
  const bytes = new Uint8Array(data.buffer, data.byteOffset + off, len).slice();
  let internal: string;
  if (name !== null) internal = internalName(jsStr(jvm, name));
  else {
    try {
      internal = jvm.loader.className(bytes);
    } catch (e) {
      if (e instanceof JavaThrowable) return new ThrowResult(e.obj);
      throw e;
    }
  }
  return retrying(() => jvm.mirror(jvm.loader.define(internal, bytes, loader, pd as JObject | null)));
}

/** A frame that called AccessController.doPrivileged, while the action runs: where a stack walk stops (Ruling R20). */
interface PrivilegedFrame {
  readonly frame: object;
  /** The protection domain of the class that called doPrivileged (null: a boot class, fully trusted). */
  readonly domain: JObject | null;
  /** The AccessControlContext passed to doPrivileged, or null. */
  readonly context: JObject | null;
}

/** Each thread's frames inside doPrivileged, innermost last. */
const privilegedFrames = new WeakMap<JThread, PrivilegedFrame[]>();

/**
 * doPrivileged: runs the action with its caller marked privileged until it returns or throws (getStackAccessControlContext
 * stops there); a checked exception becomes PrivilegedActionException, as the JDK specifies.
 */
function doPrivileged(jvm: Jvm, t: JThread, action: JValue, iface: string, context: JValue = null): NativeResult {
  if (action === null) return jvm.throwNew('java/lang/NullPointerException');
  const a = action as JObject;
  const m = selectMethod(a.cls, method(jvm.bootClass(iface), 'run()Ljava/lang/Object;'));
  if (!m) return jvm.throwNew('java/lang/AbstractMethodError', `${externalName(a.cls.name)}.run()`);
  // the top frame is this native's marker; the one under it called doPrivileged
  const caller = t.frames[t.frames.length - 2];
  let stack = privilegedFrames.get(t);
  if (!stack) privilegedFrames.set(t, (stack = []));
  const entry: PrivilegedFrame | null = caller ? { frame: caller, domain: caller.method.cls.protectionDomain, context: context as JObject | null } : null;
  if (entry) stack.push(entry);
  const marks = stack;
  const done = (): void => {
    if (!entry) return;
    const i = marks.lastIndexOf(entry);
    if (i >= 0) marks.splice(i, 1);
  };
  return new Invoke(
    m,
    [a],
    (r) => {
      done();
      return r ?? null;
    },
    (e) => {
      done();
      const exception = jvm.bootClass('java/lang/Exception');
      const runtime = jvm.bootClass('java/lang/RuntimeException');
      if (e.cls.isSubclassOf(exception) && !e.cls.isSubclassOf(runtime)) {
        return throwConstructed(jvm, t, 'java/security/PrivilegedActionException', '(Ljava/lang/Exception;)V', [e]);
      }
      return new ThrowResult(e);
    },
  );
}

/**
 * AccessController.getStackAccessControlContext (Ruling R20): the protection domains of the methods on the calling
 * thread's stack, innermost first, up to and including the innermost caller of doPrivileged, whose own domain counts
 * and whose context argument becomes the privileged context. Boot classes (null domain) add nothing. Null only for a
 * privileged walk that found no domain and no privileged context (trusted code inside doPrivileged: nothing to check).
 * Otherwise a context, with a null domain array when no domain was found: an unprivileged stack of trusted code still
 * has its thread's inherited context, which AccessControlContext.optimize merges in (a thread started by restricted
 * code stays restricted), as the JDK specifies.
 */
function stackAccessControlContext(jvm: Jvm, t: JThread): JObject | null {
  const frames = t.frames;
  const privileged = privilegedFrames.get(t);
  const domains: JObject[] = [];
  let isPrivileged = false;
  let privilegedContext: JObject | null = null;
  // the top frame is this native's marker
  for (let i = frames.length - 2; i >= 0; i--) {
    const f = frames[i]!;
    let mark: PrivilegedFrame | undefined;
    if (privileged?.length) {
      for (let k = privileged.length - 1; k >= 0; k--) {
        if (privileged[k]!.frame === f) {
          mark = privileged[k];
          break;
        }
      }
    }
    const domain = mark ? mark.domain : f.method.cls.protectionDomain;
    // de-duplicated over the whole stack (HotSpot drops only consecutive repeats): a check against a set of domains is
    // the same either way, so neither side needs "fixing" to match the other
    if (domain !== null && !domains.includes(domain)) domains.push(domain);
    if (mark) {
      isPrivileged = true;
      privilegedContext = mark.context;
      break;
    }
  }
  if (domains.length === 0 && isPrivileged && privilegedContext === null) return null;
  const acc = jvm.heap.newObject(jvm.bootClass('java/security/AccessControlContext'));
  const array = domains.length ? jvm.newArray(jvm.bootClass('java/security/ProtectionDomain'), domains) : null;
  jvm.setField(acc, 'context', '[Ljava/security/ProtectionDomain;', array);
  jvm.setField(acc, 'isPrivileged', 'Z', isPrivileged ? 1 : 0);
  jvm.setField(acc, 'isAuthorized', 'Z', 1);
  jvm.setField(acc, 'privilegedContext', 'Ljava/security/AccessControlContext;', privilegedContext);
  return acc;
}

function setProperties(jvm: Jvm, props: JObject): NativeResult {
  const entries = new Map<string, string>(BASE_PROPERTIES);
  for (const [k, v] of jvm.opts.systemProperties ?? []) entries.set(k, v);
  const set = virtual(props, jvm.bootClass('java/util/Properties'), 'setProperty(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/Object;');
  return each(
    [...entries],
    ([k, v]) => new Invoke(set, [props, jvm.heap.newString(k), jvm.heap.newString(v)], () => undefined),
    () => props,
  );
}

function setStatic(jvm: Jvm, cls: string, name: string, desc: string, v: JValue): undefined {
  const c = jvm.bootClass(cls);
  c.staticValues[c.declaredField(name, desc)!.slot] = v;
  return undefined;
}

/** Thread.start0: the new thread runs run(), then dispatchUncaughtException if it threw, then exit(), as HotSpot. */
function startThread(jvm: Jvm, self: JObject): NativeResult {
  const thread = jvm.bootClass('java/lang/Thread');
  jvm.threads.spawnWith(self, (t) => {
    t.syncStatus(jvm.threadStatusSlot);
    self.nativeData = t;
    // HotSpot's ensure_join: under the Thread object's monitor, the thread stops being alive and joiners are woken.
    const finish = (): NativeResult =>
      withMonitor(jvm, t, self, () => {
        t.exited = true;
        jvm.setField(self, 'threadStatus', 'I', 2);
        jvm.threads.notify(self, true, t);
        jvm.threads.monitorExit(t, self);
        return undefined;
      });
    const exit = (): NativeResult => new Invoke(method(thread, 'exit()V'), [self], finish, finish);
    const run = virtual(self, thread, 'run()V');
    return new Invoke(run, [self], exit, (e) =>
      new Invoke(method(thread, 'dispatchUncaughtException(Ljava/lang/Throwable;)V'), [self, e], exit, exit),
    );
  });
  return undefined;
}

/** The classes of the calling thread's frames below the native itself, innermost first, without Method.invoke. */
function contextClasses(t: JThread): JClass[] {
  const out: JClass[] = [];
  for (let i = t.frames.length - 2; i >= 0; i--) {
    const m = t.frames[i]!.method;
    if (m.cls.name === 'java/lang/reflect/Method' && m.name === 'invoke') continue;
    out.push(m.cls);
  }
  return out;
}

export function registerLangNatives(table: NativeTable): void {
  table.register({
    'java/lang/Object.clone()Ljava/lang/Object;': (ctx, self) => {
      const o = self as JObject;
      const cloneable = ctx.jvm.bootClass('java/lang/Cloneable');
      if (!o.cls.isSubclassOf(cloneable)) return ctx.jvm.throwNew('java/lang/CloneNotSupportedException', externalName(o.cls.name));
      return ctx.jvm.heap.clone(o);
    },

    'java/lang/Class.forName0(Ljava/lang/String;ZLjava/lang/ClassLoader;Ljava/lang/Class;)Ljava/lang/Class;': (ctx, name, init, loader) =>
      forName(ctx.jvm, ctx.thread, name, init as number, loader as JObject | null),
    'java/lang/Class.getPrimitiveClass(Ljava/lang/String;)Ljava/lang/Class;': (ctx, name) => {
      const codes: Record<string, 'I' | 'J' | 'F' | 'D' | 'Z' | 'B' | 'C' | 'S' | 'V'> = {
        int: 'I', long: 'J', float: 'F', double: 'D', boolean: 'Z', byte: 'B', char: 'C', short: 'S', void: 'V',
      };
      const code = codes[jsStr(ctx.jvm, name)];
      return code ? ctx.jvm.mirror(ctx.jvm.loader.primitive(code)) : ctx.jvm.throwNew('java/lang/ClassNotFoundException', jsStr(ctx.jvm, name));
    },
    'java/lang/Class.isInstance(Ljava/lang/Object;)Z': (_ctx, self, o) => (o !== null && (o as JObject).cls.isSubclassOf(classOf(self)) ? 1 : 0),
    'java/lang/Class.isAssignableFrom(Ljava/lang/Class;)Z': (ctx, self, other) => {
      if (other === null) return ctx.jvm.throwNew('java/lang/NullPointerException');
      return classOf(other).isSubclassOf(classOf(self)) ? 1 : 0;
    },
    'java/lang/Class.isInterface()Z': (_ctx, self) => (classOf(self).isInterface ? 1 : 0),
    'java/lang/Class.isArray()Z': (_ctx, self) => (classOf(self).componentType ? 1 : 0),
    'java/lang/Class.isPrimitive()Z': (_ctx, self) => (classOf(self).isPrimitive ? 1 : 0),
    'java/lang/Class.getName0()Ljava/lang/String;': (ctx, self) => ctx.jvm.heap.intern(externalName(classOf(self).name)),
    'java/lang/Class.getSuperclass()Ljava/lang/Class;': (ctx, self) => {
      const s = classOf(self).superClass;
      return s ? ctx.jvm.mirror(s) : null;
    },
    'java/lang/Class.getInterfaces0()[Ljava/lang/Class;': (ctx, self) =>
      ctx.jvm.newArray(ctx.jvm.bootClass('java/lang/Class'), classOf(self).interfaces.map((i) => ctx.jvm.mirror(i))),
    'java/lang/Class.getComponentType()Ljava/lang/Class;': (ctx, self) => {
      const c = classOf(self).componentType;
      return c ? ctx.jvm.mirror(c) : null;
    },
    'java/lang/Class.getModifiers()I': (_ctx, self) => classModifiers(classOf(self)),
    'java/lang/Class.getDeclaringClass0()Ljava/lang/Class;': (ctx, self) => {
      const c = classOf(self);
      const ic = c.file?.innerClasses.find((e) => e.inner === c.name && e.outer !== null);
      return ic ? retrying(() => ctx.jvm.mirror(ctx.jvm.loader.resolveClass(c, ic.outer!))) : null;
    },
    'java/lang/Class.getDeclaredClasses0()[Ljava/lang/Class;': (ctx, self) => {
      const c = classOf(self);
      const names = (c.file?.innerClasses ?? []).filter((e) => e.outer === c.name && e.inner !== c.name).map((e) => e.inner);
      return retrying(() => ctx.jvm.newArray(ctx.jvm.bootClass('java/lang/Class'), names.map((n) => ctx.jvm.mirror(ctx.jvm.loader.resolveClass(c, n)))));
    },
    'java/lang/Class.getEnclosingMethod0()[Ljava/lang/Object;': (ctx, self) => {
      const c = classOf(self);
      const em = c.file?.enclosingMethod;
      if (!em) return null;
      return retrying(() => {
        const jvm = ctx.jvm;
        const outer = jvm.mirror(jvm.loader.resolveClass(c, em.cls));
        let name: JObject | null = null;
        let desc: JObject | null = null;
        const nat = em.nat ? c.file!.cp[em.nat] : null;
        if (nat?.tag === 'nat') {
          const n = c.file!.cp[nat.name];
          const d = c.file!.cp[nat.desc];
          if (n?.tag === 'utf8') name = jvm.heap.newString(n.value);
          if (d?.tag === 'utf8') desc = jvm.heap.newString(d.value);
        }
        return jvm.newArray(jvm.bootClass('java/lang/Object'), [outer, name, desc]);
      });
    },
    'java/lang/Class.getGenericSignature0()Ljava/lang/String;': (ctx, self) => {
      const s = classOf(self).file?.signature;
      return s ? ctx.jvm.heap.newString(s) : null;
    },
    'java/lang/Class.getProtectionDomain0()Ljava/security/ProtectionDomain;': (_ctx, self) => classOf(self).protectionDomain,
    'java/lang/Class.getSigners()[Ljava/lang/Object;': (ctx, self) => {
      const s = classOf(self).signers as JArray | null;
      return s ? ctx.jvm.heap.clone(s) : null;
    },
    'java/lang/Class.setSigners([Ljava/lang/Object;)V': (_ctx, self, signers) => {
      classOf(self).signers = signers as JObject | null;
      return undefined;
    },

    'java/lang/System.arraycopy(Ljava/lang/Object;ILjava/lang/Object;II)V': (ctx, src, sp, dst, dp, len) =>
      arraycopy(ctx.jvm, src, sp as number, dst, dp as number, len as number),
    'java/lang/System.currentTimeMillis()J': (ctx) => BigInt(Math.floor(ctx.jvm.opts.nowMs())),
    'java/lang/System.nanoTime()J': (ctx) => BigInt(Math.round(ctx.jvm.opts.nowMs() * 1e6)),
    'java/lang/System.identityHashCode(Ljava/lang/Object;)I': (ctx, o) => (o === null ? 0 : ctx.jvm.heap.identityHash(o as JObject)),
    'java/lang/System.initProperties(Ljava/util/Properties;)Ljava/util/Properties;': (ctx, props) => setProperties(ctx.jvm, props as JObject),
    'java/lang/System.setIn0(Ljava/io/InputStream;)V': (ctx, v) => setStatic(ctx.jvm, 'java/lang/System', 'in', 'Ljava/io/InputStream;', v),
    'java/lang/System.setOut0(Ljava/io/PrintStream;)V': (ctx, v) => setStatic(ctx.jvm, 'java/lang/System', 'out', 'Ljava/io/PrintStream;', v),
    'java/lang/System.setErr0(Ljava/io/PrintStream;)V': (ctx, v) => setStatic(ctx.jvm, 'java/lang/System', 'err', 'Ljava/io/PrintStream;', v),
    'java/lang/System.mapLibraryName(Ljava/lang/String;)Ljava/lang/String;': (ctx, name) => {
      if (name === null) return ctx.jvm.throwNew('java/lang/NullPointerException');
      return ctx.jvm.heap.newString(`lib${jsStr(ctx.jvm, name)}.so`);
    },

    'java/lang/Thread.currentThread()Ljava/lang/Thread;': (ctx) => ctx.thread.javaThread,
    'java/lang/Thread.start0()V': (ctx, self) => startThread(ctx.jvm, self as JObject),
    'java/lang/Thread.isAlive()Z': (_ctx, self) => {
      const t = jthread(self);
      return t && !t.exited && t.state !== 'terminated' ? 1 : 0;
    },
    'java/lang/Thread.holdsLock(Ljava/lang/Object;)Z': (ctx, o) => {
      if (o === null) return ctx.jvm.throwNew('java/lang/NullPointerException');
      return (o as JObject).monitor?.owner === ctx.thread ? 1 : 0;
    },
    'java/lang/Thread.interrupt0()V': (ctx, self) => {
      const t = jthread(self);
      if (t && t.state !== 'terminated') ctx.jvm.threads.interrupt(t);
      return undefined;
    },
    'java/lang/Thread.isInterrupted(Z)Z': (_ctx, self, clear) => {
      const t = jthread(self);
      if (!t) return 0;
      const was = t.interrupted;
      if (clear) t.interrupted = false;
      return was ? 1 : 0;
    },
    'java/lang/Thread.setPriority0(I)V': none,
    'java/lang/Thread.setNativeName(Ljava/lang/String;)V': none,
    'java/lang/Thread.suspend0()V': none,
    'java/lang/Thread.resume0()V': none,
    'java/lang/Thread.countStackFrames()I': () => 0,
    'java/lang/Thread.stop0(Ljava/lang/Object;)V': (ctx, self, e) => (jthread(self) === ctx.thread ? new ThrowResult(e as JObject) : undefined),
    'java/lang/Thread.getThreads()[Ljava/lang/Thread;': (ctx) => {
      const seen = new Set<JObject>();
      for (const t of ctx.jvm.threads.live) if (t.javaThread) seen.add(t.javaThread);
      return ctx.jvm.newArray(ctx.jvm.bootClass('java/lang/Thread'), [...seen]);
    },
    'java/lang/Thread.dumpThreads([Ljava/lang/Thread;)[[Ljava/lang/StackTraceElement;': (ctx, threads) => {
      const jvm = ctx.jvm;
      const traces = ((threads as JArray).data as (JObject | null)[]).map((o) => threadTrace(jvm, o ? jthread(o) : null));
      return jvm.newArray(jvm.loader.arrayOf(jvm.bootClass('java/lang/StackTraceElement')), traces);
    },

    'java/lang/Throwable.getStackTraceDepth()I': (_ctx, self) => ((self as JObject).nativeData as StackTrace | null)?.methods.length ?? 0,
    'java/lang/Throwable.getStackTraceElement(I)Ljava/lang/StackTraceElement;': (ctx, self, i) => {
      const trace = (self as JObject).nativeData as StackTrace | null;
      const n = i as number;
      if (!trace || n < 0 || n >= trace.methods.length) return ctx.jvm.throwNew('java/lang/IndexOutOfBoundsException');
      return stackTraceElement(ctx.jvm, trace.methods[n]!, trace.pcs[n]!);
    },

    'java/lang/String.intern()Ljava/lang/String;': (ctx, self) => ctx.jvm.heap.internObject(self as JObject),

    'java/lang/Float.floatToRawIntBits(F)I': (_ctx, f) => {
      bits.setFloat32(0, f as number);
      return bits.getInt32(0);
    },
    'java/lang/Float.intBitsToFloat(I)F': (_ctx, i) => {
      bits.setInt32(0, i as number);
      return bits.getFloat32(0);
    },
    'java/lang/Double.doubleToRawLongBits(D)J': (_ctx, d) => {
      bits.setFloat64(0, d as number);
      return bits.getBigInt64(0);
    },
    'java/lang/Double.longBitsToDouble(J)D': (_ctx, l) => {
      bits.setBigInt64(0, l as bigint);
      return bits.getFloat64(0);
    },

    // System.getenv sees no variables. This deliberately differs from libbluray, where xlets under HotSpot see the real
    // process environment: a browser has no environment to show them
    'java/lang/ProcessEnvironment.environ()[[B': (ctx) => ctx.jvm.newArray(ctx.jvm.loader.arrayOf(ctx.jvm.loader.primitive('B')), []),
    'java/lang/Runtime.availableProcessors()I': () => 1,
    'java/lang/Runtime.freeMemory()J': () => MEMORY,
    'java/lang/Runtime.totalMemory()J': () => MEMORY,
    'java/lang/Runtime.maxMemory()J': () => MEMORY,
    'java/lang/Runtime.gc()V': none,
    'java/lang/Runtime.runFinalization0()V': none,
    'java/lang/Runtime.traceInstructions(Z)V': none,
    'java/lang/Runtime.traceMethodCalls(Z)V': none,

    'java/lang/ClassLoader.registerNatives()V': none,
    'java/lang/ClassLoader.defineClass0(Ljava/lang/String;[BIILjava/security/ProtectionDomain;)Ljava/lang/Class;': (ctx, self, name, b, off, len, pd) =>
      defineClass(ctx.jvm, self as JObject, name, b, off as number, len as number, pd),
    'java/lang/ClassLoader.defineClass1(Ljava/lang/String;[BIILjava/security/ProtectionDomain;Ljava/lang/String;)Ljava/lang/Class;': (ctx, self, name, b, off, len, pd) =>
      defineClass(ctx.jvm, self as JObject, name, b, off as number, len as number, pd),
    'java/lang/ClassLoader.resolveClass0(Ljava/lang/Class;)V': none,
    'java/lang/ClassLoader.findBootstrapClass(Ljava/lang/String;)Ljava/lang/Class;': (ctx, _self, name) => {
      const c = ctx.jvm.loader.loadBoot(internalName(jsStr(ctx.jvm, name)));
      return c ? ctx.jvm.mirror(c) : null;
    },
    'java/lang/ClassLoader.findLoadedClass0(Ljava/lang/String;)Ljava/lang/Class;': (ctx, self, name) => {
      if (name === null) return null;
      const c = ctx.jvm.loader.findLoaded(self as JObject, internalName(jsStr(ctx.jvm, name)));
      return c ? ctx.jvm.mirror(c) : null;
    },
    // Every library counts as linked into the VM, as in a statically linked JDK, so loadLibrary touches no files.
    'java/lang/ClassLoader.findBuiltinLib(Ljava/lang/String;)Ljava/lang/String;': (ctx, name) => {
      const m = /^lib(.+)\.so$/.exec(jsStr(ctx.jvm, name));
      return m ? ctx.jvm.heap.newString(m[1]!) : null;
    },
    'java/lang/ClassLoader.retrieveDirectives()Ljava/lang/AssertionStatusDirectives;': (ctx) => {
      const jvm = ctx.jvm;
      const d = jvm.heap.newObject(jvm.bootClass('java/lang/AssertionStatusDirectives'));
      const strings = jvm.bootClass('java/lang/String');
      const booleans = jvm.loader.primitive('Z');
      jvm.setField(d, 'classes', '[Ljava/lang/String;', jvm.newArray(strings, []));
      jvm.setField(d, 'packages', '[Ljava/lang/String;', jvm.newArray(strings, []));
      jvm.setField(d, 'classEnabled', '[Z', jvm.newArray(booleans, []));
      jvm.setField(d, 'packageEnabled', '[Z', jvm.newArray(booleans, []));
      return d;
    },
    'java/lang/ClassLoader$NativeLibrary.load(Ljava/lang/String;Z)V': (ctx, self) => {
      ctx.jvm.setField(self as JObject, 'handle', 'J', 1n);
      ctx.jvm.setField(self as JObject, 'jniVersion', 'I', 0x00010008);
      ctx.jvm.setField(self as JObject, 'loaded', 'Z', 1);
      return undefined;
    },
    'java/lang/ClassLoader$NativeLibrary.find(Ljava/lang/String;)J': () => 0n,
    'java/lang/ClassLoader$NativeLibrary.unload(Ljava/lang/String;Z)V': none,

    'java/lang/Compiler.registerNatives()V': none,
    'java/lang/Compiler.initialize()V': none,
    'java/lang/Compiler.compileClass(Ljava/lang/Class;)Z': () => 0,
    'java/lang/Compiler.compileClasses(Ljava/lang/String;)Z': () => 0,
    'java/lang/Compiler.command(Ljava/lang/Object;)Ljava/lang/Object;': () => null,
    'java/lang/Compiler.enable()V': none,
    'java/lang/Compiler.disable()V': none,

    // No package of the boot class path comes from a jar file Java could read a manifest from.
    'java/lang/Package.getSystemPackage0(Ljava/lang/String;)Ljava/lang/String;': () => null,
    'java/lang/Package.getSystemPackages0()[Ljava/lang/String;': (ctx) => ctx.jvm.newArray(ctx.jvm.bootClass('java/lang/String'), []),

    'java/lang/Shutdown.beforeHalt()V': none,
    // Runtime.halt: every thread ends and the status is kept for the host, which decides what exiting means.
    'java/lang/Shutdown.halt0(I)V': (ctx, status) => {
      ctx.jvm.exitStatus = status as number;
      ctx.jvm.threads.halt();
      return undefined;
    },

    'java/lang/SecurityManager.getClassContext()[Ljava/lang/Class;': (ctx) =>
      ctx.jvm.newArray(ctx.jvm.bootClass('java/lang/Class'), contextClasses(ctx.thread).map((c) => ctx.jvm.mirror(c))),
    'java/lang/SecurityManager.currentClassLoader0()Ljava/lang/ClassLoader;': (ctx) =>
      contextClasses(ctx.thread).find((c) => c.loader !== null)?.loader ?? null,
    'java/lang/SecurityManager.classDepth(Ljava/lang/String;)I': (ctx, _self, name) =>
      contextClasses(ctx.thread).findIndex((c) => c.name === internalName(jsStr(ctx.jvm, name))),
    'java/lang/SecurityManager.classLoaderDepth0()I': (ctx) => contextClasses(ctx.thread).findIndex((c) => c.loader !== null),
    'java/lang/SecurityManager.currentLoadedClass0()Ljava/lang/Class;': (ctx) => {
      const c = contextClasses(ctx.thread).find((k) => k.loader !== null);
      return c ? ctx.jvm.mirror(c) : null;
    },

    'java/security/AccessController.doPrivileged(Ljava/security/PrivilegedAction;)Ljava/lang/Object;': (ctx, a) =>
      doPrivileged(ctx.jvm, ctx.thread, a, 'java/security/PrivilegedAction'),
    'java/security/AccessController.doPrivileged(Ljava/security/PrivilegedAction;Ljava/security/AccessControlContext;)Ljava/lang/Object;': (ctx, a, c) =>
      doPrivileged(ctx.jvm, ctx.thread, a, 'java/security/PrivilegedAction', c),
    'java/security/AccessController.doPrivileged(Ljava/security/PrivilegedExceptionAction;)Ljava/lang/Object;': (ctx, a) =>
      doPrivileged(ctx.jvm, ctx.thread, a, 'java/security/PrivilegedExceptionAction'),
    'java/security/AccessController.doPrivileged(Ljava/security/PrivilegedExceptionAction;Ljava/security/AccessControlContext;)Ljava/lang/Object;': (ctx, a, c) =>
      doPrivileged(ctx.jvm, ctx.thread, a, 'java/security/PrivilegedExceptionAction', c),
    'java/security/AccessController.getStackAccessControlContext()Ljava/security/AccessControlContext;': (ctx) => stackAccessControlContext(ctx.jvm, ctx.thread),
    'java/security/AccessController.getInheritedAccessControlContext()Ljava/security/AccessControlContext;': (ctx) => {
      const t = ctx.thread.javaThread;
      return t ? ctx.jvm.getField(t, 'inheritedAccessControlContext', 'Ljava/security/AccessControlContext;') : null;
    },

    'java/util/TimeZone.getSystemTimeZoneID(Ljava/lang/String;)Ljava/lang/String;': (ctx) => ctx.jvm.heap.newString('UTC'),
    'java/util/TimeZone.getSystemGMTOffsetID()Ljava/lang/String;': (ctx) => ctx.jvm.heap.newString('GMT'),
    'java/util/concurrent/atomic/AtomicLong.VMSupportsCS8()Z': () => 1,
  });
}
