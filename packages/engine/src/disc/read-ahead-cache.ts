/*
 * Original code for bluray-web: the on-disk read-ahead cache of a NAS disc (buffer first), in the Origin Private File
 * System.
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

/** The cache's folder in the origin's private file system; one folder per disc below it. */
export const CACHE_DIR = 'read-ahead';
/** A disc's cache is cleared once it is this old (counted from its first byte). */
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Each file's bytes are kept in segments of this size, each in its own file, so what playback has passed can be freed
 * a segment at a time: the cache holds about the lead ahead of the play position, plus a segment or two.
 */
export const SEGMENT_BYTES = 64 * 1024 * 1024;
const META = 'meta.json';

export interface ReadAheadCacheDeps {
  /** The origin's private file system (navigator.storage.getDirectory()), or a stand-in. */
  readonly root: () => Promise<FileSystemDirectoryHandle>;
  /** Epoch ms. */
  readonly now: () => number;
  /**
   * The size of each of the disc's files (the manifest's): it is part of the cached files' names, so bytes kept for a
   * file that has since changed size are never served, and are removed at open.
   */
  readonly fileSize: (path: string) => number | undefined;
  /** SEGMENT_BYTES by default (tests use smaller). */
  readonly segmentBytes?: number;
}

export interface ByteRange {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

/** The part of FileSystemSyncAccessHandle used here (dedicated workers only). */
interface SyncHandle {
  read(buffer: Uint8Array, opts: { at: number }): number;
  write(buffer: Uint8Array, opts: { at: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileHandle {
  createSyncAccessHandle(): Promise<SyncHandle>;
}

interface DirHandle {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterable<string>;
}

/** One segment's files: its bytes (at offsets from the segment's start) and the ranges it holds (a JSON index). */
interface Segment {
  readonly data: SyncHandle;
  readonly index: SyncHandle;
}

/** What is held of one disc file: merged [start, end) ranges in file offsets, and which segments have files. */
interface Held {
  ranges: Array<[number, number]>;
  readonly segments: Set<number>;
}

/**
 * Byte ranges of one disc's files, kept on disk so the bytes needed to play straight through can be fetched ahead of
 * time. Written through sync access handles, so it runs in a dedicated worker (the engine's). What it holds is known
 * in memory from the open on, so the questions about it (has, coveredEnd, heldBytes) are answered at once.
 */
export class ReadAheadCache {
  /** Each segment's open files, by segment file name. */
  private readonly segments = new Map<string, Promise<Segment>>();
  private readonly held = new Map<string, Held>();
  private readonly segmentBytes: number;
  private closed = false;
  private creating: Promise<void> | null = null;

  private constructor(
    private readonly top: DirHandle,
    private readonly name: string,
    private dir: DirHandle,
    private readonly deps: ReadAheadCacheDeps,
    /** When the disc's cache got its first byte (meta.json), or null. */
    private created: number | null,
  ) {
    this.segmentBytes = deps.segmentBytes ?? SEGMENT_BYTES;
  }

  static async open(discId: string, deps: ReadAheadCacheDeps): Promise<ReadAheadCache> {
    const root = (await deps.root()) as unknown as DirHandle;
    const top = await root.getDirectoryHandle(CACHE_DIR, { create: true });
    const name = safeName(discId);
    const dir = await top.getDirectoryHandle(name, { create: true });
    const meta = await readJson(dir, META);
    const cache = new ReadAheadCache(top, name, dir, deps, createdOf(meta));
    await cache.load();
    return cache;
  }

  /** Removes every disc's cache (a disc not on the NAS opened). */
  static async clearAll(root: () => Promise<FileSystemDirectoryHandle>): Promise<void> {
    const dir = (await root()) as unknown as DirHandle;
    await dir.removeEntry(CACHE_DIR, { recursive: true }).catch(() => undefined); // none yet, or in use
  }

  /** Removes every disc's cache that is over 24 hours old (the engine worker's start). */
  static async clearExpired(root: () => Promise<FileSystemDirectoryHandle>, now: number): Promise<void> {
    let top: DirHandle;
    try {
      top = await ((await root()) as unknown as DirHandle).getDirectoryHandle(CACHE_DIR);
    } catch {
      return; // none yet
    }
    const names: string[] = [];
    for await (const name of top.keys()) names.push(name);
    for (const name of names) {
      try {
        const created = createdOf(await readJson(await top.getDirectoryHandle(name), META));
        if (created !== null && now - created > CACHE_MAX_AGE_MS) await top.removeEntry(name, { recursive: true });
      } catch {
        // in use by another tab, or not a disc's folder
      }
    }
  }

  /** Removes every other disc's cache, and this disc's once it is over 24 hours old. */
  async clearOthers(): Promise<void> {
    const others: string[] = [];
    for await (const entry of this.top.keys()) if (entry !== this.name) others.push(entry);
    for (const other of others) await this.top.removeEntry(other, { recursive: true }).catch(() => undefined);
    if (this.created !== null && this.deps.now() - this.created > CACHE_MAX_AGE_MS) {
      this.closeSegments();
      this.held.clear();
      this.created = null;
      await this.top.removeEntry(this.name, { recursive: true });
      this.dir = await this.top.getDirectoryHandle(this.name, { create: true });
    }
  }

  /** Stores `bytes` at `offset` of `path`. */
  async write(path: string, offset: number, bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    if (this.closed) throw closedError();
    const size = this.deps.fileSize(path);
    if (size === undefined) throw new Error(`${path} is not on the disc`);
    if (this.created === null) {
      // the first byte dates the cache (meta.json); writes at once share the one write of it
      this.creating ??= (async () => {
        const created = this.deps.now();
        await writeJson(this.dir, META, { created });
        this.created = created;
      })().finally(() => (this.creating = null));
      await this.creating;
    }
    const held = this.heldOf(path);
    for (let at = offset; at < offset + bytes.length; ) {
      // the disc may have closed while this write waited (on meta.json or the last segment's open)
      if (this.closed) throw closedError();
      const seg = Math.floor(at / this.segmentBytes);
      const segStart = seg * this.segmentBytes;
      const end = Math.min(offset + bytes.length, segStart + this.segmentBytes);
      const segment = await this.segment(path, size, seg);
      if (this.closed) throw closedError();
      segment.data.write(bytes.subarray(at - offset, end - offset), { at: at - segStart });
      segment.data.flush();
      held.segments.add(seg);
      held.ranges = addRange(held.ranges, at, end);
      const json = new TextEncoder().encode(JSON.stringify(clip(held.ranges, segStart, segStart + this.segmentBytes)));
      segment.index.truncate(0);
      segment.index.write(json, { at: 0 });
      segment.index.flush();
      at = end;
    }
  }

  /** The bytes of `path` at `offset`, or null unless all `length` of them are held. */
  async read(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    const size = this.deps.fileSize(path);
    if (this.closed || size === undefined || !this.has(path, offset, length)) return null;
    const out = new Uint8Array(length);
    for (let at = offset; at < offset + length; ) {
      if (this.closed) return null;
      const seg = Math.floor(at / this.segmentBytes);
      const segStart = seg * this.segmentBytes;
      const end = Math.min(offset + length, segStart + this.segmentBytes);
      const segment = await this.segment(path, size, seg).catch((err: unknown) => {
        if (this.closed) return null;
        throw err;
      });
      if (segment === null || this.closed) return null;
      const part = out.subarray(at - offset, end - offset);
      if (segment.data.read(part, { at: at - segStart }) !== part.length) return null;
      at = end;
    }
    return out;
  }

  /** Whether all of `offset`..`offset + length` of `path` is held. */
  has(path: string, offset: number, length: number): boolean {
    const end = this.coveredEnd(path, offset);
    return end !== null && end >= offset + length;
  }

  /** The end of the held run of `path` that `offset` is in, or null when `offset` isn't held. */
  coveredEnd(path: string, offset: number): number | null {
    for (const [s, e] of this.held.get(path)?.ranges ?? []) if (s <= offset && offset < e) return e;
    return null;
  }

  /** How many bytes of `path` between `start` and `end` are held. */
  heldBytes(path: string, start: number, end: number): number {
    let sum = 0;
    for (const [s, e] of this.held.get(path)?.ranges ?? []) sum += Math.max(0, Math.min(e, end) - Math.max(s, start));
    return sum;
  }

  /** Frees every segment that overlaps none of `keep` (what is still ahead of the play position). */
  async evictOutside(keep: readonly ByteRange[]): Promise<void> {
    for (const [path, held] of this.held) {
      const size = this.deps.fileSize(path) ?? 0;
      for (const seg of [...held.segments]) {
        const segStart = seg * this.segmentBytes;
        const segEnd = segStart + this.segmentBytes;
        if (keep.some((r) => r.path === path && r.start < segEnd && segStart < r.end)) continue;
        held.segments.delete(seg);
        held.ranges = subtract(held.ranges, segStart, segEnd);
        const base = segmentName(path, size, seg);
        const open = this.segments.get(base);
        this.segments.delete(base);
        const segment = await open?.catch(() => null);
        segment?.data.close();
        segment?.index.close();
        await this.dir.removeEntry(`${base}.bin`).catch(() => undefined);
        await this.dir.removeEntry(`${base}.json`).catch(() => undefined);
      }
    }
  }

  /** Lets go of the files (the disc closed); what is on disk stays for the next open of this disc. */
  close(): void {
    this.closed = true;
    this.closeSegments();
  }

  private closeSegments(): void {
    const open = [...this.segments.values()];
    this.segments.clear();
    for (const p of open) {
      p.then(
        (s) => {
          s.data.close();
          s.index.close();
        },
        () => undefined,
      );
    }
  }

  private heldOf(path: string): Held {
    let held = this.held.get(path);
    if (!held) {
      held = { ranges: [], segments: new Set() };
      this.held.set(path, held);
    }
    return held;
  }

  /** Reads what the disc's folder holds: each segment's index, for files still the manifest's size; the rest goes. */
  private async load(): Promise<void> {
    const names: string[] = [];
    for await (const name of this.dir.keys()) names.push(name);
    for (const name of names) {
      if (name === META) continue;
      const m = /^([A-Za-z0-9_-]+)\.(\d+)\.(\d+)\.(bin|json)$/.exec(name);
      const path = m ? unsafeName(m[1]!) : null;
      const current = path !== null && this.deps.fileSize(path) === Number(m![2]);
      if (!current) {
        await this.dir.removeEntry(name).catch(() => undefined); // stale (the file changed on the NAS) or unknown
        continue;
      }
      if (m![4] !== 'json') continue;
      const seg = Number(m![3]);
      const segStart = seg * this.segmentBytes;
      let ranges: Array<[number, number]> = [];
      try {
        const parsed: unknown = await readJson(this.dir, name);
        if (Array.isArray(parsed)) ranges = parsed.filter(isRange);
      } catch {
        ranges = []; // a damaged index holds nothing
      }
      // only what lies in the segment and inside the bytes written (a write cut short holds nothing past its end)
      const written = await this.dataSize(`${m![1]}.${m![2]}.${m![3]}.bin`);
      const held = this.heldOf(path!);
      for (const [s, e] of clip(ranges, segStart, segStart + Math.min(this.segmentBytes, written))) held.ranges = addRange(held.ranges, s, e);
      held.segments.add(seg);
    }
  }

  private async dataSize(name: string): Promise<number> {
    try {
      const handle = await (await this.dir.getFileHandle(name)).createSyncAccessHandle();
      try {
        return handle.getSize();
      } finally {
        handle.close();
      }
    } catch {
      return 0;
    }
  }

  /** A segment's files, opened once (made when missing). */
  private segment(path: string, size: number, seg: number): Promise<Segment> {
    const base = segmentName(path, size, seg);
    let opening = this.segments.get(base);
    if (!opening) {
      opening = this.openSegment(base);
      this.segments.set(base, opening);
      opening.catch(() => {
        if (this.segments.get(base) === opening) this.segments.delete(base); // a later call tries again
      });
    }
    return opening;
  }

  /**
   * Opens a segment's two files. When the disc closed meanwhile, `close()` has already let go of the segments it knew,
   * so the new handles are closed here (else they would hold the files until the worker ends) and the open fails.
   */
  private async openSegment(base: string): Promise<Segment> {
    if (this.closed) throw closedError();
    const data = await (await this.dir.getFileHandle(`${base}.bin`, { create: true })).createSyncAccessHandle();
    let index: SyncHandle;
    try {
      index = await (await this.dir.getFileHandle(`${base}.json`, { create: true })).createSyncAccessHandle();
    } catch (err) {
      data.close();
      throw err;
    }
    if (this.closed) {
      data.close();
      index.close();
      throw closedError();
    }
    return { data, index };
  }
}

function closedError(): DOMException {
  return new DOMException('the read-ahead cache is closed', 'InvalidStateError');
}

/** A file name for any id or path: letters, digits and '-' stay, every other UTF-8 byte becomes '_xx' (so '_' too). */
export function safeName(id: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(id)) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9-]/.test(c) ? c : `_${byte.toString(16).padStart(2, '0')}`;
  }
  return out || '_';
}

/** safeName's inverse, or null for a name it can't have made. */
export function unsafeName(name: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < name.length; i++) {
    if (name[i] === '_') {
      const hex = name.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/.test(hex)) return null;
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(name.charCodeAt(i));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/** A segment's file name without extension: the file's path, its size (so a changed file never matches) and the index. */
export function segmentName(path: string, size: number, seg: number): string {
  return `${safeName(path)}.${size}.${seg}`;
}

function createdOf(meta: unknown): number | null {
  return typeof meta === 'object' && meta !== null && typeof (meta as { created?: unknown }).created === 'number' ? (meta as { created: number }).created : null;
}

async function readJson(dir: DirHandle, name: string): Promise<unknown> {
  let handle: SyncHandle;
  try {
    handle = await (await dir.getFileHandle(name)).createSyncAccessHandle();
  } catch {
    return null;
  }
  try {
    const bytes = new Uint8Array(handle.getSize());
    handle.read(bytes, { at: 0 });
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  } finally {
    handle.close();
  }
}

async function writeJson(dir: DirHandle, name: string, value: unknown): Promise<void> {
  const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    handle.truncate(0);
    handle.write(new TextEncoder().encode(JSON.stringify(value)), { at: 0 });
    handle.flush();
  } finally {
    handle.close();
  }
}

function isRange(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && Number.isSafeInteger(v[0]) && Number.isSafeInteger(v[1]) && v[0] >= 0 && v[1] > v[0];
}

/** `ranges` with [start, end) added, merged with any range it overlaps or touches. */
function addRange(ranges: ReadonlyArray<[number, number]>, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = start;
  let e = end;
  let placed = false;
  for (const [rs, re] of ranges) {
    if (re < s) out.push([rs, re]);
    else if (rs > e) {
      if (!placed) {
        out.push([s, e]);
        placed = true;
      }
      out.push([rs, re]);
    } else {
      s = Math.min(s, rs);
      e = Math.max(e, re);
    }
  }
  if (!placed) out.push([s, e]);
  return out;
}

/** `ranges` without [start, end). */
function subtract(ranges: ReadonlyArray<[number, number]>, start: number, end: number): Array<[number, number]> {
  return ranges.flatMap(([s, e]): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    if (s < start) out.push([s, Math.min(e, start)]);
    if (e > end) out.push([Math.max(s, end), e]);
    return out;
  });
}

/** The parts of `ranges` inside [start, end). */
function clip(ranges: ReadonlyArray<[number, number]>, start: number, end: number): Array<[number, number]> {
  return ranges.flatMap(([s, e]): Array<[number, number]> => (Math.min(e, end) > Math.max(s, start) ? [[Math.max(s, start), Math.min(e, end)]] : []));
}
