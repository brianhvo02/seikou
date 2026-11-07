/*
 * Overlay command semantics from libbluray src/libbluray/decoders/overlay.h
 * (BD_OVERLAY_*), applied the way a YUV overlay consumer does.
 *
 * Original implementation for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { ycrcbToRgba } from './palette';
import type { PgPaletteEntry, RleElem } from './segments';

export type OverlayCmd = 'init' | 'close' | 'clear' | 'draw' | 'wipe' | 'hide' | 'flush';

export interface OverlayOp {
  readonly cmd: OverlayCmd;
  readonly pts: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly palette?: readonly PgPaletteEntry[];
  readonly img?: readonly RleElem[];
  readonly paletteUpdate?: boolean;
}

const MAX_CACHED_COLOURS = 4096;

export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/**
 * A fixed-size plane holding one palette entry (Y, Cr, Cb, T) per pixel, row-major,
 * stored as 4 bytes per pixel in exactly that order. All-zero is "empty".
 *
 * apply() semantics (the whole spec, so a C port can match it):
 *  - init, close, clear: set every byte of the plane to 0; the whole plane is dirty.
 *    (init's x/y/w/h are ignored: the plane size is fixed at construction.)
 *  - draw: decode `img` as RLE rows starting at (x, y). A zero-length element at column >= w
 *    ends a line (next line, column 0); one at column < w is ignored; every other element writes `palette[color]` (Y, Cr, Cb, T; an
 *    absent entry is 0,0,0,0) over `len` pixels, REPLACING what was there (no blending,
 *    transparent entries overwrite too). Pixels outside the plane, past column w or past
 *    row h are skipped. Dirty gets (x, y, w, h) clipped to the plane. A draw without
 *    img or palette does nothing.
 *  - paletteUpdate (palette_update_flag): libbluray's graphics controller always sends the
 *    full image and palette with such a draw, so it is applied as an ordinary full redraw
 *    of the rect; the flag is informational only.
 *  - wipe: set all four bytes of every pixel in the clipped rect to 0; rect becomes dirty.
 *  - hide, flush: no pixel changes (hide only says the plane is empty; clear/wipe precede it).
 *
 * Buffered planes (overlay.h: changes are committed at BD_OVERLAY_FLUSH): draw and wipe change a back
 * buffer; flush copies the back buffer's changed area to the visible buffer and marks it dirty; init,
 * close and clear reset both buffers at once. hash(), rgba(), dirty() and hasContent read the visible
 * buffer.
 *
 * hash(): FNV-1a 64-bit (offset basis 0xcbf29ce484222325, prime 0x100000001b3) over the
 * bytes Y, Cr, Cb, T of every pixel in row-major order, printed as 16 lowercase hex digits.
 */
export class OverlayPlane {
  readonly width: number;
  readonly height: number;
  private readonly px: Uint8Array;
  /** Where draw and wipe write: the back buffer when buffered, else px. */
  private readonly buf: Uint8Array;
  private readonly buffered: boolean;
  /** Buffered only: the back-buffer area changed since the last flush. */
  private pending: Rect | null = null;
  /** Areas drawn in `buf` and not wiped since (a wipe removes the areas it covers whole); what flush makes visible. */
  private drawnRects: Rect[] = [];
  private shownRects: Rect[] = [];
  /** The same bytes as one little-endian word per pixel: the key of the colour cache. */
  private readonly words: Uint32Array;
  /** Plane word (Y, Cr, Cb, T) to packed RGBA; menus use a few dozen colours, so this replaces the per-pixel conversion. */
  private readonly rgbaCache = new Map<number, number>();
  private dirtyRect: Rect | null = null;

  constructor(width = 1920, height = 1080, opts: { readonly buffered?: boolean } = {}) {
    this.width = width;
    this.height = height;
    this.buffered = opts.buffered ?? false;
    this.px = new Uint8Array(width * height * 4);
    this.buf = this.buffered ? new Uint8Array(width * height * 4) : this.px;
    this.words = new Uint32Array(this.px.buffer);
  }

  /**
   * False when nothing drawn is visible: nothing was drawn since the plane was cleared, or wipes have since covered every
   * drawn area (a partial wipe leaves it counted). The player stops drawing an empty plane on every frame.
   */
  get hasContent(): boolean {
    return (this.buffered ? this.shownRects : this.drawnRects).length > 0;
  }

  apply(op: OverlayOp): void {
    switch (op.cmd) {
      case 'init':
      case 'close':
      case 'clear':
        this.px.fill(0);
        if (this.buffered) this.buf.fill(0);
        this.drawnRects = [];
        this.shownRects = [];
        this.pending = null;
        this.markDirty(0, 0, this.width, this.height);
        break;
      case 'draw':
        this.draw(op);
        break;
      case 'wipe':
        this.wipe(op.x, op.y, op.w, op.h);
        break;
      case 'flush':
        if (this.buffered) this.flush();
        break;
      case 'hide':
        break;
    }
  }

  dirty(): Rect | null {
    return this.dirtyRect;
  }

  takeDirty(): Rect | null {
    const d = this.dirtyRect;
    this.dirtyRect = null;
    return d;
  }

  /** RGBA (non-premultiplied, ImageData order) for the rect clipped to the plane; only touches the rect. */
  rgba(rect: Rect): Uint8ClampedArray<ArrayBuffer> {
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(this.width, rect.x + rect.w);
    const y1 = Math.min(this.height, rect.y + rect.h);
    const w = Math.max(0, x1 - x0);
    const h = Math.max(0, y1 - y0);
    const out = new Uint8ClampedArray(w * h * 4);
    const out32 = new Uint32Array(out.buffer);
    const cache = this.rgbaCache;
    if (cache.size > MAX_CACHED_COLOURS) cache.clear();
    let o = 0;
    let lastWord = -1; // no word equals it
    let lastRgba = 0;
    for (let y = y0; y < y1; y++) {
      let i = y * this.width + x0;
      for (let x = x0; x < x1; x++, i++) {
        const word = this.words[i]!;
        if (word !== lastWord) {
          let rgba = cache.get(word);
          if (rgba === undefined) {
            const p = i * 4;
            rgba = ycrcbToRgba({ y: this.px[p]!, cr: this.px[p + 1]!, cb: this.px[p + 2]!, t: this.px[p + 3]! });
            cache.set(word, rgba);
          }
          lastWord = word;
          lastRgba = rgba;
        }
        out32[o++] = lastRgba;
      }
    }
    return out;
  }

  /** FNV-1a 64 over the raw plane; test and trace use only. */
  hash(): string {
    // 64-bit state as two 32-bit halves; the prime is 2^40 + 0x1b3
    let hi = 0xcbf29ce4;
    let lo = 0x84222325;
    const px = this.px;
    for (let i = 0; i < px.length; i++) {
      lo = (lo ^ px[i]!) >>> 0;
      const loProd = lo * 0x1b3; // < 2^41, exact
      const hiProd = hi * 0x1b3;
      const carry = Math.floor(loProd / 4294967296);
      hi = (hiProd + carry + ((lo << 8) >>> 0)) % 4294967296; // lo << 40 lands in the high half
      lo = loProd % 4294967296;
    }
    return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
  }

  private markDirty(x: number, y: number, w: number, h: number): void {
    this.dirtyRect = union(this.dirtyRect, { x, y, w, h });
  }

  /** A change to `buf`: dirty at once when unbuffered, at the next flush when buffered. */
  private changed(r: Rect): void {
    if (this.buffered) this.pending = union(this.pending, r);
    else this.markDirty(r.x, r.y, r.w, r.h);
  }

  private flush(): void {
    this.shownRects = [...this.drawnRects];
    const r = this.pending;
    if (!r) return;
    this.pending = null;
    for (let row = r.y; row < r.y + r.h; row++) {
      const p = (row * this.width + r.x) * 4;
      this.px.set(this.buf.subarray(p, p + r.w * 4), p);
    }
    this.markDirty(r.x, r.y, r.w, r.h);
  }

  private clip(x: number, y: number, w: number, h: number): Rect | null {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w);
    const y1 = Math.min(this.height, y + h);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  private wipe(x: number, y: number, w: number, h: number): void {
    const r = this.clip(x, y, w, h);
    if (!r) return;
    for (let row = r.y; row < r.y + r.h; row++) {
      const p = (row * this.width + r.x) * 4;
      this.buf.fill(0, p, p + r.w * 4);
    }
    this.drawnRects = this.drawnRects.filter((d) => !inside(d, r));
    this.changed(r);
  }

  private draw(op: OverlayOp): void {
    const { img, palette } = op;
    if (!img || !palette) return;
    const px = this.buf;
    let row = op.y;
    let col = 0;
    for (const e of img) {
      if (e.len === 0) {
        // end of line once the row is full; a zero-length element earlier in a row (which
        // rle_crop_object can emit) is skipped, as rle_crop_object skips them on input
        if (col >= op.w) {
          row++;
          col = 0;
        }
        continue;
      }
      if (row >= op.y + op.h) break;
      if (row >= 0 && row < this.height) {
        const pe = palette[e.color];
        const end = Math.min(col + e.len, op.w);
        for (let c = col; c < end; c++) {
          const x = op.x + c;
          if (x < 0 || x >= this.width) continue;
          const p = (row * this.width + x) * 4;
          px[p] = pe ? pe.y : 0;
          px[p + 1] = pe ? pe.cr : 0;
          px[p + 2] = pe ? pe.cb : 0;
          px[p + 3] = pe ? pe.t : 0;
        }
      }
      col += e.len;
    }
    const r = this.clip(op.x, op.y, op.w, op.h);
    if (!r) return;
    this.drawnRects = [...this.drawnRects.filter((d) => !inside(d, r)), r]; // a redraw in place replaces the earlier area
    this.changed(r);
  }
}

/** `a` lies wholly inside `b`. */
function inside(a: Rect, b: Rect): boolean {
  return a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
}

function union(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
