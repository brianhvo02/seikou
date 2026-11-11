import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { DiscEntry } from '@seikou/nas/nas-api';
import { UdfError, UdfImage, readUdf, udfPieces } from '@seikou/bdmv/udf';
import type { UdfExtent, UdfFile, UdfRead } from '@seikou/bdmv/udf';
import { discId } from './disc-id';

/**
 * Runs `fn` with a reader over the image at `abs`, open for that long, and the image's size. A request past the end
 * is clamped to it before anything is allocated, so it comes back short.
 */
async function withImage<T>(abs: string, fn: (read: UdfRead, size: number) => Promise<T>): Promise<T> {
  const handle = await open(abs, 'r');
  try {
    const { size } = await handle.stat();
    return await fn(async (offset, requested) => {
      const length = Math.max(0, Math.min(requested, size - offset));
      const buf = Buffer.alloc(length);
      let got = 0;
      while (got < length) {
        const { bytesRead } = await handle.read(buf, got, length - got, offset + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return buf.subarray(0, got);
    }, size);
  } finally {
    await handle.close();
  }
}

/**
 * Whether the image at `abs` is a Blu-ray disc: its UDF tree has BDMV/INDEX.BDMV. Reads only the volume descriptors,
 * the root and BDMV directories and one file entry. False for an image that isn't UDF; read errors propagate.
 */
export async function isoIsDisc(abs: string): Promise<boolean> {
  try {
    return await withImage(abs, async (read) => (await (await UdfImage.open(read)).find('BDMV/INDEX.BDMV')) !== null);
  } catch (err) {
    if (err instanceof UdfError) return false;
    throw err;
  }
}

/** Whether the ISO disc `entry` at `abs` is still the image the library scanned (same size and mtime). */
export async function isoUnchanged(entry: DiscEntry, abs: string): Promise<boolean> {
  try {
    const st = await stat(abs);
    return st.isFile() && discId(entry.path, st.size, st.mtimeMs) === entry.id;
  } catch {
    return false;
  }
}

/** `files` by path, without those whose extents go past the end of the image: they could not be served whole. */
function treeOf(files: readonly UdfFile[], size: number): ReadonlyMap<string, UdfFile> {
  return new Map(files.filter((f) => f.extents.every((e) => e.offset < 0 || e.offset + e.length <= size)).map((f) => [f.path, f]));
}

/** The UDF tree of the image at `abs` (path → file). */
export function readIsoTree(abs: string): Promise<ReadonlyMap<string, UdfFile>> {
  return withImage(abs, async (read, size) => treeOf(await readUdf(read), size));
}

/**
 * The UDF tree of the image at `abs` if it is a Blu-ray disc (as `isoIsDisc`), parsed once; null otherwise. An image
 * that isn't a disc costs only the probe. Read errors propagate.
 */
export async function isoDiscTree(abs: string): Promise<ReadonlyMap<string, UdfFile> | null> {
  try {
    return await withImage(abs, async (read, size) => {
      const image = await UdfImage.open(read);
      return (await image.find('BDMV/INDEX.BDMV')) ? treeOf(await image.files(), size) : null;
    });
  } catch (err) {
    if (err instanceof UdfError) return null;
    throw err;
  }
}

/** The parsed UDF trees of the last `max` ISO discs used, by disc id (path → file), so range reads don't re-parse. */
export class IsoTrees {
  private readonly trees = new Map<string, Promise<ReadonlyMap<string, UdfFile>>>();

  constructor(private readonly max = 32) {}

  /** The tree of disc `id` at `abs`, parsed on first use and kept; the least recently used tree goes past `max`. Rejects when the file is not a readable UDF image. */
  get(id: string, abs: string): Promise<ReadonlyMap<string, UdfFile>> {
    let tree = this.trees.get(id);
    if (tree) {
      this.trees.delete(id);
    } else {
      tree = readIsoTree(abs);
      // A failed parse isn't kept: the next request tries again.
      tree.catch(() => {
        if (this.trees.get(id) === tree) this.trees.delete(id);
      });
    }
    this.trees.set(id, tree);
    for (const oldest of this.trees.keys()) {
      if (this.trees.size <= this.max) break;
      this.trees.delete(oldest);
    }
    return tree;
  }
}

const ZEROS = Buffer.alloc(64 * 1024);

/** Image pieces (offset -1: zeros) as one stream, each piece read from the image in turn. */
function piecesStream(abs: string, pieces: readonly UdfExtent[]): Readable {
  async function* chunks(): AsyncGenerator<Buffer> {
    for (const piece of pieces) {
      if (piece.offset < 0) {
        for (let left = piece.length; left > 0; left -= ZEROS.length) yield ZEROS.subarray(0, Math.min(left, ZEROS.length));
      } else {
        let got = 0;
        for await (const chunk of createReadStream(abs, { start: piece.offset, end: piece.offset + piece.length - 1 }) as AsyncIterable<Buffer>) {
          got += chunk.length;
          yield chunk;
        }
        // The image is shorter than the tree says: fail the body rather than end it early.
        if (got < piece.length) throw new Error(`short read in ${abs} at ${piece.offset}`);
      }
    }
  }
  return Readable.from(chunks(), { objectMode: false });
}

/** Bytes `[start, end]` (inclusive) of `file` in the image at `abs`, as a stream. */
export function isoFileStream(abs: string, file: UdfFile, start: number, end: number): Readable {
  return piecesStream(abs, udfPieces(file, start, end + 1));
}

/**
 * The whole of each of `files` in the image at `abs`, read through one open handle. A short read throws, or with
 * `skipShort` leaves just that file out.
 */
export async function readIsoFiles(abs: string, files: readonly UdfFile[], skipShort = false): Promise<Map<string, Buffer>> {
  return withImage(abs, async (read) => {
    const out = new Map<string, Buffer>();
    files: for (const file of files) {
      const buf = Buffer.alloc(file.size);
      let at = 0;
      for (const piece of udfPieces(file, 0, file.size)) {
        if (piece.offset >= 0) {
          const bytes = await read(piece.offset, piece.length);
          if (bytes.length < piece.length) {
            if (skipShort) continue files;
            throw new Error(`short read in ${abs} at ${piece.offset}`);
          }
          buf.set(bytes, at);
        }
        at += piece.length;
      }
      out.set(file.path, buf);
    }
    return out;
  });
}
