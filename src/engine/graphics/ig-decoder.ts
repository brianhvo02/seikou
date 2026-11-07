/*
 * Ported from libbluray src/libbluray/decoders/ig_decode.c, ig.h and the IG parts of graphics_processor.c
 * Copyright (C) 2010-2013  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { parseMobjCmd, type MobjCmd } from '../bdmv/mobj-parser';
import { parseUoMaskTable, type UoMask } from '../hdmv/uo-mask';
import { ByteReader, ParseError } from '@seikou/bdmv/byte-reader';
import {
  SegmentJoiner, SegmentType, decodeCompositionDescriptor, decodeCompositionObject, decodeObject, decodePalette,
  decodeSequenceDescriptor, decodeVideoDescriptor, decodeWindow,
  type PgCompositionObject, type PgObject, type PgPalette, type PgWindow,
} from './segments';

const NAV_CMD_SIZE = 12;

/** BD_IG_BUTTON. Neighbour refs (upper/lower/left/right) use 0xffff for "no button", as in libbluray. */
export interface IgButton {
  readonly id: number;
  readonly numericSelectValue: number; // numeric_select_value
  readonly autoActionFlag: boolean;
  readonly x: number; // x_pos
  readonly y: number; // y_pos
  readonly upper: number; // upper_button_id_ref
  readonly lower: number; // lower_button_id_ref
  readonly left: number; // left_button_id_ref
  readonly right: number; // right_button_id_ref
  readonly normalStart: number; // normal_start_object_id_ref
  readonly normalEnd: number;
  readonly normalRepeat: boolean;
  readonly selectedSound: number; // selected_sound_id_ref
  readonly selectedStart: number;
  readonly selectedEnd: number;
  readonly selectedRepeat: boolean;
  readonly activatedSound: number;
  readonly activatedStart: number;
  readonly activatedEnd: number;
  readonly navCmds: readonly MobjCmd[];
}
/** BD_IG_BOG */
export interface IgBog { readonly defaultValidButton: number; readonly buttons: readonly IgButton[] } // default_valid_button_id_ref
/** BD_IG_EFFECT (duration in 90 kHz ticks) */
export interface IgEffect { readonly duration: number; readonly paletteId: number; readonly compositionObjects: readonly PgCompositionObject[] }
/** BD_IG_EFFECT_SEQUENCE */
export interface IgEffectSequence { readonly windows: readonly PgWindow[]; readonly effects: readonly IgEffect[] }
/** BD_IG_PAGE */
export interface IgPage {
  readonly id: number;
  readonly version: number;
  readonly uoMask: UoMask; // uo_mask_table
  readonly inEffects: IgEffectSequence;
  readonly outEffects: IgEffectSequence;
  readonly animationFrameRateCode: number;
  readonly defaultSelectedButton: number; // default_selected_button_id_ref
  readonly defaultActivatedButton: number;
  readonly paletteId: number; // palette_id_ref
  readonly bogs: readonly IgBog[];
}
/**
 * BD_IG_INTERACTIVE (the segment) merged with BD_IG_INTERACTIVE_COMPOSITION. The video and composition
 * descriptor fields are an addition to the Task 9 interface so the graphics controller can size its planes.
 */
export interface IgComposition {
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly frameRate: number; // video_descriptor.frame_rate code
  readonly compositionNumber: number;
  readonly compositionState: number; // 0 normal, 1 acquisition point, 2 epoch start
  readonly streamModel: number; // 0 multiplexed with the timeouts below, 1 out of mux
  readonly uiModel: 0 | 1; // 0 always on, 1 pop-up
  readonly compositionTimeoutPts: number; // 0 unless streamModel is 0
  readonly selectionTimeoutPts: number;
  readonly userTimeoutDuration: number;
  readonly pages: readonly IgPage[];
}
export interface IgDisplaySet {
  readonly pts: number;
  readonly epochStart: boolean;
  readonly composition: IgComposition | null;
  readonly palettes: ReadonlyMap<number, PgPalette>;
  readonly objects: ReadonlyMap<number, PgObject>;
  readonly complete: boolean;
}

const u24 = (r: ByteReader): number => (r.u8() << 16) | r.u16();

/** _decode_button */
function decodeButton(r: ByteReader): IgButton {
  const id = r.u16();
  const numericSelectValue = r.u16();
  const autoActionFlag = r.flag();
  r.skipBits(7);
  const x = r.u16();
  const y = r.u16();
  const upper = r.u16();
  const lower = r.u16();
  const left = r.u16();
  const right = r.u16();
  const normalStart = r.u16();
  const normalEnd = r.u16();
  const normalRepeat = r.flag();
  r.skipBits(7);
  const selectedSound = r.u8();
  const selectedStart = r.u16();
  const selectedEnd = r.u16();
  const selectedRepeat = r.flag();
  r.skipBits(7);
  const activatedSound = r.u8();
  const activatedStart = r.u16();
  const activatedEnd = r.u16();
  const numNavCmds = r.u16();
  const navCmds: MobjCmd[] = [];
  for (let i = 0; i < numNavCmds; i++) navCmds.push(parseMobjCmd(r.take(NAV_CMD_SIZE)));
  return {
    id, numericSelectValue, autoActionFlag, x, y, upper, lower, left, right,
    normalStart, normalEnd, normalRepeat, selectedSound, selectedStart, selectedEnd, selectedRepeat,
    activatedSound, activatedStart, activatedEnd, navCmds,
  };
}

/** _decode_bog */
function decodeBog(r: ByteReader): IgBog {
  const defaultValidButton = r.u16();
  const numButtons = r.u8();
  const buttons: IgButton[] = [];
  for (let i = 0; i < numButtons; i++) buttons.push(decodeButton(r));
  return { defaultValidButton, buttons };
}

/** _decode_effect */
function decodeEffect(r: ByteReader): IgEffect {
  const duration = u24(r);
  const paletteId = r.u8();
  const num = r.u8();
  const compositionObjects: PgCompositionObject[] = [];
  for (let i = 0; i < num; i++) compositionObjects.push(decodeCompositionObject(r));
  return { duration, paletteId, compositionObjects };
}

/** _decode_effect_sequence */
function decodeEffectSequence(r: ByteReader): IgEffectSequence {
  const numWindows = r.u8();
  const windows: PgWindow[] = [];
  for (let i = 0; i < numWindows; i++) windows.push(decodeWindow(r));
  const numEffects = r.u8();
  const effects: IgEffect[] = [];
  for (let i = 0; i < numEffects; i++) effects.push(decodeEffect(r));
  return { windows, effects };
}

/** _decode_page */
function decodePage(r: ByteReader): IgPage {
  const id = r.u8();
  const version = r.u8();
  const uoMask = parseUoMaskTable(r.take(8));
  const inEffects = decodeEffectSequence(r);
  const outEffects = decodeEffectSequence(r);
  const animationFrameRateCode = r.u8();
  const defaultSelectedButton = r.u16();
  const defaultActivatedButton = r.u16();
  const paletteId = r.u8();
  const numBogs = r.u8();
  const bogs: IgBog[] = [];
  for (let i = 0; i < numBogs; i++) bogs.push(decodeBog(r));
  return { id, version, uoMask, inEffects, outEffects, animationFrameRateCode, defaultSelectedButton, defaultActivatedButton, paletteId, bogs };
}

/** bb_read_u64(bb, 33) */
function readPts33(r: ByteReader): number {
  return r.bits(1) * 2 ** 32 + r.bits(32);
}

/**
 * ig_decode_interactive: `r` is positioned after the 3-byte segment header; fragments must already be
 * joined. Throws ParseError where libbluray returns 0.
 */
export function decodeInteractive(r: ByteReader): IgComposition {
  const video = decodeVideoDescriptor(r);
  const comp = decodeCompositionDescriptor(r);
  const sd = decodeSequenceDescriptor(r);
  if (!sd.firstInSeq) throw new ParseError('ig_decode_interactive(): not first in seq');
  if (!sd.lastInSeq) throw new ParseError('ig_decode_interactive(): not last in seq');

  // _decode_interactive_composition
  const dataLen = u24(r);
  if (dataLen !== r.remaining) throw new ParseError(`ig_decode_interactive(): buffer size mismatch (expected ${dataLen}, have ${r.remaining})`);
  const streamModel = r.bits(1);
  const uiModel = r.bits(1) as 0 | 1;
  r.skipBits(6);
  let compositionTimeoutPts = 0;
  let selectionTimeoutPts = 0;
  if (streamModel === 0) {
    r.skipBits(7);
    compositionTimeoutPts = readPts33(r);
    r.skipBits(7);
    selectionTimeoutPts = readPts33(r);
  }
  const userTimeoutDuration = u24(r);
  const numPages = r.u8();
  const pages: IgPage[] = [];
  for (let i = 0; i < numPages; i++) pages.push(decodePage(r));
  return {
    videoWidth: video.width, videoHeight: video.height, frameRate: video.frameRate,
    compositionNumber: comp.number, compositionState: comp.state,
    streamModel, uiModel, compositionTimeoutPts, selectionTimeoutPts, userTimeoutDuration, pages,
  };
}

/**
 * graphics_processor for IG: PG_DISPLAY_SET state plus graphics_processor_decode_pes. Feed one PES
 * payload (one segment) per push(); an END_OF_DISPLAY segment completes the display set.
 * libbluray's stc/dts gating is not ported: segments are decoded as they arrive.
 */
export class IgSegmentDecoder {
  /** corrupt segments dropped */
  errors = 0;

  private readonly joiner = new SegmentJoiner();
  private ics: IgComposition | null = null;
  private decoding = false;
  private epochStart = false;
  private validPts = 0;
  private palettes = new Map<number, PgPalette>();
  private objects = new Map<number, PgObject>();

  push(payload: Uint8Array, pts: number, _dts: number | null): IgDisplaySet | null {
    let result: IgDisplaySet | null = null;
    for (const seg of this.joiner.push(payload)) {
      if (seg.length <= 2) continue; // segment too short, skipping
      try {
        if (this.decodeSegment(seg, pts)) {
          result = {
            pts: this.validPts,
            epochStart: this.epochStart,
            composition: this.ics,
            palettes: new Map(this.palettes),
            objects: new Map(this.objects),
            complete: true,
          };
        }
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.errors++;
      }
    }
    return result;
  }

  /** Drops the display set being received (a seek cut it); the epoch's objects and palettes stay. */
  discardPartial(): void {
    this.joiner.reset();
    this.decoding = false;
  }

  reset(): void {
    this.joiner.reset();
    this.ics = null;
    this.decoding = false;
    this.epochStart = false;
    this.validPts = 0;
    this.palettes = new Map();
    this.objects = new Map();
  }

  /** _decode_segment; true when the display set is complete. */
  private decodeSegment(seg: Uint8Array, pts: number): boolean {
    const r = new ByteReader(seg, 3);
    switch (seg[0]) {
      case SegmentType.OBJECT:
        this.decodeOds(r);
        return false;
      case SegmentType.PALETTE:
        this.decodePds(r);
        return false;
      case SegmentType.IG_COMPOSITION:
        this.decodeIcs(r, pts);
        return false;
      case SegmentType.END_OF_DISPLAY:
        if (!this.decoding) return false; // orphan end of display segment
        this.decoding = false;
        return true;
      default:
        return false; // PG / TextST segments and unknown types are not handled here
    }
  }

  /** _decode_ods: a failed decode drops the object (libbluray keeps an empty entry). */
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
      // C: an existing entry keeps whatever pg_decode_object wrote, with img = NULL; a new id is never added
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
    // 8.8.3.1.1: in a normal-state composition a palette update keeps the entries it does not mention
    const update = existing !== undefined && this.ics !== null && this.ics.compositionState === 0;
    const palette = decodePalette(r, update ? existing : undefined);
    this.palettes.set(palette.id, palette);
  }

  /** _decode_ics + _check_epoch_start */
  private decodeIcs(r: ByteReader, pts: number): void {
    this.ics = null;
    this.ics = decodeInteractive(r);
    this.validPts = pts;
    if (this.ics.compositionState === 2) {
      this.palettes = new Map();
      this.objects = new Map();
      this.epochStart = true;
    } else {
      this.epochStart = false;
    }
    this.decoding = true;
  }
}
