// SPDX-License-Identifier: LGPL-3.0-or-later
// Reassemble the PES packets of a clip from its source packets.
import { readFile } from 'node:fs/promises';
import { parseSourcePacket, PesAssembler, type PesPacket } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  const clip = new Uint8Array(await readFile(new URL('../../../fixtures/synthetic/disc1/BDMV/STREAM/00001.m2ts', import.meta.url))).subarray(0, 192 * 2000);
  const found: PesPacket[] = [];

  // #region construct
  const assembler = new PesAssembler((pes) => found.push(pes));
  // #endregion

  // #region push
  for (let offset = 0; offset + 192 <= clip.length; offset += 192) {
    const packet = parseSourcePacket(clip, offset);
    if (packet && packet.pid === 0x1011) assembler.push(packet); // the video stream
  }
  // #endregion

  // #region flush
  assembler.flush(); // hands over the last unbounded PES
  console.log(found.length, 'PES packets, the first at PTS', found[0]?.pts);
  // #endregion

  // #region reset
  assembler.reset(); // after a seek: drop what is half assembled
  // #endregion

  if (found.length === 0) throw new Error('no PES packet was assembled');
}
