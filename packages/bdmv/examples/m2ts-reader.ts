// SPDX-License-Identifier: LGPL-3.0-or-later
// Demux the video PES packets of a clip, reading it in chunks through a ByteSource.
import { readFile } from 'node:fs/promises';
import { type ByteSource, M2tsReader, type PesPacket } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  const clip = new Uint8Array(await readFile(new URL('../../../fixtures/synthetic/disc1/BDMV/STREAM/00001.m2ts', import.meta.url)));
  const source: ByteSource = {
    exists: (path) => path === 'BDMV/STREAM/00001.m2ts',
    size: () => clip.length,
    list: () => ['00001.m2ts'],
    read: async (_path, offset, length) => clip.subarray(offset, offset + length),
  };
  const packets: PesPacket[] = [];

  // #region construct
  const reader = new M2tsReader({ source, path: 'BDMV/STREAM/00001.m2ts', startSpn: 0, pids: new Set([0x1011]) });
  // #endregion

  // #region next
  for (let chunk = await reader.next(); chunk; chunk = await reader.next()) packets.push(...chunk);
  console.log(packets.length, 'video PES packets,', reader.stats.corruptPackets, 'corrupt source packets');
  // #endregion

  // #region cancel
  reader.cancel(); // stop early: next() now answers null
  // #endregion

  if (packets.length === 0 || (await reader.next()) !== null) throw new Error('the demuxer found no video');
}
