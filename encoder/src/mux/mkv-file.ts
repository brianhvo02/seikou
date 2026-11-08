// SPDX-License-Identifier: LGPL-3.0-or-later
import { checkMatroskaInput, readMatroska, writeMatroska, type MkvInput, type MkvResult, type ParsedMkv } from '@seikou/matroska';
import { nodeFileSink, nodeRangeReader } from './node-io';

/**
 * Writes `input` as a Matroska or WebM file at `path`, replacing it, with `seikou-encode` as the
 * application name unless `input.appName` says otherwise. An input `writeMatroska` would refuse
 * for its subtitle blocks or its DocType throws before the file is touched; an error while
 * writing leaves the file partial.
 */
export async function writeMkv(path: string, input: MkvInput): Promise<MkvResult> {
  checkMatroskaInput(input);
  return writeMatroska(await nodeFileSink(path), { appName: 'seikou-encode', ...input });
}

/** Reads the description of the Matroska or WebM file at `path` (see `readMatroska`); `blocks()` reads the file again on each call. */
export async function readMkv(path: string): Promise<ParsedMkv> {
  return readMatroska(await nodeRangeReader(path));
}
