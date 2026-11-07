/*
 * Draws a laid-out event onto a canvas with libass's compositing: per run a fill mask, a border mask (the fill
 * widened by the border ellipse), blur, the fill cut out of the border, a shadow, colours and karaoke, clips;
 * shadows of all runs first, then borders, then fills. Glyphs are rasterized by the browser.
 *
 * Ported from libass 0.17.5 (ass_render.c): the filter flags of render_and_combine_glyphs, the positions of
 * quantize_transform, quantize_blur, restore_blur, the composition of ass_composite_construct, render_text,
 * render_glyph (rectangle and karaoke split), blend_vector_clip (as a canvas clip), the BorderStyle 3 box of
 * get_bitmap_glyph; (ass_bitmap.c):
 * ass_fix_outline; (ass_font.c): the strengths of ass_glyph_embolden and ass_glyph_italicize and the decoration
 * rectangles of ass_get_glyph_outline. libass is ISC-licensed; see src/engine/NOTICE. Modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

import { parseDrawing, toPath2D } from './drawing';
import { doubleToD6, lrint, type GlyphInfo } from './events';
import type { FrameEvent } from './frame';
import { DECO_STRIKETHROUGH, DECO_UNDERLINE, EF_KARAOKE, EF_KARAOKE_KF, EF_KARAOKE_KO, type RenderState } from './state';
import { applyFade } from './tags';
import { applyMat3, isAffine, normalize, type Mat3 } from './transform';

export const FILTER_BORDER_STYLE_3 = 0x01;
export const FILTER_NONZERO_BORDER = 0x02;
export const FILTER_NONZERO_SHADOW = 0x04;
export const FILTER_FILL_IN_SHADOW = 0x08;
export const FILTER_FILL_IN_BORDER = 0x10;

const BLUR_PRECISION = 1 / 256;
const POSITION_PRECISION = 8;
const BLUR_RADIUS_SCALE = 2 / Math.sqrt(Math.log(256));

const alpha = (c: number): number => c & 0xff;

/** The filter flags of render_and_combine_glyphs for a run's first glyph. */
export function runFlags(info: Pick<GlyphInfo, 'borderStyle' | 'borderX' | 'borderY' | 'shadowX' | 'shadowY' | 'effectType' | 'fade' | 'c'>): number {
  let flags = 0;
  if (info.borderStyle === 3) flags |= FILTER_BORDER_STYLE_3;
  if (info.borderX || info.borderY) flags |= FILTER_NONZERO_BORDER;
  if (info.shadowX || info.shadowY) flags |= FILTER_NONZERO_SHADOW;
  if (flags & FILTER_NONZERO_SHADOW && (info.effectType === EF_KARAOKE_KF || info.effectType === EF_KARAOKE_KO || alpha(info.c[0]) !== 0xff || info.borderStyle === 3)) flags |= FILTER_FILL_IN_SHADOW;
  if (!(flags & FILTER_NONZERO_BORDER) && !(flags & FILTER_FILL_IN_SHADOW)) flags &= ~FILTER_NONZERO_SHADOW;
  if ((flags & FILTER_NONZERO_BORDER && alpha(info.c[0]) === 0 && alpha(info.c[1]) === 0 && info.fade === 0) || info.borderStyle === 3) flags |= FILTER_FILL_IN_BORDER;
  return flags;
}

/** quantize_blur: the quantisation step and the shadow mask for a radius in px. */
function quantizeBlur(radius: number): { q: number; mask: number } {
  const scale = (64 * BLUR_PRECISION) / POSITION_PRECISION;
  radius *= scale;
  // ord = floor(log2((1 + radius) * POSITION_PRECISION))
  const ord = Math.floor(Math.log2((1 + radius) * POSITION_PRECISION));
  return { q: lrint(Math.log1p(radius) / BLUR_PRECISION), mask: (1 << ord) - 1 };
}

/** restore_blur(quantize_blur(...)): the Gaussian variance (px²) libass blurs with for \blur along one axis. */
export function blurVariance(blur: number, blurScale: number): number {
  const { q } = quantizeBlur(blur * blurScale * BLUR_RADIUS_SCALE);
  const sigma = Math.expm1(BLUR_PRECISION * q) / ((64 * BLUR_PRECISION) / POSITION_PRECISION);
  return sigma * sigma;
}

/** The shadow offset (26.6) rounded to the grid quantize_blur gives for this blur radius (px). */
export function quantizeShadow(shadow26: number, blurRadius: number): number {
  const { mask } = quantizeBlur(blurRadius);
  return (shadow26 + (mask >> 1)) & ~mask;
}

/** ass_fix_outline: the fill cut out of the border. */
export function fixOutline(fill: Uint8Array, border: Uint8Array): void {
  for (let i = 0; i < border.length; i++) {
    const o = border[i]!;
    const g = fill[i]!;
    border[i] = o > g ? o - (g >> 1) : 0;
  }
}

/** 1D squared distance transform (Felzenszwalb), weighted. */
function edt1d(f: Float64Array, n: number, weight: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    if (f[q] === Infinity) continue;
    if (f[v[0]!] === Infinity) { v[0] = q; continue; }
    let s: number;
    for (;;) {
      const p = v[k]!;
      s = (f[q]! + weight * q * q - (f[p]! + weight * p * p)) / (2 * weight * (q - p));
      if (s <= z[k]!) {
        if (k === 0) { v[0] = q; s = -Infinity; break; }
        k--;
      } else break;
    }
    if (s === -Infinity) { z[0] = -Infinity; z[1] = Infinity; continue; }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  if (f[v[0]!] === Infinity) { d.fill(Infinity, 0, n); return; }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const p = v[k]!;
    d[q] = weight * (q - p) * (q - p) + f[p]!;
  }
}

/**
 * The mask widened by an axis-aligned ellipse of radii rx, ry (px): what stroking the outline with round joins
 * covers. A weighted Euclidean distance transform from the pixels at least half covered.
 */
export function dilate(mask: Uint8Array, w: number, h: number, rx: number, ry: number): Uint8Array {
  const out = new Uint8Array(mask);
  if (rx <= 0 && ry <= 0) return out;
  const r = Math.max(rx, ry);
  // distances in a metric where the ellipse is a circle of radius r
  const wx = (r / Math.max(rx, 1e-9)) ** 2;
  const wy = (r / Math.max(ry, 1e-9)) ** 2;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = mask[i]! >= 128 ? 0 : Infinity;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]!;
    edt1d(f, h, wy, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]!;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x]!;
    edt1d(f, w, wx, d, v, z);
    for (let x = 0; x < w; x++) {
      const dist = Math.sqrt(d[x]!);
      const cov = Math.min(1, Math.max(0, r + 1 - dist));
      const i = y * w + x;
      out[i] = Math.max(out[i]!, Math.round(cov * 255));
    }
  }
  return out;
}

/** What the raster needs from its host: canvases, Path2D, and the projective warp for 3D-rotated runs. */
export interface RasterContext {
  createCanvas(w: number, h: number): OffscreenCanvas;
  readonly Path2D: typeof Path2D;
  /** Draws `source` (laid out in layout space, origin at the run's first glyph) onto `target` through `m`; `origin` is where target's (0,0) is on the frame. */
  warp?(target: OffscreenCanvasRenderingContext2D, source: OffscreenCanvas, m: Mat3, originX: number, originY: number): void;
  /** Maps a 0xRRGGBBAA colour before drawing (the player's colour-matrix conversion). */
  mapColor?(c: number): number;
  /** Rendered run masks by everything that shapes them (libass's bitmap and composite caches). */
  readonly masks?: MaskCache;
  /** Each animated run's last shape (its mask key without position): a run whose shape changes every frame is drawn directly. */
  readonly lastShapes?: Map<string, string>;
  /** Whether canvases honour `ctx.filter`; without it a blurred run is never drawn directly (the blur runs on the mask in JS). */
  readonly canvasFilter: boolean;
  /** Cap of the per-side text supersampling (default 8). */
  readonly maxTextSupersampling?: number;
  /** Coloured run layers by mask and colours (libass's composite cache): a run that only moves is one drawImage. */
  readonly layers?: LayerCache;
}

export interface RunMasks { readonly w: number; readonly h: number; readonly fill: Uint8Array; readonly border: Uint8Array | null; readonly shadow: Uint8Array | null }
export interface MaskCache { get(key: string): RunMasks | undefined; set(key: string, masks: RunMasks): void }
/** Layers positioned relative to the run's canvas origin. */
export interface CachedLayers { readonly shadow: Layer | null; readonly border: Layer | null; readonly fill: Layer | null; readonly ox: number; readonly oy: number }
export interface LayerCache { get(key: string): CachedLayers | undefined; set(key: string, layers: CachedLayers): void }

/** libass's subpixel grid: 1/8 px, in 26.6 units. */
const POSITION_GRID = 8;

/**
 * quantize_transform's positions for a run (affine glyphs): the first glyph with ink has the centre of its box
 * rounded to the 1/8 px grid, and every glyph is first moved by that rounding, then has its own centre rounded.
 * Glyphs stay on the grid relative to the run, so cached masks fit any frame.
 */
export function quantizePositions(glyphs: readonly GlyphInfo[], mats: readonly Mat3[]): Mat3[] {
  let offset: readonly [number, number] | null = null;
  return mats.map((m, k) => {
    if (!isAffine(m)) return m;
    const g = glyphs[k]!;
    const [cx, cy] = applyMat3(m, (g.bboxXMin + g.bboxXMax) / 2, (g.bboxYMin + g.bboxYMax) / 2);
    const c = [cx / POSITION_GRID, cy / POSITION_GRID] as const;
    const inked = g.bboxXMax > g.bboxXMin && g.bboxYMax > g.bboxYMin;
    const d = offset ?? [0, 0];
    const q = [Math.round(c[0] - d[0]), Math.round(c[1] - d[1])] as const;
    if (!offset && inked) offset = [c[0] - q[0], c[1] - q[1]];
    return [m[0], m[1], m[2] + (q[0] - c[0]) * POSITION_GRID, m[3], m[4], m[5] + (q[1] - c[1]) * POSITION_GRID, m[6], m[7], m[8]] as Mat3;
  });
}

/** An event composited into one canvas; drawn at (x, y + the event's collision shift). */
export interface RenderedEvent { readonly canvas: OffscreenCanvas; readonly x: number; readonly y: number }

/** A coloured layer at a frame position: pixels (the mask path) or a canvas (the direct path). */
export interface Layer { x: number; y: number; w: number; h: number; data?: ImageData; canvas?: OffscreenCanvas }
interface RunLayers { shadow: Layer | null; border: Layer | null; fill: Layer | null }

type Affine = [number, number, number, number, number, number];

/** The canvas transform taking a glyph's local text px (at its em size) to device px through m and its outline transform. */
function glyphAffine(m: Mat3, g: GlyphInfo): Affine {
  const sx = g.trScaleX;
  const sy = g.trScaleY;
  const ox = g.trOffsetX;
  const oy = g.trOffsetY;
  // local px → outline 26.6 is ×64; outline → layout is (s·o + offset); m maps layout 26.6 to device 26.6
  const a = m[0] * sx;
  const b = m[3] * sx;
  const c = m[1] * sy;
  const d = m[4] * sy;
  const e = (m[0] * ox + m[1] * oy + m[2]) / 64;
  const f = (m[3] * ox + m[4] * oy + m[5]) / 64;
  return [a, b, c, d, e, f];
}

/** Draws one glyph's fill (text, synthetic bold, decorations, or drawing) in white at the current transform. */
function drawGlyph(ctx: OffscreenCanvasRenderingContext2D, g: GlyphInfo, rc: RasterContext, borderWidth = 0): void {
  if (g.drawingText !== null) {
    const d = g.drawing ?? parseDrawing(g.drawingText);
    const path = toPath2D(d, (x, y) => [x / 64, y / 64], rc.Path2D);
    ctx.fill(path, 'nonzero');
    if (borderWidth > 0) {
      ctx.lineWidth = borderWidth;
      ctx.stroke(path);
    }
    return;
  }
  const face = g.face;
  if (!face) return;
  const em = g.emPx;
  if (face.synthItalic) ctx.transform(1, 0, -face.italicShear, 1, 0, 0);
  ctx.font = `${em}px "${face.cssFamily}"`;
  // unhinted outlines at fractional positions, as libass renders them (ASS_HINTING_NONE)
  ctx.textRendering = 'geometricPrecision';
  ctx.fontKerning = 'none';
  const text = g.clusterText ?? String.fromCodePoint(g.symbol);
  const bold = face.synthBold ? em / 64 : 0;
  // FT_Outline_Embolden grows the outline right and up by its strength, keeping the left and bottom edges: a
  // centred stroke of that width, moved by half of it, does the same
  if (bold > 0) ctx.translate(bold / 2, -bold / 2);
  ctx.fillText(text, 0, 0);
  if (bold > 0 || borderWidth > 0) {
    if (bold > 0) {
      // ass_glyph_embolden: FT_Outline_Embolden moves points along corner bisectors (mitred corners)
      ctx.lineWidth = bold;
      ctx.lineJoin = 'miter';
      ctx.strokeText(text, 0, 0);
    }
    if (borderWidth > 0) {
      ctx.lineWidth = bold + borderWidth;
      ctx.lineJoin = 'round';
      ctx.strokeText(text, 0, 0);
    }
  }
  if (bold > 0) ctx.translate(-bold / 2, bold / 2);
  const f = face.face;
  const k = em / f.unitsPerEm;
  const adv = Math.round(g.metrics?.advance ?? 0);
  if (adv > 0 && g.flags & DECO_UNDERLINE && f.underlinePosition <= 0 && f.underlineThickness > 0) {
    const size = Math.round(f.underlineThickness * k * 64) / 64;
    ctx.fillRect(0, -f.underlinePosition * k - size / 2, adv, size);
    if (borderWidth > 0) {
      ctx.lineWidth = borderWidth;
      ctx.strokeRect(0, -f.underlinePosition * k - size / 2, adv, size);
    }
  }
  if (adv > 0 && g.flags & DECO_STRIKETHROUGH && f.strikeoutPosition >= 0 && f.strikeoutSize > 0) {
    const size = Math.round(f.strikeoutSize * k * 64) / 64;
    ctx.fillRect(0, -f.strikeoutPosition * k - size / 2, adv, size);
    if (borderWidth > 0) {
      ctx.lineWidth = borderWidth;
      ctx.strokeRect(0, -f.strikeoutPosition * k - size / 2, adv, size);
    }
  }
}

/**
 * The border as the canvas stroke of each glyph with round joins, when every glyph's transform is a uniform scale
 * and rotation and the border is round (the common case): exact, unlike the distance transform. Null otherwise.
 */
function strokedBorder(rc: RasterContext, glyphs: readonly GlyphInfo[], mats: readonly Mat3[], w: number, h: number, ox: number, oy: number, bx26: number, by26: number, ss: number): Uint8Array | null {
  if (Math.abs(bx26 - by26) > 1e-6 * Math.max(bx26, by26)) return null;
  const transforms = glyphs.map((g, k) => glyphAffine(mats[k]!, g));
  const scales: number[] = [];
  for (const t of transforms) {
    const sx = Math.hypot(t[0], t[1]);
    const sy = Math.hypot(t[2], t[3]);
    if (Math.abs(sx - sy) > 1e-4 * Math.max(sx, sy) || Math.abs(t[0] * t[2] + t[1] * t[3]) > 1e-4 * sx * sy) return null;
    scales.push(sx);
  }
  return supersampled(rc, w, h, ss, (ctx) => {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    glyphs.forEach((g, k) => {
      const t = transforms[k]!;
      // the border radius in layout px is bx26/64; the glyph's layout→device scale is the same for x and y here
      const m = mats[k]!;
      const layoutToDevice = Math.hypot(m[0], m[3]);
      const radius = ((bx26 / 64) * layoutToDevice) / scales[k]!; // in the glyph's local px
      ctx.setTransform(ss * t[0], ss * t[1], ss * t[2], ss * t[3], ss * (t[4] - ox), ss * (t[5] - oy));
      drawGlyph(ctx, g, rc, 2 * radius);
    });
  });
}

/** The BorderStyle 3 box of a glyph, as get_bitmap_glyph builds it, in layout 26.6 relative to the glyph. */
function boxRect(s: RenderState, g: GlyphInfo): [number, number, number, number] {
  let bx = (64 * g.borderX * s.borderScaleX) / s.parScaleX;
  let by = 64 * g.borderY * s.borderScaleY;
  let width = g.hspacingScaled + g.advanceX;
  let height = g.asc + g.desc;
  const osx = g.scaleX * g.scaleFix;
  const osy = g.scaleY * g.scaleFix;
  // VSFilter's double scaling of the opaque box
  bx *= osx;
  by *= osy;
  width *= osx;
  height *= osy;
  bx = Math.max(64, bx);
  by = Math.max(64, by);
  // get_bitmap_glyph maps the unit box straight into the matrix's layout units: offset (−bx, −by − asc), size + 2·bord
  const x0 = -bx;
  const y0 = -by - g.asc;
  return [x0, y0, x0 + width + 2 * bx, y0 + height + 2 * by];
}

/**
 * Draws white at ss× the size and box-filters it down, for anti-aliasing close to libass's exact coverage.
 * Static events (drawn once, cached) use STATIC_SS, animated ones ANIMATED_SS.
 */
const STATIC_SS = 4;
const ANIMATED_SS = 2;
/**
 * Chrome draws text under about 256 device px from a glyph cache that snaps the baseline to whole pixels (and x to
 * quarter pixels); larger text is filled as exact paths. Text runs are supersampled enough to reach that size, up
 * to the cap (8 by default), where the snapping is at most 1/16 px.
 */
const PATH_TEXT_PX = 256;
const DEFAULT_MAX_TEXT_SS = 8;

/** The supersampling factor for a run's masks. */
export function textSupersampling(base: number, glyphs: readonly GlyphInfo[], mats: readonly Mat3[], maxSs = DEFAULT_MAX_TEXT_SS): number {
  let ss = base;
  glyphs.forEach((g, k) => {
    if (g.drawingText !== null || !g.face || g.emPx <= 0) return;
    const t = glyphAffine(mats[k]!, g);
    const px = g.emPx * Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2]));
    if (px > 0) ss = Math.max(ss, Math.min(maxSs, Math.ceil(PATH_TEXT_PX / px)));
  });
  return ss;
}
function supersampled(rc: RasterContext, w: number, h: number, ss: number, draw: (ctx: OffscreenCanvasRenderingContext2D) => void): Uint8Array {
  const big = rc.createCanvas(w * ss, h * ss);
  // GPU-backed although read back once: Chrome's CPU canvases snap the baseline of text under 256 px to whole
  // pixels (and x to quarter pixels), which the GPU's glyph atlas positions to a few hundredths
  const ctx = big.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  draw(ctx);
  const hi = ctx.getImageData(0, 0, w * ss, h * ss).data;
  const out = new Uint8Array(w * h);
  const W = w * ss;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = 0; j < ss; j++) {
        const row = ((y * ss + j) * W + x * ss) * 4 + 3;
        for (let i = 0; i < ss; i++) sum += hi[row + 4 * i]!;
      }
      out[y * w + x] = Math.round(sum / (ss * ss));
    }
  }
  return out;
}

function readAlpha(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number): Uint8Array {
  const data = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = data[4 * i + 3]!;
  return out;
}

/** Normalized taps of a sampled Gaussian, out to 3σ. */
function gaussianKernel(sigma: number): Float64Array {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  return k;
}

/**
 * A Gaussian blur of an alpha mask with separate x and y deviations, like ass_gaussian_blur. Done in JS rather
 * than by the canvas filter: Chrome's CPU-backed canvases (the ones we read back) approximate blur() with box
 * passes that drop deviations under 0.8 px and step coarsely above.
 */
export function gaussianBlur(mask: Uint8Array, w: number, h: number, sigmaX: number, sigmaY: number): Uint8Array {
  if (sigmaX < 0.03 && sigmaY < 0.03) return mask;
  let buf = Float64Array.from(mask);
  const pass = (sigma: number, horizontal: boolean): void => {
    if (sigma < 0.03) return;
    const k = gaussianKernel(sigma);
    const r = (k.length - 1) / 2;
    const out = new Float64Array(buf.length);
    const [n, lines, step, stride] = horizontal ? [w, h, 1, w] : [h, w, w, 1];
    for (let line = 0; line < lines; line++) {
      const base = line * stride;
      for (let i = 0; i < n; i++) {
        const v = buf[base + i * step]!;
        if (v === 0) continue;
        const lo = Math.max(0, i - r);
        const hi = Math.min(n - 1, i + r);
        for (let j = lo; j <= hi; j++) out[base + j * step]! += v * k[j - i + r]!;
      }
    }
    buf = out;
  };
  pass(sigmaX, true);
  pass(sigmaY, false);
  const res = new Uint8Array(mask.length);
  for (let i = 0; i < res.length; i++) res[i] = Math.min(255, Math.round(buf[i]!));
  return res;
}

function colorize(mask: Uint8Array, w: number, h: number, color: (x: number) => number, x0: number, y0: number): Layer {
  const data = new ImageData(w, h);
  const d = data.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = mask[i]!;
      if (!m) continue;
      const c = color(x0 + x);
      d[4 * i] = c >>> 24;
      d[4 * i + 1] = (c >>> 16) & 0xff;
      d[4 * i + 2] = (c >>> 8) & 0xff;
      d[4 * i + 3] = Math.round((m * (255 - (c & 0xff))) / 255);
    }
  }
  return { x: x0, y: y0, w, h, data };
}

/** Renders a run's shadow, border and fill layers in device space. */
function renderRun(rc: RasterContext, ev: FrameEvent, idx: readonly number[], runIndex: number): RunLayers {
  const s = ev.layout.text.state;
  const glyphs = idx.map((i) => ev.layout.text.glyphs[i]!);
  const mats = quantizePositions(glyphs, idx.map((i) => normalize(ev.matrices[i]!)));
  const ss = textSupersampling(ev.animated ? ANIMATED_SS : STATIC_SS, glyphs, mats, rc.maxTextSupersampling);
  const first = glyphs[0]!;
  const flags = runFlags(first);
  const c = first.c.map((v) => { const f = applyFade(v, first.fade); return rc.mapColor ? rc.mapColor(f) : f; });

  // border ellipse in layout 26.6 (get_bitmap_glyph), mapped to device px by the first glyph's matrix
  const bx26 = (64 * s.borderScaleX * first.borderX) / s.parScaleX;
  const by26 = 64 * s.borderScaleY * first.borderY;
  const m0 = mats[0]!;
  // the projection's derivative at the glyph origin (m is normalized: m[8] = 1)
  const jxx = m0[0] - m0[2] * m0[6];
  const jxy = m0[1] - m0[2] * m0[7];
  const jyx = m0[3] - m0[5] * m0[6];
  const jyy = m0[4] - m0[5] * m0[7];
  const rx = Math.hypot(jxx * bx26, jyx * bx26) / 64;
  const ry = Math.hypot(jxy * by26, jyy * by26) / 64;
  const r2x = blurVariance(first.blur, s.blurScaleX);
  const r2y = blurVariance(first.blur, s.blurScaleY);
  const sigmaX = Math.sqrt(r2x + 0.5 * first.be);
  const sigmaY = Math.sqrt(r2y + 0.5 * first.be);
  const sigma = Math.sqrt((r2x + r2y) / 2 + 0.5 * first.be);
  const shadow26X = quantizeShadow(doubleToD6(first.shadowX * s.borderScaleX), first.blur * s.blurScaleX * BLUR_RADIUS_SCALE);
  const shadow26Y = quantizeShadow(doubleToD6(first.shadowY * s.borderScaleY), first.blur * s.blurScaleY * BLUR_RADIUS_SCALE);

  // device bounding box of the run's glyph boxes (and BorderStyle 3 boxes), padded for border, blur and shadow
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (m: Mat3, x: number, y: number): void => {
    const [px, py] = applyMat3(m, x, y);
    minX = Math.min(minX, px / 64); maxX = Math.max(maxX, px / 64);
    minY = Math.min(minY, py / 64); maxY = Math.max(maxY, py / 64);
  };
  glyphs.forEach((g, k) => {
    const m = mats[k]!;
    const boxes: [number, number, number, number][] = [[g.bboxXMin, g.bboxYMin, g.bboxXMax, g.bboxYMax]];
    if (flags & FILTER_BORDER_STYLE_3) boxes.push(boxRect(s, g));
    for (const [x0, y0, x1, y1] of boxes) {
      extend(m, x0, y0); extend(m, x1, y0); extend(m, x0, y1); extend(m, x1, y1);
    }
  });
  if (!Number.isFinite(minX)) return { shadow: null, border: null, fill: null };
  const pad = Math.ceil(Math.max(rx, ry) + 3 * sigma + 3);
  const ox = Math.floor(minX) - pad;
  const oy = Math.floor(minY) - pad;
  const w = Math.ceil(maxX) + pad - ox;
  const h = Math.ceil(maxY) + pad - oy;
  if (w <= 0 || h <= 0 || w * h > 4096 * 4096) return { shadow: null, border: null, fill: null };

  const key = rc.masks ? maskKey(glyphs, mats, ox, oy, w, h, flags, bx26, by26, sigma, s, ss) : '';
  // an animated run whose shape changes every frame (rotation, size…) would never hit the cache: drawn straight
  // onto canvases (GPU, no read-back) when compositing allows it; moving, fading or karaoke runs keep their masks
  let reshaped = false;
  if (ev.animated && rc.lastShapes) {
    // no position and no canvas size (both follow the sub-pixel position of a run that only moves)
    // nor the fill-in flags, which follow the alpha (a fade)
    const shapeFlags = flags & ~(FILTER_FILL_IN_BORDER | FILTER_FILL_IN_SHADOW);
    const shapeKey = maskKey(glyphs, mats.map((m) => [m[0], m[1], 0, m[3], m[4], 0, m[6], m[7], m[8]] as Mat3), 0, 0, 0, 0, shapeFlags, bx26, by26, sigma, s, ss);
    const id = `${ev.index}:${runIndex}`;
    reshaped = rc.lastShapes.get(id) !== undefined && rc.lastShapes.get(id) !== shapeKey;
    rc.lastShapes.set(id, shapeKey);
  }
  const direct = reshaped && mats.every(isAffine) && !(flags & FILTER_BORDER_STYLE_3)
    && (!(flags & FILTER_NONZERO_BORDER) || (flags & FILTER_FILL_IN_BORDER) !== 0)
    && (!(flags & FILTER_NONZERO_SHADOW) || (flags & FILTER_FILL_IN_SHADOW) !== 0);
  if (direct && (rc.canvasFilter || sigma < 0.03) && !rc.masks?.get(key)) return directLayers();

  const type = first.effectType;
  const kTiming = first.effectTiming;
  const colorKey = rc.layers
    ? layerKey(key, c, type, type === EF_KARAOKE_KF ? kfBreak(glyphs, mats, first, s.parScaleX) - ox : kTiming > 0 ? 1 : 0, shadow26X, shadow26Y)
    : '';
  const hit = rc.layers?.get(colorKey);
  if (hit) {
    const at = (l: Layer | null): Layer | null => (l ? { ...l, x: l.x + ox - hit.ox, y: l.y + oy - hit.oy } : null);
    return { shadow: at(hit.shadow), border: at(hit.border), fill: at(hit.fill) };
  }
  const result = layersFromMasks();
  if (rc.layers) {
    const toCanvas = (l: Layer | null): Layer | null => {
      if (!l?.data) return l;
      const canvas = rc.createCanvas(l.w, l.h);
      canvas.getContext('2d')!.putImageData(l.data, 0, 0);
      return { x: l.x, y: l.y, w: l.w, h: l.h, canvas };
    };
    const stored = { shadow: toCanvas(result.shadow), border: toCanvas(result.border), fill: toCanvas(result.fill), ox, oy };
    rc.layers.set(colorKey, stored);
    return stored;
  }
  return result;

  function layersFromMasks(): RunLayers {
    const cached = rc.masks?.get(key);
    const masks = cached ?? buildMasks();
    if (!cached) rc.masks?.set(key, masks);
    return colorLayers(masks.fill, masks.border, masks.shadow);
  }

  /**
   * White shapes drawn by the canvas and tinted with source-in, for a run whose border keeps the fill (opaque fill)
   * and whose shadow takes the whole shape: no ass_fix_outline is needed, so no pixels are read back.
   */
  function directLayers(): RunLayers {
    // text supersampled on the GPU past the glyph cache's baseline snapping, then scaled down (and blurred) there;
    // a power of two, halved step by step: a bilinear 2:1 step is the 2×2 box filter of `supersampled` on CPU and
    // GPU canvases alike, where 'high' smoothing filters differently on each (and failed the libass budget on CPU)
    const dss = 2 ** Math.ceil(Math.log2(textSupersampling(1, glyphs, mats, rc.maxTextSupersampling)));
    const shapes = (borderWidthOf: ((k: number) => number) | null, blurred: boolean): OffscreenCanvas => {
      const draw = (ctx: OffscreenCanvasRenderingContext2D, scale: number): void => {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#fff';
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        glyphs.forEach((g, k) => {
          const t = glyphAffine(mats[k]!, g);
          ctx.setTransform(scale * t[0], scale * t[1], scale * t[2], scale * t[3], scale * (t[4] - ox), scale * (t[5] - oy));
          drawGlyph(ctx, g, rc, borderWidthOf ? borderWidthOf(k) : 0);
        });
      };
      const canvas = rc.createCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      const filter = blurred && sigma >= 0.03 ? `blur(${sigma}px)` : 'none';
      if (dss === 1) {
        ctx.filter = filter;
        draw(ctx, 1);
        return canvas;
      }
      let big = rc.createCanvas(w * dss, h * dss);
      draw(big.getContext('2d')!, dss);
      for (let f = dss / 2; f > 1; f /= 2) {
        const half = rc.createCanvas(w * f, h * f);
        const hctx = half.getContext('2d')!;
        hctx.imageSmoothingQuality = 'low';
        hctx.drawImage(big, 0, 0, w * f, h * f);
        big = half;
      }
      ctx.imageSmoothingQuality = 'low';
      ctx.filter = filter;
      ctx.drawImage(big, 0, 0, w, h);
      return canvas;
    };
    const tint = (shape: OffscreenCanvas, paint: (ctx: OffscreenCanvasRenderingContext2D) => void, x: number, y: number): Layer => {
      const canvas = rc.createCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(shape, 0, 0);
      ctx.globalCompositeOperation = 'source-in';
      paint(ctx);
      return { x, y, w, h, canvas };
    };
    const solid = (color: number) => (ctx: OffscreenCanvasRenderingContext2D, x = 0, width = w): void => {
      ctx.globalAlpha = (255 - (color & 0xff)) / 255;
      ctx.fillStyle = `rgb(${color >>> 24},${(color >>> 16) & 0xff},${(color >>> 8) & 0xff})`;
      ctx.fillRect(x, 0, width, h);
    };
    const hasBorder = (flags & FILTER_NONZERO_BORDER) !== 0;
    const fillShape = shapes(null, !hasBorder);
    let borderShape: OffscreenCanvas | null = null;
    if (hasBorder) {
      // round, uniformly scaled borders are strokes; otherwise the distance transform on the fill
      const radii = glyphs.map((g, k) => {
        const t = glyphAffine(mats[k]!, g);
        const sx = Math.hypot(t[0], t[1]);
        const sy = Math.hypot(t[2], t[3]);
        return Math.abs(sx - sy) <= 1e-4 * sx && Math.abs(bx26 - by26) <= 1e-6 * bx26 ? ((bx26 / 64) * Math.hypot(mats[k]![0], mats[k]![3])) / sx : null;
      });
      if (radii.every((r) => r !== null)) borderShape = shapes((k) => 2 * radii[k]!, true);
      else return colorLayersFromMasks();
    }
    const type = first.effectType;
    const kTiming = first.effectTiming;
    const fillPaint = (ctx: OffscreenCanvasRenderingContext2D): void => {
      if (type === EF_KARAOKE_KF) {
        const brk = kfBreak(glyphs, mats, first, s.parScaleX) - ox;
        solid(c[0]!)(ctx, 0, Math.max(0, brk));
        solid(c[1]!)(ctx, brk, Math.max(0, w - brk));
      } else solid(type === EF_KARAOKE || type === EF_KARAOKE_KO ? (kTiming > 0 ? c[0]! : c[1]!) : c[0]!)(ctx);
    };
    let shadow: Layer | null = null;
    if (flags & FILTER_NONZERO_SHADOW) {
      shadow = tint(borderShape ?? fillShape, (ctx) => solid(c[3]!)(ctx), ox + shadow26X / 64, oy + shadow26Y / 64);
    }
    const border = borderShape && !(type === EF_KARAOKE_KO && kTiming <= 0) ? tint(borderShape, (ctx) => solid(c[2]!)(ctx), ox, oy) : null;
    return { shadow, border, fill: tint(fillShape, fillPaint, ox, oy) };
  }

  function colorLayersFromMasks(): RunLayers {
    const masks = buildMasks();
    return colorLayers(masks.fill, masks.border, masks.shadow);
  }

  function buildMasks(): RunMasks {
    const fillCanvas = rc.createCanvas(w, h);
    const fctx = fillCanvas.getContext('2d', { willReadFrequently: true })!;
    fctx.fillStyle = '#fff';
    fctx.strokeStyle = '#fff';
    const affine = mats.every(isAffine) || !rc.warp;
    let fill: Uint8Array;
    let border: Uint8Array | null = null;
    if (affine) {
      fill = supersampled(rc, w, h, ss, (sctx) => {
        glyphs.forEach((g, k) => {
          const t = glyphAffine(mats[k]!, g);
          sctx.setTransform(ss * t[0], ss * t[1], ss * t[2], ss * t[3], ss * (t[4] - ox), ss * (t[5] - oy));
          drawGlyph(sctx, g, rc);
        });
      });
      if (!(flags & FILTER_BORDER_STYLE_3) && flags & FILTER_NONZERO_BORDER) {
        const stroked = strokedBorder(rc, glyphs, mats, w, h, ox, oy, bx26, by26, ss);
        border = stroked ?? dilate(fill, w, h, rx, ry);
      }
    } else {
      // 3D rotation: fill and border in layout space around the first glyph (libass strokes before the
      // transform), then both warped to the frame
      const lrx = bx26 / 64;
      const lry = by26 / 64;
      let lx0 = Infinity;
      let ly0 = Infinity;
      let lx1 = -Infinity;
      let ly1 = -Infinity;
      for (const g of glyphs) {
        const dx = (g.shiftX - first.shiftX) / 64;
        const dy = (g.shiftY - first.shiftY) / 64;
        lx0 = Math.min(lx0, dx + g.bboxXMin / 64); lx1 = Math.max(lx1, dx + g.bboxXMax / 64);
        ly0 = Math.min(ly0, dy + g.bboxYMin / 64); ly1 = Math.max(ly1, dy + g.bboxYMax / 64);
      }
      const lpad = Math.ceil(Math.max(lrx, lry) + 3);
      const lox = Math.floor(lx0) - lpad;
      const loy = Math.floor(ly0) - lpad;
      const lw = Math.ceil(lx1) + lpad - lox;
      const lh = Math.ceil(ly1) + lpad - loy;
      // supersampled like the affine path: layout canvas at ss×, warped into an ss× device canvas, filtered down
      const drawLayout = (ctx: OffscreenCanvasRenderingContext2D, borderOf: (g: GlyphInfo) => number): void => {
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#fff';
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (const g of glyphs) {
          const dx = (g.shiftX - first.shiftX) / 64;
          const dy = (g.shiftY - first.shiftY) / 64;
          ctx.setTransform(ss * g.trScaleX, 0, 0, ss * g.trScaleY, ss * (dx + g.trOffsetX / 64 - lox), ss * (dy + g.trOffsetY / 64 - loy));
          drawGlyph(ctx, g, rc, borderOf(g));
        }
      };
      // layout canvas px (u, v) at ss× is layout 26.6 (64(u/ss + lox), 64(v/ss + loy)) relative to the first glyph;
      // the device canvas is ss× too
      const tx = 64 * lox;
      const ty = 64 * loy;
      const m2 = m0[2] + tx * m0[0] + ty * m0[1];
      const m5 = m0[5] + tx * m0[3] + ty * m0[4];
      const m8 = m0[8] + tx * m0[6] + ty * m0[7];
      const shifted: Mat3 = [m0[0], m0[1], ss * m2, m0[3], m0[4], ss * m5, m0[6] / ss, m0[7] / ss, m8];
      const warped = (source: OffscreenCanvas): Uint8Array => supersampled(rc, w, h, ss, (sctx) => rc.warp!(sctx, source, shifted, ss * ox, ss * oy));
      const layout = rc.createCanvas(lw * ss, lh * ss);
      const lctx = layout.getContext('2d', { willReadFrequently: true })!;
      drawLayout(lctx, () => 0);
      fill = warped(layout);
      if (!(flags & FILTER_BORDER_STYLE_3) && flags & FILTER_NONZERO_BORDER) {
        const lb = rc.createCanvas(lw * ss, lh * ss);
        const lbctx = lb.getContext('2d', { willReadFrequently: true })!;
        const uniform = Math.abs(lrx - lry) <= 1e-6 * Math.max(lrx, lry) && glyphs.every((g) => Math.abs(g.trScaleX - g.trScaleY) <= 1e-6 * g.trScaleX);
        if (uniform) {
          // a round border in layout space, stroked in each glyph's local px
          drawLayout(lbctx, (g) => (2 * lrx) / g.trScaleX);
        } else {
          const lfill = readAlpha(lctx, lw * ss, lh * ss);
          const lborder = dilate(lfill, lw * ss, lh * ss, lrx * ss, lry * ss);
          const img = lbctx.createImageData(lw * ss, lh * ss);
          for (let i = 0; i < lborder.length; i++) {
            img.data[4 * i] = img.data[4 * i + 1] = img.data[4 * i + 2] = 255;
            img.data[4 * i + 3] = lborder[i]!;
          }
          lbctx.putImageData(img, 0, 0);
        }
        border = warped(lb);
      }
  }

  if (flags & FILTER_BORDER_STYLE_3) {
    if (flags & (FILTER_NONZERO_BORDER | FILTER_NONZERO_SHADOW)) {
      const bc = rc.createCanvas(w, h);
      const bctx = bc.getContext('2d', { willReadFrequently: true })!;
      bctx.fillStyle = '#fff';
      glyphs.forEach((g, k) => {
        const [x0, y0, x1, y1] = boxRect(s, g);
        const m = mats[k]!;
        bctx.beginPath();
        for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const) {
          const [px, py] = applyMat3(m, x, y);
          bctx.lineTo(px / 64 - ox, py / 64 - oy);
        }
        bctx.fill();
      });
      border = readAlpha(bctx, w, h);
    }
  }

  // ass_synth_blur: the fill only without a border (or for the opaque box), the border always
  if (!(flags & FILTER_NONZERO_BORDER) || flags & FILTER_BORDER_STYLE_3) fill = gaussianBlur(fill, w, h, sigmaX, sigmaY);
  if (border) border = gaussianBlur(border, w, h, sigmaX, sigmaY);

  if (border && !(flags & FILTER_FILL_IN_BORDER) && !(flags & FILTER_FILL_IN_SHADOW)) fixOutline(fill, border);
  let shadow: Uint8Array | null = null;
  if (flags & FILTER_NONZERO_SHADOW) {
    if (flags & FILTER_NONZERO_BORDER && border) {
      shadow = new Uint8Array(border);
      if (flags & FILTER_FILL_IN_BORDER && !(flags & FILTER_FILL_IN_SHADOW)) fixOutline(fill, shadow);
    } else if (flags & FILTER_BORDER_STYLE_3) {
      shadow = border;
      border = null;
    } else {
      shadow = new Uint8Array(fill);
    }
  }
  if (border && flags & FILTER_FILL_IN_SHADOW && !(flags & FILTER_FILL_IN_BORDER)) fixOutline(fill, border);
  return { w, h, fill, border, shadow };
  }

  function colorLayers(fill: Uint8Array, border: Uint8Array | null, shadow: Uint8Array | null): RunLayers {
    // colours: render_text
    const type = first.effectType;
    const kTiming = first.effectTiming;
    let fillColor: (x: number) => number = () => c[0]!;
    if (type === EF_KARAOKE || type === EF_KARAOKE_KO) fillColor = () => (kTiming > 0 ? c[0]! : c[1]!);
    else if (type === EF_KARAOKE_KF) {
      const brk = kfBreak(glyphs, mats, first, s.parScaleX);
      fillColor = (x) => (x < brk ? c[0]! : c[1]!);
  }
  const shadowLayer = shadow ? colorize(shadow, w, h, () => c[3]!, ox, oy) : null;
  if (shadowLayer) {
    shadowLayer.x += shadow26X / 64;
    shadowLayer.y += shadow26Y / 64;
  }
  const borderLayer = border && !(type === EF_KARAOKE_KO && kTiming <= 0) ? colorize(border, w, h, () => c[2]!, ox, oy) : null;
  return { shadow: shadowLayer, border: borderLayer, fill: colorize(fill, w, h, fillColor, ox, oy) };
  }
}

/** Everything that shapes a run's masks, positions relative to its canvas origin. */
/**
 * The key of a run's coloured layers: its masks' key plus what colours and places them (colours after fade, the
 * karaoke state, and the shadow offset, which the cached shadow layer carries).
 */
export function layerKey(maskKey: string, colors: readonly number[], effectType: number, karaoke: number, shadow26X: number, shadow26Y: number): string {
  return `${maskKey}#${colors.join(',')}#${effectType}#${karaoke}#${shadow26X},${shadow26Y}`;
}

function maskKey(glyphs: readonly GlyphInfo[], mats: readonly Mat3[], ox: number, oy: number, w: number, h: number, flags: number, bx26: number, by26: number, sigma: number, s: RenderState, ss: number): string {
  const r = (v: number): number => Math.round(v * 1e6) / 1e6;
  const parts: (string | number)[] = [ss, w, h, flags, r(bx26), r(by26), r(sigma)];
  glyphs.forEach((g, k) => {
    const m = mats[k]!;
    parts.push(g.clusterText ?? g.symbol, g.drawingText ?? '', g.face?.cssFamily ?? '', g.face?.synthBold ? 1 : 0, g.face?.synthItalic ? 1 : 0,
      g.flags, r(g.emPx), r(g.trScaleX), r(g.trScaleY), r(g.trOffsetX), r(g.trOffsetY), r(g.shiftX - glyphs[0]!.shiftX), r(g.shiftY - glyphs[0]!.shiftY),
      r(m[0]), r(m[1]), r(m[2] - 64 * ox * m[8]), r(m[3]), r(m[4]), r(m[5] - 64 * oy * m[8]), r(m[6]), r(m[7]), r(m[8]));
    if (flags & FILTER_BORDER_STYLE_3) parts.push(...boxRect(s, g).map(r));
  });
  return parts.join('|');
}

/** render_and_combine_glyphs' \kf split: the run's leftmost transformed x plus the sweep distance, device px. */
export function kfBreak(glyphs: readonly GlyphInfo[], mats: readonly Mat3[], first: GlyphInfo, parScaleX: number): number {
  let leftmost = Infinity;
  glyphs.forEach((g, k) => {
    for (const [x, y] of [[g.bboxXMin, g.bboxYMin], [g.bboxXMin, g.bboxYMax], [g.bboxXMax, g.bboxYMin], [g.bboxXMax, g.bboxYMax]] as const) {
      leftmost = Math.min(leftmost, applyMat3(mats[k]!, x, y)[0]);
    }
  });
  if (!Number.isFinite(leftmost)) leftmost = 0;
  const v = leftmost / 64 + (first.effectTiming / 64) * parScaleX;
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

/** The runs of an event as render_and_combine_glyphs splits them: indices of their visible glyphs. */
export function eventRuns(ev: FrameEvent): number[][] {
  const runs: number[][] = [];
  let newRun = true;
  ev.layout.text.glyphs.forEach((g, i) => {
    if (g.startsNewRun) newRun = true;
    if (g.skip || !ev.matrices[i]) return;
    if (newRun) runs.push([]);
    newRun = false;
    runs.at(-1)!.push(i);
  });
  return runs;
}

/** Applies the event's clip (rectangle and/or vector, normal or inverse) to ctx, which the caller saves and restores. */
function applyClip(ctx: OffscreenCanvasRenderingContext2D, rc: RasterContext, ev: FrameEvent, frame: { width: number; height: number }): void {
  const l = ev.layout;
  const s = l.text.state;
  const clamp = (v: number, max: number): number => Math.min(max, Math.max(0, v));
  const x0 = clamp(l.clip.x0, frame.width);
  const y0 = clamp(l.clip.y0, frame.height);
  const x1 = clamp(l.clip.x1, frame.width);
  const y1 = clamp(l.clip.y1, frame.height);
  const rect = new rc.Path2D();
  if (l.clip.mode) {
    rect.rect(0, 0, frame.width, frame.height);
    rect.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip(rect, 'evenodd');
  } else {
    rect.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip(rect);
  }
  if (l.clip.drawing !== null) {
    const base = (1 << ((l.clip.drawingScale - 1) & 31)) | 0;
    const wscale = base > 0 ? 1 / base : 0;
    const d = parseDrawing(l.clip.drawing);
    const path = toPath2D(d, (x, y) => [(x * s.screenScaleX * wscale) / 64, (y * s.screenScaleY * wscale) / 64], rc.Path2D);
    if (l.clip.drawingMode) {
      const inv = new rc.Path2D();
      inv.rect(0, 0, frame.width, frame.height);
      inv.addPath(path);
      ctx.clip(inv, 'evenodd');
    } else {
      ctx.clip(path, 'nonzero');
    }
  }
}

/** Composites an event's runs into one canvas: shadows, then borders, then fills, clipped; null when nothing shows. */
export function renderEvent(rc: RasterContext, ev: FrameEvent, frame: { readonly width: number; readonly height: number }): RenderedEvent | null {
  const runs = eventRuns(ev).map((idx, i) => renderRun(rc, ev, idx, i));
  const layers: Layer[] = [];
  if (ev.layout.text.state.borderStyle !== 4) for (const r of runs) if (r.shadow) layers.push(r.shadow);
  for (const r of runs) if (r.border) layers.push(r.border);
  for (const r of runs) if (r.fill) layers.push(r.fill);
  if (!layers.length) return null;
  const x0 = Math.floor(Math.min(...layers.map((l) => l.x)));
  const y0 = Math.floor(Math.min(...layers.map((l) => l.y)));
  const x1 = Math.ceil(Math.max(...layers.map((l) => l.x + l.w)));
  const y1 = Math.ceil(Math.max(...layers.map((l) => l.y + l.h)));
  const out = rc.createCanvas(x1 - x0, y1 - y0);
  const ctx = out.getContext('2d')!; // drawn, never read: stays on the GPU
  ctx.translate(-x0, -y0);
  applyClip(ctx, rc, ev, frame);
  let scratch: OffscreenCanvas | null = null;
  for (const layer of layers) {
    if (!scratch || scratch.width < layer.w || scratch.height < layer.h) scratch = rc.createCanvas(Math.max(layer.w, scratch?.width ?? 0), Math.max(layer.h, scratch?.height ?? 0));
    const sctx = scratch.getContext('2d')!;
    if (layer.canvas) {
      ctx.drawImage(layer.canvas, layer.x, layer.y);
      continue;
    }
    sctx.clearRect(0, 0, layer.w, layer.h);
    sctx.putImageData(layer.data!, 0, 0);
    ctx.drawImage(scratch, 0, 0, layer.w, layer.h, layer.x, layer.y, layer.w, layer.h);
  }
  return { canvas: out, x: x0, y: y0 };
}

/** Draws one laid-out event onto ctx (device px, frame origin at 0,0), moved by its collision shift (shift_event). */
export function drawEvent(ctx: OffscreenCanvasRenderingContext2D, rc: RasterContext, ev: FrameEvent, frame: { readonly width: number; readonly height: number }): void {
  const r = renderEvent(rc, ev, frame);
  if (r) ctx.drawImage(r.canvas, r.x, r.y + ev.shiftY);
}
