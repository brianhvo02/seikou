/*
 * Original code for bluray-web: java.io and sun.nio natives of the BD-J virtual machine over its Vfs. File
 * descriptors are integers kept in FileDescriptor.fd, each standing for a VfsHandle; 1 and 2 are the host's stdout
 * and stderr. Relative paths resolve against user.dir, which is /.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { Suspend, ThrowResult } from '../interpreter';
import type { NativeResult } from '../interpreter';
import type { Jvm } from '../jvm';
import type { Vfs, VfsHandle, VfsMode } from '../vfs';
import { JavaThrowable } from '../values';
import type { JArray, JObject, JValue } from '../values';
import type { NativeContext, NativeTable } from './index';
import { offHeap } from './unsafe';
import { byteArray, jsStr, none } from './util';

interface FdTable {
  readonly handles: Map<number, VfsHandle>;
  next: number;
  readonly decoders: Map<number, TextDecoder>;
}

const tables = new WeakMap<Jvm, FdTable>();

function fdTable(jvm: Jvm): FdTable {
  let t = tables.get(jvm);
  if (!t) tables.set(jvm, (t = { handles: new Map(), next: 3, decoders: new Map() }));
  return t;
}

/** A path as the process sees it, with user.dir (/) as the working directory. */
export const absolute = (path: string): string => (path === '' || path.startsWith('/') ? path : `/${path}`);

function canonicalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '' && seg !== '.') out.push(seg);
  }
  return `/${out.join('/')}`;
}

function vfsOf(jvm: Jvm): Vfs | null {
  return jvm.opts.vfs ?? null;
}

/** The absolute path of a java.io.File. */
function filePath(jvm: Jvm, f: JValue): string {
  return absolute(jsStr(jvm, jvm.getField(f as JObject, 'path', 'Ljava/lang/String;')));
}

/** The FileDescriptor of a stream or RandomAccessFile. */
function fdObject(jvm: Jvm, owner: JValue): JObject | null {
  return jvm.getField(owner as JObject, 'fd', 'Ljava/io/FileDescriptor;') as JObject | null;
}

function fdNumber(jvm: Jvm, fd: JObject | null): number {
  return fd === null ? -1 : (jvm.getField(fd, 'fd', 'I') as number);
}

function handleOfFd(jvm: Jvm, fd: JObject | null): VfsHandle | null {
  return fdTable(jvm).handles.get(fdNumber(jvm, fd)) ?? null;
}

function handleOf(jvm: Jvm, owner: JValue): VfsHandle | null {
  return handleOfFd(jvm, fdObject(jvm, owner));
}

/** The reason open(2) would give, for FileNotFoundException's "<path> (<reason>)". */
function openFailure(vfs: Vfs | null, path: string, write: boolean): string {
  const st = vfs?.stat(path) ?? null;
  if (st?.kind === 'dir') return 'Is a directory';
  const parent = vfs?.stat(path.slice(0, path.lastIndexOf('/')) || '/') ?? null;
  if (parent?.kind !== 'dir') return 'No such file or directory';
  if (write && !vfs!.writable(path)) return 'Read-only file system';
  // a new file the storage scope's quota has no room for (its tar header, ruling R24), as open(2) on a full disk
  if (write && st === null && vfs!.quotaRefusesNewFile(path)) return 'No space left on device';
  return 'No such file or directory';
}

/** Opens `path` into the owner's FileDescriptor, or throws FileNotFoundException as the JDK's fileOpen does. */
export function openInto(ctx: NativeContext, owner: JValue, name: JValue, mode: VfsMode): NativeResult {
  const jvm = ctx.jvm;
  if (name === null) return jvm.throwNew('java/lang/NullPointerException');
  const path = jsStr(jvm, name);
  const abs = absolute(path);
  const vfs = vfsOf(jvm);
  const st = vfs?.stat(abs) ?? null;
  const h = st?.kind === 'dir' ? null : (vfs?.open(abs, mode) ?? null);
  if (!h) return jvm.throwNew('java/io/FileNotFoundException', `${path} (${openFailure(vfs, abs, mode !== 'r')})`);
  const fd = fdObject(jvm, owner);
  if (fd === null) return jvm.throwNew('java/lang/NullPointerException');
  const t = fdTable(jvm);
  const n = t.next++;
  t.handles.set(n, h);
  jvm.setField(fd, 'fd', 'I', n);
  return undefined;
}

function closeFd(jvm: Jvm, fd: JObject | null): void {
  if (fd === null) return;
  const n = fdNumber(jvm, fd);
  const t = fdTable(jvm);
  const h = t.handles.get(n);
  if (h) {
    vfsOf(jvm)?.close(h);
    t.handles.delete(n);
  }
  jvm.setField(fd, 'fd', 'I', -1);
}

function bytesOf(a: JValue): Uint8Array {
  const d = (a as JArray).data as Int8Array;
  return new Uint8Array(d.buffer, d.byteOffset, d.length);
}

function checkBounds(jvm: Jvm, b: JValue, off: number, len: number): NativeResult | null {
  if (b === null) return jvm.throwNew('java/lang/NullPointerException');
  if (off < 0 || len < 0 || off + len > ((b as JArray).data as Int8Array).length) return jvm.throwNew('java/lang/IndexOutOfBoundsException');
  return null;
}

/**
 * Suspends on a host read; a rejection (a removed file, an abort) becomes a Java exception of class `cls` in the
 * calling thread rather than a failure of the whole runtime, with `message` or else the JS error's message.
 */
export function suspendRead<T>(jvm: Jvm, read: Promise<T>, cls: string, k: (v: T) => NativeResult, message?: string): Suspend {
  let value: T;
  let failure: unknown = null;
  let failed = false;
  return new Suspend(
    read.then(
      (v) => void (value = v),
      (e: unknown) => void ((failed = true), (failure = e)),
    ),
    (r) => {
      if (r instanceof ThrowResult) return r;
      if (!failed) return k(value);
      if (failure instanceof JavaThrowable) return new ThrowResult(failure.obj);
      return jvm.throwNew(cls, message ?? (failure instanceof Error ? failure.message : String(failure)));
    },
  );
}

/** read(2) into `out`; -1 at end of file. Disc reads suspend the thread. */
function readHandle(jvm: Jvm, h: VfsHandle, out: Uint8Array, off: number, len: number, k: (n: number) => NativeResult = (n) => n): NativeResult {
  const r = vfsOf(jvm)!.read(h, out, off, len);
  return typeof r === 'number' ? k(r) : suspendRead(jvm, r, 'java/io/IOException', k);
}

export function readBytes(ctx: NativeContext, self: JValue, b: JValue, off: JValue, len: JValue): NativeResult {
  const jvm = ctx.jvm;
  const bad = checkBounds(jvm, b, off as number, len as number);
  if (bad) return bad;
  if (len === 0) return 0;
  const h = handleOf(jvm, self);
  if (!h) return jvm.throwNew('java/io/IOException', 'Stream Closed');
  return readHandle(jvm, h, bytesOf(b), off as number, len as number);
}

function readByte(ctx: NativeContext, self: JValue): NativeResult {
  const jvm = ctx.jvm;
  const h = handleOf(jvm, self);
  if (!h) return jvm.throwNew('java/io/IOException', 'Stream Closed');
  const one = new Uint8Array(1);
  return readHandle(jvm, h, one, 0, 1, (n) => (n <= 0 ? -1 : one[0]!));
}

/** Writes to fd 1 and 2 go to the host's stdout and stderr, decoded as UTF-8 across write boundaries. */
function writeFd(jvm: Jvm, fd: JObject | null, bytes: Uint8Array): NativeResult {
  const n = fdNumber(jvm, fd);
  if (n === 1 || n === 2) {
    const t = fdTable(jvm);
    let d = t.decoders.get(n);
    if (!d) t.decoders.set(n, (d = new TextDecoder('utf-8')));
    const s = d.decode(bytes, { stream: true });
    if (s !== '') (n === 1 ? jvm.opts.stdout : jvm.opts.stderr)(s);
    return undefined;
  }
  const h = handleOfFd(jvm, fd);
  const vfs = vfsOf(jvm)!;
  // the memory mounts' limit (the memory profile's) is a full disk: write(2) fails with ENOSPC
  if (h && !vfs.fits(h, bytes.length)) return jvm.throwNew('java/io/IOException', NO_SPACE);
  if (!h || !vfs.write(h, bytes, 0, bytes.length)) return jvm.throwNew('java/io/IOException', 'Bad file descriptor');
  return undefined;
}

/** strerror(ENOSPC), as the JDK's write and ftruncate failures report it. */
const NO_SPACE = 'No space left on device';

/** RandomAccessFile.setLength and FileChannel.truncate: ftruncate. */
function truncateFd(jvm: Jvm, h: VfsHandle | null, len: bigint): NativeResult | null {
  const vfs = vfsOf(jvm)!;
  if (h?.writable && !vfs.fitsLength(h, Number(len))) return jvm.throwNew('java/io/IOException', NO_SPACE);
  return h && vfs.truncate(h, Number(len)) ? null : jvm.throwNew('java/io/IOException', 'Bad file descriptor');
}

function writeBytes(ctx: NativeContext, self: JValue, b: JValue, off: JValue, len: JValue): NativeResult {
  const bad = checkBounds(ctx.jvm, b, off as number, len as number);
  if (bad) return bad;
  return writeFd(ctx.jvm, fdObject(ctx.jvm, self), bytesOf(b).subarray(off as number, (off as number) + (len as number)));
}

const BA_EXISTS = 0x01;
const BA_REGULAR = 0x02;
const BA_DIRECTORY = 0x04;
const ACCESS_WRITE = 0x02;
const SPACE_TOTAL = 0;
const O_RDWR = 2;

export function closeStream(ctx: NativeContext, self: JValue): number {
  closeFd(ctx.jvm, fdObject(ctx.jvm, self));
  return 0;
}

/** Off-heap memory at `address` as bytes, for FileChannel's direct-buffer reads and writes. */
function memory(jvm: Jvm, address: JValue, len: number): Uint8Array | null {
  const b = offHeap(jvm, address as bigint, len);
  return b ? new Uint8Array(b.view.buffer, b.view.byteOffset + b.offset, len) : null;
}

export function registerIoNatives(natives: NativeTable): void {
  natives.register({
    'java/io/FileDescriptor.initIDs()V': none,
    'java/io/FileDescriptor.sync()V': none,
    'java/io/ObjectStreamClass.initNative()V': none,
    'java/io/ObjectStreamClass.hasStaticInitializer(Ljava/lang/Class;)Z': (ctx, c) =>
      ctx.jvm.classOf(c as JObject).methods.has('<clinit>()V') ? 1 : 0,
    'java/io/Console.istty()Z': () => 0,
    'java/io/Console.encoding()Ljava/lang/String;': () => null,
    'java/io/Console.echo(Z)Z': () => 1,

    'java/io/UnixFileSystem.initIDs()V': none,
    'java/io/UnixFileSystem.canonicalize0(Ljava/lang/String;)Ljava/lang/String;': (ctx, _self, path) => {
      if (path === null) return ctx.jvm.throwNew('java/lang/NullPointerException');
      return ctx.jvm.heap.newString(canonicalize(absolute(jsStr(ctx.jvm, path))));
    },
    'java/io/UnixFileSystem.getBooleanAttributes0(Ljava/io/File;)I': (ctx, _self, f) => {
      if (f === null) return ctx.jvm.throwNew('java/lang/NullPointerException');
      const st = vfsOf(ctx.jvm)?.stat(filePath(ctx.jvm, f)) ?? null;
      return st === null ? 0 : BA_EXISTS | (st.kind === 'dir' ? BA_DIRECTORY : BA_REGULAR);
    },
    'java/io/UnixFileSystem.checkAccess(Ljava/io/File;I)Z': (ctx, _self, f, access) => {
      const path = filePath(ctx.jvm, f);
      const vfs = vfsOf(ctx.jvm);
      if (!vfs?.stat(path)) return 0;
      return ((access as number) & ACCESS_WRITE) !== 0 && !vfs.writable(path) ? 0 : 1;
    },
    'java/io/UnixFileSystem.getLastModifiedTime(Ljava/io/File;)J': (ctx, _self, f) =>
      BigInt(Math.floor(vfsOf(ctx.jvm)?.stat(filePath(ctx.jvm, f))?.mtimeMs ?? 0)),
    'java/io/UnixFileSystem.getLength(Ljava/io/File;)J': (ctx, _self, f) => BigInt(vfsOf(ctx.jvm)?.stat(filePath(ctx.jvm, f))?.size ?? 0),
    'java/io/UnixFileSystem.setPermission(Ljava/io/File;IZZ)Z': (ctx, _self, f) => (vfsOf(ctx.jvm)?.stat(filePath(ctx.jvm, f)) ? 1 : 0),
    'java/io/UnixFileSystem.setReadOnly(Ljava/io/File;)Z': (ctx, _self, f) => (vfsOf(ctx.jvm)?.stat(filePath(ctx.jvm, f)) ? 1 : 0),
    'java/io/UnixFileSystem.setLastModifiedTime(Ljava/io/File;J)Z': (ctx, _self, f, time) =>
      vfsOf(ctx.jvm)?.setMtime(filePath(ctx.jvm, f), Number(time as bigint)) ? 1 : 0,
    'java/io/UnixFileSystem.createFileExclusively(Ljava/lang/String;)Z': (ctx, _self, name) => {
      const jvm = ctx.jvm;
      const path = absolute(jsStr(jvm, name));
      const vfs = vfsOf(jvm);
      if (vfs?.stat(path)) return 0;
      const h = vfs?.open(path, 'w') ?? null;
      if (!h) return jvm.throwNew('java/io/IOException', openFailure(vfs, path, true));
      vfs!.close(h);
      return 1;
    },
    'java/io/UnixFileSystem.delete0(Ljava/io/File;)Z': (ctx, _self, f) => (vfsOf(ctx.jvm)?.delete(filePath(ctx.jvm, f)) ? 1 : 0),
    'java/io/UnixFileSystem.list(Ljava/io/File;)[Ljava/lang/String;': (ctx, _self, f) => {
      const jvm = ctx.jvm;
      const names = vfsOf(jvm)?.list(filePath(jvm, f)) ?? null;
      return names === null ? null : jvm.newArray(jvm.bootClass('java/lang/String'), names.map((n) => jvm.heap.newString(n)));
    },
    'java/io/UnixFileSystem.createDirectory(Ljava/io/File;)Z': (ctx, _self, f) => (vfsOf(ctx.jvm)?.mkdir(filePath(ctx.jvm, f)) ? 1 : 0),
    'java/io/UnixFileSystem.rename0(Ljava/io/File;Ljava/io/File;)Z': (ctx, _self, a, b) =>
      vfsOf(ctx.jvm)?.rename(filePath(ctx.jvm, a), filePath(ctx.jvm, b)) ? 1 : 0,
    'java/io/UnixFileSystem.getSpace(Ljava/io/File;I)J': (ctx, _self, f, t) => {
      const path = filePath(ctx.jvm, f);
      const vfs = vfsOf(ctx.jvm);
      if (!vfs?.stat(path) || !vfs.writable(`${path}/x`)) return 0n;
      return t === SPACE_TOTAL ? 1n << 32n : 1n << 30n;
    },

    'java/io/FileInputStream.initIDs()V': none,
    'java/io/FileInputStream.open0(Ljava/lang/String;)V': (ctx, self, name) => openInto(ctx, self, name, 'r'),
    'java/io/FileInputStream.read0()I': readByte,
    'java/io/FileInputStream.readBytes([BII)I': readBytes,
    'java/io/FileInputStream.skip0(J)J': (ctx, self, n) => {
      const h = handleOf(ctx.jvm, self);
      if (!h) return ctx.jvm.throwNew('java/io/IOException', 'Stream Closed');
      const from = h.position;
      h.position = Math.max(0, from + Number(n as bigint));
      return BigInt(h.position - from);
    },
    'java/io/FileInputStream.available0()I': (ctx, self) => {
      const h = handleOf(ctx.jvm, self);
      if (!h) return ctx.jvm.throwNew('java/io/IOException', 'Stream Closed');
      return Math.max(0, Math.min(0x7fffffff, h.size() - h.position));
    },
    'java/io/FileInputStream.close0()V': (ctx, self) => void closeStream(ctx, self),

    'java/io/FileOutputStream.initIDs()V': none,
    'java/io/FileOutputStream.open0(Ljava/lang/String;Z)V': (ctx, self, name, append) => openInto(ctx, self, name, append ? 'a' : 'w'),
    'java/io/FileOutputStream.write(IZ)V': (ctx, self, b) => writeFd(ctx.jvm, fdObject(ctx.jvm, self), new Uint8Array([(b as number) & 0xff])),
    'java/io/FileOutputStream.writeBytes([BIIZ)V': writeBytes,
    'java/io/FileOutputStream.close0()V': (ctx, self) => void closeStream(ctx, self),

    'java/io/RandomAccessFile.initIDs()V': none,
    'java/io/RandomAccessFile.open0(Ljava/lang/String;I)V': (ctx, self, name, mode) =>
      openInto(ctx, self, name, ((mode as number) & O_RDWR) !== 0 ? 'rw' : 'r'),
    'java/io/RandomAccessFile.read0()I': readByte,
    'java/io/RandomAccessFile.readBytes([BII)I': readBytes,
    'java/io/RandomAccessFile.write0(I)V': (ctx, self, b) => writeFd(ctx.jvm, fdObject(ctx.jvm, self), new Uint8Array([(b as number) & 0xff])),
    'java/io/RandomAccessFile.writeBytes([BII)V': writeBytes,
    'java/io/RandomAccessFile.getFilePointer()J': (ctx, self) => {
      const h = handleOf(ctx.jvm, self);
      return h ? BigInt(h.position) : ctx.jvm.throwNew('java/io/IOException', 'Stream Closed');
    },
    'java/io/RandomAccessFile.seek0(J)V': (ctx, self, pos) => {
      const h = handleOf(ctx.jvm, self);
      if (!h) return ctx.jvm.throwNew('java/io/IOException', 'Stream Closed');
      h.position = Number(pos as bigint);
      return undefined;
    },
    'java/io/RandomAccessFile.length()J': (ctx, self) => {
      const h = handleOf(ctx.jvm, self);
      return h ? BigInt(h.size()) : ctx.jvm.throwNew('java/io/IOException', 'Stream Closed');
    },
    'java/io/RandomAccessFile.setLength(J)V': (ctx, self, len) => {
      return truncateFd(ctx.jvm, handleOf(ctx.jvm, self), len as bigint) ?? undefined;
    },
    'java/io/RandomAccessFile.close0()V': (ctx, self) => void closeStream(ctx, self),

    // FileChannel over the same descriptors; direct buffers are Unsafe's off-heap blocks.
    'sun/nio/ch/FileChannelImpl.initIDs()J': () => 4096n,
    'sun/nio/ch/FileDispatcherImpl.init()V': none,
    'sun/nio/ch/FileDispatcherImpl.lock0(Ljava/io/FileDescriptor;ZJJZ)I': () => 0,
    'sun/nio/ch/FileDispatcherImpl.release0(Ljava/io/FileDescriptor;JJ)V': none,
    'sun/nio/ch/FileDispatcherImpl.preClose0(Ljava/io/FileDescriptor;)V': none,
    'sun/nio/ch/FileDispatcherImpl.close0(Ljava/io/FileDescriptor;)V': (ctx, fd) => void closeFd(ctx.jvm, fd as JObject | null),
    'sun/nio/ch/FileDispatcherImpl.force0(Ljava/io/FileDescriptor;Z)I': () => 0,
    'sun/nio/ch/FileDispatcherImpl.size0(Ljava/io/FileDescriptor;)J': (ctx, fd) => {
      const h = handleOfFd(ctx.jvm, fd as JObject | null);
      return h ? BigInt(h.size()) : ctx.jvm.throwNew('java/io/IOException', 'Bad file descriptor');
    },
    'sun/nio/ch/FileDispatcherImpl.seek0(Ljava/io/FileDescriptor;J)J': (ctx, fd, pos) => {
      const h = handleOfFd(ctx.jvm, fd as JObject | null);
      if (!h) return ctx.jvm.throwNew('java/io/IOException', 'Bad file descriptor');
      if ((pos as bigint) >= 0n) h.position = Number(pos as bigint);
      return BigInt(h.position);
    },
    'sun/nio/ch/FileDispatcherImpl.truncate0(Ljava/io/FileDescriptor;J)I': (ctx, fd, len) => {
      return truncateFd(ctx.jvm, handleOfFd(ctx.jvm, fd as JObject | null), len as bigint) ?? 0;
    },
    'sun/nio/ch/FileDispatcherImpl.read0(Ljava/io/FileDescriptor;JI)I': (ctx, fd, address, len) => {
      const h = handleOfFd(ctx.jvm, fd as JObject | null);
      const mem = memory(ctx.jvm, address, len as number);
      if (!h || !mem) return ctx.jvm.throwNew('java/io/IOException', 'Bad file descriptor');
      return readHandle(ctx.jvm, h, mem, 0, len as number);
    },
    'sun/nio/ch/FileDispatcherImpl.write0(Ljava/io/FileDescriptor;JI)I': (ctx, fd, address, len) => {
      const mem = memory(ctx.jvm, address, len as number);
      if (!mem) return ctx.jvm.throwNew('java/io/IOException', 'Bad address');
      const r = writeFd(ctx.jvm, fd as JObject | null, mem);
      return r === undefined ? len : r;
    },
    'sun/nio/ch/FileKey.initIDs()V': none,
    'sun/nio/ch/FileKey.init(Ljava/io/FileDescriptor;)V': (ctx, self, fd) => {
      const h = handleOfFd(ctx.jvm, fd as JObject | null);
      let ino = 0;
      for (const ch of h?.path ?? '') ino = (Math.imul(ino, 31) + ch.charCodeAt(0)) | 0;
      ctx.jvm.setField(self as JObject, 'st_dev', 'J', 1n);
      ctx.jvm.setField(self as JObject, 'st_ino', 'J', BigInt(ino >>> 0));
      return undefined;
    },
    'sun/nio/ch/IOUtil.initIDs()V': none,
    'sun/nio/ch/IOUtil.iovMax()I': () => 16,
    'sun/nio/ch/IOUtil.fdLimit()I': () => 1024,
    'sun/nio/ch/IOUtil.fdVal(Ljava/io/FileDescriptor;)I': (ctx, fd) => fdNumber(ctx.jvm, fd as JObject | null),
    'sun/nio/ch/IOUtil.setfdVal(Ljava/io/FileDescriptor;I)V': (ctx, fd, v) => void ctx.jvm.setField(fd as JObject, 'fd', 'I', v),
    'sun/nio/ch/IOUtil.randomBytes([B)Z': () => 0,
    'sun/nio/ch/IOUtil.configureBlocking(Ljava/io/FileDescriptor;Z)V': none,
    'sun/nio/ch/NativeThread.init()V': none,
    'sun/nio/ch/NativeThread.current()J': () => 0n,
    'sun/nio/ch/NativeThread.signal(J)V': none,
    'sun/nio/fs/UnixNativeDispatcher.init()I': () => 0,
    'sun/nio/fs/UnixNativeDispatcher.getcwd()[B': (ctx) => byteArray(ctx.jvm, new Uint8Array([0x2f])),
  });
}

/** Reads a whole VFS file, suspending on disc reads; null when it is missing or a read fails. */
export function readVfsFile(vfs: Vfs, path: string, k: (bytes: Uint8Array | null) => NativeResult): NativeResult {
  const h = vfs.open(path, 'r');
  if (!h) return k(null);
  const out = new Uint8Array(h.size());
  let off = 0;
  const done = (bytes: Uint8Array | null): NativeResult => {
    vfs.close(h);
    return k(bytes);
  };
  const got = (n: number): NativeResult => {
    if (n <= 0) return done(null);
    off += n;
    return step();
  };
  const step = (): NativeResult => {
    while (off < out.length) {
      const r = vfs.read(h, out, off, out.length - off);
      if (typeof r !== 'number') {
        return new Suspend(
          r.catch(() => -1),
          (n) => (n instanceof ThrowResult ? n : got(n as number)),
        );
      }
      if (r <= 0) return done(null);
      off += r;
    }
    return done(out);
  };
  return step();
}
