// SPDX-License-Identifier: LGPL-3.0-or-later
import type { RangeReader } from './io';

/**
 * A `RangeReader` over a `Blob` or `File`, for a browser or a worker: each read slices the blob and
 * reads only that slice. The reader is named after the blob when it is a `File`.
  * @example ../examples/blob-range-reader.ts
 */
export function blobRangeReader(blob: Blob): RangeReader {
  const name = (blob as { name?: unknown }).name;
  return {
    size: blob.size,
    ...(typeof name === 'string' && name !== '' ? { name } : {}),
    async read(offset, length, signal) {
      signal?.throwIfAborted();
      const end = Math.min(blob.size, offset + length);
      if (offset >= end) return new Uint8Array(0);
      const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      signal?.throwIfAborted();
      return bytes;
    },
  };
}
