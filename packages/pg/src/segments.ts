/*
 * Ported from libbluray src/libbluray/decoders/graphics_processor.c (segment joining),
 * pg_decode.c (descriptors, palette, object, window, composition object) and pg.h
 * Copyright (C) 2010-2013  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ByteReader, ParseError } from '@seikou/bdmv/byte-reader';

/** pgs_segment_type_e */
export const SegmentType = {
  PALETTE: 0x14,
  OBJECT: 0x15,
  PG_COMPOSITION: 0x16,
  WINDOW: 0x17,
  IG_COMPOSITION: 0x18,
  END_OF_DISPLAY: 0x80,
  DIALOG_STYLE: 0x81,
  DIALOG_PRESENTATION: 0x82,
} as const;

/** BD_PG_PALETTE_ENTRY (Y, Cr, Cb, T) */
export interface PgPaletteEntry { readonly y: number; readonly cr: number; readonly cb: number; readonly t: number }
/** BD_PG_PALETTE: 256 entries indexed by palette index; entries never set are all zero. */
export interface PgPalette { readonly id: number; readonly version: number; readonly entries: readonly PgPaletteEntry[] }
/** BD_PG_RLE_ELEM; a zero-length element marks the end of a line. */
export interface RleElem { readonly len: number; readonly color: number }
/** BD_PG_OBJECT */
export interface PgObject { readonly id: number; readonly version: number; readonly width: number; readonly height: number; readonly img: readonly RleElem[] }
/** BD_PG_WINDOW */
export interface PgWindow { readonly id: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/** BD_PG_COMPOSITION_OBJECT (crop fields are 0 when cropFlag is false) */
export interface PgCompositionObject {
  readonly objectId: number; // object_id_ref
  readonly windowId: number; // window_id_ref
  readonly cropFlag: boolean;
  readonly forcedOnFlag: boolean;
  readonly x: number;
  readonly y: number;
  readonly cropX: number;
  readonly cropY: number;
  readonly cropW: number;
  readonly cropH: number;
}
/** BD_PG_VIDEO_DESCRIPTOR */
export interface PgVideoDescriptor { readonly width: number; readonly height: number; readonly frameRate: number }
/** BD_PG_COMPOSITION_DESCRIPTOR; state: 0 normal, 1 acquisition point, 2 epoch start */
export interface PgCompositionDescriptor { readonly number: number; readonly state: number }
/** BD_PG_SEQUENCE_DESCRIPTOR */
export interface PgSequenceDescriptor { readonly firstInSeq: boolean; readonly lastInSeq: boolean }

export const EMPTY_PALETTE_ENTRY: PgPaletteEntry = { y: 0, cr: 0, cb: 0, t: 0 };

export function decodeVideoDescriptor(r: ByteReader): PgVideoDescriptor {
  const width = r.u16();
  const height = r.u16();
  const frameRate = r.bits(4);
  r.skipBits(4);
  return { width, height, frameRate };
}

export function decodeCompositionDescriptor(r: ByteReader): PgCompositionDescriptor {
  const number = r.u16();
  const state = r.bits(2);
  r.skipBits(6);
  return { number, state };
}

export function decodeSequenceDescriptor(r: ByteReader): PgSequenceDescriptor {
  const firstInSeq = r.flag();
  const lastInSeq = r.flag();
  r.skipBits(6);
  return { firstInSeq, lastInSeq };
}

export function decodeWindow(r: ByteReader): PgWindow {
  return { id: r.u8(), x: r.u16(), y: r.u16(), width: r.u16(), height: r.u16() };
}

export function decodeCompositionObject(r: ByteReader): PgCompositionObject {
  const objectId = r.u16();
  const windowId = r.u8();
  const cropFlag = r.flag();
  const forcedOnFlag = r.flag();
  r.skipBits(6);
  const x = r.u16();
  const y = r.u16();
  let cropX = 0, cropY = 0, cropW = 0, cropH = 0;
  if (cropFlag) {
    cropX = r.u16();
    cropY = r.u16();
    cropW = r.u16();
    cropH = r.u16();
  }
  return { objectId, windowId, cropFlag, forcedOnFlag, x, y, cropX, cropY, cropW, cropH };
}

/**
 * pg_decode_palette / pg_decode_palette_update: `r` is positioned after the 3-byte segment header.
 * With `previous` the entries of that palette are kept (update, 8.8.3.1.1), otherwise they start zeroed.
 */
export function decodePalette(r: ByteReader, previous?: PgPalette): PgPalette {
  const id = r.u8();
  const version = r.u8();
  const entries: PgPaletteEntry[] = previous ? previous.entries.slice() : new Array<PgPaletteEntry>(256).fill(EMPTY_PALETTE_ENTRY);
  while (r.remaining > 0) {
    const index = r.u8();
    entries[index] = { y: r.u8(), cr: r.u8(), cb: r.u8(), t: r.u8() };
  }
  return { id, version, entries };
}

/** _decode_rle: runs until the data ends; the run lengths must add up to width * height exactly. */
function decodeRle(r: ByteReader, width: number, height: number): RleElem[] {
  const img: RleElem[] = [];
  let pixelsLeft = width * height;
  while (r.remaining > 0) {
    let len = 1;
    let color = r.bits(8);
    if (color === 0) {
      if (!r.flag()) {
        len = r.flag() ? r.bits(14) : r.bits(6);
      } else {
        len = r.flag() ? r.bits(14) : r.bits(6);
        color = r.bits(8);
      }
    }
    img.push({ len, color });
    pixelsLeft -= len;
    if (pixelsLeft < 0) throw new ParseError(`pg_decode_object(): too many pixels (${-pixelsLeft})`);
  }
  if (pixelsLeft > 0) throw new ParseError(`pg_decode_object(): missing ${pixelsLeft} pixels`);
  return img;
}

/** pg_decode_object: `r` is positioned after the 3-byte segment header; fragments must already be joined. */
export function decodeObject(r: ByteReader, written?: { id: number; version: number; width: number; height: number }): PgObject {
  // `written` receives the fields pg_decode_object has stored in the C struct when it fails part-way
  const id = r.u16();
  const version = r.u8();
  if (written) {
    written.id = id;
    written.version = version;
  }
  const sd = decodeSequenceDescriptor(r);
  if (!sd.firstInSeq) throw new ParseError('pg_decode_object(): not first in sequence');
  if (!sd.lastInSeq) throw new ParseError('pg_decode_object(): not last in sequence');
  const dataLen = (r.u8() << 16) | r.u16();
  if (dataLen !== r.remaining) throw new ParseError(`pg_decode_object(): buffer size mismatch (expected ${dataLen}, have ${r.remaining})`);
  const width = r.u16();
  const height = r.u16();
  if (written) {
    written.width = width;
    written.height = height;
  }
  return { id, version, width, height, img: decodeRle(r, width, height) };
}

interface FragmentLayout { readonly idPos: number; readonly sdPos: number; readonly dataPos: number }
const ID_LEN = 3;

function fragmentLayout(type: number): FragmentLayout | null {
  if (type === SegmentType.OBJECT) return { idPos: 3, sdPos: 6, dataPos: 7 };
  if (type === SegmentType.IG_COMPOSITION) return { idPos: 8, sdPos: 11, dataPos: 12 };
  return null;
}

function sequenceByte(b: number): PgSequenceDescriptor {
  return { firstInSeq: (b & 0x80) !== 0, lastInSeq: (b & 0x40) !== 0 };
}

function sameBytes(a: Uint8Array, b: Uint8Array, pos: number, len: number): boolean {
  for (let i = 0; i < len; i++) if (a[pos + i] !== b[pos + i]) return false;
  return true;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * _join_segment_fragments for one-segment-per-call input: ODS and ICS segments may be split over several
 * PES packets (first_in_seq without last_in_seq, then continuations with the same id bytes). Feed each
 * segment to push(); it returns the segments that are now ready to decode, in order.
 */
// Deviation from C: fragments are joined in arrival order only (no queue search); a too-short continuation is
// treated as a non-matching segment (C drops it). Readers are strict about overreads where C zero-fills.
export class SegmentJoiner {
  private chunks: Uint8Array[] = [];
  private layout: FragmentLayout | null = null;

  push(seg: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    if (this.layout) {
      const lay = this.layout;
      const head = this.chunks[0]!;
      if (seg[0] === head[0] && seg.length >= lay.sdPos + 1 && sameBytes(seg, head, lay.idPos, ID_LEN)) {
        if (seg.length > lay.dataPos) this.chunks.push(seg.subarray(lay.dataPos));
        if (sequenceByte(seg[lay.sdPos]!).lastInSeq) {
          const joined = concat(this.chunks);
          joined[lay.sdPos] = 0xff; // first + last in sequence
          this.drop();
          out.push(joined);
        }
        return out;
      }
      // not a continuation: decode what we have (it fails the sequence checks), as libbluray does
      out.push(concat(this.chunks));
      this.drop();
    }
    const lay = seg.length >= 3 ? fragmentLayout(seg[0]!) : null;
    if (!lay || seg.length < lay.sdPos + 1) {
      out.push(seg);
      return out;
    }
    const sd = sequenceByte(seg[lay.sdPos]!);
    if (sd.lastInSeq || !sd.firstInSeq) {
      out.push(seg);
      return out;
    }
    this.layout = lay;
    this.chunks = [seg];
    return out;
  }

  reset(): void {
    this.drop();
  }

  private drop(): void {
    this.chunks = [];
    this.layout = null;
  }
}
