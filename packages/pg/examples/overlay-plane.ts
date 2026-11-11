// SPDX-License-Identifier: LGPL-3.0-or-later
// Apply a display set's overlay operations to a plane and read back what changed.
import { readFile } from 'node:fs/promises';
import { parseSourcePacket, PesAssembler } from '@seikou/bdmv';
import { OverlayPlane, PgRenderer, PgSegmentDecoder, type OverlayOp } from '@seikou/pg';

export default async function example(): Promise<void> {
  const clip = new Uint8Array(await readFile(new URL('../../../fixtures/synthetic/disc-subs/BDMV/STREAM/00001.m2ts', import.meta.url)));
  const decoder = new PgSegmentDecoder();
  const ops: OverlayOp[] = [];
  const renderer = new PgRenderer({ displayFlag: () => true, onOverlay: (op) => ops.push(op) });
  const assembler = new PesAssembler((pes) => {
    const set = decoder.push(pes.payload, pes.pts ?? 0, pes.dts ?? null);
    if (set && ops.length === 0) renderer.render(set); // the first display set draws a caption
  });
  for (let offset = 0; offset + 192 <= clip.length; offset += 192) {
    const packet = parseSourcePacket(clip, offset);
    if (packet && packet.pid === 0x1200) assembler.push(packet);
  }
  assembler.flush();

  // #region construct
  const plane = new OverlayPlane(1920, 1080, { buffered: true }); // changes show at a 'flush'
  // #endregion

  // #region apply
  for (const op of ops) plane.apply(op);
  console.log('shown:', plane.hasContent);
  // #endregion

  // #region dirty
  const area = plane.dirty(); // what changed since the last takeDirty, or null
  console.log('changed area', area);
  // #endregion

  // #region rgba
  const corner = { x: area!.x, y: area!.y, w: 64, h: 32 }; // any rectangle: here the top left 64 by 32 pixels of the changed area
  const pixels = plane.rgba(corner); // RGBA bytes of just that rectangle, ready for ImageData
  console.log(pixels.length / 4, 'pixels');
  // #endregion

  // #region hash
  console.log('plane hash', plane.hash()); // 16 hex digits, the same for the same picture
  // #endregion

  // #region takeDirty
  plane.takeDirty(); // read and clear: the next call answers null until something changes
  // #endregion

  if (!area || area.w <= 0 || pixels.length !== 64 * 32 * 4 || plane.dirty() !== null) throw new Error('the caption did not reach the plane');
}
