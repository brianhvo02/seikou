// SPDX-License-Identifier: LGPL-3.0-or-later
import { open, stat } from 'node:fs/promises';
import type { MkvSink, RangeReader } from '@seikou/matroska';

/**
 * A `RangeReader` over the file at `path`. It opens the file for each read, so it holds no file
 * handle and needs no closing; the size is the file's size when this is called.
 */
export async function nodeRangeReader(path: string): Promise<RangeReader> {
  const size = (await stat(path)).size;
  return {
    size,
    name: path,
    async read(offset, length, signal) {
      signal?.throwIfAborted();
      const buf = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
      if (buf.length === 0) return buf;
      const fh = await open(path, 'r');
      try {
        let done = 0;
        while (done < buf.length) {
          const { bytesRead } = await fh.read(buf, done, buf.length - done, offset + done);
          if (bytesRead === 0) break;
          done += bytesRead;
        }
        return buf.subarray(0, done);
      } finally {
        await fh.close();
      }
    },
  };
}

/** An `MkvSink` that writes the file at `path`, replacing it if it exists. */
export async function nodeFileSink(path: string): Promise<MkvSink> {
  const fh = await open(path, 'w');
  let pos = 0;
  const writeAll = async (data: Uint8Array, position: number): Promise<void> => {
    let done = 0;
    while (done < data.length) {
      const { bytesWritten } = await fh.write(data, done, data.length - done, position + done);
      done += bytesWritten;
    }
  };
  return {
    async write(bytes) {
      await writeAll(bytes, pos);
      pos += bytes.length;
    },
    writeAt: (position, bytes) => writeAll(bytes, position),
    close: () => fh.close(),
  };
}
