/*
 * The BD-J graphics plane: a SharedArrayBuffer the BD-J worker draws into and the engine worker reads.
 *
 * updateGraphic is ported from libbluray, src/libbluray/bdj/native/org_videolan_Libbluray.c
 * (Java_org_videolan_Libbluray_updateGraphicN and _updateGraphic, the application-allocated buffer path) and
 * src/libbluray/bluray.c (bdpriv_bdj_osd_cb, bdpriv_lock_osd_buffer / bdpriv_unlock_osd_buffer); the writer carries out
 * the ARGB overlay commands of src/libbluray/decoders/overlay.h (BD_ARGB_OVERLAY_INIT, DRAW, FLUSH, CLOSE) the way an
 * application does with its own frame buffer.
 * Copyright (C) 2010-2019  Petri Hintukainen <phintuka@users.sourceforge.net>
 *
 * Ported to TypeScript and modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import { PLANE_HEIGHT, PLANE_WIDTH } from '@seikou/engine/bdj-provider';
import type { GraphicsPlaneReaderLike, PlaneRect } from '@seikou/engine/bdj-types';
export type { PlaneRect } from '@seikou/engine/bdj-types';

/** The plane's fixed size (bdj-provider.ts): the largest BD-J graphics configuration. A smaller plane keeps its pixels at the top left. */
export { PLANE_HEIGHT, PLANE_WIDTH };

/*
 * Layout: HEADER_WORDS Int32 words, then PLANE_WIDTH * PLANE_HEIGHT Int32 ARGB words (0xAARRGGBB, not premultiplied),
 * row-major with a stride of PLANE_WIDTH. Every header word is read and written with Atomics.
 */
const LOCK = 0; // 0 free, 1 held (bdpriv_lock_osd_buffer's argb_buffer_mutex)
const WIDTH = 1; // the size Java opened the plane with (INIT); 0 while closed
const HEIGHT = 2;
const DIRTY_X0 = 3; // the union of the rectangles published since the reader last took it, inclusive; x0 > x1: none
const DIRTY_Y0 = 4;
const DIRTY_X1 = 5;
const DIRTY_Y1 = 6;
const FLUSHES = 7; // BD_ARGB_OVERLAY_FLUSH count
const VISIBLE = 8; // 1 when the last published plane has a pixel with non-zero alpha
const VERSION = 9; // bumped on every publication (flush, init, close): the reader's change test
const OPAQUE = 10; // the writer's count of pixels with non-zero alpha in the plane as drawn (published or not)
const HEADER_WORDS = 16;
const HEADER_BYTES = HEADER_WORDS * 4;
const PIXELS = PLANE_WIDTH * PLANE_HEIGHT;

/** The reader never waits for the writer's lock (the render path must not block): it tries again at the next frame. */
const READER_LOCK_MS = 0;

export function createGraphicsPlane(): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(HEADER_BYTES + PIXELS * 4);
  const h = new Int32Array(buffer, 0, HEADER_WORDS);
  h[DIRTY_X0] = PLANE_WIDTH;
  h[DIRTY_Y0] = PLANE_HEIGHT;
  h[DIRTY_X1] = -1;
  h[DIRTY_Y1] = -1;
  return buffer;
}

class PlaneViews {
  protected readonly header: Int32Array;
  protected readonly pixels: Int32Array;

  constructor(readonly buffer: SharedArrayBuffer) {
    this.header = new Int32Array(buffer, 0, HEADER_WORDS);
    this.pixels = new Int32Array(buffer, HEADER_BYTES, PIXELS);
  }

  /** Takes the lock, waiting at most `ms` (Infinity: until it is free); false when it could not. */
  protected acquire(ms: number): boolean {
    const deadline = ms === Infinity ? Infinity : performance.now() + ms;
    while (Atomics.compareExchange(this.header, LOCK, 0, 1) !== 0) {
      const left = deadline - performance.now();
      if (left <= 0) return false;
      Atomics.wait(this.header, LOCK, 1, Math.min(left, 5));
    }
    return true;
  }

  protected release(): void {
    Atomics.store(this.header, LOCK, 0);
    Atomics.notify(this.header, LOCK);
  }
}

/**
 * The BD-J worker's side: an application-allocated ARGB buffer (BD_ARGB_BUFFER) and the overlay commands that change
 * it. What is drawn becomes visible to the reader only at flush (or at once for init and close, which clear the plane).
 */
export class GraphicsPlaneWriter extends PlaneViews {
  private depth = 0;
  /** Drawn since the last flush, inclusive; x0 > x1: nothing. */
  private px0 = PLANE_WIDTH;
  private py0 = PLANE_HEIGHT;
  private px1 = -1;
  private py1 = -1;

  /** bdpriv_lock_osd_buffer: nests, so a draw and its flush can share one hold. */
  lock(): void {
    if (this.depth++ === 0) this.acquire(Infinity);
  }

  unlock(): void {
    if (this.depth > 0 && --this.depth === 0) this.release();
  }

  /** BD_ARGB_OVERLAY_INIT: the plane opens at w × h, cleared. */
  init(w: number, h: number): void {
    this.held(() => this.reset(w, h));
  }

  /** BD_ARGB_OVERLAY_CLOSE: the plane closes, cleared. */
  close(): void {
    this.held(() => this.reset(0, 0));
  }

  /**
   * BD_ARGB_OVERLAY_DRAW with the copy into the application's buffer that precedes it: rows y0..y1, columns x0..x1
   * (inclusive) of `argb`, whose rows are `stride` pixels apart, to the same place in the plane. Clipped to the plane.
   */
  draw(argb: Int32Array, stride: number, x0: number, y0: number, x1: number, y1: number): void {
    const cx0 = Math.max(0, x0);
    const cy0 = Math.max(0, y0);
    const cx1 = Math.min(PLANE_WIDTH - 1, x1);
    const cy1 = Math.min(PLANE_HEIGHT - 1, y1);
    if (cx1 < cx0 || cy1 < cy0) return;
    this.held(() => {
      const px = this.pixels;
      const n = cx1 - cx0 + 1;
      let opaque = 0;
      for (let y = cy0; y <= cy1; y++) {
        const src = y * stride + cx0;
        if (src < 0 || src + n > argb.length) break; // GetIntArrayRegion's ArrayIndexOutOfBoundsException ends the copy
        const dst = y * PLANE_WIDTH + cx0;
        for (let i = 0; i < n; i++) {
          const v = argb[src + i]!;
          const was = px[dst + i]!;
          if ((v ^ was) >>> 24 !== 0) opaque += (v >>> 24 !== 0 ? 1 : 0) - (was >>> 24 !== 0 ? 1 : 0);
          px[dst + i] = v;
        }
      }
      Atomics.add(this.header, OPAQUE, opaque);
      this.px0 = Math.min(this.px0, cx0);
      this.py0 = Math.min(this.py0, cy0);
      this.px1 = Math.max(this.px1, cx1);
      this.py1 = Math.max(this.py1, cy1);
    });
  }

  /** BD_ARGB_OVERLAY_FLUSH: what was drawn since the last flush becomes the reader's. */
  flush(): void {
    this.held(() => {
      if (this.px1 >= this.px0) this.publish(this.px0, this.py0, this.px1, this.py1);
      else this.publish(PLANE_WIDTH, PLANE_HEIGHT, -1, -1);
      this.px0 = PLANE_WIDTH;
      this.py0 = PLANE_HEIGHT;
      this.px1 = this.py1 = -1;
      Atomics.add(this.header, FLUSHES, 1);
    });
  }

  private reset(w: number, h: number): void {
    this.pixels.fill(0);
    Atomics.store(this.header, OPAQUE, 0);
    Atomics.store(this.header, WIDTH, Math.max(0, Math.min(PLANE_WIDTH, w)));
    Atomics.store(this.header, HEIGHT, Math.max(0, Math.min(PLANE_HEIGHT, h)));
    this.px0 = PLANE_WIDTH;
    this.py0 = PLANE_HEIGHT;
    this.px1 = this.py1 = -1;
    this.publish(0, 0, PLANE_WIDTH - 1, PLANE_HEIGHT - 1);
  }

  private publish(x0: number, y0: number, x1: number, y1: number): void {
    const hd = this.header;
    if (x1 >= x0 && y1 >= y0) {
      Atomics.store(hd, DIRTY_X0, Math.min(hd[DIRTY_X0]!, x0));
      Atomics.store(hd, DIRTY_Y0, Math.min(hd[DIRTY_Y0]!, y0));
      Atomics.store(hd, DIRTY_Y1, Math.max(hd[DIRTY_Y1]!, y1));
      Atomics.store(hd, DIRTY_X1, Math.max(hd[DIRTY_X1]!, x1));
    }
    Atomics.store(hd, VISIBLE, Atomics.load(hd, OPAQUE) > 0 ? 1 : 0);
    Atomics.add(hd, VERSION, 1);
  }

  private held(fn: () => void): void {
    this.lock();
    try {
      fn();
    } finally {
      this.unlock();
    }
  }
}

/**
 * Java_org_videolan_Libbluray_updateGraphicN → _updateGraphic → bdpriv_bdj_osd_cb, with the plane as the
 * application-allocated buffer: no image means open (w, h > 0) or close; an image's dirty rectangle x0..y1 (inclusive)
 * is copied, clipped to the buffer, then drawn and flushed.
 */
export function updateGraphic(
  plane: GraphicsPlaneWriter,
  width: number,
  height: number,
  argb: Int32Array | null,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  /* nothing to draw ? */
  if (argb && (x1 < x0 || y1 < y0 || (x1 | y1) < 0)) return;
  plane.lock();
  try {
    /* close ? */
    if (!argb) {
      // bdpriv_bdj_osd_cb with no image: init or close
      if (width > 0 && height > 0) plane.init(width, height);
      else plane.close();
      return;
    }
    /* clip */
    if (y1 >= PLANE_HEIGHT) y1 = PLANE_HEIGHT - 1;
    if (x1 >= PLANE_WIDTH) x1 = PLANE_WIDTH - 1;
    /* no changed pixels ? */
    if (x1 < x0 || y1 < y0) return;
    plane.draw(argb, width, x0, y0, x1, y1);
    plane.flush();
  } finally {
    plane.unlock();
  }
}

/** The engine worker's side. */
export class GraphicsPlaneReader extends PlaneViews implements GraphicsPlaneReaderLike {
  private copied = -1;

  /**
   * The version (version()) of the plane the last copyDirtyInto that copied anything took, read under the lock, so
   * exactly what the copy holds; -1 before the first. The writer flushes on its own thread, so a copy may take a flush
   * that a pending() test made before it did not see.
   */
  copiedVersion(): number {
    return this.copied;
  }

  /** How many times the plane has been flushed. */
  flushCount(): number {
    return Atomics.load(this.header, FLUSHES);
  }

  /** Changes with every flush, init and close. */
  version(): number {
    return Atomics.load(this.header, VERSION);
  }

  /** Whether something was published that copyDirtyInto has not taken yet. */
  pending(): boolean {
    return Atomics.load(this.header, DIRTY_X1) >= 0;
  }

  /** Whether the last flushed plane has any pixel with non-zero alpha. */
  visible(): boolean {
    return Atomics.load(this.header, VISIBLE) !== 0;
  }

  /** The size Java opened the plane with (0 × 0 while closed). */
  size(): { readonly width: number; readonly height: number } {
    return { width: Atomics.load(this.header, WIDTH), height: Atomics.load(this.header, HEIGHT) };
  }

  /**
   * Copies the area published since the last call (or, with `all`, the whole plane) into `image` (PLANE_WIDTH ×
   * PLANE_HEIGHT, RGBA) and returns it; null when nothing changed (without touching the lock), or when the writer
   * holds the plane: then nothing is waited for, and what was published stays pending for the next call.
   */
  copyDirtyInto(image: ImageData, all = false): PlaneRect | null {
    if (!all && !this.pending()) return null;
    if (!this.acquire(READER_LOCK_MS)) return null;
    try {
      const hd = this.header;
      let x0 = hd[DIRTY_X0]!;
      let y0 = hd[DIRTY_Y0]!;
      let x1 = hd[DIRTY_X1]!;
      let y1 = hd[DIRTY_Y1]!;
      Atomics.store(hd, DIRTY_X0, PLANE_WIDTH);
      Atomics.store(hd, DIRTY_Y0, PLANE_HEIGHT);
      Atomics.store(hd, DIRTY_Y1, -1);
      Atomics.store(hd, DIRTY_X1, -1);
      if (all) {
        x0 = y0 = 0;
        x1 = PLANE_WIDTH - 1;
        y1 = PLANE_HEIGHT - 1;
      }
      if (x1 < x0 || y1 < y0) return null;
      this.copied = Atomics.load(hd, VERSION);
      const out = image.data;
      const px = this.pixels;
      for (let y = y0; y <= y1; y++) {
        let s = y * PLANE_WIDTH + x0;
        let d = s * 4;
        for (let x = x0; x <= x1; x++, s++, d += 4) {
          const v = px[s]!;
          out[d] = (v >>> 16) & 255;
          out[d + 1] = (v >>> 8) & 255;
          out[d + 2] = v & 255;
          out[d + 3] = v >>> 24;
        }
      }
      return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
    } finally {
      this.release();
    }
  }

  /**
   * FNV-1a 32 over the plane's PLANE_WIDTH × PLANE_HEIGHT ARGB words, row-major, each word's bytes little-endian
   * (B, G, R, A): tools/bdj-trace's plane hash, as 8 lowercase hex digits.
   */
  hash(): string {
    this.acquire(Infinity);
    try {
      return planeHash(this.buffer);
    } finally {
      this.release();
    }
  }

  /** hash() without waiting for the writer's lock (the render path must not block): null while the writer holds it. */
  tryHash(): string | null {
    if (!this.acquire(READER_LOCK_MS)) return null;
    try {
      return planeHash(this.buffer);
    } finally {
      this.release();
    }
  }
}

/**
 * GraphicsPlaneReader.hash without taking the lock, for a caller that holds it already (the writer at a flush): FNV-1a
 * 32 over the plane's ARGB words, as tools/bdj-trace prints it.
 */
export function planeHash(buffer: SharedArrayBuffer): string {
  const px = new Int32Array(buffer, HEADER_BYTES, PIXELS);
  let h = 0x811c9dc5;
  for (let i = 0; i < PIXELS; i++) {
    const v = px[i]!;
    h = Math.imul(h ^ (v & 255), 0x01000193);
    h = Math.imul(h ^ ((v >>> 8) & 255), 0x01000193);
    h = Math.imul(h ^ ((v >>> 16) & 255), 0x01000193);
    h = Math.imul(h ^ (v >>> 24), 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
