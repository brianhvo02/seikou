// SPDX-License-Identifier: LGPL-3.0-or-later
import { mkdirSync, readFileSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
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
  onRead?: (relativePath: string) => void;
}

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

  private save(): void {
    mkdirSync(this.opts.dataDir, { recursive: true });
    const value: Persisted = { version: 1, files: Object.fromEntries(this.files) };
    replaceAtomically(this.file, JSON.stringify(value));
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
    this.opts.onRead?.(rel);
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

  private async walk(dir: string, out: string[]): Promise<void> {
    let names;
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isCode(err, 'ENOENT')) return;
      throw err;
    }
    for (const e of names) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await this.walk(full, out);
      else if (e.isFile() && /\.mkv$/i.test(e.name)) out.push(posix(relative(this.opts.dir, full)));
    }
  }

  /** Reads the folder; files unchanged since the last scan are not read again. Overlapping calls share one scan. */
  scan(): Promise<void> {
    this.scanning ??= this.doScan().finally(() => {
      this.scanning = null;
    });
    this.firstScan ??= this.scanning;
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    const found: string[] = [];
    await this.walk(this.opts.dir, found);
    const next = new Map<string, FileRecord>();
    for (const rel of found.sort()) {
      let s;
      try {
        s = await stat(this.abs(rel));
      } catch {
        continue;
      }
      const old = this.files.get(rel);
      next.set(rel, old && old.size === s.size && old.mtimeMs === s.mtimeMs ? old : await this.read(rel, s.size, s.mtimeMs));
    }
    this.files = next;
    this.resolve();
    this.save();
  }

  /** True once the first scan has finished; false after `ms`, or when none was started. */
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
    const rel = posix(relative(this.opts.dir, path));
    if (rel.startsWith('..') || rel.split('/').some((s) => s.startsWith('.') && s !== '.')) throw new Error('not inside the encodes folder');
    const s = await stat(path);
    const record = await this.read(rel, s.size, s.mtimeMs);
    if (!record.entry) throw new Error('the file names no AniList id and episode in its tags');
    this.files.set(rel, record);
    this.resolve();
    this.save();
    return this.get(record.entry.id)!;
  }

  /** Takes an episode out of the index and deletes its file. */
  async remove(id: string): Promise<void> {
    const entry = this.get(id);
    if (!entry) return;
    await rm(entry.path, { force: true });
    this.files.delete(posix(relative(this.opts.dir, entry.path)));
    this.resolve();
    this.save();
  }
}
