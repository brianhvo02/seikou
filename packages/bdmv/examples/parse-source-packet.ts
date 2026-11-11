// SPDX-License-Identifier: LGPL-3.0-or-later
// Read the first transport packet of a clip.
import { readFile } from 'node:fs/promises';
import { parseSourcePacket } from '@seikou/bdmv';

export default async function example(): Promise<void> {
  // #region parse
  const clip = new Uint8Array(await readFile(new URL('../../../fixtures/synthetic/disc1/BDMV/STREAM/00001.m2ts', import.meta.url)));
  const packet = parseSourcePacket(clip, 0); // each source packet is 192 bytes
  if (packet) console.log('PID', packet.pid, 'payload bytes', packet.payload.length);
  // #endregion
  if (!packet) throw new Error('the first packet is unusable');
}
