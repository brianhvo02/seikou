/*
 * The per-event render state that override tags change (RenderContext of libass), and its reset to a style.
 *
 * Ported from libass 0.17.5 (ass_render.h): RenderContext; (ass_render.c): handle_selective_style_overrides
 * (with overrides disabled), ass_layout_res, init_font_scale, ass_reset_render_context, init_render_context;
 * (ass_parse.c): ass_update_font. libass is ISC-licensed; see src/engine/NOTICE. Modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

import type { FontRequest } from './fonts';
import type { AssEvent, AssStyle, AssTrack } from './types';

export const DECO_UNDERLINE = 1;
export const DECO_STRIKETHROUGH = 2;
export const DECO_ROTATE = 4;

export const EVENT_NORMAL = 0;
export const EVENT_POSITIONED = 1;

export const EF_NONE = 0;
export const EF_KARAOKE = 1;
export const EF_KARAOKE_KF = 2;
export const EF_KARAOKE_KO = 3;

export const PARSED_FADE = 1 << 0;
export const PARSED_A = 1 << 1;

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

/** RenderContext: same fields, units and meanings. */
export interface RenderState {
  readonly track: AssTrack;
  readonly event: AssEvent;
  readonly settings: RenderSettings;
  style: AssStyle;
  /** ass_update_font's ASS_FontDesc. */
  fontRequest: FontRequest;
  family: string;
  bold: number;
  italic: number;
  fontSize: number;
  parsedTags: number;
  flags: number;
  alignment: number;
  justify: number;
  frx: number; fry: number; frz: number;
  fax: number; fay: number;
  posX: number; posY: number;
  orgX: number; orgY: number;
  scaleX: number; scaleY: number;
  hspacing: number;
  borderX: number; borderY: number;
  evtType: number;
  borderStyle: number;
  /** 0xRRGGBBAA, primary, secondary, outline, back. */
  c: [number, number, number, number];
  /** Integers, as libass's int fields. */
  clipX0: number; clipY0: number; clipX1: number; clipY1: number;
  haveOrigin: boolean;
  /** 1 = \iclip rectangle. */
  clipMode: number;
  detectCollisions: boolean;
  be: number;
  fade: number;
  blur: number;
  shadowX: number; shadowY: number;
  pbo: number;
  clipDrawingText: string | null;
  drawingScale: number;
  clipDrawingScale: number;
  /** 1 = \iclip drawing. */
  clipDrawingMode: number;
  effectType: number;
  effectTiming: number;
  effectSkipTiming: number;
  resetEffect: boolean;
  wrapStyle: number;
  fontEncoding: number;
  explicit: boolean;
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
