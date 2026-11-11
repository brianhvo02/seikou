// SPDX-License-Identifier: LGPL-3.0-or-later
// Turn an H.264 SPS NAL unit into the codec string WebCodecs wants.
import { avcCodecString } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  // #region codec
  const sps = new Uint8Array([0x67, 0x64, 0x00, 0x28, 0xac, 0xd9]); // NAL header, High profile, level 4.0
  const codec = avcCodecString(sps);
  console.log(codec); // avc1.640028
  // #endregion
  if (codec !== 'avc1.640028') throw new Error(`unexpected codec string ${codec}`);
}
