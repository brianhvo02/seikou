// SPDX-License-Identifier: LGPL-3.0-or-later
import type { SubtitleBlock } from '../mux/mkv-writer';

// The `.sup` file is the PGS stream as Blu-ray authoring tools exchange it: the segments of every
// display set in order, each preceded by a 10-byte header of the magic "PG" (0x50 0x47), the
// presentation time stamp and the decoding time stamp, each 32 bits big-endian on the 90 kHz clock.
// A segment itself is one byte of segment type, a 16-bit big-endian length, then that many bytes
// (Blu-ray's presentation graphics segments: PCS 0x16, WDS 0x17, PDS 0x14, ODS 0x15, END 0x80).
// The Matroska codec mapping for `S_HDMV/PGS` stores those segments without the 10-byte headers,
// one display set per block, so writing a `.sup` puts a header back in front of each segment.

/** Thrown when a block's data does not split into whole PGS segments. */
export class SupError extends Error {}

const HEADER = 10;

/**
 * Builds a `.sup` file from the blocks of an `S_HDMV/PGS` track, in order. Every segment of a
 * block gets a header of `PG`, a PTS of the block's `timeMs` in 90 kHz ticks (kept modulo 2^32,
 * as the 32-bit field is), and a DTS of 0, which players of `.sup` files ignore. Throws `SupError`
 * when a segment's length runs past the end of its block.
 */
export async function toSup(blocks: AsyncIterable<SubtitleBlock>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const block of blocks) {
    const pts90 = Math.round(block.timeMs * 90) % 2 ** 32;
    const d = block.data;
    for (let pos = 0; pos < d.length; ) {
      if (pos + 3 > d.length) throw new SupError(`a PGS block at ${block.timeMs} ms ends inside a segment header`);
      const length = 3 + ((d[pos + 1]! << 8) | d[pos + 2]!);
      if (pos + length > d.length) throw new SupError(`a PGS segment at ${block.timeMs} ms runs past the end of its block`);
      const out = new Uint8Array(HEADER + length);
      const view = new DataView(out.buffer);
      out[0] = 0x50; // P
      out[1] = 0x47; // G
      view.setUint32(2, pts90, false);
      view.setUint32(6, 0, false);
      out.set(d.subarray(pos, pos + length), HEADER);
      parts.push(out);
      total += out.length;
      pos += length;
    }
  }
  const sup = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    sup.set(p, off);
    off += p.length;
  }
  return sup;
}
