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

/**
 * The segment type byte that starts every Presentation Graphics (PG) and Interactive Graphics (IG) segment
 * on a disc, as libbluray `graphics_processor.c` names them in `pgs_segment_type_e`. PALETTE is the palette
 * definition segment (PDS), OBJECT the object definition segment (ODS), PG_COMPOSITION the presentation
 * composition segment (PCS), WINDOW the window definition segment (WDS) and END_OF_DISPLAY the END segment that
 * closes a display set. IG_COMPOSITION is the interactive composition segment (ICS). The two dialog values
 * are text subtitle (TextST) segments, which this package does not decode.
 */
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

/**
 * One palette colour, libbluray `pg.h` `BD_PG_PALETTE_ENTRY`: luma `y`, chroma `cr` and `cb`, and `t`, the
 * transparency (alpha, 0 clear to 255 opaque). All four are single bytes as stored on the disc, in
 * limited-range BT.709 (see `ycrcbToRgba`).
 */
export interface PgPaletteEntry { readonly y: number; readonly cr: number; readonly cb: number; readonly t: number }
/**
 * A palette definition segment, libbluray `pg.h` `BD_PG_PALETTE`. `entries` always holds 256 entries indexed by the
 * palette index an object's pixels carry; entries the disc never set are all zero. `id` is the palette id a
 * composition names in `paletteIdRef`, and `version` is the version byte read from the segment (the decoder does not count versions).
 */
export interface PgPalette { readonly id: number; readonly version: number; readonly entries: readonly PgPaletteEntry[] }
/**
 * One run of a run-length coded image, libbluray `pg.h` `BD_PG_RLE_ELEM`: `len` pixels of palette index `color`.
 * A `len` of 0 marks the end of a line.
 */
export interface RleElem { readonly len: number; readonly color: number }
/**
 * A decoded object definition segment, libbluray `pg.h` `BD_PG_OBJECT`: a bitmap `width` by `height` pixels in
 * `img` as run-length elements, drawn through a palette. `id` is what compositions name in `objectId`; `version`
 * is the version byte read from the segment (the decoder does not count versions).
 */
export interface PgObject { readonly id: number; readonly version: number; readonly width: number; readonly height: number; readonly img: readonly RleElem[] }
/**
 * One window of a window definition segment, libbluray `pg.h` `BD_PG_WINDOW`: a rectangle of the plane
 * (`x`, `y` of its top left corner, `width`, `height`, all in pixels of the video frame) in which the composition
 * objects that name it as `windowId` are shown.
 */
export interface PgWindow { readonly id: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/**
 * One object a presentation composition segment places, libbluray `pg.h` `BD_PG_COMPOSITION_OBJECT`. `x` and `y`
 * are the object's top left corner on the plane in video pixels. `cropFlag` says the object is shown cropped to
 * the rectangle `cropX`, `cropY`, `cropW`, `cropH` of its own bitmap; the four crop fields are 0 when it is false.
 * `forcedOnFlag` marks a forced subtitle, shown even when the viewer has subtitles off.
 */
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
/**
 * The video size a composition was authored for, libbluray `pg.h` `BD_PG_VIDEO_DESCRIPTOR`: `width` and `height`
 * in pixels, and `frameRate`, the 4-bit frame rate code as stored on the disc (not frames per second).
 */
export interface PgVideoDescriptor { readonly width: number; readonly height: number; readonly frameRate: number }
/**
 * Where a composition sits in the stream, libbluray `pg.h` `BD_PG_COMPOSITION_DESCRIPTOR`. `number` counts
 * compositions. `state` is 0 for a normal composition that changes the current display, 1 for an acquisition
 * point that carries everything the display needs, and 2 for an epoch start, which discards all objects, palettes
 * and windows of the previous epoch.
 */
export interface PgCompositionDescriptor { readonly number: number; readonly state: number }
/**
 * Whether a segment is the first and the last piece of its data, libbluray `pg.h` `BD_PG_SEQUENCE_DESCRIPTOR`. An
 * object that is too large for one segment is split over several, the first with `firstInSeq` and the last with
 * `lastInSeq`.
 */
export interface PgSequenceDescriptor { readonly firstInSeq: boolean; readonly lastInSeq: boolean }

/** The all-zero (fully transparent) palette entry that a palette starts from. */
export const EMPTY_PALETTE_ENTRY: PgPaletteEntry = { y: 0, cr: 0, cb: 0, t: 0 };

/** `pg_decode_video_descriptor`: reads the video size and frame rate code (5 bytes). */
export function decodeVideoDescriptor(r: ByteReader): PgVideoDescriptor {
  const width = r.u16();
  const height = r.u16();
  const frameRate = r.bits(4);
  r.skipBits(4);
  return { width, height, frameRate };
}

/** `pg_decode_composition_descriptor`: reads the composition number and state (3 bytes). */
export function decodeCompositionDescriptor(r: ByteReader): PgCompositionDescriptor {
  const number = r.u16();
  const state = r.bits(2);
  r.skipBits(6);
  return { number, state };
}

/** `pg_decode_sequence_descriptor`: reads the first and last in sequence flags (1 byte). */
export function decodeSequenceDescriptor(r: ByteReader): PgSequenceDescriptor {
  const firstInSeq = r.flag();
  const lastInSeq = r.flag();
  r.skipBits(6);
  return { firstInSeq, lastInSeq };
}

/** `pg_decode_window`: reads one window, its id and rectangle (9 bytes). */
export function decodeWindow(r: ByteReader): PgWindow {
  return { id: r.u8(), x: r.u16(), y: r.u16(), width: r.u16(), height: r.u16() };
}

/** `pg_decode_composition_object`: reads one object placement, with the crop rectangle only when its flag is set. */
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
 * `pg_decode_palette` and `pg_decode_palette_update`: reads a palette definition segment, with `r` positioned
 * after the 3-byte segment header. With `previous` the entries of that palette are kept and the segment's entries
 * replace only the ones it names (an update), otherwise all entries start zeroed. A truncated segment throws
 * `ParseError` from the reader.
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

/** `_decode_rle`: reads run-length elements until the data ends. Throws `ParseError` unless the run lengths add up to width * height exactly. */
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

/**
 * `pg_decode_object`: reads an object definition segment, with `r` positioned after the 3-byte segment header and
 * fragments already joined (see `SegmentJoiner`). Throws `ParseError` for a segment that is not whole or whose pixels
 * do not add up. `written`, when given, receives the id, version, width and height read before a failure.
 */
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
 * libbluray `graphics_processor.c` `_join_segment_fragments`, for input that arrives one segment per call: ODS and
 * ICS segments may be split over several PES packets (first_in_seq without last_in_seq, then continuations with the
 * same id bytes). Feed each segment to `push`; it returns the segments that are now ready to decode, in order.
 * Deviation from the C code: fragments are joined in arrival order only (no queue search); a too-short continuation is
 * treated as a non-matching segment (C drops it). Readers are strict about overreads where C zero-fills.
 */
export class SegmentJoiner {
  private chunks: Uint8Array[] = [];
  private layout: FragmentLayout | null = null;

  /**
   * Takes one whole segment (type byte first) and returns the segments ready to decode: the segment itself when it
   * is not fragmented, the joined segment once its last fragment arrives, nothing while fragments are pending, and
   * the incomplete pending data (which then fails its sequence checks) when a non-continuation arrives.
   */
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

  /** Forgets any fragments waiting for their continuation. */
  reset(): void {
    this.drop();
  }

  private drop(): void {
    this.chunks = [];
    this.layout = null;
  }
}
