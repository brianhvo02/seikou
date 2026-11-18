// SPDX-License-Identifier: LGPL-3.0-or-later
/** One VC-1 frame of an Annex E elementary stream: its bytes and whether they begin with a sequence or entry point header. */
export interface Vc1Frame {
  readonly bytes: Uint8Array;
  readonly entryPoint: boolean;
}

const SEQUENCE_HEADER = 0x0f;
const ENTRY_POINT = 0x0e;
const FRAME = 0x0d;

/**
 * Splits an Advanced Profile elementary stream into frames. A frame starts at its frame start code (0x0D), or at the
 * sequence or entry point header in front of it; its second field (0x0C) and user data stay with it.
 */
export function splitVc1Frames(es: Uint8Array): Vc1Frame[] {
  const starts: Array<{ at: number; entryPoint: boolean }> = [];
  let headerAt = -1;
  for (let i = 0; i + 3 < es.length; i++) {
    if (es[i] !== 0 || es[i + 1] !== 0 || es[i + 2] !== 1) continue;
    const code = es[i + 3];
    if ((code === SEQUENCE_HEADER || code === ENTRY_POINT) && headerAt < 0) headerAt = i;
    else if (code === FRAME) {
      starts.push({ at: headerAt >= 0 ? headerAt : i, entryPoint: headerAt >= 0 });
      headerAt = -1;
    }
  }
  return starts.map((s, k) => ({ bytes: es.subarray(s.at, k + 1 < starts.length ? starts[k + 1]!.at : es.length), entryPoint: s.entryPoint }));
}
