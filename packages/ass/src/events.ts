/*
 * An event's text into glyph records (GlyphInfo) carrying the render state at each character, split into style
 * runs, and karaoke timing once glyphs are placed.
 *
 * Ported from libass 0.17.5 (ass_render.h): GlyphInfo; (ass_render.c): parse_events, fix_glyph_scaling,
 * split_style_runs; (ass_parse.c): ass_process_karaoke_effects. libass is ISC-licensed; see src/engine/NOTICE.
 * Modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

import type { Drawing } from './drawing';
import type { FontRequest, ResolvedFace } from './fonts';
import type { GlyphMetrics } from './measure';
import { DECO_ROTATE, EF_KARAOKE_KF, EF_NONE, initRenderState, type RenderSettings, type RenderState } from './state';
import { nextChar, parseTags } from './tags';
import type { AssEvent, AssTrack } from './types';

const VERTICAL_LOWER_BOUND = 0x02f1;

/** GlyphInfo: same fields and units (positions and advances are 26.6 integers). */
export interface GlyphInfo {
  symbol: number;
  skip: boolean;
  isTrimmedWhitespace: boolean;
  font: FontRequest;
  /** Filled by layout (retrieve_glyphs). */
  face: ResolvedFace | null;
  fontSize: number;
  drawingText: string | null;
  drawingScale: number;
  drawingPbo: number;
  linebreak: number;
  startsNewRun: boolean;
  c: [number, number, number, number];
  effectType: number;
  effectTiming: number;
  effectSkipTiming: number;
  resetEffect: boolean;
  asc: number;
  desc: number;
  be: number;
  blur: number;
  shadowX: number;
  shadowY: number;
  frx: number; fry: number; frz: number;
  fax: number; fay: number;
  scaleX: number;
  scaleY: number;
  scaleFix: number;
  borderStyle: number;
  borderX: number;
  borderY: number;
  hspacing: number;
  hspacingScaled: number;
  italic: number;
  bold: number;
  flags: number;
  fade: number;
  shapeRunId: number;
  posX: number; posY: number;
  offsetX: number; offsetY: number;
  advanceX: number; advanceY: number;
  clusterAdvanceX: number; clusterAdvanceY: number;
  shiftX: number; shiftY: number;
  /** Next glyph of a cluster (filled by layout). */
  next: GlyphInfo | null;
  // filled by layout (get_outline_glyph): the outline's box after the transform below, 26.6
  bboxXMin: number; bboxYMin: number; bboxXMax: number; bboxYMax: number;
  /** ASS_Transform: outline units to layout units. */
  trScaleX: number; trScaleY: number; trOffsetX: number; trOffsetY: number;
  /** The em size in px the glyph's outline is at (font_size 256 through ass_face_set_size). */
  emPx: number;
  metrics: GlyphMetrics | null;
  drawing: Drawing | null;
  /** A ligature root: the characters of its cluster, drawn together (null for a single character). */
  clusterText: string | null;
}

export interface EventText { readonly glyphs: GlyphInfo[]; readonly state: RenderState; readonly now: number }

/** lrint: round half to even. */
export function lrint(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
export const doubleToD6 = (x: number): number => lrint(x * 64);
export const d6ToDouble = (x: number): number => x / 64;

/** fix_glyph_scaling with ASS_HINTING_NONE: outlines at 256 px, the rest of the size moved into scale_x/y. */
function fixGlyphScaling(g: GlyphInfo): void {
  const ftSize = 256;
  if (!g.fontSize) return;
  const mul = g.fontSize / ftSize;
  g.scaleFix = 1 / mul;
  g.scaleX *= mul;
  g.scaleY *= mul;
  g.fontSize = ftSize;
}

function glyphFrom(s: RenderState, code: number, drawingText: string | null): GlyphInfo {
  const g: GlyphInfo = {
    symbol: code, skip: false, isTrimmedWhitespace: false, font: s.fontRequest, face: null,
    fontSize: Math.abs(s.fontSize * s.screenScaleY), // VSFilter: font glyphs use PlayResY scaling in both dimensions
    drawingText, drawingScale: drawingText !== null ? s.drawingScale : 0, drawingPbo: drawingText !== null ? s.pbo : 0,
    linebreak: 0, startsNewRun: false, c: [s.c[0], s.c[1], s.c[2], s.c[3]],
    effectType: s.effectType, effectTiming: s.effectTiming, effectSkipTiming: s.effectSkipTiming, resetEffect: s.resetEffect,
    asc: 0, desc: 0, be: s.be, blur: s.blur, shadowX: s.shadowX, shadowY: s.shadowY,
    frx: s.frx, fry: s.fry, frz: s.frz, fax: s.fax, fay: s.fay,
    scaleX: s.scaleX, scaleY: s.scaleY, scaleFix: 1, borderStyle: s.borderStyle, borderX: s.borderX, borderY: s.borderY,
    hspacing: s.hspacing, hspacingScaled: 0, italic: s.italic, bold: s.bold,
    flags: s.flags | (s.fontRequest.vertical && code >= VERTICAL_LOWER_BOUND ? DECO_ROTATE : 0),
    fade: s.fade, shapeRunId: 0, posX: 0, posY: 0, offsetX: 0, offsetY: 0, advanceX: 0, advanceY: 0,
    clusterAdvanceX: 0, clusterAdvanceY: 0, shiftX: 0, shiftY: 0, next: null,
    bboxXMin: 0, bboxYMin: 0, bboxXMax: 0, bboxYMax: 0, trScaleX: 1, trScaleY: 1, trOffsetX: 0, trOffsetY: 0,
    emPx: 0, metrics: null, drawing: null, clusterText: null,
  };
  if (drawingText === null) {
    g.hspacingScaled = doubleToD6((g.hspacing * s.screenScaleX / s.parScaleX) * g.scaleX);
    fixGlyphScaling(g);
  }
  return g;
}

/** init_render_context + parse_events; null when the event has no characters (libass skips it). `now` is ms from the event's start. */
export function parseEvent(track: AssTrack, event: AssEvent, settings: RenderSettings, now: number): EventText | null {
  const s = initRenderState(track, event, settings);
  const text = event.text;
  const glyphs: GlyphInfo[] = [];
  let p = 0;
  for (;;) {
    let drawing: string | null = null;
    let code = 0;
    while (p < text.length) {
      const close = text[p] === '{' ? text.indexOf('}', p) : -1;
      if (close !== -1) {
        parseTags(s, text.slice(p + 1, close), 1, false, now);
        p = close + 1;
      } else if (s.drawingScale) {
        let q = p;
        if (text[q] === '{') q++;
        while (q < text.length && text[q] !== '{') q++;
        drawing = text.slice(p, q);
        code = 0xfffc; // object replacement character
        p = q;
        break;
      } else {
        [code, p] = nextChar(s, text, p);
        break;
      }
    }
    if (code === 0) break;
    glyphs.push(glyphFrom(s, code, drawing));
    s.effectType = EF_NONE;
    s.effectTiming = 0;
    s.effectSkipTiming = 0;
    s.resetEffect = false;
  }
  return glyphs.length ? { glyphs, state: s, now } : null;
}

/** split_style_runs */
export function splitStyleRuns(text: EventText): void {
  const g = text.glyphs;
  let lastEffectType = g[0]!.effectType;
  g[0]!.startsNewRun = true;
  for (let i = 1; i < g.length; i++) {
    const info = g[i]!;
    const last = g[i - 1]!;
    const effectType = info.effectType;
    info.startsNewRun = info.effectTiming !== 0
      || (effectType !== EF_NONE && effectType !== lastEffectType)
      || info.drawingText !== null || last.drawingText !== null
      || last.font.family !== info.font.family || last.font.vertical !== info.font.vertical
      || last.fontSize !== info.fontSize
      || last.c[0] !== info.c[0] || last.c[1] !== info.c[1] || last.c[2] !== info.c[2] || last.c[3] !== info.c[3]
      || last.be !== info.be || last.blur !== info.blur || last.shadowX !== info.shadowX || last.shadowY !== info.shadowY
      || last.frx !== info.frx || last.fry !== info.fry || last.frz !== info.frz || last.fax !== info.fax || last.fay !== info.fay
      || last.scaleX !== info.scaleX || last.scaleY !== info.scaleY
      || last.borderStyle !== info.borderStyle || last.borderX !== info.borderX || last.borderY !== info.borderY
      || last.hspacing !== info.hspacing || last.italic !== info.italic || last.bold !== info.bold
      || ((last.flags ^ info.flags) & ~DECO_ROTATE) !== 0;
    if (effectType !== EF_NONE) lastEffectType = effectType;
  }
}

const i32 = (v: number): number => v | 0;
const u32 = (v: number): number => v >>> 0;

/**
 * ass_process_karaoke_effects: gives every glyph of a karaoke word its effect type, and as effect_timing the
 * distance (26.6) from the glyph to where primary colour gives way to secondary. Needs glyph positions.
 */
export function processKaraoke(text: EventText, now: number): void {
  const g = text.glyphs;
  let timing = 0;
  let skipTiming = 0;
  let effectType = EF_NONE;
  let lastBoundary = -1;
  let hasReset = false;
  for (let i = 0; i <= g.length; i++) {
    if (i < g.length && !g[i]!.startsNewRun) {
      if (g[i]!.resetEffect) {
        hasReset = true;
        skipTiming = 0;
      }
      // VSFilter: \k12345\k0 without a run break keeps the word, but delays the next one
      skipTiming = i32(skipTiming + u32(g[i]!.effectSkipTiming));
      continue;
    }
    const start = lastBoundary;
    const end = i;
    lastBoundary = end;
    if (start < 0) continue;
    const first = g[start]!;
    if (first.effectType !== EF_NONE) effectType = first.effectType;
    if (effectType === EF_NONE) continue;
    if (first.resetEffect) timing = 0;

    const tmStart = timing + first.effectSkipTiming;
    let tmEnd = tmStart + first.effectTiming;
    timing = (hasReset ? 0 : tmEnd) + skipTiming;
    skipTiming = 0;
    hasReset = false;
    if (effectType !== EF_KARAOKE_KF) tmEnd = tmStart;

    let x: number;
    if (now < tmStart) x = -100_000_000;
    else if (now >= tmEnd) x = 100_000_000;
    else {
      let firstVisible = start;
      let lastVisible = end - 1;
      while (firstVisible < lastVisible && g[firstVisible]!.skip) firstVisible++;
      while (firstVisible < lastVisible && g[lastVisible]!.skip) lastVisible--;
      const xStart = g[firstVisible]!.posX;
      const xEnd = g[lastVisible]!.posX + g[lastVisible]!.advanceX;
      let dt = (now - tmStart) / (tmEnd - tmStart);
      const frz = first.frz % 360;
      if (frz > 90 && frz < 270) {
        // fill from right to left
        dt = 1 - dt;
        for (let k = start; k < end; k++) {
          const info = g[k]!;
          [info.c[0], info.c[1]] = [info.c[1], info.c[0]];
        }
      }
      x = xStart + lrint((xEnd - xStart) * dt);
    }
    for (let k = start; k < end; k++) {
      g[k]!.effectType = effectType;
      g[k]!.effectTiming = x - g[k]!.posX;
    }
  }
}
