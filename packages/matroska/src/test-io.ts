// SPDX-License-Identifier: LGPL-3.0-or-later
import type { MkvSink, RangeReader } from './io';

/** An in-memory `MkvSink` for tests: `bytes()` gives the file as written so far. */
export function memorySink(): MkvSink & { bytes(): Uint8Array } {
  let data = new Uint8Array(0);
  let end = 0;
  let pos = 0;
  const put = (position: number, bytes: Uint8Array): void => {
    if (position + bytes.length > data.length) {
      const grown = new Uint8Array(Math.max(data.length * 2, position + bytes.length));
      grown.set(data);
      data = grown;
    }
    data.set(bytes, position);
    end = Math.max(end, position + bytes.length);
  };
  return {
    async write(bytes) {
      put(pos, bytes);
      pos += bytes.length;
    },
    async writeAt(position, bytes) {
      put(position, bytes);
    },
    async close() {},
    bytes: () => data.slice(0, end),
  };
}

/** A `RangeReader` over bytes held in memory; `reads` counts the calls, `maxRead` is the longest one asked for. */
export function memoryReader(bytes: Uint8Array): RangeReader & { reads: number; maxRead: number } {
  const reader = {
    size: bytes.length,
    reads: 0,
    maxRead: 0,
    async read(offset: number, length: number): Promise<Uint8Array> {
      reader.reads++;
      reader.maxRead = Math.max(reader.maxRead, length);
      return bytes.slice(offset, Math.min(bytes.length, offset + length));
    },
  };
  return reader;
}
