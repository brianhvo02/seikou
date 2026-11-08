// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, readFileSync } from 'node:fs';
import { readdir, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { openMatroska } from '@seikou/matroska';
import type { MkvChapterInfo } from '@seikou/matroska';
import { encodeId } from '@seikou/nas/encode-id';
import { isCode, replaceAtomically } from '@seikou/titles/atomic-json';
import { withFileReader } from './node-reader';

/** One encoded episode, read from the tags of its MKV. */
export interface EncodeEntry {
  /** `<anilistId>-<episode>` */
  id: string;
  anilistId: number;
  episode: number;
  episodeTitle: string | null;
  discKey: string | null;
  playlistId: string | null;
  episodeStartMs: number | null;
  /** Absolute path of the file; never sent to a client. */
  path: string;
  size: number;
  mtimeMs: number;
  durationMs: number;
  chapters: MkvChapterInfo[];
  tracks: { kind: 'video' | 'audio' | 'subtitle'; codec: string; language: string; name: string; isDefault: boolean; isForced: boolean }[];
}

export interface EncodeIndexOptions {
  /** The encodes folder (`ENCODES_DIR`). */
  dir: string;
  /** The server's data volume; the index is `<dataDir>/encodes.json`. */
  dataDir: string;
  log: (message: string) => void;
  /** Called with a file's path (relative to `dir`) each time the file is read; tests count these. */
  onRead?: (relativePath: string) => void | Promise<void>;
  /** Writes the index file; default `replaceAtomically` (tests make it fail). */
  writeIndex?: (file: string, json: string) => void;
  /** A file modified more recently than this is left for the next scan (a copy in progress). Default 10 s. */
  settleMs?: number;
  now?: () => number;
}

/** What a client may be told of the index's state. */
export interface EncodeIndexState {
  /** The first scan has not finished. */
  scanning: boolean;
  /** The folder is missing or unreadable; the last good list is still served. */
  rootMissing: boolean;
  /** The folder is readable but holds no MKV while the index has entries (an unmounted drive?); the last list is served. */
  rootEmpty: boolean;
  /** The message of a scan that failed, else null. */
  scanError: string | null;
}

const DEFAULT_SETTLE_MS = 10_000;

/** The encodes folder itself could not be read. */
class RootUnreadable extends Error {}

type StoredEntry = Omit<EncodeEntry, 'path'>;

/** What is kept for one file: its size and mtime, and its entry (without the path) or null when it names no episode. */
interface FileRecord {
  size: number;
  mtimeMs: number;
  entry: StoredEntry | null;
}

interface Persisted {
  version: 1;
  /** Keyed by the file's path relative to the folder, with `/` separators. */
  files: Record<string, FileRecord>;
}

const TRACK_KINDS: Record<number, 'video' | 'audio' | 'subtitle'> = { 1: 'video', 2: 'audio', 17: 'subtitle' };
const WHOLE = /^[1-9]\d{0,14}$/;

function whole(text: string | undefined): number | null {
  const trimmed = text?.trim();
  return trimmed !== undefined && WHOLE.test(trimmed) ? Number(trimmed) : null;
}

const posix = (path: string): string => path.split(sep).join('/');

/**
 * The encodes folder's index (`<dataDir>/encodes.json`): every `.mkv` under the folder (dot folders and `.partial`
 * files left out) read through its Matroska tags. A file is read again only when its size or mtime changed. A file
 * that names an AniList id and an episode is listed under them wherever it lies; two with the same pair keep the one
 * at `<anilistId>/<episode>.mkv`, else the newest. Anything else is unfiled. The scan never moves or deletes a file.
 */
export class EncodeIndex {
  private readonly file: string;
  private files = new Map<string, FileRecord>();
  private entries: EncodeEntry[] = [];
  private unfiledFiles: { path: string; size: number }[] = [];
  private scanning: Promise<void> | null = null;
  private firstScan: Promise<void> | null = null;
  private firstSettled = false;
  private rootProblem: string | null = null;
  private rootEmpty = false;
  private closed = false;
  private scanError: string | null = null;
  /** While a scan runs: what `add` and `remove` changed since it began (null for a removal), which its commit keeps. */
  private changedDuringScan: Map<string, FileRecord | null> | null = null;

  constructor(private readonly opts: EncodeIndexOptions) {
    this.file = join(opts.dataDir, 'encodes.json');
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Persisted;
      if (parsed.version === 1 && parsed.files && typeof parsed.files === 'object') this.files = new Map(Object.entries(parsed.files));
    } catch (err) {
      if (!isCode(err, 'ENOENT') && !(err instanceof SyntaxError)) throw err;
    }
    this.resolve();
  }

  private save(files: Map<string, FileRecord>): void {
    mkdirSync(this.opts.dataDir, { recursive: true });
    const value: Persisted = { version: 1, files: Object.fromEntries(files) };
    (this.opts.writeIndex ?? replaceAtomically)(this.file, JSON.stringify(value));
  }

  /** Writes `files` to disk first, then makes them the list served; a failed write leaves both as they were. */
  private commit(files: Map<string, FileRecord>): void {
    this.save(files);
    this.files = files;
    this.resolve();
  }

  private abs(rel: string): string {
    return join(this.opts.dir, ...rel.split('/'));
  }

  /** Builds the lists from the file records. */
  private resolve(): void {
    const winners = new Map<string, { rel: string; record: FileRecord; entry: StoredEntry }>();
    const unfiled: { path: string; size: number }[] = [];
    for (const [rel, record] of [...this.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const entry = record.entry;
      if (!entry) {
        unfiled.push({ path: this.abs(rel), size: record.size });
        continue;
      }
      const held = winners.get(entry.id);
      if (!held) {
        winners.set(entry.id, { rel, record, entry });
        continue;
      }
      const canonical = (r: string): boolean => r === `${entry.anilistId}/${entry.episode}.mkv`;
      const keepNew = canonical(rel) ? true : canonical(held.rel) ? false : record.mtimeMs > held.record.mtimeMs;
      this.opts.log(`encodes: ${rel} and ${held.rel} are both episode ${entry.id}; listing ${keepNew ? rel : held.rel}`);
      if (keepNew) winners.set(entry.id, { rel, record, entry });
    }
    this.entries = [...winners.values()]
      .map(({ rel, record, entry }) => ({ ...entry, path: this.abs(rel), size: record.size, mtimeMs: record.mtimeMs }))
      .sort((a, b) => a.anilistId - b.anilistId || a.episode - b.episode);
    this.unfiledFiles = unfiled;
  }

  private async read(rel: string, size: number, mtimeMs: number): Promise<FileRecord> {
    await this.opts.onRead?.(rel);
    try {
      const mkv = await withFileReader(this.abs(rel), (reader) => openMatroska(reader));
      const anilistId = whole(mkv.tags.ANILIST_ID);
      const episode = whole(mkv.tags.EPISODE);
      if (anilistId === null || episode === null) return { size, mtimeMs, entry: null };
      const startText = mkv.tags.SEIKOU_EPISODE_START_MS?.trim();
      const start = startText ? Number(startText) : NaN;
      return {
        size,
        mtimeMs,
        entry: {
          id: encodeId(anilistId, episode),
          anilistId,
          episode,
          episodeTitle: mkv.tags.EPISODE_TITLE?.trim() || null,
          discKey: mkv.tags.SEIKOU_DISC_KEY?.trim() || null,
          playlistId: mkv.tags.SEIKOU_PLAYLIST?.trim() || null,
          episodeStartMs: Number.isFinite(start) ? start : null,
          size,
          mtimeMs,
          durationMs: mkv.durationMs,
          chapters: [...mkv.chapters],
          tracks: mkv.tracks.flatMap((t) => {
            const kind = TRACK_KINDS[t.type];
            return kind ? [{ kind, codec: t.codecId, language: t.language, name: t.name, isDefault: t.isDefault, isForced: t.isForced }] : [];
          }),
        },
      };
    } catch (err) {
      this.opts.log(`encodes: ${rel} is not a readable Matroska file: ${err instanceof Error ? err.message : String(err)}`);
      return { size, mtimeMs, entry: null };
    }
  }

  /** Collects the `.mkv` files under `dir`; a folder that can't be read is skipped (listed in `skipped`), except the root. */
  private async walk(dir: string, out: string[], skipped: string[]): Promise<void> {
    let names;
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (dir === this.opts.dir) throw new RootUnreadable(message);
      this.opts.log(`encodes: skipping ${posix(relative(this.opts.dir, dir))}: ${message}`);
      skipped.push(posix(relative(this.opts.dir, dir)));
      return;
    }
    for (const e of names) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await this.walk(full, out, skipped);
      else if (e.isFile() && /\.mkv$/i.test(e.name)) out.push(posix(relative(this.opts.dir, full)));
    }
  }

  /** Reads the folder; files unchanged since the last scan are not read again. Overlapping calls share one scan. */
  scan(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.scanning ??= this.doScan()
      .catch((err: unknown) => {
        this.scanError = err instanceof Error ? err.message : String(err);
        throw err;
      })
      .finally(() => {
        this.scanning = null;
      });
    this.firstScan ??= this.scanning.then(
      () => {
        this.firstSettled = true;
      },
      () => {
        this.firstSettled = true;
      },
    );
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    this.changedDuringScan = new Map();
    try {
      await this.scanFolder();
    } finally {
      this.changedDuringScan = null;
    }
  }

  private async scanFolder(): Promise<void> {
    const found: string[] = [];
    const skipped: string[] = [];
    try {
      await this.walk(this.opts.dir, found, skipped);
    } catch (err) {
      if (!(err instanceof RootUnreadable)) throw err;
      // Like a library root that is missing: keep the last good list, and say so once.
      if (this.rootProblem !== err.message) this.opts.log(`encodes: ${this.opts.dir} can't be read (${err.message}); keeping the last index`);
      this.rootProblem = err.message;
      return;
    }
    this.rootProblem = null;
    if (found.length === 0 && this.files.size > 0) {
      // Readable but empty, as a failed mount leaves its mountpoint: keep the list. Removing encodes on purpose goes through the delete route.
      if (!this.rootEmpty) this.opts.log(`encodes: ${this.opts.dir} holds no MKV files; keeping the last index`);
      this.rootEmpty = true;
      return;
    }
    this.rootEmpty = false;
    this.scanError = null;
    const settleMs = this.opts.settleMs ?? DEFAULT_SETTLE_MS;
    const now = (this.opts.now ?? Date.now)();
    const next = new Map<string, FileRecord>();
    for (const rel of found.sort()) {
      let s;
      try {
        s = await stat(this.abs(rel));
      } catch {
        continue;
      }
      const old = this.files.get(rel);
      if (old && old.size === s.size && old.mtimeMs === s.mtimeMs) next.set(rel, old);
      else if (settleMs > 0 && now - s.mtimeMs < settleMs) {
        // being copied: the next scan takes it (what we knew of it stays meanwhile)
        if (old) next.set(rel, old);
      } else next.set(rel, await this.read(rel, s.size, s.mtimeMs));
    }
    // a folder we couldn't read keeps what it held
    for (const [rel, record] of this.files) if (!next.has(rel) && skipped.some((d) => rel.startsWith(`${d}/`))) next.set(rel, record);
    // what `add` and `remove` did while this scan read the folder wins over what the scan saw
    for (const [rel, record] of this.changedDuringScan ?? []) {
      if (record) next.set(rel, record);
      else next.delete(rel);
    }
    this.commit(next);
  }

  /** Stops further scans (shutdown). */
  close(): void {
    this.closed = true;
  }

  state(): EncodeIndexState {
    return { scanning: !this.firstSettled, rootMissing: this.rootProblem !== null, rootEmpty: this.rootEmpty, scanError: this.scanError };
  }

  /** True once the first scan has finished (well or not: see `state`); false after `ms`, or when none was started. */
  async ready(ms: number): Promise<boolean> {
    if (!this.firstScan) return false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((r) => {
      timer = setTimeout(() => r(false), ms);
    });
    try {
      return await Promise.race([this.firstScan.then(() => true, () => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  list(): readonly EncodeEntry[] {
    return this.entries;
  }

  get(id: string): EncodeEntry | null {
    return this.entries.find((e) => e.id === id) ?? null;
  }

  unfiled(): readonly { path: string; size: number }[] {
    return this.unfiledFiles;
  }

  /** Reads one file (say, one just uploaded) into the index; throws when it names no AniList id and episode. */
  async add(path: string): Promise<EncodeEntry> {
    let root: string;
    try {
      root = await realpath(this.opts.dir);
    } catch {
      throw new Error('the encodes folder is missing');
    }
    let real: string;
    try {
      real = await realpath(path);
    } catch {
      throw new Error('no such file');
    }
    const rel = posix(relative(root, real));
    if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || rel.split('/').some((seg) => seg.startsWith('.'))) throw new Error('not inside the encodes folder');
    const s = await stat(real);
    const record = await this.read(rel, s.size, s.mtimeMs);
    if (!record.entry) throw new Error('the file names no AniList id and episode in its tags');
    this.commit(new Map(this.files).set(rel, record));
    this.changedDuringScan?.set(rel, record);
    return this.get(record.entry.id)!;
  }

  /** Takes an episode out of the index and deletes its file. */
  async remove(id: string): Promise<void> {
    const entry = this.get(id);
    if (!entry) return;
    // the index first: a failed save keeps both the entry and its file
    const files = new Map(this.files);
    const rel = posix(relative(this.opts.dir, entry.path));
    files.delete(rel);
    this.commit(files);
    this.changedDuringScan?.set(rel, null);
    try {
      await rm(entry.path, { force: true });
    } catch (err) {
      this.opts.log(`encodes: removed ${id} from the index but not its file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
