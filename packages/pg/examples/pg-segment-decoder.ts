// SPDX-License-Identifier: LGPL-3.0-or-later
// Turn the PES payloads of a clip's PG stream into display sets, segment by segment.
import { readFile } from 'node:fs/promises';
import { parseSourcePacket, PesAssembler, type PesPacket } from '@seikou/bdmv';
import { PgSegmentDecoder, type PgDisplaySet } from '@seikou/pg';

export default async function example(): Promise<void> {
  const clip = new Uint8Array(await readFile(new URL('../../../fixtures/synthetic/disc-subs/BDMV/STREAM/00001.m2ts', import.meta.url)));
  const pesPackets: PesPacket[] = [];
  const assembler = new PesAssembler((pes) => pesPackets.push(pes));
  for (let offset = 0; offset + 192 <= clip.length; offset += 192) {
    const packet = parseSourcePacket(clip, offset);
    if (packet && packet.pid === 0x1200) assembler.push(packet); // the first PG stream
  }
  assembler.flush();
  const sets: PgDisplaySet[] = [];

  // #region construct
  const decoder = new PgSegmentDecoder();
  // #endregion

  // #region push
  for (const pes of pesPackets) {
    const set = decoder.push(pes.payload, pes.pts ?? 0, pes.dts ?? null); // one segment per call
    if (set) sets.push(set); // an END segment completes a display set
  }
  console.log(sets.length, 'display sets; the first at PTS', sets[0]?.pts, 'with', sets[0]?.composition.compositionObjects.length, 'object');
  // #endregion

  // #region discardPartial
  decoder.discardPartial(); // a seek cut a display set in two: drop the half, keep the epoch's objects
  // #endregion

  // #region reset
  decoder.reset(); // forget the epoch too
  // #endregion

  if (sets.length === 0 || decoder.errors !== 0) throw new Error('the PG stream did not decode');
}
