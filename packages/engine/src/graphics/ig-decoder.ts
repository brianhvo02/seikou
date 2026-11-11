/*
 * Ported from libbluray src/libbluray/decoders/ig_decode.c, ig.h and the IG parts of graphics_processor.c
 * Copyright (C) 2010-2013  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { parseMobjCmd, type MobjCmd } from '@seikou/bdmv/mobj-parser';
import { parseUoMaskTable, type UoMask } from '../hdmv/uo-mask';
import { ByteReader, ParseError } from '@seikou/bdmv/byte-reader';
import {
  SegmentJoiner, SegmentType, decodeCompositionDescriptor, decodeCompositionObject, decodeObject, decodePalette,
  decodeSequenceDescriptor, decodeVideoDescriptor, decodeWindow,
  type PgCompositionObject, type PgObject, type PgPalette, type PgWindow,
} from '@seikou/pg';

const NAV_CMD_SIZE = 12;

/**
 * One button of an interactive graphics (IG) menu page: libbluray's `BD_IG_BUTTON` in `ig.h`. Neighbour ids use 0xFFFF for
 * "no button", as in libbluray. Object ids refer to the display set's graphics objects; a state shows its start object,
 * or animates from its start to its end object.
 */
export interface IgButton {
  /** The button's id, unique within the page. */
  readonly id: number;
  /** The number key value that selects this button (`numeric_select_value`). */
  readonly numericSelectValue: number;
  /** The button activates as soon as it is selected (`auto_action_flag`). */
  readonly autoActionFlag: boolean;
  /** Left edge on the IG plane, in pixels (`x_pos`). */
  readonly x: number;
  /** Top edge on the IG plane, in pixels (`y_pos`). */
  readonly y: number;
  /** Id of the button the Up key moves to (`upper_button_id_ref`). */
  readonly upper: number;
  /** Id of the button the Down key moves to (`lower_button_id_ref`). */
  readonly lower: number;
  /** Id of the button the Left key moves to (`left_button_id_ref`). */
  readonly left: number;
  /** Id of the button the Right key moves to (`right_button_id_ref`). */
  readonly right: number;
  /** First object of the normal state (`normal_start_object_id_ref`); 0xFFFF for none. */
  readonly normalStart: number;
  /** Last object of the normal state's animation. */
  readonly normalEnd: number;
  /** The normal state's animation loops. */
  readonly normalRepeat: boolean;
  /** Id of the `sound.bdmv` sound played when the button is selected (`selected_sound_id_ref`); 0xFF for none. */
  readonly selectedSound: number;
  /** First object of the selected state. */
  readonly selectedStart: number;
  /** Last object of the selected state's animation. */
  readonly selectedEnd: number;
  /** The selected state's animation loops. */
  readonly selectedRepeat: boolean;
  /** Id of the sound played when the button is activated (`activated_sound_id_ref`); 0xFF for none. */
  readonly activatedSound: number;
  /** First object of the activated state. */
  readonly activatedStart: number;
  /** Last object of the activated state's animation. */
  readonly activatedEnd: number;
  /** The navigation commands that run when the button is activated, run as the IG object by the VM. */
  readonly navCmds: readonly MobjCmd[];
}
/**
 * A button overlap group: the buttons that share one place on the page, only one of which is enabled at a time
 * (libbluray `BD_IG_BOG`).
 */
export interface IgBog {
  /** The button enabled when the page opens (`default_valid_button_id_ref`). */
  readonly defaultValidButton: number;
  /** The group's buttons. */
  readonly buttons: readonly IgButton[];
}
/** One step of a page's in or out effect (libbluray `BD_IG_EFFECT`). */
export interface IgEffect {
  /** How long the step lasts, in 90 kHz ticks. */
  readonly duration: number;
  /** The palette the step draws with. */
  readonly paletteId: number;
  /** The objects drawn in the step, with their positions. */
  readonly compositionObjects: readonly PgCompositionObject[];
}
/** The windows and steps of a page's in or out effect (libbluray `BD_IG_EFFECT_SEQUENCE`). */
export interface IgEffectSequence {
  /** The screen areas the effect draws into. */
  readonly windows: readonly PgWindow[];
  /** The steps, in order. */
  readonly effects: readonly IgEffect[];
}
/** One page of an IG menu (libbluray `BD_IG_PAGE`). */
export interface IgPage {
  /** The page id; the menu page register (PSR11) holds it. */
  readonly id: number;
  /** The page's version number; a new version of the same id replaces it. */
  readonly version: number;
  /** User operations the page forbids while it shows (`uo_mask_table`). */
  readonly uoMask: UoMask;
  /** The effect played when the page opens. */
  readonly inEffects: IgEffectSequence;
  /** The effect played when the page closes. */
  readonly outEffects: IgEffectSequence;
  /** The frame rate code that paces button animations; the controller turns it into a tick interval. */
  readonly animationFrameRateCode: number;
  /** The button selected when the page opens (`default_selected_button_id_ref`). */
  readonly defaultSelectedButton: number;
  /** The button activated when the user timeout expires (`default_activated_button_id_ref`). */
  readonly defaultActivatedButton: number;
  /** The palette the page draws with (`palette_id_ref`). */
  readonly paletteId: number;
  /** The page's button overlap groups. */
  readonly bogs: readonly IgBog[];
}
/**
 * The interactive composition segment: libbluray's `BD_IG_INTERACTIVE` (the segment) merged with
 * `BD_IG_INTERACTIVE_COMPOSITION`. The video descriptor fields are an addition to libbluray's structure so the graphics
 * controller can size its planes.
 */
export interface IgComposition {
  /** Width of the video the graphics are made for, from the video descriptor. */
  readonly videoWidth: number;
  /** Height of that video. */
  readonly videoHeight: number;
  /** The video descriptor's frame rate code. */
  readonly frameRate: number;
  /** The composition number, counting up with each display set. */
  readonly compositionNumber: number;
  /** 0 normal, 1 acquisition point (a full set that can start decoding), 2 epoch start (clears earlier objects and palettes). */
  readonly compositionState: number;
  /** 0 when the menu is multiplexed in the clip and the timeouts below apply, 1 when it is out of mux. */
  readonly streamModel: number;
  /** 0 for an always-on menu, 1 for a pop-up menu. */
  readonly uiModel: 0 | 1;
  /** The PTS at which the menu ends; 0 unless `streamModel` is 0. */
  readonly compositionTimeoutPts: number;
  /** The PTS after which no button can be selected; 0 unless `streamModel` is 0. */
  readonly selectionTimeoutPts: number;
  /** Ticks of inactivity (90 kHz) after which the user timeout acts; 0 for none. */
  readonly userTimeoutDuration: number;
  /** The menu's pages. */
  readonly pages: readonly IgPage[];
}
/** One complete IG display set: the composition and every palette and object known at its end. */
export interface IgDisplaySet {
  /** The PTS of the composition segment, in 90 kHz ticks. */
  readonly pts: number;
  /** The composition starts an epoch (state 2), so objects and palettes were cleared before it. */
  readonly epochStart: boolean;
  /** The interactive composition; null when none has arrived. */
  readonly composition: IgComposition | null;
  /** The epoch's palettes by id (copies, so later segments do not change a set already handed over). */
  readonly palettes: ReadonlyMap<number, PgPalette>;
  /** The epoch's graphics objects by id. */
  readonly objects: ReadonlyMap<number, PgObject>;
  /** The END segment was seen: the set can be used. */
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
 * Decodes IG segments into display sets: libbluray's `graphics_processor.c` (the `PG_DISPLAY_SET` state and
 * `graphics_processor_decode_pes`) for the IG stream. Feed one PES payload (one segment) per `push`; an
 * END_OF_DISPLAY segment completes the display set. libbluray's stc and dts gating is not ported: segments are decoded
 * as they arrive, and the navigator decides when to push them.
 */
export class IgSegmentDecoder {
  /** Segments dropped because they were corrupt. */
  errors = 0;

  private readonly joiner = new SegmentJoiner();
  private ics: IgComposition | null = null;
  private decoding = false;
  private epochStart = false;
  private validPts = 0;
  private palettes = new Map<number, PgPalette>();
  private objects = new Map<number, PgObject>();

  /**
   * Takes one PES payload at `pts` (90 kHz) and returns the display set it completed, or null. A corrupt segment is
   * counted in `errors` and skipped. `_dts` is accepted for the shape of the caller's call and ignored.
   */
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

  /** Forgets everything: the partial set, the composition, the palettes and objects (a playlist closed). */
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
    // in a normal-state composition a palette update keeps the entries it does not mention (as libbluray's `graphics_processor.c`, which cites 8.8.3.1.1 for it)
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
