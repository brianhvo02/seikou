// SPDX-License-Identifier: LGPL-3.0-or-later
/**
 * Soft pulldown for test streams: turns a 23.976 progressive MPEG-2 elementary stream into the 29.97 interlaced stream
 * a DVD or Blu-ray 480i film carries, by rewriting header bits only (no picture is re-encoded). The sequence header's
 * frame_rate_code becomes 4 (29.97), the sequence extension's progressive_sequence 0, and each picture coding
 * extension, in presentation order, takes the 3:2 flags [top first + repeat, bottom first, bottom first + repeat, top
 * first] with progressive_frame (and chroma_420_type) 1.
 */

/** The flags of each picture in a 3:2 cycle, by its place in presentation order. */
export const PULLDOWN_CYCLE: readonly { readonly tff: boolean; readonly rff: boolean }[] = [
  { tff: true, rff: true },
  { tff: false, rff: false },
  { tff: false, rff: true },
  { tff: true, rff: false },
];

const SEQUENCE_HEADER = 0xb3;
const EXTENSION = 0xb5;
const GOP_HEADER = 0xb8;
const PICTURE = 0x00;
const SEQUENCE_EXTENSION_ID = 1;
const PICTURE_CODING_EXTENSION_ID = 8;
const FRAME_RATE_29_97 = 4;

/**
 * Returns a soft-pulldown copy of `es`, a progressive MPEG-2 stream with sequence extensions (ffmpeg's mpeg2video at
 * 24000/1001). Presentation order is each picture's temporal_reference counted from its GOP's first picture.
 */
export function softPulldown(es: Uint8Array): Uint8Array {
  const out = es.slice();
  let gopBase = 0;
  let inGop = 0;
  let display = -1;
  let patched = 0;
  for (let i = 0; i + 8 < out.length; i++) {
    if (out[i] !== 0 || out[i + 1] !== 0 || out[i + 2] !== 1) continue;
    const code = out[i + 3]!;
    const p = i + 4;
    if (code === SEQUENCE_HEADER) {
      // horizontal_size (12), vertical_size (12), aspect_ratio_information (4), frame_rate_code (4).
      out[p + 3] = (out[p + 3]! & 0xf0) | FRAME_RATE_29_97;
    } else if (code === GOP_HEADER) {
      gopBase += inGop;
      inGop = 0;
    } else if (code === PICTURE) {
      display = gopBase + ((out[p]! << 2) | (out[p + 1]! >> 6));
      inGop++;
    } else if (code === EXTENSION) {
      const id = out[p]! >> 4;
      if (id === SEQUENCE_EXTENSION_ID) {
        // progressive_sequence is bit 3 of the extension's second byte.
        out[p + 1] = out[p + 1]! & ~0x08;
      } else if (id === PICTURE_CODING_EXTENSION_ID) {
        if (display < 0) throw new Error('a picture coding extension before any picture header');
        const { tff, rff } = PULLDOWN_CYCLE[display % PULLDOWN_CYCLE.length]!;
        // Fourth byte: top_field_first (bit 7), repeat_first_field (bit 1), chroma_420_type (bit 0); fifth byte:
        // progressive_frame (bit 7).
        let b = out[p + 3]! & ~0x83;
        if (tff) b |= 0x80;
        if (rff) b |= 0x02;
        out[p + 3] = b | 0x01;
        out[p + 4] = out[p + 4]! | 0x80;
        patched++;
      }
    }
  }
  if (patched === 0) throw new Error('no picture coding extension: not an MPEG-2 stream');
  return out;
}
