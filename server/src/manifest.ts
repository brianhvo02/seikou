import { readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { DiscEntry, DiscManifest } from '../../src/engine/disc/nas-api';
import type { UdfFile } from '@seikou/bdmv/udf';
import { discId } from './disc-id';
import { readIsoFiles } from './iso';

/** The top-level folders of a disc that the manifest lists and the files route serves. */
const DISC_FOLDERS = new Set(['BDMV', 'CERTIFICATE']);
/** What the engine reads whole while opening a disc (`readWhole`). */
const INLINED = /^(BDMV\/(INDEX\.BDMV|MOVIEOBJECT\.BDMV|PLAYLIST\/[^/]+\.MPLS|CLIPINF\/[^/]+\.CLPI|AUXDATA\/SOUND\.BDMV|BDJO\/[^/]+\.BDJO)|CERTIFICATE\/ID\.BDMV)$/;
const MAX_INLINE_BYTES = 1024 * 1024;
/** All a manifest inlines; files past it are listed without bytes, and the client reads them through the files route. */
const INLINE_BUDGET_BYTES = 8 * 1024 * 1024;
/** Stats and reads of a folder disc's manifest in flight at once. */
const MANIFEST_CONCURRENCY = 8;

/** `fn` over `items` with at most `limit` calls in flight, results in item order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The inline candidates among `files` (in order) that fit the manifest's inline budget together. */
function inlineCandidates<T extends { path: string; size: number }>(files: readonly T[]): T[] {
  let left = INLINE_BUDGET_BYTES;
  return files.filter((f) => {
    if (!INLINED.test(f.path) || f.size > MAX_INLINE_BYTES || f.size > left) return false;
    left -= f.size;
    return true;
  });
}

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The entry of `dir` named `name` in any case, if it is a real directory or file (symlinks are never followed). */
async function child(dir: string, name: string, want: 'dir' | 'file'): Promise<string | null> {
  const upper = name.toUpperCase();
  const found = (await entries(dir))
    .filter((e) => e.name.toUpperCase() === upper && (want === 'dir' ? e.isDirectory() : e.isFile()))
    .sort((a, b) => (a.name < b.name ? -1 : 1))[0];
  return found ? join(dir, found.name) : null;
}

/**
 * Whether the folder disc `entry` at `dir` is still the one the library scanned: its index.bdmv exists and has the
 * size and mtime its id was made from.
 */
export async function discUnchanged(entry: DiscEntry, dir: string): Promise<boolean> {
  const bdmv = await child(dir, 'BDMV', 'dir');
  const index = bdmv && (await child(bdmv, 'INDEX.BDMV', 'file'));
  if (!index) return false;
  try {
    const st = await stat(index);
    return discId(entry.path, st.size, st.mtimeMs) === entry.id;
  } catch {
    return false;
  }
}

/** The segments of a disc-relative path under BDMV or CERTIFICATE, or null for any other or an odd path. */
function discSegments(path: string): string[] | null {
  const segments = path.split('/');
  if (!DISC_FOLDERS.has(segments[0]!.toUpperCase())) return null;
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))) return null;
  return segments;
}

/** The file of an ISO disc's tree for a disc-relative path in any case, under BDMV or CERTIFICATE only. */
export function resolveIsoFile(tree: ReadonlyMap<string, UdfFile>, path: string): UdfFile | null {
  const segments = discSegments(path);
  return segments ? (tree.get(segments.join('/').toUpperCase()) ?? null) : null;
}

/**
 * The real file under the disc folder `dir` for a disc-relative path in any case ('BDMV/STREAM/00001.M2TS'), found by
 * listing each directory, so the path never reaches the filesystem as given. Null unless it names a regular file
 * under BDMV or CERTIFICATE.
 */
export async function resolveDiscFile(dir: string, path: string): Promise<string | null> {
  const segments = discSegments(path);
  if (!segments) return null;
  let current: string | null = dir;
  for (const [i, segment] of segments.entries()) {
    current = await child(current, segment, i === segments.length - 1 ? 'file' : 'dir');
    if (!current) return null;
  }
  return current;
}

/** A directory's entries: real directories and files only count (symlinks are neither). */
export type ListDir = (abs: string) => Promise<readonly { name: string; isDir: boolean; isFile: boolean }[] | null>;

/** Reads a directory's entries from disk. */
export const listDir: ListDir = async (abs) => (await entries(abs)).map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }));

/**
 * Every regular file under the disc folder's BDMV and CERTIFICATE, upper-cased; on a case clash the first name wins.
 * `list` reads each directory (a caller can pace the reads through it).
 */
export async function listFiles(dir: string, list: ListDir = listDir): Promise<{ path: string; abs: string }[]> {
  const out = new Map<string, string>();
  const walk = async (abs: string, rel: string): Promise<void> => {
    const sorted = [...((await list(abs)) ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of sorted) {
      if (e.name.startsWith('.')) continue;
      const path = rel === '' ? e.name.toUpperCase() : `${rel}/${e.name.toUpperCase()}`;
      if (rel === '' && !DISC_FOLDERS.has(path)) continue;
      if (e.isDir) await walk(join(abs, e.name), path);
      else if (e.isFile && rel !== '' && !out.has(path)) out.set(path, join(abs, e.name));
    }
  };
  await walk(dir, '');
  return [...out].map(([path, abs]) => ({ path, abs })).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The manifest of the folder disc at `dir`. */
export async function buildManifest(dir: string, disc: { id: string; name: string }): Promise<DiscManifest> {
  const stated = await mapLimit(await listFiles(dir), MANIFEST_CONCURRENCY, async ({ path, abs }) => {
    try {
      return { path, abs, size: (await stat(abs)).size };
    } catch {
      return null; // Vanished meanwhile.
    }
  });
  const present = stated.filter((f): f is { path: string; abs: string; size: number } => f !== null);
  const read = await mapLimit(inlineCandidates(present), MANIFEST_CONCURRENCY, async ({ path, abs }) => {
    try {
      return [path, (await readFile(abs)).toString('base64')] as const;
    } catch {
      return null; // Listed without its bytes: the client reads it through the files route.
    }
  });
  const inline: Record<string, string> = Object.fromEntries(read.filter((e) => e !== null));
  return { discId: disc.id, name: disc.name, files: present.map(({ path, size }) => ({ path, size })), inline };
}

/** The manifest of the ISO disc at `abs` whose UDF tree is `tree`: the same shape as a folder disc's. */
export async function buildIsoManifest(abs: string, tree: ReadonlyMap<string, UdfFile>, disc: { id: string; name: string }): Promise<DiscManifest> {
  // As for a folder disc: files under BDMV and CERTIFICATE, none hidden.
  const listed = [...tree.values()]
    .filter((f) => resolveIsoFile(tree, f.path) === f && !f.path.split('/').some((s) => s.startsWith('.')))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const bytes = await readIsoFiles(abs, inlineCandidates(listed));
  const inline: Record<string, string> = {};
  for (const [path, buf] of bytes) inline[path] = buf.toString('base64');
  return { discId: disc.id, name: disc.name, files: listed.map(({ path, size }) => ({ path, size })), inline };
}

/** The largest `.M2TS` in an ISO disc's BDMV/STREAM. */
export function largestIsoClip(tree: ReadonlyMap<string, UdfFile>): UdfFile | null {
  let best: UdfFile | null = null;
  for (const f of tree.values()) if (/^BDMV\/STREAM\/[^/]+\.M2TS$/.test(f.path) && (!best || f.size > best.size)) best = f;
  return best;
}

/** The largest `.M2TS` under the disc folder's BDMV/STREAM, with its size. */
export async function largestClip(dir: string): Promise<{ abs: string; size: number } | null> {
  const bdmv = await child(dir, 'BDMV', 'dir');
  const stream = bdmv && (await child(bdmv, 'STREAM', 'dir'));
  if (!stream) return null;
  let best: { abs: string; size: number } | null = null;
  for (const e of await entries(stream)) {
    if (!e.isFile() || !e.name.toUpperCase().endsWith('.M2TS')) continue;
    try {
      const abs = join(stream, e.name);
      const { size } = await stat(abs);
      if (!best || size > best.size) best = { abs, size };
    } catch {
      // Vanished meanwhile.
    }
  }
  return best;
}
