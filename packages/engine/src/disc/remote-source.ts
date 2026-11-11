/*
 * Original code for Seikou: a disc on the NAS, read by byte ranges with sequential read-ahead.
 *
 * Copyright (C) 2026  Seikou contributors
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { DiscError, type ByteSource } from '@seikou/bdmv/byte-source';
import type { DiscManifest } from '@seikou/nas/nas-api';

/** Byte ranges of the disc's files (HttpTransport). Paths are the manifest's. */
export interface RangeTransport {
  /** The bytes of `path` from `offset`, at most `length` (fewer at the end of the file). */
  read(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** Uses a fresh session token for later requests. */
  setToken(token: string): void;
}

/** How a `RemoteSource` reads and how much it holds. */
export interface RemoteSourceOptions {
  /** Upper bound of the bytes held: chunks read ahead, in flight, and those kept from earlier reads. */
  readonly readAheadBytes: number;
  /** Size of one transport request. */
  readonly chunkBytes: number;
  /** Transport requests in flight at most while reading ahead. */
  readonly inFlight: number;
  /** A read has been pending for WAITING_AFTER_MS (true), and all such reads have landed (false). */
  readonly onWaiting?: (waiting: boolean) => void;
}

/** A read pending this long shows "Waiting for the NAS drive…" (spun-down disks take seconds to start). */
export const WAITING_AFTER_MS = 3_000;

/** Where chunks are looked for before the network: the disc's on-disk read-ahead cache (ReadAheadCache). */
export interface ChunkCache {
  /** The bytes, or null unless all of them are held. */
  read(path: string, offset: number, length: number): Promise<Uint8Array | null>;
  /** Stores bytes at `offset`. */
  write(path: string, offset: number, bytes: Uint8Array): Promise<void>;
  /** Whether all of the range is held. */
  has(path: string, offset: number, length: number): boolean;
}

interface Chunk {
  readonly key: string;
  readonly path: string;
  readonly index: number;
  readonly size: number;
  readonly controller: AbortController;
  readonly promise: Promise<Uint8Array>;
  bytes: Uint8Array | null;
  /** Counted in `fetching` until it lands, fails or is aborted. */
  pending: boolean;
  /** Reads waiting for this chunk; a chunk somebody waits for is never aborted or evicted. */
  waiters: number;
}

/**
 * ByteSource over a NAS disc. Files the manifest inlines are served from memory; the rest is read in chunks of
 * `chunkBytes`, aligned in each file. After every read the chunks that follow it are fetched ahead, `inFlight` at a
 * time, until `readAheadBytes` are held; a read elsewhere in the same file (a seek) aborts that read-ahead and starts
 * it again from there.
 * @example ../../examples/remote-source.ts#construct
 */
export class RemoteSource implements ByteSource {
  private readonly sizes = new Map<string, number>();
  private readonly inline = new Map<string, Uint8Array>();
  /** Fetched and in-flight chunks, least recently used first. */
  private readonly chunks = new Map<string, Chunk>();
  private held = 0;
  private fetching = 0;
  /** The last chunk of the last read: read-ahead continues after it. */
  private cursor: { readonly path: string; readonly index: number } | null = null;
  private waitingReads = 0;
  private closed = false;
  private cache: ChunkCache | null = null;
  private writeThrough: ((path: string, offset: number, bytes: Uint8Array) => void) | null = null;
  /** Reads waiting for a chunk still being fetched. */
  private readsWaiting = 0;
  /** Network requests of peeks still in flight (aborted on close). */
  private readonly peeking = new Set<AbortController>();
  /** Chunks the cache fill is fetching (fillChunk), by chunk key. */
  private readonly filling = new Map<string, Promise<Uint8Array>>();

  constructor(
    manifest: DiscManifest,
    private readonly transport: RangeTransport,
    private readonly opts: RemoteSourceOptions,
  ) {
    for (const f of manifest.files) this.sizes.set(f.path.toUpperCase(), f.size);
    for (const [path, base64] of Object.entries(manifest.inline)) this.inline.set(path.toUpperCase(), decodeBase64(base64));
  }

  /** Size of one range request; chunks are aligned to it in each file. */
  get chunkBytes(): number {
    return this.opts.chunkBytes;
  }

  /** Bytes held by the read-ahead cache, fetched or in flight. */
  get bufferedBytes(): number {
    return this.held;
  }

  /**
   * Bytes of `path` landed after the chunk of the last read (the reader holds that one), up to the first chunk not yet
   * landed, and whether they run to the end of the file. Nothing when the last read was in another file.
   * @example ../../examples/remote-source.ts#bufferedAhead
   */
  bufferedAhead(path: string): { bytes: number; toEnd: boolean } {
    const key = path.toUpperCase();
    const c = this.cursor;
    if (!c || c.path !== key) return { bytes: 0, toEnd: false };
    const count = Math.ceil((this.sizes.get(key) ?? 0) / this.opts.chunkBytes);
    let bytes = 0;
    let i = c.index + 1;
    for (; i < count; i++) {
      const chunk = this.chunks.get(chunkKey(key, i));
      if (!chunk?.bytes) break;
      bytes += chunk.size;
    }
    return { bytes, toEnd: i >= count };
  }

  /** Read-ahead (or a read) is still fetching; false once the budget is full or the file is read to its end. */
  get readingAhead(): boolean {
    return this.fetching > 0;
  }

  /**
   * Whether the manifest lists `path` (case-insensitive).
   * @example ../../examples/remote-source.ts#exists
   */
  exists(path: string): boolean {
    return this.sizes.has(path.toUpperCase());
  }

  /**
   * The size the manifest gives; throws `DiscError` `missing-file` for an unlisted path.
   * @example ../../examples/remote-source.ts#size
   */
  size(path: string): number {
    return this.get(path);
  }

  /**
   * The normalised (upper-case) paths of every file.
   * @example ../../examples/remote-source.ts#paths
   */
  paths(): string[] {
    return [...this.sizes.keys()];
  }

  /**
   * The names directly inside `dir`, sorted, upper case.
   * @example ../../examples/remote-source.ts#list
   */
  list(dir: string): string[] {
    const prefix = `${dir.toUpperCase().replace(/\/$/, '')}/`;
    const names: string[] = [];
    for (const key of this.sizes.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest !== '' && !rest.includes('/')) names.push(rest);
    }
    return names.sort();
  }

  /**
   * Passes a fresh session token to the transport.
   * @example ../../examples/remote-source.ts#setToken
   */
  setToken(token: string): void {
    this.transport.setToken(token);
  }

  /**
   * Chunks are read from `cache` when it holds them, before the network.
   * @example ../../examples/remote-source.ts#setCache
   */
  setCache(cache: ChunkCache | null): void {
    this.cache = cache;
  }

  /**
   * Fetches the chunk of `path` at `offset` (a chunk boundary) into the cache unless it holds it, and resolves with the
   * bytes that came over the network (0 when it was held). A read of that chunk meanwhile waits for this fetch rather
   * than fetching it again.
   * @example ../../examples/remote-source.ts#fillChunk
   */
  async fillChunk(path: string, offset: number, signal: AbortSignal): Promise<number> {
    const cache = this.cache;
    if (!cache) throw new Error('this disc has no read-ahead cache');
    const key = path.toUpperCase();
    const length = Math.min(this.opts.chunkBytes, this.get(path) - offset);
    if (length <= 0 || cache.has(key, offset, length)) return 0;
    const ck = chunkKey(key, Math.floor(offset / this.opts.chunkBytes));
    const fetching = this.transport.read(key, offset, length, signal).then(async (bytes) => {
      await cache.write(key, offset, bytes);
      return bytes;
    });
    this.filling.set(ck, fetching);
    try {
      return (await fetching).length;
    } finally {
      if (this.filling.get(ck) === fetching) this.filling.delete(ck);
    }
  }

  /** A read (playback's) is waiting for a chunk still being fetched: the cache fill steps back to one request. */
  get playbackWaiting(): boolean {
    return this.readsWaiting > 0;
  }

  /**
   * The chunk at `offset` of `path` is being fetched (by a read, read-ahead or the fill).
   * @example ../../examples/remote-source.ts#isFetching
   */
  isFetching(path: string, offset: number): boolean {
    const ck = chunkKey(path.toUpperCase(), Math.floor(offset / this.opts.chunkBytes));
    return this.chunks.get(ck)?.pending === true || this.filling.has(ck);
  }

  /**
   * While a fill follows playback (bufferFirst), every chunk read from the network is offered to `keep` (CacheFill.keep),
   * which stores it in the cache when the fill would have fetched it, so the fill doesn't fetch it again; the fill frees
   * it once playback has passed it. Null: nothing is kept.
   * @example ../../examples/remote-source.ts#setWriteThrough
   */
  setWriteThrough(keep: ((path: string, offset: number, bytes: Uint8Array) => void) | null): void {
    this.writeThrough = keep;
  }

  /**
   * Aborts every fetch and drops the cache (the disc was closed).
   * @example ../../examples/remote-source.ts#close
   */
  close(): void {
    this.closed = true;
    for (const c of this.chunks.values()) {
      if (!c.pending) continue;
      c.controller.abort(new DOMException('disc closed', 'AbortError'));
      this.settle(c);
    }
    for (const p of this.peeking) p.abort(new DOMException('disc closed', 'AbortError'));
    this.peeking.clear();
    this.chunks.clear();
    this.held = 0;
    this.cursor = null;
  }

  /**
   * The bytes at `offset`, at most `length` (fewer at the end of the file, none past it). Chunks come from memory, the
   * cache, the fill's in-flight fetch or the network, in that order, and the read starts read-ahead after its last
   * chunk. Throws `DiscError` `missing-file` for an unlisted path or `read-failed` once the source is closed, and passes on
   * the transport's errors.
   * @example ../../examples/remote-source.ts#read
   */
  read(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    return this.readRange(path, offset, length, signal, false);
  }

  /**
   * ByteSource.peek: from the chunks held when they cover the range, else exactly the range from the network, kept
   * nowhere. Either way no read-ahead starts and the read-ahead cursor stays put.
   * @example ../../examples/remote-source.ts#peek
   */
  async peek(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError(`invalid read offset ${offset} in ${path}`);
    const key = path.toUpperCase();
    const end = Math.min(offset + length, this.get(path));
    if (offset >= end || this.inline.has(key)) return this.readRange(path, offset, length, signal, true);
    const chunkBytes = this.opts.chunkBytes;
    let held = true;
    for (let i = Math.floor(offset / chunkBytes); i <= Math.floor((end - 1) / chunkBytes) && held; i++) held = this.chunks.has(chunkKey(key, i));
    if (held) return this.readRange(path, offset, length, signal, true);
    signal?.throwIfAborted();
    if (this.closed) throw new DiscError('read-failed', `Failed to read ${path}: the disc was closed`, [path]);
    const cache = this.cache;
    if (cache?.has(path, offset, end - offset)) {
      const cached = await cache.read(path, offset, end - offset).catch(() => null);
      if (cached) return cached;
    }
    // its own request, aborted by the caller's signal or by close() like a chunk's
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    this.peeking.add(controller);
    try {
      return await this.watched(this.transport.read(path, offset, end - offset, controller.signal), true);
    } finally {
      this.peeking.delete(controller);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * `reading` with the read's bookkeeping: counted in `readsWaiting` while it waits on the network (`onNetwork`), and
   * "Waiting for the NAS drive" (onWaiting) once it has taken WAITING_AFTER_MS.
   */
  private async watched<T>(reading: Promise<T>, onNetwork: boolean): Promise<T> {
    if (onNetwork) this.readsWaiting++;
    let waiting = false;
    const timer = setTimeout(() => {
      waiting = true;
      if (this.waitingReads++ === 0) this.opts.onWaiting?.(true);
    }, WAITING_AFTER_MS);
    try {
      return await reading;
    } finally {
      clearTimeout(timer);
      if (onNetwork) this.readsWaiting--;
      if (waiting && --this.waitingReads === 0) this.opts.onWaiting?.(false);
    }
  }

  private async readRange(path: string, offset: number, length: number, signal: AbortSignal | undefined, peek: boolean): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError(`invalid read offset ${offset} in ${path}`);
    const key = path.toUpperCase();
    const size = this.get(path);
    const end = Math.min(offset + length, size);
    if (offset >= end) return new Uint8Array(0);
    const inlined = this.inline.get(key);
    if (inlined) return inlined.slice(offset, end);
    signal?.throwIfAborted();
    if (this.closed) throw new DiscError('read-failed', `Failed to read ${path}: the disc was closed`, [path]);

    const chunkBytes = this.opts.chunkBytes;
    const first = Math.floor(offset / chunkBytes);
    const last = Math.floor((end - 1) / chunkBytes);
    if (!peek) {
      const c = this.cursor;
      const sequential = c !== null && c.path === key && (first === c.index || first === c.index + 1);
      if (c !== null && c.path === key && !sequential && !this.chunks.has(chunkKey(key, first))) this.abortReadAhead(key);
      this.cursor = { path: key, index: last };
    }

    const needed: Chunk[] = [];
    for (let i = first; i <= last; i++) {
      const chunk = this.chunk(key, i, size);
      chunk.waiters++;
      needed.push(chunk);
    }
    if (!peek) this.pump();

    try {
      const parts = await this.watched(abortable(Promise.all(needed.map((n) => n.promise)), signal), needed.some((n) => n.pending));
      const out = new Uint8Array(end - offset);
      let filled = 0;
      for (const [k, part] of parts.entries()) {
        const base = (first + k) * chunkBytes;
        const from = Math.max(offset - base, 0);
        const to = Math.min(end - base, part.length);
        if (to <= from) break; // the file was shorter than the manifest says
        out.set(part.subarray(from, to), filled);
        filled += to - from;
      }
      return filled === out.length ? out : out.subarray(0, filled);
    } finally {
      for (const n of needed) n.waiters--;
      this.trim();
    }
  }

  private get(path: string): number {
    const size = this.sizes.get(path.toUpperCase());
    if (size === undefined) throw new DiscError('missing-file', `Missing file ${path}`, [path]);
    return size;
  }

  /** The chunk, fetched now if it is not held; marked most recently used. */
  private chunk(path: string, index: number, fileSize: number): Chunk {
    const key = chunkKey(path, index);
    const held = this.chunks.get(key);
    if (held) {
      this.chunks.delete(key);
      this.chunks.set(key, held);
      return held;
    }
    return this.fetch(path, index, fileSize);
  }

  private fetch(path: string, index: number, fileSize: number): Chunk {
    const key = chunkKey(path, index);
    const start = index * this.opts.chunkBytes;
    const size = Math.min(this.opts.chunkBytes, fileSize - start);
    const controller = new AbortController();
    this.fetching++;
    const promise = this.readThrough(path, start, size, controller.signal);
    const chunk: Chunk = { key, path, index, size, controller, promise, bytes: null, pending: true, waiters: 0 };
    this.chunks.set(key, chunk);
    this.held += size;
    promise.then(
      (bytes) => {
        this.settle(chunk);
        chunk.bytes = bytes;
        this.pump();
      },
      () => {
        this.settle(chunk);
        this.drop(chunk); // a later read fetches it again and reports the failure
        this.pump();
      },
    );
    return chunk;
  }

  /** A chunk from the cache when it holds it, or from the fill fetching it, else from the network. */
  private async readThrough(path: string, start: number, size: number, signal: AbortSignal): Promise<Uint8Array> {
    const cache = this.cache;
    if (cache) {
      const cached = await cache.read(path, start, size).catch(() => null);
      signal.throwIfAborted();
      if (cached) return cached;
      const filling = this.filling.get(chunkKey(path, Math.floor(start / this.opts.chunkBytes)));
      const filled = filling ? await abortable(filling, signal).catch((err: unknown) => (signal.aborted ? Promise.reject(err) : null)) : null;
      if (filled) return filled;
    }
    const bytes = await this.transport.read(path, start, size, signal);
    if (cache) this.writeThrough?.(path, start, bytes);
    return bytes;
  }

  /** Starts read-ahead after the cursor while requests and the budget allow. */
  private pump(): void {
    const c = this.cursor;
    if (!c || this.closed) return;
    const fileSize = this.sizes.get(c.path) ?? 0;
    const count = Math.ceil(fileSize / this.opts.chunkBytes);
    const window = Math.floor(this.opts.readAheadBytes / this.opts.chunkBytes);
    for (let i = c.index + 1; i < count && i <= c.index + window && this.fetching < this.opts.inFlight; i++) {
      if (this.chunks.has(chunkKey(c.path, i))) continue;
      const size = Math.min(this.opts.chunkBytes, fileSize - i * this.opts.chunkBytes);
      if (this.held + size > this.opts.readAheadBytes) this.evict(this.opts.readAheadBytes - size, true);
      if (this.held + size > this.opts.readAheadBytes) return;
      this.fetch(c.path, i, fileSize);
    }
  }

  /** After a read: back within the budget, dropping what is not ahead of the cursor first. */
  private trim(): void {
    this.evict(this.opts.readAheadBytes, true);
    this.evict(this.opts.readAheadBytes, false);
  }

  /** Drops landed chunks nobody waits for, least recently used first, until at most `target` bytes are held. */
  private evict(target: number, onlyBehind: boolean): void {
    for (const chunk of [...this.chunks.values()]) {
      if (this.held <= target) return;
      if (!chunk.bytes || chunk.waiters > 0) continue;
      if (onlyBehind && this.isAhead(chunk)) continue;
      this.drop(chunk);
    }
  }

  private isAhead(chunk: Chunk): boolean {
    const c = this.cursor;
    return c !== null && chunk.path === c.path && chunk.index > c.index;
  }

  /** A seek: read-ahead of `path` that no read waits for is cancelled. */
  private abortReadAhead(path: string): void {
    for (const chunk of [...this.chunks.values()]) {
      if (chunk.path !== path || chunk.bytes || chunk.waiters > 0) continue;
      chunk.controller.abort(new DOMException('read-ahead cancelled by a seek', 'AbortError'));
      this.settle(chunk);
      this.drop(chunk);
    }
  }

  private settle(chunk: Chunk): void {
    if (!chunk.pending) return;
    chunk.pending = false;
    this.fetching--;
  }

  private drop(chunk: Chunk): void {
    if (this.chunks.get(chunk.key) !== chunk) return;
    this.chunks.delete(chunk.key);
    this.held -= chunk.size;
  }
}

function chunkKey(path: string, index: number): string {
  return `${path}\n${index}`;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** `promise`, or a rejection with the signal's reason once it aborts (the work behind the promise goes on). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
