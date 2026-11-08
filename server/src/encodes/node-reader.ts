// SPDX-License-Identifier: LGPL-3.0-or-later
import { open } from 'node:fs/promises';
import type { RangeReader } from '@seikou/matroska';

/** Runs `fn` with a `RangeReader` over a file: one handle for all of its reads, closed afterwards. */
export async function withFileReader<T>(path: string, fn: (reader: RangeReader) => Promise<T>): Promise<T> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const reader: RangeReader = {
      name: path,
      size,
      async read(offset, length, signal) {
        signal?.throwIfAborted();
        if (offset >= size || length <= 0) return new Uint8Array(0);
        const want = Math.min(length, size - offset);
        const buffer = new Uint8Array(want);
        let got = 0;
        while (got < want) {
          const { bytesRead } = await handle.read(buffer, got, want - got, offset + got);
          if (bytesRead === 0) break;
          got += bytesRead;
        }
        return got === want ? buffer : buffer.subarray(0, got);
      },
    };
    return await fn(reader);
  } finally {
    await handle.close();
  }
}
