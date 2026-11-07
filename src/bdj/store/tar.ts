/*
 * Original code for bluray-web: a scope's snapshot as the NAS store keeps it, a POSIX ustar archive of regular files
 * (the NAS store contract: `ustar\0` + `00` headers, typeflag '0', paths of at most 255 bytes split into prefix and
 * name, mtimes in whole seconds).
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { SnapshotFile } from './bdj-store';

const BLOCK = 512;
const NAME_BYTES = 100;
const PREFIX_BYTES = 155;
const MAX_PATH_BYTES = 255;

const utf8 = new TextEncoder();
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const latin1 = (b: Uint8Array): string => String.fromCharCode(...b);

export class TarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarFormatError';
  }
}

/** A path the NAS accepts: relative, no empty, `.` or `..` segment, valid as ustar (prefix/name split). */
export function tarPathFits(path: string): boolean {
  return splitPath(path) !== null;
}

function validSegments(path: string): boolean {
  if (path.length === 0 || path.startsWith('/')) return false;
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The ustar prefix and name of `path`, or null when it does not fit (the name at most 100 bytes, the prefix 155). */
function splitPath(path: string): { readonly prefix: Uint8Array; readonly name: Uint8Array } | null {
  if (!validSegments(path)) return null;
  const all = utf8.encode(path);
  if (all.length > MAX_PATH_BYTES) return null;
  if (all.length <= NAME_BYTES) return { prefix: new Uint8Array(0), name: all };
  // the longest prefix that fits, so the name is as short as it can be
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    const prefix = utf8.encode(path.slice(0, i));
    const name = utf8.encode(path.slice(i + 1));
    if (prefix.length <= PREFIX_BYTES && name.length <= NAME_BYTES && name.length > 0) return { prefix, name };
  }
  return null;
}

function putOctal(block: Uint8Array, at: number, length: number, value: number): void {
  // length - 1 digits and a NUL
  const text = value.toString(8).padStart(length - 1, '0');
  if (text.length > length - 1) throw new TarFormatError('a number does not fit its header field');
  for (let i = 0; i < text.length; i++) block[at + i] = text.charCodeAt(i);
  block[at + length - 1] = 0;
}

function putText(block: Uint8Array, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) block[at + i] = text.charCodeAt(i);
}

function checksum(block: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return sum;
}

/**
 * The archive of `files`, each a regular file (mode 0644) with its mtime in whole seconds (floor). A path that does
 * not fit a ustar header throws: callers leave such files out first (tarPathFits).
 */
export function writeTar(files: readonly SnapshotFile[]): Uint8Array<ArrayBuffer> {
  let size = 2 * BLOCK;
  for (const f of files) size += BLOCK + Math.ceil(f.bytes.length / BLOCK) * BLOCK;
  const out = new Uint8Array(size);
  let at = 0;
  for (const f of files) {
    const split = splitPath(f.path);
    if (!split) throw new TarFormatError(`${f.path}: the path does not fit a ustar header`);
    const header = out.subarray(at, at + BLOCK);
    header.set(split.name, 0);
    putOctal(header, 100, 8, 0o644);
    putOctal(header, 108, 8, 0);
    putOctal(header, 116, 8, 0);
    putOctal(header, 124, 12, f.bytes.length);
    putOctal(header, 136, 12, Math.max(0, Math.floor(f.mtime / 1000)));
    header[156] = 0x30; // '0': a regular file
    putText(header, 257, 'ustar\0');
    putText(header, 263, '00');
    header.set(split.prefix, 345);
    putText(header, 148, `${checksum(header).toString(8).padStart(6, '0')}\0 `);
    out.set(f.bytes, at + BLOCK);
    at += BLOCK + Math.ceil(f.bytes.length / BLOCK) * BLOCK;
  }
  return out; // ends in two zero blocks
}

function cString(block: Uint8Array, at: number, length: number): Uint8Array {
  const field = block.subarray(at, at + length);
  const end = field.indexOf(0);
  return end < 0 ? field : field.subarray(0, end);
}

function readOctal(block: Uint8Array, at: number, length: number, what: string): number {
  const text = latin1(block.subarray(at, at + length)).replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (!/^[0-7]+$/.test(text)) throw new TarFormatError(`bad ${what} field`);
  return parseInt(text, 8);
}

const isZero = (b: Uint8Array): boolean => b.every((x) => x === 0);

/** The files of a ustar archive (POSIX or GNU magic, regular files only), mtimes in ms; anything else throws. */
export function readTar(archive: Uint8Array): SnapshotFile[] {
  const files: SnapshotFile[] = [];
  const seen = new Set<string>();
  let at = 0;
  for (;;) {
    if (at + BLOCK > archive.length) throw new TarFormatError('the archive has no end marker');
    const header = archive.subarray(at, at + BLOCK);
    if (isZero(header)) return files;
    if (readOctal(header, 148, 8, 'checksum') !== checksum(header)) throw new TarFormatError('bad header checksum');
    const magic = latin1(header.subarray(257, 263));
    if (magic !== 'ustar\0' && magic !== 'ustar ') throw new TarFormatError('not a ustar header');
    const type = header[156]!;
    if (type !== 0x30 && type !== 0) throw new TarFormatError('an entry is not a regular file');
    let path: string;
    try {
      const name = utf8Strict.decode(cString(header, 0, NAME_BYTES));
      const prefix = utf8Strict.decode(cString(header, 345, PREFIX_BYTES));
      path = prefix ? `${prefix}/${name}` : name;
    } catch {
      throw new TarFormatError('a path is not valid UTF-8');
    }
    if (!validSegments(path) || seen.has(path)) throw new TarFormatError(`bad or repeated path ${JSON.stringify(path)}`);
    seen.add(path);
    const size = readOctal(header, 124, 12, 'size');
    const mtime = readOctal(header, 136, 12, 'mtime');
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (at + BLOCK + padded > archive.length) throw new TarFormatError('an entry runs past the end of the archive');
    files.push({ path, mtime: mtime * 1000, bytes: archive.slice(at + BLOCK, at + BLOCK + size) });
    at += BLOCK + padded;
  }
}
