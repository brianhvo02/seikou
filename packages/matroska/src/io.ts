// SPDX-License-Identifier: LGPL-3.0-or-later

/** A source of bytes read by position: a file, an HTTP resource read with range requests, a blob. */
export interface RangeReader {
  /** Total length in bytes. */
  readonly size: number;
  /**
   * Reads up to `length` bytes starting at `offset`. Returns fewer only at the end of the
   * data, and an empty array at or past it. Rejects when `signal` aborts.
   */
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/**
 * Where `writeMatroska` puts a file. `write` appends at the current end; `writeAt` overwrites
 * bytes already written (the Segment size, the SeekHead and the duration, which are only known at
 * the end) and leaves the append position where it was.
 */
export interface MkvSink {
  /** Appends `bytes` after everything written with `write`. */
  write(bytes: Uint8Array): Promise<void>;
  /** Overwrites the bytes at `position` with `bytes`; the range must already have been written. */
  writeAt(position: number, bytes: Uint8Array): Promise<void>;
  /** Finishes the file and releases what the sink holds. Called once, also when writing fails. */
  close(): Promise<void>;
}
