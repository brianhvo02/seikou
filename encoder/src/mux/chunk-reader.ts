// SPDX-License-Identifier: LGPL-3.0-or-later
import type { Readable } from 'node:stream';

/** Pulls exact byte counts from a Readable without buffering more than needed. */
export class ChunkReader {
  private readonly iterator: AsyncIterator<unknown>;
  private chunks: Uint8Array[] = [];
  private available = 0;
  private ended = false;

  /** `label` prefixes the truncation error message, e.g. "IVF" or "Ogg". */
  constructor(
    stream: Readable,
    private readonly label: string,
  ) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  /** Returns exactly n bytes, or null on a clean end of stream before the first byte. */
  async read(n: number): Promise<Uint8Array | null> {
    while (this.available < n && !this.ended) {
      const next = await this.iterator.next();
      if (next.done === true) {
        this.ended = true;
        break;
      }
      const chunk = next.value as Uint8Array;
      if (chunk.length > 0) {
        this.chunks.push(chunk);
        this.available += chunk.length;
      }
    }
    if (this.available < n) {
      if (this.available === 0) return null;
      throw new Error(`${this.label}: truncated stream (wanted ${n} bytes, got ${this.available})`);
    }
    return this.take(n);
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0]!;
      const want = Math.min(n - filled, head.length);
      out.set(head.subarray(0, want), filled);
      filled += want;
      if (want === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(want);
    }
    this.available -= n;
    return out;
  }
}
