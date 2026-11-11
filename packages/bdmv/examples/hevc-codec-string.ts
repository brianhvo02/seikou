// SPDX-License-Identifier: LGPL-3.0-or-later
// Turn an HEVC SPS NAL unit into the codec string WebCodecs wants.
import { hevcCodecString } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  // #region codec
  const sps = new Uint8Array(20);
  sps.set([0x42, 0x01, 0x01], 0); // NAL header, then the VPS id
  sps.set([0x01, 0x60, 0x00, 0x00, 0x00], 3); // Main profile and its compatibility flags
  sps.set([0x90, 0, 0, 0, 0, 0], 8); // constraint flags
  sps[14] = 120; // level 4.0
  const codec = hevcCodecString(sps);
  console.log(codec); // hev1.1.6.L120.90
  // #endregion
  if (codec !== 'hev1.1.6.L120.90') throw new Error(`unexpected codec string ${codec}`);
}
