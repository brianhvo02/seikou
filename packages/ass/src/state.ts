/*
 * The per-event render state that override tags change (RenderContext of libass), and its reset to a style.
 *
 * Ported from libass 0.17.5 (ass_render.h): RenderContext; (ass_render.c): handle_selective_style_overrides
 * (with overrides disabled), ass_layout_res, init_font_scale, ass_reset_render_context, init_render_context;
 * (ass_parse.c): ass_update_font. libass is ISC-licensed; see packages/ass/NOTICE. Modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

import type { FontRequest } from './fonts';
import type { AssEvent, AssStyle, AssTrack } from './types';

/** Glyph decoration flag, libass `ass_font.h` `DECO_UNDERLINE`: draw an underline (`\u1`). */
export const DECO_UNDERLINE = 1;
/** Glyph decoration flag, libass `DECO_STRIKETHROUGH`: draw a strike-out line (`\s1`). */
export const DECO_STRIKETHROUGH = 2;
/** Glyph flag, libass `DECO_ROTATE`: the glyph is turned a quarter turn: vertical text (a family name starting with `@`) in characters above U+02F1. */
export const DECO_ROTATE = 4;

/** Event placement, libass `ass_render.h` `EVENT_NORMAL`: placed by alignment and margins. */
export const EVENT_NORMAL = 0;
/** Event placement, libass `EVENT_POSITIONED`: after `\pos` or `\move`, where the margins are ignored. */
export const EVENT_POSITIONED = 1;

/** Karaoke effect type, libass `ass_render.h` `EF_NONE`: no effect. */
export const EF_NONE = 0;
/** Karaoke effect type `EF_KARAOKE` (`\k`): a syllable changes colour at once when its time comes. */
export const EF_KARAOKE = 1;
/** Karaoke effect type `EF_KARAOKE_KF` (`\kf` and `\K`): the colour sweeps across the syllable over its duration. */
export const EF_KARAOKE_KF = 2;
/** Karaoke effect type `EF_KARAOKE_KO` (`\ko`): like `\kf`, and the outline sweeps too. */
export const EF_KARAOKE_KO = 3;

/** Set in `parsedTags` once the event has had a `\fad` or `\fade` tag (libass `PARSED_FADE`; later ones are ignored). */
export const PARSED_FADE = 1 << 0;
/** Set in `parsedTags` once the event has had an alignment tag, `\a` or `\an` (libass `PARSED_A`; later ones are ignored). */
export const PARSED_A = 1 << 1;

/** The frame the renderer draws for, set by the host as libass's `ass_set_frame_size`, `ass_set_storage_size` and `ass_set_font_scale` set it. */
export interface RenderSettings {
  /** The frame (the video rectangle) in device pixels: ass_set_frame_size. */
  readonly frameWidth: number;
  readonly frameHeight: number;
  /** The video's storage size: ass_set_storage_size. */
  readonly storageWidth: number;
  readonly storageHeight: number;
  /** ass_set_font_scale (the user's size). */
  readonly fontScale: number;
}

/**
 * The state of one event's text as override tags change it: libass `RenderContext` (`ass_render.h`), with the same
 * fields, units and meanings. It starts from the event's style (`resetRenderState`), each `{...}` block edits it
 * (`parseTags`), and glyph records copy it as they are made. Lengths are script pixels unless noted.
 */
export interface RenderState {
  readonly track: AssTrack;
  readonly event: AssEvent;
  readonly settings: RenderSettings;
  /** The style the state was last reset to (the event's, or the one `\r` named). */
  style: AssStyle;
  /** ass_update_font's ASS_FontDesc. */
  fontRequest: FontRequest;
  /** The font family as the tags last set it (`\fn`). */
  family: string;
  /** Bold as `\b` sets it: 0 or 1, or a weight such as 700; `updateFont` turns it into the requested weight. */
  bold: number;
  /** Italic as `\i` sets it: 0 or 1. */
  italic: number;
  /** The font size (`\fs`). */
  fontSize: number;
  /** `PARSED_*` bits: which once-only tags the event has already used. */
  parsedTags: number;
  /** `DECO_*` bits: underline (`\u`), strike-out (`\s`). */
  flags: number;
  /** `VALIGN_* | HALIGN_*` (`\an`, `\a`). */
  alignment: number;
  /** Line justification inside the text box: 0 follows the alignment, 1 left, 2 centre, 3 right (the style's `Justify`; no tag sets it). */
  justify: number;
  /** Rotation in degrees about the x, y and z axes (`\frx`, `\fry`, `\frz`). */
  frx: number; fry: number; frz: number;
  /** Shear factors along x and y (`\fax`, `\fay`). */
  fax: number; fay: number;
  /** The position given by `\pos` or `\move`, valid when `evtType` is `EVENT_POSITIONED`. */
  posX: number; posY: number;
  /** The rotation origin (`\org`), valid when `haveOrigin`. */
  orgX: number; orgY: number;
  /** Glyph scale as fractions (`\fscx`, `\fscy`). */
  scaleX: number; scaleY: number;
  /** Extra space between characters (`\fsp`). */
  hspacing: number;
  /** Outline width along x and y (`\bord`, `\xbord`, `\ybord`). */
  borderX: number; borderY: number;
  /** `EVENT_NORMAL` or `EVENT_POSITIONED`. */
  evtType: number;
  /** BorderStyle (1 outline and shadow, 3 box); the style's, there is no tag for it. */
  borderStyle: number;
  /** 0xRRGGBBAA, primary, secondary, outline, back (`\c`/`\1c` to `\4c`, `\alpha`, `\1a` to `\4a`). */
  c: [number, number, number, number];
  /** The rectangle clip (`\clip`, `\iclip`) in script pixels. Integers, as libass's int fields. */
  clipX0: number; clipY0: number; clipX1: number; clipY1: number;
  /** An origin was given with `\org`; otherwise the rotation point comes from the alignment. */
  haveOrigin: boolean;
  /** 1 = \iclip rectangle. */
  clipMode: number;
  /** Whether the event takes part in collision handling: false once `\pos`, `\move` or `\org` has been used. */
  detectCollisions: boolean;
  /** Edge blur passes (`\be`). */
  be: number;
  /** The fade alpha at the event's current time, from `\fad` or `\fade`. */
  fade: number;
  /** Gaussian blur radius (`\blur`). */
  blur: number;
  /** Shadow distance along x and y (`\shad`, `\xshad`, `\yshad`). */
  shadowX: number; shadowY: number;
  /** Baseline offset of a drawing (`\pbo`). */
  pbo: number;
  /** The vector clip's drawing text (`\clip` with a drawing), or null. */
  clipDrawingText: string | null;
  /** The `\p` scale for drawings (0 outside drawing mode). */
  drawingScale: number;
  /** The scale given to the vector clip. */
  clipDrawingScale: number;
  /** 1 = \iclip drawing. */
  clipDrawingMode: number;
  /** Karaoke: the `EF_*` type, the time of the current syllable and the time skipped so far. */
  effectType: number;
  effectTiming: number;
  effectSkipTiming: number;
  /** Set by a karaoke tag so the next glyph starts a new syllable. */
  resetEffect: boolean;
  /** `WrapStyle`, as `\q` sets it. */
  wrapStyle: number;
  /** Character set number (`\fe`). */
  fontEncoding: number;
  /** The event has a hard override (`\pos`, `\move`, `\clip`, `\org`, `\p`), which `hasHardOverrides` finds. */
  explicit: boolean;
  /** Script pixels to frame pixels for text, borders and blur, with the viewer's font scale folded in. */
  screenScaleX: number; screenScaleY: number;
  borderScaleX: number; borderScaleY: number;
  blurScaleX: number; blurScaleY: number;
  /** ASS_Renderer.par_scale_x of ass_start_frame. */
  parScaleX: number;
}

/** ass_event_has_hard_overrides: \pos, \move, \clip, \iclip, \org, \pbo or \p inside an override block. */
export function hasHardOverrides(str: string): boolean {
  for (let i = 0; i < str.length; ) {
    if (str[i] === '\\' && i + 1 < str.length) i += 2;
    else if (str[i] === '{') {
      i++;
      while (i < str.length && str[i] !== '}') {
        if (str[i] === '\\' && /^(pos|move|clip|iclip|org|pbo|p)/.test(str.slice(i + 1, i + 6))) return true;
        i++;
      }
    } else i++;
  }
  return false;
}

/** ass_layout_res: LayoutRes, else the storage size, else PlayRes. */
export function layoutRes(track: AssTrack, settings: RenderSettings): { x: number; y: number } {
  if (track.layoutResX > 0 && track.layoutResY > 0) return { x: track.layoutResX, y: track.layoutResY };
  if (settings.storageWidth > 0 && settings.storageHeight > 0) return { x: settings.storageWidth, y: settings.storageHeight };
  return { x: track.playResX, y: track.playResY };
}

/** The pixel aspect correction of ass_start_frame: frame aspect over layout-resolution aspect. */
export function parScale(track: AssTrack, settings: RenderSettings): number {
  if (settings.frameWidth > 0 && settings.frameHeight > 0) {
    const lr = layoutRes(track, settings);
    return settings.frameWidth / settings.frameHeight / (lr.x / lr.y);
  }
  return 1;
}

/** init_font_scale (use_margins off, no selective overrides: the font scale always applies). */
function initFontScale(s: RenderState): void {
  const w = s.settings.frameWidth;
  const h = s.settings.frameHeight;
  s.screenScaleX = w / s.track.playResX;
  s.screenScaleY = h / s.track.playResY;
  const lr = layoutRes(s.track, s.settings);
  s.blurScaleX = w / lr.x;
  s.blurScaleY = h / lr.y;
  if (s.track.scaledBorderAndShadow) {
    s.borderScaleX = s.screenScaleX;
    s.borderScaleY = s.screenScaleY;
  } else {
    s.borderScaleX = s.blurScaleX;
    s.borderScaleY = s.blurScaleY;
  }
  const k = s.settings.fontScale;
  s.screenScaleX *= k;
  s.screenScaleY *= k;
  s.borderScaleX *= k;
  s.borderScaleY *= k;
  s.blurScaleX *= k;
  s.blurScaleY *= k;
}

/** ass_update_font */
export function updateFont(s: RenderState): void {
  let family = s.family;
  let vertical = false;
  if (family.startsWith('@')) {
    vertical = true;
    family = family.slice(1);
  }
  let bold = s.bold;
  if (bold === 1 || bold === -1) bold = 700;
  else if (bold <= 0) bold = 400;
  let italic = s.italic;
  if (italic === 1) italic = 100;
  else if (italic <= 0) italic = 0;
  s.fontRequest = { family, bold, italic, vertical };
}

/** ass_reset_render_context: like {\r}, back to `style` (null: the event's style). */
export function resetRenderState(s: RenderState, style: AssStyle | null): void {
  style ??= s.track.styles[s.event.style] ?? s.track.styles[0]!;
  s.style = style;
  initFontScale(s);
  s.c = [style.primaryColour, style.secondaryColour, style.outlineColour, style.backColour];
  s.flags = (style.underline ? DECO_UNDERLINE : 0) | (style.strikeOut ? DECO_STRIKETHROUGH : 0);
  s.fontSize = style.fontSize;
  s.family = style.fontName;
  s.bold = style.bold;
  s.italic = style.italic;
  updateFont(s);
  s.borderStyle = style.borderStyle;
  s.borderX = style.outline;
  s.borderY = style.outline;
  s.scaleX = style.scaleX;
  s.scaleY = style.scaleY;
  s.hspacing = style.spacing;
  s.be = 0;
  s.blur = style.blur;
  s.shadowX = style.shadow;
  s.shadowY = style.shadow;
  s.frx = 0;
  s.fry = 0;
  s.frz = style.angle;
  s.fax = 0;
  s.fay = 0;
  s.fontEncoding = style.encoding;
}

/** init_render_context (the Effect field's Banner/Scroll transitions are out of scope). */
export function initRenderState(track: AssTrack, event: AssEvent, settings: RenderSettings): RenderState {
  const style = track.styles[event.style] ?? track.styles[0]!;
  const s: RenderState = {
    track, event, settings, style,
    fontRequest: { family: '', bold: 400, italic: 0, vertical: false }, family: '', bold: 0, italic: 0, fontSize: 0,
    parsedTags: 0, flags: 0, alignment: 0, justify: 0, frx: 0, fry: 0, frz: 0, fax: 0, fay: 0,
    posX: 0, posY: 0, orgX: 0, orgY: 0, scaleX: 1, scaleY: 1, hspacing: 0, borderX: 0, borderY: 0,
    evtType: EVENT_NORMAL, borderStyle: 1, c: [0, 0, 0, 0],
    clipX0: 0, clipY0: 0, clipX1: track.playResX, clipY1: track.playResY, haveOrigin: false, clipMode: 0,
    detectCollisions: true, be: 0, fade: 0, blur: 0, shadowX: 0, shadowY: 0, pbo: 0,
    clipDrawingText: null, drawingScale: 0, clipDrawingScale: 1, clipDrawingMode: 0,
    effectType: EF_NONE, effectTiming: 0, effectSkipTiming: 0, resetEffect: false,
    wrapStyle: track.wrapStyle, fontEncoding: 0, explicit: hasHardOverrides(event.text),
    screenScaleX: 1, screenScaleY: 1, borderScaleX: 1, borderScaleY: 1, blurScaleX: 1, blurScaleY: 1,
    parScaleX: parScale(track, settings),
  };
  resetRenderState(s, null);
  s.alignment = s.style.alignment;
  s.justify = s.style.justify;
  return s;
}
