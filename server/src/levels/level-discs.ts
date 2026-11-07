import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { DiscEntry, DiscManifest } from '../../../src/engine/disc/nas-api';
import type { UdfFile } from '@seikou/bdmv/udf';
import { IsoTrees, isoFileStream, isoUnchanged, readIsoFiles } from '../iso';
import type { Library } from '../library';
import { buildIsoManifest, buildManifest, discUnchanged, resolveDiscFile, resolveIsoFile } from '../manifest';
import { audioWireBps, PesCoreFilter } from './audio-core';
import type { ClipInput, ClipReader } from './encoder';
import { SOURCE_PACKET_BYTES } from './levels';

/** A stream file of a disc: what ffmpeg reads, how the server reads it, and its identity for the cache key. */
export interface ClipSource {
  readonly input: ClipInput;
  readonly read: ClipReader;
  readonly size: number;
  readonly mtimeMs: number;
  /** The file's size and mtime now (a stat of the resolved file), or null when it is gone: whether it was replaced. */
  stamp(): Promise<{ readonly size: number; readonly mtimeMs: number } | null>;
}

/** One disc's original files, as the level service reads them. Paths are disc-relative and upper-case. */
export interface LevelDiscSource {
  manifest(): Promise<DiscManifest>;
  /** A whole file (a CLPI or MPLS the manifest didn't inline), or null. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** Bytes [offset, offset + length) of a file, or null when it is missing. */
  readRange(path: string, offset: number, length: number): Promise<Buffer | null>;
  clip(path: string): Promise<ClipSource | null>;
}

/**
 * The rate an audio PID takes at a level, in source packets, from its first readable frame in `stream` (the head of a
 * clip): its PES packets are gathered in order, reduced to the core a level carries, and the first one `audioWireBps`
 * reads decides.
 */
export async function firstAudioBps(stream: Readable, pid: number, coding: number): Promise<number> {
  const filter = new PesCoreFilter(coding);
  let chunks: Uint8Array[] = [];
  let partial = new Uint8Array(0);
  let lastError: Error | null = null;
  const tryPes = (): number | null => {
    if (chunks.length === 0) return null;
    const size = chunks.reduce((n, c) => n + c.length, 0);
    let pes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      pes.set(c, at);
      at += c.length;
    }
    chunks = [];
    const declared = pes.length >= 6 ? (pes[4]! << 8) | pes[5]! : 0;
    if (declared) pes = pes.subarray(0, 6 + declared);
    const core = pes.length >= 9 ? filter.push(pes) : null;
    if (!core) return null;
    try {
      return audioWireBps(coding, core);
    } catch (err) {
      lastError = err as Error;
      return null;
    }
  };
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let data = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (partial.length) {
        const joined = new Uint8Array(partial.length + data.length);
        joined.set(partial);
        joined.set(data, partial.length);
        data = joined;
      }
      const whole = data.length - (data.length % SOURCE_PACKET_BYTES);
      for (let p = 0; p < whole; p += SOURCE_PACKET_BYTES) {
        if (data[p + 4] !== 0x47 || (((data[p + 5]! & 0x1f) << 8) | data[p + 6]!) !== pid) continue;
        const flags = data[p + 7]!;
        if (!(flags & 0x10)) continue;
        const payloadAt = flags & 0x20 ? p + 9 + data[p + 8]! : p + 8;
        if (payloadAt >= p + SOURCE_PACKET_BYTES) continue;
        if (data[p + 5]! & 0x40) {
          const bps = tryPes();
          if (bps !== null) return bps;
        }
        chunks.push(data.slice(payloadAt, p + SOURCE_PACKET_BYTES));
      }
      partial = data.slice(whole);
    }
    const bps = tryPes();
    if (bps !== null) return bps;
  } finally {
    stream.destroy();
  }
  throw lastError ?? new Error(`levels: no audio frame of PID 0x${pid.toString(16)} at the clip's start`);
}

/** Collects a stream into one buffer. */
async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) parts.push(chunk);
  return Buffer.concat(parts);
}

async function stampOf(abs: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await stat(abs);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** A folder disc's files for the level service. */
export function folderDiscSource(dir: string, disc: { id: string; name: string }): LevelDiscSource {
  return {
    manifest: () => buildManifest(dir, disc),
    async readFile(path) {
      const abs = await resolveDiscFile(dir, path);
      return abs ? new Uint8Array(await readFile(abs)) : null;
    },
    async readRange(path, offset, length) {
      const abs = await resolveDiscFile(dir, path);
      if (!abs) return null;
      const handle = await open(abs, 'r');
      try {
        const out = Buffer.alloc(length);
        let got = 0;
        while (got < length) {
          const { bytesRead } = await handle.read(out, got, length - got, offset + got);
          if (bytesRead === 0) throw new Error(`levels: ${path} is shorter than its manifest says`);
          got += bytesRead;
        }
        return out;
      } finally {
        await handle.close();
      }
    },
    async clip(path) {
      const abs = await resolveDiscFile(dir, path);
      if (!abs) return null;
      const st = await stat(abs);
      return {
        input: { path: abs },
        read: (from, to) => createReadStream(abs, { start: from, ...(to === undefined ? {} : { end: to - 1 }) }),
        size: st.size,
        mtimeMs: st.mtimeMs,
        stamp: () => stampOf(abs),
      };
    },
  };
}

/** An ISO disc's files for the level service: ffmpeg gets a stream file's bytes through a pipe. */
export function isoDiscSource(abs: string, tree: ReadonlyMap<string, UdfFile>, disc: { id: string; name: string }): LevelDiscSource {
  const file = (path: string): UdfFile | null => resolveIsoFile(tree, path);
  return {
    manifest: () => buildIsoManifest(abs, tree, disc),
    async readFile(path) {
      const f = file(path);
      if (!f) return null;
      const got = (await readIsoFiles(abs, [f])).get(f.path);
      return got ? new Uint8Array(got) : null;
    },
    async readRange(path, offset, length) {
      const f = file(path);
      if (!f) return null;
      if (length === 0) return Buffer.alloc(0);
      return collect(isoFileStream(abs, f, offset, offset + length - 1));
    },
    async clip(path) {
      const f = file(path);
      if (!f) return null;
      const { mtimeMs } = await stat(abs);
      const read: ClipReader = (from, to) => isoFileStream(abs, f, from, (to ?? f.size) - 1);
      // A file inside the image changes only with the image, whose mtime then changes.
      const stamp = async (): Promise<{ size: number; mtimeMs: number } | null> => {
        const image = await stampOf(abs);
        return image && { size: f.size, mtimeMs: image.mtimeMs };
      };
      return { input: { read }, read, size: f.size, mtimeMs, stamp };
    },
  };
}

/** The library's discs for the level service: a disc that is gone or changed since the scan is null. */
export function libraryDiscSources(library: Library, isoTrees: IsoTrees = new IsoTrees()): (discId: string) => Promise<LevelDiscSource | null> {
  return async (discId) => {
    const disc: DiscEntry | null = library.disc(discId);
    if (!disc) return null;
    const abs = library.locate(disc);
    if (!abs) return null;
    if (disc.kind === 'iso') {
      if (!(await isoUnchanged(disc, abs))) return null;
      return isoDiscSource(abs, await isoTrees.get(disc.id, abs), disc);
    }
    if (!(await discUnchanged(disc, abs))) return null;
    return folderDiscSource(abs, disc);
  };
}
