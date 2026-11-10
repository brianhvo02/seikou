// SPDX-License-Identifier: LGPL-3.0-or-later
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { openMatroska } from '@seikou/matroska';
import { encodeId } from '@seikou/nas/encode-id';
import { titleFromTags, titlePart } from '@seikou/nas/encode-title';
import type { EncodeTitle } from '@seikou/nas/encode-title';
import { isCode, replaceAtomically } from '@seikou/titles/atomic-json';
import { HttpError } from '../http';
import type { EncodeEntry, EncodeIndex } from './index-store';
import { withFileReader } from './node-reader';

/** The most one `PUT` may carry. */
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
/** Free space that must remain after an upload's size. */
export const ROOM_MARGIN_BYTES = 1024 * 1024 * 1024;
/** An upload untouched for this long is removed. */
/** Open uploads one device may hold. */
export const MAX_OPEN_PER_DEVICE = 8;
export const STALE_UPLOAD_MS = 24 * 60 * 60_000;
const MAX_UPLOAD_BYTES = 2 ** 44;

export const UPLOAD_ID = /^[0-9a-f]{16}$/;

/** An inclusive byte range `[first, last]`. */
export type ByteRange = [number, number];

interface UploadMeta {
  size: number;
  sha256: string;
  name: string;
  deviceId: string;
  /** Sorted, merged, inclusive. */
  ranges: ByteRange[];
  /** Last touch, ms. */
  touchedAt: number;
}

export interface UploadStoreOptions {
  /** The encodes folder. */
  dir: string;
  index: EncodeIndex;
  log: (message: string) => void;
  now?: () => number;
  /** Free bytes on the folder's disk; default `statfs`. */
  freeBytes?: (dir: string) => Promise<number>;
}

/** A refusal with the answer to give (`extra` joins the JSON body). */
export class UploadError extends HttpError {
  constructor(status: number, message: string, readonly extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    super(status, message, headers);
  }
}

/** Adds `[a, b]` to sorted merged ranges (touching ranges join). */
export function mergeRange(ranges: readonly ByteRange[], a: number, b: number): ByteRange[] {
  const out: ByteRange[] = [];
  let first = a;
  let last = b;
  let placed = false;
  for (const r of ranges) {
    if (r[1] + 1 < first) out.push(r);
    else if (last + 1 < r[0]) {
      if (!placed) out.push([first, last]);
      placed = true;
      out.push(r);
    } else {
      first = Math.min(first, r[0]);
      last = Math.max(last, r[1]);
    }
  }
  if (!placed) out.push([first, last]);
  return out;
}

/** The ranges of `[0, size)` that `ranges` leave uncovered. */
export function missingRanges(ranges: readonly ByteRange[], size: number): ByteRange[] {
  const out: ByteRange[] = [];
  let next = 0;
  for (const [a, b] of ranges) {
    if (a > next) out.push([next, a - 1]);
    next = Math.max(next, b + 1);
  }
  if (next < size) out.push([next, size - 1]);
  return out;
}

/** Why an upload is refused while the encodes folder can't be trusted (the drive not mounted, say). */
export const FOLDER_UNAVAILABLE_MESSAGE = "The encodes folder isn't available. Check that the drive is mounted, then try again.";

const whole = (text: string | undefined): number | null => (text !== undefined && /^[1-9]\d{0,14}$/.test(text.trim()) ? Number(text.trim()) : null);

/**
 * Resumable uploads of encoded episodes into `<dir>/.uploads/<id>.partial`, with `<id>.json` (size, hash, name,
 * the device, the stored ranges). Chunks land anywhere in the preallocated file, in any order and more than once.
 * `complete` checks every byte, the SHA-256 and the tags, then renames the file to `<titlePart>/<episode>.mkv` and
 * lists it; an existing file there is replaced only by that rename.
 */
export class UploadStore {
  private readonly uploads: string;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<unknown>>();
  private creating: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: UploadStoreOptions) {
    this.uploads = join(opts.dir, '.uploads');
    this.now = opts.now ?? Date.now;
  }

  private partial = (id: string): string => join(this.uploads, `${id}.partial`);
  private metaFile = (id: string): string => join(this.uploads, `${id}.json`);

  /** Runs `fn` after the upload's earlier calls, so range merges and completion never interleave. */
  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(id, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }

  private async readMeta(id: string): Promise<UploadMeta | null> {
    if (!UPLOAD_ID.test(id)) return null;
    try {
      return JSON.parse(await readFile(this.metaFile(id), 'utf8')) as UploadMeta;
    } catch (err) {
      if (isCode(err, 'ENOENT') || err instanceof SyntaxError) return null;
      throw err;
    }
  }

  private writeMeta(id: string, meta: UploadMeta): void {
    replaceAtomically(this.metaFile(id), JSON.stringify(meta));
  }

  private async discard(id: string): Promise<void> {
    await rm(this.partial(id), { force: true });
    await rm(this.metaFile(id), { force: true });
  }

  private async free(): Promise<number> {
    if (this.opts.freeBytes) return this.opts.freeBytes(this.opts.dir);
    const s = await statfs(this.opts.dir);
    return Number(s.bavail) * Number(s.bsize);
  }

  /**
   * Refuses (503 `encodes-folder-unavailable`) when the encodes folder is missing or not a directory, or the index
   * reports it missing or empty while it still lists episodes: an upload must never land on the empty mountpoint of an
   * unmounted drive. The folder itself is never made here.
   */
  private async checkFolder(): Promise<void> {
    const refuse = (): UploadError => new UploadError(503, 'encodes-folder-unavailable', { message: FOLDER_UNAVAILABLE_MESSAGE });
    try {
      if (!(await stat(this.opts.dir)).isDirectory()) throw refuse();
    } catch (err) {
      if (err instanceof UploadError) throw err;
      if (isCode(err, 'ENOENT') || isCode(err, 'ENOTDIR')) throw refuse();
      throw err;
    }
    const state = this.opts.index.state();
    if (state.rootMissing || state.rootEmpty) throw refuse();
  }

  /**
   * Opens an upload and answers its id; one creation at a time, so the same-name and room checks can't both pass for
   * two POSTs. An open upload of the same name is 409 `in-progress` when another device made it; when this device did,
   * its id is answered again if size and hash match (a POST whose answer was lost is resumed, not locked out), and it
   * is dropped for the new upload if they don't (a re-encode whose old upload id was lost).
   */
  create(deviceId: string, input: Record<string, unknown>): Promise<string> {
    const run = this.creating.then(() => this.createOne(deviceId, input));
    this.creating = run.catch(() => {});
    return run;
  }

  private async createOne(deviceId: string, input: Record<string, unknown>): Promise<string> {
    const { size, sha256, name } = input;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) throw new UploadError(400, 'bad size');
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) throw new UploadError(400, 'bad sha256');
    if (typeof name !== 'string' || name === '' || name.length > 255) throw new UploadError(400, 'bad name');
    await this.checkFolder();
    // inside the folder only: never the folder itself
    try {
      await mkdir(this.uploads);
    } catch (err) {
      if (!isCode(err, 'EEXIST')) throw err;
    }
    let owed = 0;
    let mine = 0;
    const wanted = sha256.toLowerCase();
    for (const file of await readdir(this.uploads)) {
      if (!file.endsWith('.json')) continue;
      const otherId = file.slice(0, -5);
      const other = await this.readMeta(otherId);
      if (!other) continue;
      if (other.name === name) {
        // another device's open upload of the name stands; this device's own is taken up again (its answer to the
        // POST may have been lost) when it is the same file, and dropped for the new one when it is not
        if (other.deviceId !== deviceId) throw new UploadError(409, 'in-progress');
        if (other.size === size && other.sha256 === wanted) {
          await this.locked(otherId, async () => {
            const meta = await this.readMeta(otherId);
            if (meta) this.writeMeta(otherId, { ...meta, touchedAt: this.now() });
          });
          return otherId;
        }
        await this.locked(otherId, () => this.discard(otherId));
        continue;
      }
      if (other.deviceId === deviceId) mine++;
      owed += other.size - other.ranges.reduce((n, [x, y]) => n + (y - x + 1), 0);
    }
    if (mine >= MAX_OPEN_PER_DEVICE) throw new UploadError(429, 'too-many-uploads');
    // the bytes open uploads still have to write count against the room
    if ((await this.free()) < owed + size + ROOM_MARGIN_BYTES) throw new UploadError(507, 'no-room');
    const id = randomBytes(8).toString('hex');
    const handle = await open(this.partial(id), 'w');
    try {
      await handle.truncate(size);
    } finally {
      await handle.close();
    }
    this.writeMeta(id, { size, sha256: wanted, name, deviceId, ranges: [], touchedAt: this.now() });
    return id;
  }

  async status(id: string): Promise<{ size: number; ranges: ByteRange[] }> {
    const meta = await this.readMeta(id);
    if (!meta) throw new UploadError(404, 'not found');
    return { size: meta.size, ranges: meta.ranges };
  }

  /** Writes the body (exactly `b - a + 1` bytes) at offset `a`; `size` is what the request named. */
  async put(id: string, a: number, b: number, size: number, body: () => AsyncIterable<Buffer>): Promise<void> {
    return this.locked(id, async () => {
      const meta = await this.readMeta(id);
      if (!meta) throw new UploadError(404, 'not found');
      if (size !== meta.size || a > b || b >= meta.size) throw new UploadError(400, 'range outside the upload', {}, { Connection: 'close' });
      if (b - a + 1 > MAX_CHUNK_BYTES) throw new UploadError(413, 'chunk too large', {}, { Connection: 'close' });
      const handle = await open(this.partial(id), 'r+');
      let at = a;
      try {
        for await (const chunk of body()) {
          if (at + chunk.length > b + 1) throw new UploadError(400, 'body longer than its range', {}, { Connection: 'close' });
          await handle.write(chunk, 0, chunk.length, at);
          at += chunk.length;
        }
        if (at !== b + 1) throw new UploadError(400, 'body shorter than its range', {}, { Connection: 'close' });
      } finally {
        await handle.close();
      }
      meta.ranges = mergeRange(meta.ranges, a, b);
      meta.touchedAt = this.now();
      this.writeMeta(id, meta);
    });
  }

  /** `entry` is null when the file was filed but the index could not list it yet (`filed` is its id; the next scan lists it). */
  async complete(id: string): Promise<{ entry: EncodeEntry | null; filed: string }> {
    return this.locked(id, async () => {
      const meta = await this.readMeta(id);
      if (!meta) throw new UploadError(404, 'not found');
      const missing = missingRanges(meta.ranges, meta.size);
      if (missing.length > 0) throw new UploadError(409, 'incomplete', { missing });
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(this.partial(id))) hash.update(chunk as Buffer);
      if (hash.digest('hex') !== meta.sha256) {
        await this.discard(id);
        throw new UploadError(422, 'hash-mismatch');
      }
      let title: EncodeTitle | null = null;
      let episode: number | null = null;
      try {
        const mkv = await withFileReader(this.partial(id), (reader) => openMatroska(reader));
        title = titleFromTags(mkv.tags);
        episode = whole(mkv.tags.EPISODE);
      } catch (err) {
        this.opts.log(`encodes: upload ${id} is not a readable Matroska file: ${err instanceof Error ? err.message : String(err)}`);
      }
      // kept, so the owner can abort it
      if (title === null || episode === null) throw new UploadError(422, 'bad-tags');
      const folder = join(this.opts.dir, titlePart(title));
      const finalPath = join(folder, `${episode}.mkv`);
      try {
        if (!(await lstat(folder)).isDirectory()) throw new UploadError(409, 'bad-folder');
      } catch (err) {
        if (err instanceof UploadError) throw err;
        if (!isCode(err, 'ENOENT')) throw err;
      }
      await this.checkFolder();
      try {
        await mkdir(folder);
      } catch (err) {
        if (!isCode(err, 'EEXIST')) throw err;
      }
      // one rename over any old file: the old one plays until it lands
      await rename(this.partial(id), finalPath);
      await rm(this.metaFile(id), { force: true });
      const filed = encodeId(title, episode);
      try {
        return { entry: await this.opts.index.add(finalPath), filed };
      } catch (err) {
        // the file is in place; an error now must not send the client back to a gone upload
        this.opts.log(`encodes: upload ${id} was filed as ${filed} but not listed: ${err instanceof Error ? err.message : String(err)}`);
        return { entry: null, filed };
      }
    });
  }

  async abort(id: string): Promise<void> {
    return this.locked(id, async () => {
      if (!(await this.readMeta(id))) throw new UploadError(404, 'not found');
      await this.discard(id);
    });
  }

  /** Removes uploads untouched for 24 h (and partial files left without a record). */
  async sweep(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.uploads);
    } catch {
      return 0;
    }
    let removed = 0;
    const ids = new Set(names.map((n) => n.replace(/\.(partial|json)$/, '')).filter((n) => UPLOAD_ID.test(n)));
    for (const id of ids) {
      await this.locked(id, async () => {
        let touched: number;
        try {
          const meta = await this.readMeta(id);
          touched = meta ? meta.touchedAt : (await stat(this.partial(id))).mtimeMs;
        } catch {
          touched = 0;
        }
        if (this.now() - touched < STALE_UPLOAD_MS) return;
        await this.discard(id);
        removed++;
        this.opts.log(`encodes: removed the stale upload ${id}`);
      });
    }
    return removed;
  }
}
