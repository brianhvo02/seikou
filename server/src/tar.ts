/** A minimal ustar reader and writer: regular files only, never extracting anything to disk. */

const BLOCK = 512;
const MAX_PATH_BYTES = 255;

/** An archive with no files: the two zero blocks that end every ustar archive. */
export const EMPTY_TAR: Buffer = Buffer.alloc(2 * BLOCK);

/** The archive is malformed or holds something this reader refuses (a non-regular entry, a duplicate or unsafe path). */
export class TarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarError';
  }
}

/** One regular file of an archive. */
export interface TarEntry {
  /** The path inside the archive, prefix and name joined with `/`. */
  path: string;
  /** The content length in bytes. */
  size: number;
  /** Modification time in seconds since the epoch, as ustar stores it. */
  mtime: number;
}

function cString(block: Buffer, start: number, length: number): Buffer {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return end < 0 ? field : field.subarray(0, end);
}

function parseOctal(block: Buffer, start: number, length: number, what: string): number {
  const text = block.toString('latin1', start, start + length).replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (!/^[0-7]+$/.test(text)) throw new TarError(`bad ${what} field`);
  return parseInt(text, 8);
}

function checksum(block: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return sum;
}

function checkPath(path: string): void {
  if (path.length === 0) throw new TarError('empty path');
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) throw new TarError('path too long');
  if (path.startsWith('/')) throw new TarError('absolute path');
  for (const segment of path.split('/')) {
    if (segment === '..') throw new TarError('path escapes the archive');
    if (segment === '' || segment === '.') throw new TarError('empty or dot path segment');
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodePath(bytes: Buffer): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new TarError('path is not valid UTF-8');
  }
}

function isZero(block: Buffer): boolean {
  return block.every((b) => b === 0);
}

/** Lists the entries of a ustar archive, throwing `TarError` on anything that is not a plain, well-formed file. */
export function listTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let at = 0;
  for (;;) {
    if (at + BLOCK > archive.length) throw new TarError('archive has no end marker');
    const header = archive.subarray(at, at + BLOCK);
    if (isZero(header)) {
      if (at + 2 * BLOCK > archive.length || !isZero(archive.subarray(at + BLOCK, at + 2 * BLOCK))) {
        throw new TarError('archive has no end marker');
      }
      return entries;
    }
    if (parseOctal(header, 148, 8, 'checksum') !== checksum(header)) throw new TarError('bad header checksum');
    const magic = header.toString('latin1', 257, 263);
    if (magic !== 'ustar\0' && magic !== 'ustar ') throw new TarError('not a ustar header');
    const type = header[156]!;
    if (type !== 0x30 && type !== 0) throw new TarError('entry is not a regular file');
    const name = decodePath(cString(header, 0, 100));
    const prefix = decodePath(cString(header, 345, 155));
    const path = prefix ? `${prefix}/${name}` : name;
    checkPath(path);
    if (seen.has(path)) throw new TarError('duplicate path');
    seen.add(path);
    const size = parseOctal(header, 124, 12, 'size');
    const mtime = parseOctal(header, 136, 12, 'mtime');
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (at + BLOCK + padded > archive.length) throw new TarError('entry runs past the end of the archive');
    entries.push({ path, size, mtime });
    at += BLOCK + padded;
  }
}

function putOctal(block: Buffer, start: number, length: number, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= 8 ** (length - 1)) throw new TarError('number does not fit a header field');
  block.write(value.toString(8).padStart(length - 1, '0'), start, 'latin1');
}

function splitPath(path: string): { prefix: string; name: string } {
  const bytes = Buffer.byteLength(path);
  if (bytes <= 100) return { prefix: '', name: path };
  for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { prefix, name };
  }
  throw new TarError('path does not fit a ustar header');
}

/** Writes a ustar archive of regular files (for tests and as a reference for the player). */
export function writeTar(files: { path: string; data: Buffer; mtime: number }[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    checkPath(file.path);
    const { prefix, name } = splitPath(file.path);
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0, 'utf8');
    putOctal(header, 100, 8, 0o644);
    putOctal(header, 108, 8, 0);
    putOctal(header, 116, 8, 0);
    putOctal(header, 124, 12, file.data.length);
    putOctal(header, 136, 12, file.mtime);
    header[156] = 0x30;
    header.write('ustar\0', 257, 'latin1');
    header.write('00', 263, 'latin1');
    header.write(prefix, 345, 'utf8');
    header.write(`${checksum(header).toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    parts.push(header, file.data, Buffer.alloc(Math.ceil(file.data.length / BLOCK) * BLOCK - file.data.length));
  }
  parts.push(EMPTY_TAR);
  return Buffer.concat(parts);
}
