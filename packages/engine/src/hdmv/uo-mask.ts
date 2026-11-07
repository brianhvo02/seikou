/*
 * Ported from libbluray src/libbluray/bdnav/uo_mask.c, uo_mask.h, uo_mask_table.h
 * Copyright (C) 2009-2010  John Stebbins
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

export type UoOp =
  | 'menuCall' | 'titleSearch' | 'chapterSearch' | 'timeSearch' | 'skipToNextPoint' | 'skipBackToPreviousPoint'
  | 'playFirstPlay' | 'stop' | 'pauseOn' | 'pauseOff' | 'stillOff' | 'forwardPlay' | 'backwardPlay' | 'resume'
  | 'moveUp' | 'moveDown' | 'moveLeft' | 'moveRight' | 'select' | 'activate' | 'selectAndActivate'
  | 'primaryAudioChange' | 'angleChange' | 'popupOn' | 'popupOff' | 'pgEnableDisable' | 'pgChange'
  | 'secondaryVideoEnableDisable' | 'secondaryVideoChange' | 'secondaryAudioEnableDisable' | 'secondaryAudioChange'
  | 'pipPgChange';

export type UoMask = ReadonlySet<UoOp>;

export const EMPTY_UO_MASK: UoMask = new Set<UoOp>();

/** BD_UO_MASK fields in bit order (MSB first); null marks the reserved bits that uo_mask_parse skips. */
const UO_BITS: readonly (UoOp | null)[] = [
  'menuCall', 'titleSearch', 'chapterSearch', 'timeSearch', 'skipToNextPoint', 'skipBackToPreviousPoint',
  'playFirstPlay', 'stop', 'pauseOn', 'pauseOff', 'stillOff', 'forwardPlay', 'backwardPlay', 'resume',
  'moveUp', 'moveDown', 'moveLeft', 'moveRight', 'select', 'activate', 'selectAndActivate',
  'primaryAudioChange', null, 'angleChange', 'popupOn', 'popupOff', 'pgEnableDisable', 'pgChange',
  'secondaryVideoEnableDisable', 'secondaryVideoChange', 'secondaryAudioEnableDisable', 'secondaryAudioChange',
  null, 'pipPgChange',
];

/** uo_mask_parse: reads the 8-byte UO mask table. */
export function parseUoMaskTable(bytes: Uint8Array, offset = 0): UoMask {
  if (offset < 0 || offset + 8 > bytes.length) throw new RangeError('UO mask table needs 8 bytes');
  const ops = new Set<UoOp>();
  UO_BITS.forEach((op, i) => {
    if (op !== null && (bytes[offset + (i >> 3)]! & (0x80 >> (i & 7))) !== 0) ops.add(op);
  });
  return ops;
}

/** uo_mask_combine */
export function combineUoMasks(a: UoMask, b: UoMask): UoMask {
  return new Set<UoOp>([...a, ...b]);
}

/** bdpriv_get_uo_mask: the BD_UO_MASK bit-field struct read as a uint64 (field i is bit i). */
export function uoMaskBits(mask: UoMask): bigint {
  let bits = 0n;
  UO_BITS.forEach((op, i) => {
    if (op !== null && mask.has(op)) bits |= 1n << BigInt(i);
  });
  return bits;
}
