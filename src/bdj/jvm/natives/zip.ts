/*
 * Original code for bluray-web: java.util.zip and java.util.jar natives of the BD-J virtual machine. ZipFile handles
 * stand for ZipArchives read whole from the Vfs; Inflater and Deflater handles for streams over zip.ts's inflateRaw
 * coroutine and DeflateEncoder, with the zlib wrapper (RFC 1950) when nowrap is false. The fields the JDK's C code
 * updates (off, len, finished, needDict, setParams) are updated the same way.
 *
 * Copyright (C) 2026 bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { NativeResult } from '../interpreter';
import type { Jvm } from '../jvm';
import type { Vfs } from '../vfs';
import { DeflateEncoder, ZipArchive, ZipError, adler32, crc32, inflateRaw } from '../zip';
import type { InflateCoroutine, ZipEntry } from '../zip';
import type { JArray, JObject, JValue } from '../values';
import type { NativeContext, NativeTable } from './index';
import { offHeap } from './unsafe';
import { byteArray, jsStr, none } from './util';
import { absolute, suspendRead } from './io';

interface ZipHandle {
  readonly archive: ZipArchive;
  byName: Map<string, ZipEntry> | null;
  /** The Vfs path it was opened from, and the ZipFile objects that have it open (zip_util's refs). */
  readonly path: string;
  refs: number;
  /** The file's size when opened; for a memory file, the buffer the archive reads (Vfs.peek). */
  readonly size: number;
  readonly peeked: Uint8Array | null;
}

interface Handles {
  next: bigint;
  readonly zips: Map<bigint, ZipHandle>;
  /** zip_util's cache of open zips: an open of a file that is open already, and unchanged, shares its handle. */
  readonly open: Map<string, bigint>;
  readonly entries: Map<bigint, ZipEntry>;
  readonly inflaters: Map<bigint, ZInflater>;
  readonly deflaters: Map<bigint, ZDeflater>;
}

const perVm = new WeakMap<Jvm, Handles>();

function handles(jvm: Jvm): Handles {
  let h = perVm.get(jvm);
  if (!h) perVm.set(jvm, (h = { next: 1n, zips: new Map(), open: new Map(), entries: new Map(), inflaters: new Map(), deflaters: new Map() }));
  return h;
}

/**
 * The zips Java has open (ZipFile objects sharing one count once) and the archive bytes they keep beyond the Vfs's own
 * (a memory or /jdk/ file's archive reads the Vfs's bytes), each buffer counted once (Jvm.memoryStats).
 */
export function openZipStats(jvm: Jvm): { readonly handles: number; readonly bytes: number } {
  const zips = perVm.get(jvm)?.zips;
  const vfsOwn = jvm.opts.vfs?.buffers() ?? new Set<ArrayBufferLike>();
  const buffers = new Set<ArrayBufferLike>();
  for (const z of zips?.values() ?? []) if (!vfsOwn.has(z.archive.bytes.buffer)) buffers.add(z.archive.bytes.buffer);
  let bytes = 0;
  for (const b of buffers) bytes += b.byteLength;
  return { handles: zips?.size ?? 0, bytes };
}

const latin1 = (b: Uint8Array): string => String.fromCharCode(...b);

/** The bytes of a Java byte[] range, as an unsigned view. */
function bytesOf(a: JValue, off = 0, len?: number): Uint8Array {
  const d = (a as JArray).data as Int8Array;
  return new Uint8Array(d.buffer, d.byteOffset + off, len ?? d.length - off);
}

function checkRange(jvm: Jvm, a: JValue, off: number, len: number): NativeResult | null {
  if (a === null) return jvm.throwNew('java/lang/NullPointerException');
  const n = ((a as JArray).data as Int8Array).length;
  if (off < 0 || len < 0 || off + len > n) return jvm.throwNew('java/lang/ArrayIndexOutOfBoundsException');
  return null;
}

/** A whole Vfs file; disc files arrive through a promise. */
function readWhole(vfs: Vfs, path: string): Uint8Array | Promise<Uint8Array> | null {
  const h = vfs.open(path, 'r');
  if (!h) return null;
  const out = new Uint8Array(h.size());
  const step = (pos: number): Uint8Array | Promise<Uint8Array> => {
    while (pos < out.length) {
      const r = vfs.read(h, out, pos, out.length - pos);
      if (typeof r !== 'number') return r.then((n) => (n <= 0 ? out.subarray(0, pos) : step(pos + n)));
      if (r <= 0) break;
      pos += r;
    }
    vfs.close(h);
    return out.subarray(0, pos);
  };
  return step(0);
}

const ZLIB_MESSAGES: Readonly<Record<string, string>> = {
  'inflate: invalid block type': 'invalid block type',
  'inflate: stored block length mismatch': 'invalid stored block lengths',
  'inflate: bad dynamic header': 'too many length or distance symbols',
  'inflate: over-subscribed Huffman code': 'invalid code lengths set',
  'inflate: incomplete Huffman code': 'invalid code lengths set',
  'inflate: repeat with no previous length': 'invalid bit length repeat',
  'inflate: too many code lengths': 'invalid bit length repeat',
  'inflate: no end-of-block code': 'invalid code -- missing end-of-block',
  'inflate: invalid Huffman code': 'invalid code lengths set',
  'inflate: invalid literal/length code': 'invalid literal/length code',
  'inflate: invalid length symbol': 'invalid literal/length code',
  'inflate: invalid distance symbol': 'invalid distance code',
  'inflate: distance too far back': 'invalid distance too far back',
};

class DataFormat extends Error {}

/** zlib's inflate over inflateRaw: the RFC 1950 header and Adler-32 trailer unless nowrap. */
class ZInflater {
  private raw: InflateCoroutine = inflateRaw();
  /** The bytes inflateRaw holds, of which its `remaining` are the unconsumed tail. */
  private window = new Uint8Array(0);
  private header: number[] = [];
  private trailer: number[] = [];
  /** Input not yet handed to the header, the body or the trailer. */
  private pend = new Uint8Array(0);
  private phase: 'header' | 'body' | 'trailer' | 'done';
  adler = 1;
  needDict = false;
  /** The Java buffer range the unconsumed bytes came from, so a repeated call does not feed them twice. */
  last: { buf: JValue; off: number; len: number } | null = null;

  constructor(readonly nowrap: boolean) {
    this.phase = nowrap ? 'body' : 'header';
  }

  get finished(): boolean {
    return this.phase === 'done';
  }

  /** Unconsumed input bytes, as zlib's avail_in counts them. */
  get remaining(): number {
    return this.pend.length + (this.phase === 'body' ? this.raw.remaining : 0);
  }

  give(input: Uint8Array): void {
    if (input.length === 0) return;
    const merged = new Uint8Array(this.pend.length + input.length);
    merged.set(this.pend);
    merged.set(input, this.pend.length);
    this.pend = merged;
  }

  inflate(out: Uint8Array, offset: number, length: number): number {
    if (this.phase === 'header') {
      while (this.header.length < 2 && this.pend.length > 0) {
        this.header.push(this.pend[0]!);
        this.pend = this.pend.subarray(1);
      }
      if (this.header.length < 2) return 0;
      const [cmf, flg] = this.header as [number, number];
      if (((cmf << 8) | flg) % 31 !== 0) throw new DataFormat('incorrect header check');
      if ((cmf & 15) !== 8) throw new DataFormat('unknown compression method');
      if ((cmf >> 4) + 8 > 15) throw new DataFormat('invalid window size');
      this.phase = 'body';
      if (flg & 0x20) {
        this.needDict = true;
        return 0;
      }
    }
    let n = 0;
    if (this.phase === 'body') {
      if (this.pend.length > 0) {
        const tail = this.window.subarray(this.window.length - this.raw.remaining);
        const merged = new Uint8Array(tail.length + this.pend.length);
        merged.set(tail);
        merged.set(this.pend, tail.length);
        this.window = merged;
        this.raw.push(this.pend);
        this.pend = new Uint8Array(0);
      }
      try {
        n = this.raw.pull(out, offset, length);
      } catch (e) {
        if (e instanceof ZipError) throw new DataFormat(ZLIB_MESSAGES[e.message] ?? e.message.replace(/^inflate: /, ''));
        throw e;
      }
      if (!this.nowrap) this.adler = adler32(out, offset, offset + n, this.adler);
      if (!this.raw.finished) return n;
      this.pend = this.window.slice(this.window.length - this.raw.remaining);
      this.window = new Uint8Array(0);
      this.phase = this.nowrap ? 'done' : 'trailer';
    }
    if (this.phase === 'trailer') {
      while (this.trailer.length < 4 && this.pend.length > 0) {
        this.trailer.push(this.pend[0]!);
        this.pend = this.pend.subarray(1);
      }
      if (this.trailer.length < 4) return n;
      const [a, b, c, d] = this.trailer as [number, number, number, number];
      if ((((a << 24) | (b << 16) | (c << 8) | d) >>> 0) !== this.adler) throw new DataFormat('incorrect data check');
      this.phase = 'done';
    }
    return n;
  }
}

class ZDeflater {
  enc: DeflateEncoder;
  private headerDone: boolean;
  private trailerDone = false;
  adler = 1;

  constructor(
    public level: number,
    readonly nowrap: boolean,
  ) {
    this.enc = new DeflateEncoder(level);
    this.headerDone = nowrap;
  }

  /** Output queued before and after the encoder's: the zlib header and trailer. */
  private head: number[] = [];
  private tail: number[] = [];

  /** Input arrived since the last flush. */
  dirty = false;

  write(data: Uint8Array): void {
    // zlib refuses input once finishing; the JDK does not check, so it is dropped here.
    if (this.trailerDone || this.enc.done) return;
    this.header();
    if (!this.nowrap) this.adler = adler32(data, 0, data.length, this.adler);
    this.enc.write(data);
    if (data.length > 0) this.dirty = true;
  }

  flush(): void {
    this.header();
    if (this.dirty) this.enc.flush();
    this.dirty = false;
  }

  private header(): void {
    if (!this.headerDone) {
      this.headerDone = true;
      const flevel = this.level === 0 || this.level === 1 ? 0 : this.level >= 2 && this.level <= 5 ? 1 : this.level === 9 ? 3 : 2;
      const cmf = 0x78;
      let flg = flevel << 6;
      flg += (31 - (((cmf << 8) | flg) % 31)) % 31;
      this.head.push(cmf, flg);
    }
  }

  finish(): void {
    this.header();
    this.enc.finish();
    if (!this.trailerDone) {
      this.trailerDone = true;
      if (this.nowrap) return;
      const a = this.adler;
      this.tail.push(a >>> 24, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff);
    }
  }

  get done(): boolean {
    return this.enc.done && this.head.length === 0 && this.tail.length === 0;
  }

  read(out: Uint8Array, offset: number, length: number): number {
    let n = 0;
    while (n < length && this.head.length > 0) out[offset + n++] = this.head.shift()!;
    n += this.enc.read(out, offset + n, length - n);
    if (this.enc.done) while (n < length && this.tail.length > 0) out[offset + n++] = this.tail.shift()!;
    return n;
  }
}

function zipException(jvm: Jvm, message: string): NativeResult {
  return jvm.throwNew('java/util/zip/ZipException', message);
}

function zipOf(ctx: NativeContext, h: JValue): ZipHandle | null {
  return handles(ctx.jvm).zips.get(h as bigint) ?? null;
}

function entryOf(ctx: NativeContext, h: JValue): ZipEntry {
  const e = handles(ctx.jvm).entries.get(h as bigint);
  if (!e) throw new Error(`no zip entry ${String(h)}`);
  return e;
}

function newEntryHandle(jvm: Jvm, e: ZipEntry): bigint {
  const h = handles(jvm);
  const id = h.next++;
  h.entries.set(id, e);
  return id;
}

function isMetaName(name: string): boolean {
  return name.length >= 9 && name.slice(0, 9).toUpperCase() === 'META-INF/';
}

export function registerZipNatives(natives: NativeTable): void {
  natives.register({
    'java/util/zip/ZipFile.initIDs()V': none,
    'java/util/zip/ZipFile.open(Ljava/lang/String;IJZ)J': (ctx, name) => {
      const jvm = ctx.jvm;
      if (name === null) return jvm.throwNew('java/lang/NullPointerException');
      const vfs = jvm.opts.vfs;
      const path = absolute(jsStr(jvm, name));
      const h = handles(jvm);
      // ZIP_Get_From_Cache: the same file, unchanged since (a memory file's peeked buffer is never written again)
      const peeked = vfs?.peek(path) ?? null;
      const cachedId = h.open.get(path);
      const cached = cachedId === undefined ? undefined : h.zips.get(cachedId);
      if (cachedId !== undefined && cached && vfs) {
        const same = peeked
          ? cached.peeked !== null && cached.peeked.buffer === peeked.buffer && cached.peeked.byteOffset === peeked.byteOffset && cached.peeked.length === peeked.length
          : cached.peeked === null && vfs.stat(path)?.size === cached.size;
        if (same) {
          cached.refs++;
          return cachedId;
        }
      }
      const data = peeked ?? (vfs ? readWhole(vfs, path) : null);
      const open = (bytes: Uint8Array | null): NativeResult => {
        if (bytes === null) return zipException(jvm, 'No such file or directory');
        if (bytes.length === 0) return zipException(jvm, 'zip file is empty');
        let archive: ZipArchive;
        try {
          archive = ZipArchive.open(bytes);
        } catch (e) {
          if (!(e instanceof ZipError)) throw e;
          return zipException(jvm, e.message.includes('end of central directory') ? 'zip END header not found' : 'invalid CEN header (bad signature)');
        }
        const id = h.next++;
        h.zips.set(id, { archive, byName: null, path, refs: 1, size: bytes.length, peeked });
        h.open.set(path, id);
        return id;
      };
      // A read error leaves zip_util's message unset, so the JDK's ZipFile.open throws its generic ZipException.
      return data instanceof Promise ? suspendRead(jvm, data, 'java/util/zip/ZipException', open, 'error in opening zip file') : open(data);
    },
    'java/util/zip/ZipFile.getTotal(J)I': (ctx, h) => zipOf(ctx, h)?.archive.list.length ?? 0,
    'java/util/zip/ZipFile.startsWithLOC(J)Z': (ctx, h) => (zipOf(ctx, h)?.archive.startsWithLoc ? 1 : 0),
    'java/util/zip/ZipFile.getManifestNum(J)I': (ctx, h) =>
      zipOf(ctx, h)?.archive.list.filter((e) => e.name.toUpperCase() === 'META-INF/MANIFEST.MF').length ?? 0,
    'java/util/zip/ZipFile.getEntry(J[B)J': (ctx, h, name) => {
      const z = zipOf(ctx, h);
      if (!z || name === null) return 0n;
      if (!z.byName) {
        z.byName = new Map();
        for (const e of z.archive.list) if (!z.byName.has(latin1(e.nameBytes))) z.byName.set(latin1(e.nameBytes), e);
      }
      const e = z.byName.get(latin1(bytesOf(name)));
      return e ? newEntryHandle(ctx.jvm, e) : 0n;
    },
    'java/util/zip/ZipFile.getNextEntry(JI)J': (ctx, h, i) => {
      const e = zipOf(ctx, h)?.archive.list[i as number];
      return e ? newEntryHandle(ctx.jvm, e) : 0n;
    },
    'java/util/zip/ZipFile.freeEntry(JJ)V': (ctx, _h, e) => void handles(ctx.jvm).entries.delete(e as bigint),
    'java/util/zip/ZipFile.getEntryTime(J)J': (ctx, e) => BigInt(entryOf(ctx, e).dosTime),
    'java/util/zip/ZipFile.getEntryCrc(J)J': (ctx, e) => BigInt(entryOf(ctx, e).crc),
    'java/util/zip/ZipFile.getEntryCSize(J)J': (ctx, e) => BigInt(entryOf(ctx, e).compressedSize),
    'java/util/zip/ZipFile.getEntrySize(J)J': (ctx, e) => BigInt(entryOf(ctx, e).size),
    'java/util/zip/ZipFile.getEntryMethod(J)I': (ctx, e) => entryOf(ctx, e).method,
    'java/util/zip/ZipFile.getEntryFlag(J)I': (ctx, e) => entryOf(ctx, e).flag,
    'java/util/zip/ZipFile.getEntryBytes(JI)[B': (ctx, e, type) => {
      const entry = entryOf(ctx, e);
      const b = type === 0 ? entry.nameBytes : type === 1 ? entry.extra : entry.comment;
      return type !== 0 && b.length === 0 ? null : byteArray(ctx.jvm, b);
    },
    'java/util/zip/ZipFile.getCommentBytes(J)[B': (ctx, h) => {
      const c = zipOf(ctx, h)?.archive.comment;
      return c && c.length > 0 ? byteArray(ctx.jvm, c) : null;
    },
    'java/util/zip/ZipFile.read(JJJ[BII)I': (ctx, h, e, pos, b, off, len) => {
      const z = zipOf(ctx, h);
      const bad = checkRange(ctx.jvm, b, off as number, len as number);
      if (bad) return bad;
      if (!z) return zipException(ctx.jvm, 'ZipFile closed');
      let raw: Uint8Array;
      try {
        raw = z.archive.raw(entryOf(ctx, e));
      } catch (err) {
        if (err instanceof ZipError) return zipException(ctx.jvm, 'invalid LOC header (bad signature)');
        throw err;
      }
      const p = Number(pos as bigint);
      if (p < 0 || p > raw.length - 1) return zipException(ctx.jvm, 'ZIP_Read: specified offset out of range');
      const n = Math.min(len as number, raw.length - p);
      bytesOf(b).set(raw.subarray(p, p + n), off as number);
      return n;
    },
    // ZIP_Close: the archive goes once no ZipFile has it open
    'java/util/zip/ZipFile.close(J)V': (ctx, id) => {
      const h = handles(ctx.jvm);
      const z = h.zips.get(id as bigint);
      if (!z || --z.refs > 0) return;
      h.zips.delete(id as bigint);
      if (h.open.get(z.path) === id) h.open.delete(z.path);
    },
    'java/util/zip/ZipFile.getZipMessage(J)Ljava/lang/String;': () => null,
    'java/util/jar/JarFile.getMetaInfEntryNames()[Ljava/lang/String;': (ctx, self) => {
      const jvm = ctx.jvm;
      const z = zipOf(ctx, jvm.getField(self as JObject, 'jzfile', 'J'));
      const names = z?.archive.list.filter((e) => isMetaName(e.name)).map((e) => jvm.heap.newString(e.name)) ?? [];
      return names.length === 0 ? null : jvm.newArray(jvm.bootClass('java/lang/String'), names);
    },

    'java/util/zip/Inflater.initIDs()V': none,
    'java/util/zip/Inflater.init(Z)J': (ctx, nowrap) => {
      const h = handles(ctx.jvm);
      const id = h.next++;
      h.inflaters.set(id, new ZInflater(nowrap === 1));
      return id;
    },
    'java/util/zip/Inflater.setDictionary(J[BII)V': (ctx) => ctx.jvm.throwNew('java/lang/IllegalArgumentException', 'preset dictionaries are not supported'),
    'java/util/zip/Inflater.inflateBytes(J[BII)I': (ctx, self, addr, b, off, len) => {
      const jvm = ctx.jvm;
      const bad = checkRange(jvm, b, off as number, len as number);
      if (bad) return bad;
      const inf = handles(jvm).inflaters.get(addr as bigint);
      if (!inf) return jvm.throwNew('java/lang/NullPointerException');
      const o = self as JObject;
      const buf = jvm.getField(o, 'buf', '[B');
      const inOff = jvm.getField(o, 'off', 'I') as number;
      const inLen = jvm.getField(o, 'len', 'I') as number;
      const last = inf.last;
      if (!(last && last.buf === buf && last.off === inOff && last.len === inLen && inf.remaining === inLen) && inLen > 0 && buf !== null) {
        inf.give(bytesOf(buf, inOff, inLen).slice());
      }
      let n: number;
      try {
        n = inf.inflate(bytesOf(b), off as number, len as number);
      } catch (e) {
        if (e instanceof DataFormat) return jvm.throwNew('java/util/zip/DataFormatException', e.message);
        throw e;
      }
      const consumed = Math.max(0, inLen - inf.remaining);
      jvm.setField(o, 'off', 'I', inOff + consumed);
      jvm.setField(o, 'len', 'I', inLen - consumed);
      inf.last = { buf, off: inOff + consumed, len: inLen - consumed };
      if (inf.finished) jvm.setField(o, 'finished', 'Z', 1);
      if (inf.needDict) jvm.setField(o, 'needDict', 'Z', 1);
      return n;
    },
    'java/util/zip/Inflater.getAdler(J)I': (ctx, addr) => (handles(ctx.jvm).inflaters.get(addr as bigint)?.adler ?? 1) | 0,
    'java/util/zip/Inflater.reset(J)V': (ctx, addr) => {
      const h = handles(ctx.jvm);
      const inf = h.inflaters.get(addr as bigint);
      if (inf) h.inflaters.set(addr as bigint, new ZInflater(inf.nowrap));
    },
    'java/util/zip/Inflater.end(J)V': (ctx, addr) => void handles(ctx.jvm).inflaters.delete(addr as bigint),

    'java/util/zip/Deflater.initIDs()V': none,
    'java/util/zip/Deflater.init(IIZ)J': (ctx, level, _strategy, nowrap) => {
      const h = handles(ctx.jvm);
      const id = h.next++;
      h.deflaters.set(id, new ZDeflater(level as number, nowrap === 1));
      return id;
    },
    'java/util/zip/Deflater.setDictionary(J[BII)V': (ctx) => ctx.jvm.throwNew('java/lang/IllegalArgumentException', 'preset dictionaries are not supported'),
    'java/util/zip/Deflater.deflateBytes(J[BIII)I': (ctx, self, addr, b, off, len, flush) => {
      const jvm = ctx.jvm;
      const bad = checkRange(jvm, b, off as number, len as number);
      if (bad) return bad;
      const def = handles(jvm).deflaters.get(addr as bigint);
      if (!def) return jvm.throwNew('java/lang/NullPointerException');
      const o = self as JObject;
      if (jvm.getField(o, 'setParams', 'Z') === 1) {
        def.level = jvm.getField(o, 'level', 'I') as number;
        def.enc.level = def.level;
        jvm.setField(o, 'setParams', 'Z', 0);
        return 0;
      }
      const buf = jvm.getField(o, 'buf', '[B');
      const inOff = jvm.getField(o, 'off', 'I') as number;
      const inLen = jvm.getField(o, 'len', 'I') as number;
      if (inLen > 0 && buf !== null) def.write(bytesOf(buf, inOff, inLen));
      jvm.setField(o, 'off', 'I', inOff + inLen);
      jvm.setField(o, 'len', 'I', 0);
      if (jvm.getField(o, 'finish', 'Z') === 1) def.finish();
      else if (flush !== 0) def.flush();
      const n = def.read(bytesOf(b), off as number, len as number);
      if (def.done) jvm.setField(o, 'finished', 'Z', 1);
      return n;
    },
    'java/util/zip/Deflater.getAdler(J)I': (ctx, addr) => (handles(ctx.jvm).deflaters.get(addr as bigint)?.adler ?? 1) | 0,
    'java/util/zip/Deflater.reset(J)V': (ctx, addr) => {
      const h = handles(ctx.jvm);
      const def = h.deflaters.get(addr as bigint);
      if (def) h.deflaters.set(addr as bigint, new ZDeflater(def.level, def.nowrap));
    },
    'java/util/zip/Deflater.end(J)V': (ctx, addr) => void handles(ctx.jvm).deflaters.delete(addr as bigint),

    'java/util/zip/CRC32.update(II)I': (_ctx, crc, b) => crc32(new Uint8Array([(b as number) & 0xff]), 0, 1, (crc as number) >>> 0) | 0,
    'java/util/zip/CRC32.updateBytes(I[BII)I': (ctx, crc, b, off, len) =>
      checkRange(ctx.jvm, b, off as number, len as number) ?? crc32(bytesOf(b), off as number, (off as number) + (len as number), (crc as number) >>> 0) | 0,
    'java/util/zip/CRC32.updateByteBuffer(IJII)I': (ctx, crc, addr, off, len) => {
      const m = direct(ctx.jvm, addr as bigint, off as number, len as number);
      return m ? crc32(m, 0, m.length, (crc as number) >>> 0) | 0 : ctx.jvm.throwNew('java/lang/InternalError', 'bad direct buffer address');
    },
    'java/util/zip/Adler32.update(II)I': (_ctx, a, b) => adler32(new Uint8Array([(b as number) & 0xff]), 0, 1, (a as number) >>> 0) | 0,
    'java/util/zip/Adler32.updateBytes(I[BII)I': (ctx, a, b, off, len) =>
      checkRange(ctx.jvm, b, off as number, len as number) ?? adler32(bytesOf(b), off as number, (off as number) + (len as number), (a as number) >>> 0) | 0,
    'java/util/zip/Adler32.updateByteBuffer(IJII)I': (ctx, a, addr, off, len) => {
      const m = direct(ctx.jvm, addr as bigint, off as number, len as number);
      return m ? adler32(m, 0, m.length, (a as number) >>> 0) | 0 : ctx.jvm.throwNew('java/lang/InternalError', 'bad direct buffer address');
    },
  });
}

function direct(jvm: Jvm, addr: bigint, off: number, len: number): Uint8Array | null {
  const b = offHeap(jvm, addr + BigInt(off), len);
  return b ? new Uint8Array(b.view.buffer, b.view.byteOffset + b.offset, len) : null;
}
