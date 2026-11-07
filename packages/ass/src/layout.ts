/*
 * Lays out an event's glyphs as libass does: shaping runs and faces, advances, line wrapping, whitespace trimming,
 * line metrics, alignment, the text box, baseline shear, and the event's position on the frame. Advances and ink
 * come from a GlyphMeasurer instead of HarfBuzz and FreeType.
 *
 * Ported from libass 0.17.5 (ass_render.c): x2scr_pos, x2scr_left, x2scr_right, x2scr_pos_scaled, y2scr_pos,
 * y2scr, y2scr_top, y2scr_sub (use_margins off), get_outline_glyph, retrieve_glyphs, preliminary_layout,
 * measure_text_on_eol, measure_text, trim_whitespace, wrap_lines_naive (without CONFIG_UNIBREAK),
 * rewind_trailing_spaces, wrap_lines_rebalance, wrap_lines_smart, reorder_text (left to right only),
 * align_lines, compute_string_bbox, apply_baseline_shear, get_base_point and the positioning part of
 * ass_render_event; (ass_shaper.c): is_harfbuzz_ignorable, ass_shaper_skip_characters, ass_shaper_find_runs,
 * the run walk of shape_harfbuzz and shape_harfbuzz_process_run; (ass_font.c): ass_font_get_asc_desc,
 * the bounding-box effects of ass_glyph_embolden, ass_glyph_italicize and ass_get_glyph_outline.
 * libass is ISC-licensed; see src/engine/NOTICE. Modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

import { parseDrawing } from './drawing';
import { d6ToDouble, doubleToD6, lrint, processKaraoke, type EventText, type GlyphInfo } from './events';
import { advanceEmSize, emSize, type AssFonts } from './fonts';
import { DECO_ROTATE, DECO_STRIKETHROUGH, DECO_UNDERLINE, EVENT_POSITIONED, type RenderState } from './state';
import { HALIGN_CENTER, HALIGN_LEFT, HALIGN_RIGHT, VALIGN_CENTER, VALIGN_SUB, VALIGN_TOP } from './types';
import type { GlyphMeasurer } from './measure';

const ASS_JUSTIFY_LEFT = 1;
const ASS_JUSTIFY_CENTER = 2;
const ASS_JUSTIFY_RIGHT = 3;
const NEWLINE = 0x0a;
const NO_INK = { advance: 0, inkLeft: 0, inkRight: 0, inkTop: 0, inkBottom: 0 } as const;
const SPACE = 0x20;

export interface LineInfo { asc: number; desc: number }

export interface LaidOutEvent {
  readonly text: EventText;
  readonly lines: readonly LineInfo[];
  /** Device position of the text box origin (the first line's baseline at bbox x 0). */
  readonly deviceX: number;
  readonly deviceY: number;
  /** compute_string_bbox: x_min, y_min, x_max, y_max relative to the device position, px. */
  readonly bbox: readonly [number, number, number, number];
  readonly height: number;
  readonly borderTop: number;
  readonly borderBottom: number;
  readonly borderX: number;
  /** Frame pixels after ass_render_event's clip fix-up; `drawing` is the vector clip's text. */
  readonly clip: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number; readonly mode: number; readonly drawing: string | null; readonly drawingScale: number; readonly drawingMode: number };
}

/** Frame mapping with use_margins off and no API margins: every x2scr/y2scr variant is this. */
export const x2scr = (s: RenderState, x: number): number => (x * s.settings.frameWidth) / s.parScaleX / s.track.playResX;
export const x2scrScaled = (s: RenderState, x: number): number => (x * s.settings.frameWidth) / s.track.playResX;
export const y2scr = (s: RenderState, y: number): number => (y * s.settings.frameHeight) / s.track.playResY;

/** is_harfbuzz_ignorable */
function isIgnorable(c: number): boolean {
  switch (c >> 8) {
    case 0x00: return c === 0x00ad;
    case 0x03: return c === 0x034f;
    case 0x06: return c === 0x061c;
    case 0x17: return c >= 0x17b4 && c <= 0x17b5;
    case 0x18: return c >= 0x180b && c <= 0x180e;
    case 0x20: return (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f);
    case 0xfe: return (c >= 0xfe00 && c <= 0xfe0f) || c === 0xfeff;
    case 0xff: return c >= 0xfff0 && c <= 0xfff8;
    case 0x1d1: return c >= 0x1d173 && c <= 0x1d17a;
    default: return c >= 0xe0000 && c <= 0xe0fff;
  }
}

const sameFont = (a: GlyphInfo, b: GlyphInfo): boolean =>
  a.font.family === b.font.family && a.font.bold === b.font.bold && a.font.italic === b.font.italic && a.font.vertical === b.font.vertical;

/** ass_shaper_find_runs + shape_harfbuzz: faces, run ids, then advances per run from the measurer. */
function shape(e: EventText, fonts: AssFonts, measurer: GlyphMeasurer): void {
  const g = e.glyphs;
  for (const info of g) info.skip = isIgnorable(info.symbol);
  let run = 0;
  for (let i = 0; i < g.length; i++) {
    const info = g[i]!;
    if (info.drawingText === null && !info.skip) info.face = fonts.faceFor(info.font, info.symbol);
    if (i > 0) {
      const last = g[i - 1]!;
      if (!sameFont(last, info) || (!info.skip && last.face !== info.face) || info.startsNewRun || info.hspacing !== 0 || last.flags !== info.flags) run++;
      else if (info.skip) info.face = last.face;
    }
    info.shapeRunId = run;
  }
  const kerning = e.state.track.kerning;
  for (const info of g) info.skip = true;
  for (let i = 0; i < g.length; i++) {
    if (g[i]!.drawingText !== null) {
      g[i]!.skip = false;
      continue;
    }
    const offset = i;
    while (i < g.length - 1 && g[i + 1]!.shapeRunId === g[offset]!.shapeRunId) i++;
    const runGlyphs = g.slice(offset, i + 1);
    const first = runGlyphs[0]!;
    const face = first.face ?? fonts.resolve(first.font);
    const em = emSize(face.face, first.fontSize);
    const advanceEm = advanceEmSize(face.face, first.fontSize);
    const cps = runGlyphs.map((x) => (x.symbol === NEWLINE ? SPACE : x.symbol));
    // ink at the outline size, advances at the hinted size (the browser's advances don't scale linearly)
    const metrics = measurer.measureRun(face.cssFamily, em, cps, kerning);
    const advances = advanceEm === em ? metrics : measurer.measureRun(face.cssFamily, advanceEm, cps, kerning);
    // HarfBuzz merges ligatures into one cluster (liga and clig are off with \fsp)
    const clusters = first.hspacing === 0 ? face.face.clusters(cps) : cps.map((_, k) => k);
    const clusterPx = new Map<number, number>();
    clusters.forEach((root, k) => clusterPx.set(root, (clusterPx.get(root) ?? 0) + advances[k]!.advance));
    clusters.forEach((root, k) => {
      if (root !== k) runGlyphs[root]!.clusterText = (runGlyphs[root]!.clusterText ?? String.fromCodePoint(cps[root]!)) + String.fromCodePoint(cps[k]!);
    });
    runGlyphs.forEach((info, k) => {
      if (clusters[k] !== k) {
        // a ligature component: its root draws it
        Object.assign(info, { skip: true, face: info.face ?? face, emPx: em, metrics: NO_INK, advanceX: 0, advanceY: 0, clusterAdvanceX: 0, clusterAdvanceY: 0 });
        return;
      }
      const m = metrics[k]!;
      info.face ??= face;
      info.skip = false;
      info.emPx = em;
      info.metrics = m;
      // FreeType's hinted advances are whole pixels at the outline size (256 px), HarfBuzz uses them as they are
      let adv = isIgnorable(info.symbol) || info.symbol === NEWLINE ? 0 : Math.round(clusterPx.get(k)!) * 64;
      if (info.flags & DECO_ROTATE) adv = Math.round(info.fontSize * 64); // vertical advance ≈ the face height at REAL_DIM size
      info.offsetX = 0;
      info.offsetY = 0;
      info.advanceX = lrint(adv * info.scaleX);
      info.advanceY = 0;
      info.clusterAdvanceX = info.advanceX;
      info.clusterAdvanceY = 0;
    });
  }
}

/** get_outline_glyph: the outline's transform, box, advance (drawings) and ascender/descender. */
function outlineGlyph(s: RenderState, info: GlyphInfo): void {
  if (info.drawingText !== null) {
    const d = parseDrawing(info.drawingText);
    info.drawing = d;
    const [x0, y0, x1, y1] = d.cbox ?? [0, 0, 0, 0];
    const shift = (info.drawingScale - 1) & 31;
    const base = ((1 << shift) | 0);
    const w = base > 0 ? 1 / base : 0;
    const sx = (info.scaleX * w * s.screenScaleX) / s.parScaleX;
    const sy = info.scaleY * w * s.screenScaleY;
    const desc = 64 * info.drawingPbo;
    const asc = y1 - y0 - desc;
    const offY = -asc * sy;
    info.trScaleX = sx;
    info.trScaleY = sy;
    info.trOffsetX = 0;
    info.trOffsetY = offY;
    info.bboxXMin = lrint(x0 * sx);
    info.bboxYMin = lrint(y0 * sy + offY);
    info.bboxXMax = lrint(x1 * sx);
    info.bboxYMax = lrint(y1 * sy + offY);
    info.advanceX = info.clusterAdvanceX = lrint((x1 - x0) * sx);
    info.advanceY = info.clusterAdvanceY = 0;
    info.asc = lrint(asc * sy);
    info.desc = lrint(desc * sy);
    return;
  }
  const face = info.face!;
  const f = face.face;
  const em = info.emPx;
  const k = (em * 64) / f.unitsPerEm; // font units → 26.6 at this size
  const m = info.metrics!;
  // the outline's control box in libass's y-down 26.6 units
  let x0 = m.inkLeft * 64;
  let x1 = m.inkRight * 64;
  let y0 = -m.inkTop * 64;
  let y1 = -m.inkBottom * 64;
  if (m.inkRight <= m.inkLeft) x0 = x1 = y0 = y1 = 0; // no outline (a space)
  if (face.synthItalic) {
    x0 += face.italicShear * -y1;
    x1 += face.italicShear * -y0;
  }
  if (face.synthBold && x1 > x0) {
    x0 -= em / 2;
    x1 += em / 2;
  }
  const adv = Math.round(m.advance * 64);
  if (adv > 0 && info.flags & DECO_UNDERLINE && f.underlinePosition <= 0 && f.underlineThickness > 0) {
    const pos = Math.round(f.underlinePosition * k);
    const size = Math.round(f.underlineThickness * k);
    const top = -pos - (size >> 1);
    [x0, y0, x1, y1] = [Math.min(x0, 0), Math.min(y0, top), Math.max(x1, adv), Math.max(y1, top + size)];
  }
  if (adv > 0 && info.flags & DECO_STRIKETHROUGH && f.strikeoutPosition >= 0 && f.strikeoutSize > 0) {
    const pos = Math.round(f.strikeoutPosition * k);
    const size = Math.round(f.strikeoutSize * k);
    const top = -pos - (size >> 1);
    [x0, y0, x1, y1] = [Math.min(x0, 0), Math.min(y0, top), Math.max(x1, adv), Math.max(y1, top + size)];
  }
  if (info.flags & DECO_ROTATE) {
    x0 = 0;
    x1 = Math.round(info.fontSize * 64);
  }
  info.trScaleX = info.scaleX;
  info.trScaleY = info.scaleY;
  info.trOffsetX = 0;
  info.trOffsetY = 0;
  info.bboxXMin = lrint(x0 * info.scaleX);
  info.bboxYMin = lrint(y0 * info.scaleY);
  info.bboxXMax = lrint(x1 * info.scaleX);
  info.bboxYMax = lrint(y1 * info.scaleY);
  // ass_font_get_asc_desc after set_font_metrics, then get_outline_glyph's scaling
  info.asc = lrint(Math.round(f.ascender * k) * info.scaleY);
  info.desc = lrint(Math.round(-f.descender * k) * info.scaleY);
}

/** retrieve_glyphs */
function retrieveGlyphs(e: EventText): void {
  const g = e.glyphs;
  for (let i = 0; i < g.length; i++) {
    const info = g[i]!;
    outlineGlyph(e.state, info);
    // extra space after an italic to non-italic change
    if (i && g[i - 1]!.italic && !info.italic) {
      let back = i - 1;
      let og = g[back]!;
      while (back && og.bboxXMax - og.bboxXMin === 0 && og.italic) og = g[--back]!;
      if (og.bboxXMax > og.clusterAdvanceX) og.clusterAdvanceX = og.bboxXMax;
    }
    info.clusterAdvanceX += info.hspacingScaled;
  }
}

/** preliminary_layout */
function preliminaryLayout(e: EventText): void {
  let penX = 0;
  let penY = 0;
  for (const info of e.glyphs) {
    info.posX = penX;
    info.posY = penY;
    penX += info.clusterAdvanceX;
    penY += info.clusterAdvanceY;
  }
}

interface TextInfo { lines: LineInfo[]; height: number; borderTop: number; borderBottom: number; borderX: number; nLines: number }

/** wrap_lines_naive: a new line at the first breakable character after overflow; spaces only (no libunibreak). */
function wrapLinesNaive(e: EventText, ti: TextInfo, maxTextWidth: number): void {
  const g = e.glyphs;
  let s1 = 0;
  let lastBreakable = -1;
  let breakType = 0;
  ti.nLines = 1;
  for (let i = 0; i < g.length; i++) {
    const cur = g[i]!;
    let breakAt = -1;
    const sOffset = d6ToDouble(g[s1]!.bboxXMin + g[s1]!.posX);
    const len = d6ToDouble(cur.bboxXMax + cur.posX) - sOffset;
    if (cur.symbol === NEWLINE) {
      breakType = 2;
      breakAt = i;
    } else if (len >= maxTextWidth && cur.symbol !== SPACE && e.state.wrapStyle !== 2) {
      breakType = 1;
      breakAt = lastBreakable;
    }
    if (cur.symbol === SPACE) lastBreakable = i;
    if (breakAt !== -1 && breakAt + 1 < g.length) {
      const lead = breakAt + 1;
      g[lead]!.linebreak = breakType;
      lastBreakable = -1;
      s1 = lead;
      ti.nLines++;
    }
  }
}

/** rewind_trailing_spaces: from a line start back to the first non-space before it (not below start1). */
function rewindTrailingSpaces(g: readonly GlyphInfo[], start1: number, start2: number): number {
  let k = start2;
  do --k; while (k > start1 && g[k]!.symbol === SPACE);
  return k;
}

/** wrap_lines_rebalance: move soft breaks while it evens out neighbouring lines (not for WrapStyle 1). */
function wrapLinesRebalance(e: EventText): void {
  const g = e.glyphs;
  const right = (k: number): number => g[k]!.bboxXMax + g[k]!.posX;
  const left = (k: number): number => g[k]!.bboxXMin + g[k]!.posX;
  let exit = false;
  while (!exit && e.state.wrapStyle !== 1) {
    exit = true;
    let s1 = -1;
    let s2 = -1;
    let s3 = 0;
    for (let i = 0; i <= g.length; i++) {
      if (i === g.length || g[i]!.linebreak) {
        s1 = s2;
        s2 = s3;
        s3 = i;
        if (s1 >= 0 && g[s2]!.linebreak === 1) {
          let w = rewindTrailingSpaces(g, s1, s2);
          const e1Old = w;
          while (w > s1 && g[w]!.symbol !== SPACE) w--;
          let e1 = w;
          while (e1 > s1 && g[e1]!.symbol === SPACE) e1--;
          if (g[w]!.symbol === SPACE) w++;
          if (w === s1) continue;
          const e2 = rewindTrailingSpaces(g, s2, s3);
          const l1 = d6ToDouble(right(e1Old) - left(s1));
          const l2 = d6ToDouble(right(e2) - left(s2));
          const l1New = d6ToDouble(right(e1) - left(s1));
          const l2New = d6ToDouble(right(e2) - left(w));
          if (Math.abs(l1New - l2New) < Math.abs(l1 - l2)) {
            g[w]!.linebreak = 1;
            g[s2]!.linebreak = 0;
            s2 = w;
            exit = false;
          }
        }
      }
      if (i === g.length) break;
    }
  }
}

const isWhitespace = (x: GlyphInfo): boolean => (x.symbol === SPACE || x.symbol === NEWLINE) && !x.linebreak;

/** trim_whitespace */
function trimWhitespace(e: EventText): void {
  const g = e.glyphs;
  if (!g.length) return;
  const trim = (x: GlyphInfo): void => { x.skip = true; x.isTrimmedWhitespace = true; };
  let i = g.length - 1;
  while (i && isWhitespace(g[i]!)) trim(g[i--]!);
  i = 0;
  while (i < g.length && isWhitespace(g[i]!)) trim(g[i++]!);
  if (i < g.length) g[i]!.startsNewRun = true;
  for (i = 0; i < g.length; i++) {
    if (!g[i]!.linebreak) continue;
    let j = i - 1;
    while (j > 0 && isWhitespace(g[j]!)) trim(g[j--]!);
    let cur = i;
    if (g[i]!.symbol === SPACE || g[i]!.symbol === NEWLINE) {
      trim(g[i]!);
      j = i + 1;
      while (j < g.length && isWhitespace(g[j]!)) trim(g[j++]!);
      cur = j;
      i = j - 1;
    }
    if (cur < g.length) g[cur]!.startsNewRun = true;
  }
}

function measureTextOnEol(s: RenderState, ti: TextInfo, scale: number, line: number, maxAsc: number, maxDesc: number, maxBorderX: number, maxBorderY: number): void {
  ti.lines[line] = { asc: scale * maxAsc, desc: scale * maxDesc };
  ti.height += scale * maxAsc + scale * maxDesc;
  // VSFilter's biased rounding of the border
  ti.borderBottom = Math.trunc(s.borderScaleY * maxBorderY + 0.5);
  if (line === 0) ti.borderTop = ti.borderBottom;
  ti.borderX = Math.max(ti.borderX, Math.trunc(s.borderScaleX * maxBorderX + 0.5));
}

/** measure_text: line ascenders/descenders, height and border extents, ignoring trimmed whitespace. */
function measureText(e: EventText, ti: TextInfo): void {
  const s = e.state;
  ti.height = 0;
  ti.borderX = 0;
  ti.lines = [];
  let line = 0;
  let scale = 0.5 / 64;
  let maxAsc = 0;
  let maxDesc = 0;
  let maxBorderY = 0;
  let maxBorderX = 0;
  let emptyTrimmedLine = true;
  for (const cur of e.glyphs) {
    if (cur.linebreak) {
      measureTextOnEol(s, ti, scale, line, maxAsc, maxDesc, maxBorderX, maxBorderY);
      emptyTrimmedLine = true;
      maxAsc = maxDesc = 0;
      maxBorderY = maxBorderX = 0;
      scale = 0.5 / 64;
      line++;
    }
    if (emptyTrimmedLine && !cur.isTrimmedWhitespace) {
      emptyTrimmedLine = false;
      maxAsc = maxDesc = 0;
      maxBorderY = maxBorderX = 0;
    } else if (!emptyTrimmedLine && cur.isTrimmedWhitespace) {
      continue;
    }
    maxAsc = Math.max(maxAsc, cur.asc);
    maxDesc = Math.max(maxDesc, cur.desc);
    maxBorderY = Math.max(maxBorderY, cur.borderY);
    maxBorderX = Math.max(maxBorderX, cur.borderX);
    if (cur.symbol !== NEWLINE) scale = 1 / 64;
  }
  measureTextOnEol(s, ti, scale, line, maxAsc, maxDesc, maxBorderX, maxBorderY);
}

/** reorder_text for left-to-right text: glyphs in logical order, lines stacked. */
function reorderText(e: EventText, ti: TextInfo): void {
  let penX = 0;
  let penY = 0;
  let lineno = 1;
  for (const info of e.glyphs) {
    if (info.linebreak) {
      penX = 0;
      penY += doubleToD6(ti.lines[lineno - 1]!.desc);
      penY += doubleToD6(ti.lines[lineno]!.asc);
      lineno++;
    }
    if (info.skip) continue;
    info.posX = info.offsetX + penX;
    info.posY = info.offsetY + penY;
    penX += info.clusterAdvanceX;
    penY += info.clusterAdvanceY;
  }
}

/** align_lines */
function alignLines(e: EventText, maxTextWidth: number): void {
  const g = e.glyphs;
  const halign = e.state.alignment & 3;
  const justify = e.state.justify;
  const counts = (x: GlyphInfo): boolean => !x.skip && x.symbol !== NEWLINE && x.symbol !== 0;
  let width = 0;
  let maxWidth = 0;
  for (let i = 0; i <= g.length; i++) {
    if (i === g.length || g[i]!.linebreak) {
      maxWidth = Math.max(maxWidth, width);
      width = 0;
    }
    if (i < g.length && counts(g[i]!)) width += d6ToDouble(g[i]!.clusterAdvanceX);
  }
  let lastBreak = -1;
  width = 0;
  for (let i = 0; i <= g.length; i++) {
    if (i === g.length || g[i]!.linebreak) {
      let shift = 0;
      if (halign === HALIGN_LEFT) {
        if (justify === ASS_JUSTIFY_RIGHT) shift = maxWidth - width;
        else if (justify === ASS_JUSTIFY_CENTER) shift = (maxWidth - width) / 2;
      } else if (halign === HALIGN_RIGHT) {
        if (justify === ASS_JUSTIFY_LEFT) shift = maxTextWidth - maxWidth;
        else if (justify === ASS_JUSTIFY_CENTER) shift = maxTextWidth - maxWidth + (maxWidth - width) / 2;
        else shift = maxTextWidth - width;
      } else if (halign === HALIGN_CENTER) {
        if (justify === ASS_JUSTIFY_LEFT) shift = (maxTextWidth - maxWidth) / 2;
        else if (justify === ASS_JUSTIFY_RIGHT) shift = (maxTextWidth - maxWidth) / 2 + maxWidth - width;
        else shift = (maxTextWidth - width) / 2;
      }
      for (let j = lastBreak + 1; j < i; j++) g[j]!.posX += doubleToD6(shift);
      lastBreak = i - 1;
      width = 0;
    }
    if (i < g.length && counts(g[i]!)) width += d6ToDouble(g[i]!.clusterAdvanceX);
  }
}

/** compute_string_bbox */
function stringBbox(e: EventText, ti: TextInfo): [number, number, number, number] {
  if (!e.glyphs.length) return [0, 0, 0, 0];
  let xMin = 32000;
  let xMax = -32000;
  const yMin = -ti.lines[0]!.asc;
  const yMax = yMin + ti.height;
  for (const info of e.glyphs) {
    if (info.skip) continue;
    const s = d6ToDouble(info.posX);
    xMin = Math.min(xMin, s);
    xMax = Math.max(xMax, s + d6ToDouble(info.clusterAdvanceX));
  }
  return [xMin, yMin, xMax, yMax];
}

/** apply_baseline_shear (no whole-text layout: the shear restarts at each run and line) */
function applyBaselineShear(e: EventText): void {
  let shear = 0;
  for (const info of e.glyphs) {
    if (info.linebreak || info.startsNewRun) shear = 0;
    if (!info.scaleX || !info.scaleY) info.skip = true;
    if (info.skip) continue;
    const fay = (info.fay / info.scaleX) * info.scaleY;
    // int32 arithmetic as in the C: each assignment truncates
    info.posY = Math.trunc(info.posY + shear + fay * info.offsetX);
    shear = Math.trunc(shear + fay * info.advanceX);
  }
}

/** get_base_point */
export function basePoint(bbox: readonly [number, number, number, number], alignment: number): [number, number] {
  const h = alignment & 3;
  const v = alignment & 12;
  const bx = h === HALIGN_LEFT ? bbox[0] : h === HALIGN_CENTER ? (bbox[2] + bbox[0]) / 2 : h === HALIGN_RIGHT ? bbox[2] : 0;
  const by = v === VALIGN_TOP ? bbox[1] : v === VALIGN_CENTER ? (bbox[3] + bbox[1]) / 2 : v === VALIGN_SUB ? bbox[3] : 0;
  return [bx, by];
}

const lround = (x: number): number => (x < 0 ? -Math.round(-x) : Math.round(x));

/** ass_render_event from splitting the text through positioning and the clip fix-up. */
export function layoutEvent(e: EventText, fonts: AssFonts, measurer: GlyphMeasurer): LaidOutEvent {
  const s = e.state;
  const ev = s.event;
  shape(e, fonts, measurer);
  retrieveGlyphs(e);
  preliminaryLayout(e);

  const valign = s.alignment & 12;
  const marginL = ev.marginL || s.style.marginL;
  const marginR = ev.marginR || s.style.marginR;
  const marginV = ev.marginV || s.style.marginV;
  const maxTextWidth = x2scr(s, s.track.playResX - marginR) - x2scr(s, marginL);

  const ti: TextInfo = { lines: [], height: 0, borderTop: 0, borderBottom: 0, borderX: 0, nLines: 1 };
  // wrap_lines_smart
  wrapLinesNaive(e, ti, maxTextWidth);
  wrapLinesRebalance(e);
  trimWhitespace(e);
  measureText(e, ti);

  processKaraoke(e, e.now);
  reorderText(e, ti);
  alignLines(e, maxTextWidth);
  const bbox = stringBbox(e, ti);
  applyBaselineShear(e);

  let deviceX = 0;
  let deviceY = 0;
  if (s.evtType & EVENT_POSITIONED) {
    const [bx, by] = basePoint(bbox, s.alignment);
    deviceX = x2scr(s, s.posX) - bx;
    deviceY = y2scr(s, s.posY) - by;
  } else {
    deviceX = x2scr(s, marginL);
    if (valign === VALIGN_TOP) {
      deviceY = y2scr(s, marginV) + ti.lines[0]!.asc;
    } else if (valign === VALIGN_CENTER) {
      deviceY = y2scr(s, s.track.playResY / 2) - (bbox[3] + bbox[1]) / 2;
    } else {
      // line_position 0
      deviceY = y2scr(s, s.track.playResY - marginV) - ti.height + ti.lines[0]!.asc;
    }
  }

  // clip coordinates to frame pixels (use_margins off: always), clamped to the frame for explicit events
  let x0 = lround(x2scrScaled(s, s.clipX0));
  let x1 = lround(x2scrScaled(s, s.clipX1));
  let y0 = lround(y2scr(s, s.clipY0));
  let y1 = lround(y2scr(s, s.clipY1));
  if (s.explicit) {
    x0 = Math.max(x0, 0);
    y0 = Math.max(y0, 0);
    x1 = Math.min(x1, s.settings.frameWidth);
    y1 = Math.min(y1, s.settings.frameHeight);
  }

  return {
    text: e, lines: ti.lines, deviceX, deviceY, bbox, height: ti.height,
    borderTop: ti.borderTop, borderBottom: ti.borderBottom, borderX: ti.borderX,
    clip: { x0, y0, x1, y1, mode: s.clipMode, drawing: s.clipDrawingText, drawingScale: s.clipDrawingScale, drawingMode: s.clipDrawingMode },
  };
}
