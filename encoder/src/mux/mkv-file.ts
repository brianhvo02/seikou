// SPDX-License-Identifier: LGPL-3.0-or-later
import { readMatroska, writeMatroska, type MkvInput, type MkvResult, type ParsedMkv } from '@seikou/matroska';
import { nodeFileSink, nodeRangeReader } from './node-io';

/** Writes `input` as a Matroska or WebM file at `path`, replacing it. On an error the file is left partial. */
export async function writeMkv(path: string, input: MkvInput): Promise<MkvResult> {
  return writeMatroska(await nodeFileSink(path), input);
}

/** Reads the description of the Matroska or WebM file at `path` (see `readMatroska`); `blocks()` reads the file again on each call. */
export async function readMkv(path: string): Promise<ParsedMkv> {
  return readMatroska(await nodeRangeReader(path));
}
