// SPDX-License-Identifier: LGPL-3.0-or-later

/** Splits an Annex-B stream at access unit delimiters (NAL type 9). */
export function splitAccessUnits(stream: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 3 < stream.length; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1 && (stream[i + 3] & 0x1f) === 9) {
      starts.push(i > 0 && stream[i - 1] === 0 ? i - 1 : i);
    }
  }
  return starts.map((s, k) => stream.subarray(s, k + 1 < starts.length ? starts[k + 1] : stream.length));
}
