/*
 * Ported from libbluray src/libbluray/decoders/pg_decode.c, pg.h and the PG parts of graphics_processor.c
 * Copyright (C) 2010-2013  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ByteReader, ParseError } from '@seikou/bdmv/byte-reader';
import {
  SegmentJoiner, SegmentType, decodeCompositionDescriptor, decodeCompositionObject, decodeObject, decodePalette,
  decodeVideoDescriptor, decodeWindow,
  type PgCompositionDescriptor, type PgCompositionObject, type PgObject, type PgPalette, type PgVideoDescriptor, type PgWindow,
} from './segments';

/**
 * A decoded presentation composition segment, libbluray `pg.h` `BD_PG_COMPOSITION`: what one display set shows.
 * `paletteIdRef` names the palette to draw with, `paletteUpdateFlag` says the set only changes the palette, and
 * `pts` is the presentation time of the segment in 90 kHz ticks as the caller passed it.
 */
export interface PgComposition {
  readonly videoDescriptor: PgVideoDescriptor;
  readonly compositionDescriptor: PgCompositionDescriptor;
  readonly paletteUpdateFlag: boolean;
  readonly paletteIdRef: number;
  readonly compositionObjects: readonly PgCompositionObject[];
  readonly pts: number;
}

/**
 * A complete display set (libbluray `PG_DISPLAY_SET`) as `graphics_processor_decode_pes` hands it to the graphics
 * controller: one composition with the windows, palettes and objects it draws from. `pts` and `dts` are 90 kHz
 * ticks (`dts` is null when the PES had none), `epochStart` says the composition began a new epoch, and `palettes`
 * and `objects` are keyed by id and hold everything the epoch has defined so far.
 */
export interface PgDisplaySet {
  readonly pts: number; // the PCS PTS (valid_pts)
  readonly dts: number | null;
  readonly epochStart: boolean;
  readonly composition: PgComposition;
  readonly windows: readonly PgWindow[];
  readonly palettes: ReadonlyMap<number, PgPalette>;
  readonly objects: ReadonlyMap<number, PgObject>;
}

/**
 * `pg_decode_composition`: reads a presentation composition segment, with `r` positioned after the 3-byte segment header. `pts` is stored in the result.
 * @internal
 */
export function decodeComposition(r: ByteReader, pts: number): PgComposition {
  const videoDescriptor = decodeVideoDescriptor(r);
  const compositionDescriptor = decodeCompositionDescriptor(r);
  const paletteUpdateFlag = r.flag();
  r.skipBits(7);
  const paletteIdRef = r.u8();
  const num = r.u8();
  const compositionObjects: PgCompositionObject[] = [];
  for (let i = 0; i < num; i++) compositionObjects.push(decodeCompositionObject(r));
  return { videoDescriptor, compositionDescriptor, paletteUpdateFlag, paletteIdRef, compositionObjects, pts };
}

/**
 * `pg_decode_windows`: reads a window definition segment (a count, then that many windows).
 * @internal
 */
export function decodeWindows(r: ByteReader): PgWindow[] {
  const num = r.u8();
  const windows: PgWindow[] = [];
  for (let i = 0; i < num; i++) windows.push(decodeWindow(r));
  return windows;
}

/**
 * The PG half of libbluray's `graphics_processor.c`: the display set state plus `graphics_processor_decode_pes`.
 * Feed one PES payload (one segment) per `push`; an END segment completes the display set. The caller does the
 * decode time gating (the system time clock check in C), pushing each unit when the clock reaches its DTS. It runs
 * in whichever context the caller runs it in and keeps no timers. A corrupt segment is dropped and counted in
 * `errors`; other exceptions propagate.
 */
export class PgSegmentDecoder {
  /** The number of corrupt segments dropped so far (those that threw `ParseError`). */
  errors = 0;

  private readonly joiner = new SegmentJoiner();
  private pcs: PgComposition | null = null;
  private pcsDts: number | null = null;
  private decoding = false;
  private epochStart = false;
  private validPts = 0;
  private windows: PgWindow[] = [];
  private palettes = new Map<number, PgPalette>();
  private objects = new Map<number, PgObject>();

  /**
   * Decodes one segment's payload. `pts` and `dts` are the PES timestamps (90 kHz) and are kept by a composition
   * segment. Returns the complete display set when the END segment arrives, else null.
   */
  push(payload: Uint8Array, pts: number, dts: number | null): PgDisplaySet | null {
    let result: PgDisplaySet | null = null;
    for (const seg of this.joiner.push(payload)) {
      if (seg.length <= 2) continue; // segment too short, skipping
      try {
        if (this.decodeSegment(seg, pts, dts) && this.pcs) {
          result = {
            pts: this.validPts,
            dts: this.pcsDts,
            epochStart: this.epochStart,
            composition: this.pcs,
            windows: this.windows,
            palettes: new Map(this.palettes),
            objects: new Map(this.objects),
          };
        }
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.errors++;
      }
    }
    return result;
  }

  /** Drops a half-received display set (a seek cut it); the epoch's objects and palettes stay. */
  discardPartial(): void {
    this.joiner.reset();
    this.decoding = false;
  }

  /** Forgets everything including the epoch (`_reset_pg`). */
  reset(): void {
    this.joiner.reset();
    this.pcs = null;
    this.pcsDts = null;
    this.decoding = false;
    this.epochStart = false;
    this.validPts = 0;
    this.windows = [];
    this.palettes = new Map();
    this.objects = new Map();
  }

  /** _decode_segment; true when the display set is complete. */
  private decodeSegment(seg: Uint8Array, pts: number, dts: number | null): boolean {
    const r = new ByteReader(seg, 3);
    switch (seg[0]) {
      case SegmentType.OBJECT:
        this.decodeOds(r);
        return false;
      case SegmentType.PALETTE:
        this.decodePds(r);
        return false;
      case SegmentType.WINDOW:
        this.decodeWds(r);
        return false;
      case SegmentType.PG_COMPOSITION:
        this.decodePcs(r, pts, dts);
        return false;
      case SegmentType.END_OF_DISPLAY:
        if (!this.decoding) return false; // orphan end of display segment
        this.decoding = false;
        return true;
      default:
        return false; // IG / TextST segments and unknown types are not handled here
    }
  }

  /** _decode_wds */
  private decodeWds(r: ByteReader): void {
    if (!this.decoding) return; // orphan window definition segment
    this.windows = [];
    this.windows = decodeWindows(r);
  }

  /** _decode_ods: a failed decode keeps an existing entry without image data, as libbluray does. */
  private decodeOds(r: ByteReader): void {
    if (!this.decoding) return; // orphan object definition segment
    const start = r.position;
    const id = r.u16();
    r.seek(start);
    const prev = this.objects.get(id);
    const written = { id, version: prev?.version ?? 0, width: prev?.width ?? 0, height: prev?.height ?? 0 };
    try {
      this.objects.set(id, decodeObject(r, written));
    } catch (e) {
      if (prev) this.objects.set(id, { ...written, img: [] });
      throw e;
    }
  }

  /** _decode_pds */
  private decodePds(r: ByteReader): void {
    if (!this.decoding) return; // orphan palette definition segment
    const start = r.position;
    const existing = this.palettes.get(r.u8());
    r.seek(start);
    // In a normal-state composition (state 0) a palette segment with the id of an existing palette is an update:
    // entries it does not mention keep their colours. In any other state the segment replaces the palette whole.
    const update = existing !== undefined && this.pcs !== null && this.pcs.compositionDescriptor.state === 0;
    const palette = decodePalette(r, update ? existing : undefined);
    this.palettes.set(palette.id, palette);
  }

  /** _decode_pcs + _check_epoch_start */
  private decodePcs(r: ByteReader, pts: number, dts: number | null): void {
    this.pcs = null;
    this.pcs = decodeComposition(r, pts);
    this.pcsDts = dts;
    this.validPts = pts;
    if (this.pcs.compositionDescriptor.state === 2) {
      this.windows = [];
      this.palettes = new Map();
      this.objects = new Map();
      this.epochStart = true;
    } else {
      this.epochStart = false;
    }
    this.decoding = true;
  }
}
