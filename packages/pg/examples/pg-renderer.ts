// SPDX-License-Identifier: LGPL-3.0-or-later
// Render display sets into overlay operations, the way the player's graphics controller does for PG.
import { readFile } from 'node:fs/promises';
import { parseSourcePacket, PesAssembler } from '@seikou/bdmv';
import { PgRenderer, PgSegmentDecoder, type OverlayOp, type PgDisplaySet } from '@seikou/pg';

export default async function example(): Promise<void> {
  const clip = new Uint8Array(await readFile(new URL('../../../fixtures/synthetic/disc-subs/BDMV/STREAM/00001.m2ts', import.meta.url)));
  const decoder = new PgSegmentDecoder();
  const sets: PgDisplaySet[] = [];
  const assembler = new PesAssembler((pes) => {
    const set = decoder.push(pes.payload, pes.pts ?? 0, pes.dts ?? null);
    if (set) sets.push(set);
  });
  for (let offset = 0; offset + 192 <= clip.length; offset += 192) {
    const packet = parseSourcePacket(clip, offset);
    if (packet && packet.pid === 0x1200) assembler.push(packet);
  }
  assembler.flush();
  const ops: OverlayOp[] = [];

  // #region construct
  const renderer = new PgRenderer({
    displayFlag: () => true, // subtitles are on (bit 31 of PSR2); false would draw only forced objects
    onOverlay: (op) => ops.push(op),
  });
  // #endregion

  // #region render
  const drawn = renderer.render(sets[0]!); // the number of composition objects drawn
  console.log(drawn, 'object drawn:', ops.map((op) => op.cmd).join(', '));
  // #endregion

  // #region reset
  renderer.reset(); // closes the overlay: the last operation is a 'close'
  // #endregion

  if (drawn !== 1 || ops.at(-1)?.cmd !== 'close' || renderer.open) throw new Error('the display set was not rendered');
}
