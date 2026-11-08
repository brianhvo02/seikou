// SPDX-License-Identifier: LGPL-3.0-or-later
/** Keeps a fansub release's subtitle tracks and fonts, or the user's own files, on disk under the data directory. */
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { TooLargeArchive, fontsIn7z } from '@seikou/fansubs/archive';
import { dialogueIntervals } from '@seikou/fansubs/dialogue';
import type { FetchCache } from '@seikou/fansubs/fetch-cache';
import { NotFoundOnTosho, PACK_DOWNLOAD_BYTES } from '@seikou/fansubs/tosho';
import type { Tosho } from '@seikou/fansubs/tosho';
import { fetchTrack } from '@seikou/fansubs/tracks';
import { trackKind } from './release-match';
import type { ReleaseFileInfo, TrackKind } from './release-match';
import { decodeSubtitleText, srtToAss } from './srt-to-ass';

/** One cached subtitle track: the file's track info plus where its ASS text lives. */
export type CachedTrack = ReleaseFileInfo['tracks'][number] & {
  /** The ASS file, relative to the data directory. */
  readonly path: string;
  /** Whether the track holds the whole dialogue or only signs and songs. */
  readonly kind: TrackKind;
  /** The number of Dialogue events in the script (`dialogueIntervals(text).length`, so comment lines are not counted). */
  readonly dialogueLines: number;
};

/** A release file with its tracks as cached. */
export interface CachedReleaseFile extends ReleaseFileInfo {
  readonly tracks: readonly CachedTrack[];
}

/** A track that was not kept, and why. */
export interface SkippedTrack {
  /** The release file the track belongs to. */
  readonly fileId: string;
  readonly name: string;
  /** The track's format as the source names it. */
  readonly format: string;
  /** A short reason: an unsupported format or a track over the size cap. */
  readonly reason: string;
}

/** A release as stored in `releases/<key>/release.json`. Every path is relative to the data directory. */
export interface CachedRelease {
  /** `tosho-<id>`, or `local-` and 16 hex digits of a hash of the uploaded names and bytes. */
  readonly key: string;
  readonly source: 'tosho' | 'local';
  /** A name to show: the Anime Tosho title, or the uploaded file name(s). */
  readonly label: string;
  /** The release group (the `[Group]` at the start of the title); empty when none, and for local files. */
  readonly group: string;
  readonly files: readonly CachedReleaseFile[];
  /** Fonts with their original file names; the files are pooled by content under `fonts/`. */
  readonly fonts: readonly { readonly name: string; readonly path: string }[];
  /** Tracks left out; absent when none were. */
  readonly skipped?: readonly SkippedTrack[];
}

/** A local upload the cache refused. */
export class UploadRejected extends Error {
  override name = 'UploadRejected';
  /** The file that was refused, so the page can name it. */
  readonly fileName: string;
  constructor(fileName: string, reason: string) {
    super(`${fileName}: ${reason}`);
    this.fileName = fileName;
  }
}

const MAX_SUBTITLE_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_FONT_UPLOAD_BYTES = 50 * 1024 * 1024;
const SUBTITLE_EXTENSIONS = new Set(['.ass', '.ssa', '.srt']);
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.woff', '.woff2']);
const KEY_PATTERN = /^(tosho-\d+|local-[0-9a-f]{16})$/;

/** Writes through a temp name and a rename, so an interrupted write leaves no half file. */
async function writeAtomically(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, file);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
}

/**
 * Stores releases under `<data>/releases/<key>/` and fonts under `<data>/fonts/<sha256>.<ext>`. A release's
 * `release.json` is written last, so a release is either complete or absent. Fonts are shared between releases.
 */
export class ReleaseCache {
  private readonly root: string;

  /** `dataDir` is the app data directory (created as needed); `deps.fetchCache` keeps the raw downloads. */
  constructor(
    dataDir: string,
    private readonly deps: { tosho: Tosho; fetchCache: FetchCache },
  ) {
    this.root = resolve(dataDir);
  }

  /**
   * Downloads release `toshoId`'s ASS, SSA and SRT tracks (SRT becomes ASS) and its font packs once, or returns the
   * stored release without any request when every track and font file it names is still there; a stored release
   * with a file gone (part of the cache removed) is fetched again and stored over the old one. Other formats are listed as skipped. A font pack Anime Tosho lacks is no
   * error. Throws `NotFoundOnTosho` when the release is unknown, and the client's errors on a failed download.
   */
  async fetchTosho(toshoId: number, signal?: AbortSignal): Promise<CachedRelease> {
    const key = `tosho-${toshoId}`;
    const stored = await this.get(key);
    if (stored && (await this.complete(stored))) return stored;
    const release = await this.deps.tosho.byId(toshoId, { signal });
    if (!release) throw new NotFoundOnTosho(`release ${toshoId}`);
    const files: CachedReleaseFile[] = [];
    const skipped: SkippedTrack[] = [];
    const fonts = new Map<string, { name: string; path: string }>();
    for (const file of release.files) {
      const fileId = String(file.id);
      const tracks: CachedTrack[] = [];
      for (const t of file.tracks) {
        const format = t.format.toUpperCase();
        const isSrt = format === 'SRT' || format === 'SUBRIP';
        if (!isSrt && format !== 'ASS' && format !== 'SSA') {
          skipped.push({ fileId, name: t.name, format: t.format, reason: 'format not supported' });
          continue;
        }
        let text: string;
        try {
          text = await fetchTrack(this.deps.fetchCache, this.deps.tosho, t, { signal });
        } catch (e) {
          if (!(e instanceof TooLargeArchive)) throw e;
          skipped.push({ fileId, name: t.name, format: t.format, reason: 'track too large' });
          continue;
        }
        const ass = isSrt ? srtToAss(text.replace(/^﻿/, '')) : text;
        tracks.push(await this.storeTrack(key, fileId, `t${t.track}`, t.name, t.language, ass));
      }
      files.push({ id: fileId, name: file.name, tracks });
      if (tracks.length > 0) await this.fetchFonts(file.id, fonts, signal);
    }
    const group = /^\[([^\]]+)\]/.exec(release.title)?.[1] ?? '';
    return this.commit({
      key,
      source: 'tosho',
      label: release.title,
      group,
      files,
      fonts: [...fonts.values()],
      ...(skipped.length > 0 ? { skipped } : {}),
    });
  }

  /**
   * Stores the user's own files: `.ass`, `.ssa` and `.srt` subtitles (at most 5 MB each; SRT becomes ASS) and fonts
   * (at most 50 MB together). Each subtitle file becomes one release file with one track named after it. The key
   * depends on the names and bytes, so the same upload is stored once. Throws `UploadRejected` naming the file for a
   * wrong extension or size or when no subtitle file is present, and `SubtitleEncodingError` for text that is not
   * UTF-8 or UTF-16 with a BOM.
   */
  async addLocal(files: readonly { name: string; bytes: Uint8Array }[]): Promise<CachedRelease> {
    const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subs: { name: string; bytes: Uint8Array }[] = [];
    const fontFiles: { name: string; bytes: Uint8Array }[] = [];
    let fontBytes = 0;
    for (const f of sorted) {
      const ext = extname(f.name).toLowerCase();
      if (SUBTITLE_EXTENSIONS.has(ext)) {
        if (f.bytes.length > MAX_SUBTITLE_UPLOAD_BYTES) throw new UploadRejected(f.name, 'a subtitle file may be at most 5 MB');
        subs.push(f);
      } else if (FONT_EXTENSIONS.has(ext)) {
        fontBytes += f.bytes.length;
        if (fontBytes > MAX_FONT_UPLOAD_BYTES) throw new UploadRejected(f.name, 'fonts may be at most 50 MB together');
        fontFiles.push(f);
      } else {
        throw new UploadRejected(f.name, 'not a subtitle (.ass, .ssa, .srt) or font (.ttf, .otf, .ttc, .woff, .woff2) file');
      }
    }
    if (subs.length === 0) throw new UploadRejected('(no files)', 'no subtitle file among the uploads');
    const hash = createHash('sha256');
    for (const f of sorted) hash.update(f.name).update('\0').update(String(f.bytes.length)).update('\0').update(f.bytes);
    const key = `local-${hash.digest('hex').slice(0, 16)}`;
    const stored = await this.get(key);
    if (stored) return stored;
    const releaseFiles: CachedReleaseFile[] = [];
    for (const [i, f] of subs.entries()) {
      const text = decodeSubtitleText(f.bytes);
      const ass = extname(f.name).toLowerCase() === '.srt' ? srtToAss(text) : text;
      const fileId = `f${i}`;
      const track = await this.storeTrack(key, fileId, 't0', f.name, 'und', ass);
      releaseFiles.push({ id: fileId, name: f.name, tracks: [track] });
    }
    const fonts: { name: string; path: string }[] = [];
    for (const f of fontFiles) fonts.push({ name: f.name, path: await this.storeFont(f.name, f.bytes) });
    const label = subs.length === 1 ? subs[0]!.name : `${subs.length} files`;
    return this.commit({ key, source: 'local', label, group: '', files: releaseFiles, fonts });
  }

  /** The stored release for `key`, or null when none is stored (or the key is not one the cache makes). */
  async get(key: string): Promise<CachedRelease | null> {
    if (!KEY_PATTERN.test(key)) return null;
    try {
      return JSON.parse(await readFile(join(this.root, 'releases', key, 'release.json'), 'utf8')) as CachedRelease;
    } catch {
      return null;
    }
  }

  /** The bytes of a cached file by its path relative to the data directory; throws for a path outside it. */
  async read(relPath: string): Promise<Uint8Array> {
    const full = resolve(this.root, relPath);
    const rel = relative(this.root, full);
    if (isAbsolute(relPath) || rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`path outside the data directory: ${relPath}`);
    }
    return readFile(full);
  }

  /** Whether every track and font file `release` names is present in the data directory. */
  private async complete(release: CachedRelease): Promise<boolean> {
    const paths = [...release.files.flatMap((f) => f.tracks.map((t) => t.path)), ...release.fonts.map((f) => f.path)];
    try {
      await Promise.all(paths.map((p) => access(join(this.root, p))));
      return true;
    } catch {
      return false;
    }
  }

  private async storeTrack(
    key: string,
    fileId: string,
    trackId: string,
    name: string,
    language: string,
    ass: string,
  ): Promise<CachedTrack> {
    const path = `releases/${key}/${fileId}-${trackId}.ass`;
    await writeAtomically(join(this.root, path), ass);
    return { id: trackId, name, language, path, kind: trackKind(name), dialogueLines: dialogueIntervals(ass).length };
  }

  /** Writes a font once under its content hash and returns its relative path. */
  private async storeFont(name: string, bytes: Uint8Array): Promise<string> {
    const path = `fonts/${createHash('sha256').update(bytes).digest('hex')}${extname(name).toLowerCase()}`;
    const present = await readFile(join(this.root, path)).then(
      (b) => b.length === bytes.length,
      () => false,
    );
    if (!present) await writeAtomically(join(this.root, path), bytes);
    return path;
  }

  private async fetchFonts(fileId: number, into: Map<string, { name: string; path: string }>, signal?: AbortSignal): Promise<void> {
    const url = this.deps.tosho.fontPackUrl(fileId);
    let pack: Buffer;
    try {
      pack = await this.deps.fetchCache.get(url, () => this.deps.tosho.download(url, { signal }, PACK_DOWNLOAD_BYTES));
    } catch (e) {
      if (e instanceof NotFoundOnTosho) return;
      throw e;
    }
    for (const font of await fontsIn7z(pack)) {
      const path = await this.storeFont(font.name, font.data);
      const id = `${font.name}\0${path}`;
      if (!into.has(id)) into.set(id, { name: font.name, path });
    }
  }

  /** Writes `release.json` (the last file of a release) and returns the release as a later `get` would. */
  private async commit(release: CachedRelease): Promise<CachedRelease> {
    await writeAtomically(join(this.root, 'releases', release.key, 'release.json'), JSON.stringify(release, null, 2));
    return release;
  }
}
