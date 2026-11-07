/*
 * Original code for bluray-web: the HAVi background still a BD-J title shows under the video
 * (HStillImageBackgroundConfiguration.displayImage, natives/havi.ts). libbluray never draws one; a player does. Its
 * pixels are never visible to Java, so the browser decodes the encoded bytes (createImageBitmap in production).
 *
 * Copyright (C) 2026  bluray-web contributors
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import type { BackgroundStillLike, ScreenRect, ShownStill, BackgroundStillDeps } from '../bdj-types';
export type { ScreenRect, ShownStill, DecodeImage, BackgroundStillDeps } from '../bdj-types';

/** Decoded RGBA bytes of an image of this size. */
const decodedBytes = (width: number, height: number): number => width * height * 4;

/**
 * The width and height a PNG, GIF or JPEG header declares, without decoding it (null: not one of these, or no size
 * found), so the memory a still will take is known before it is decoded.
 */
export function encodedImageSize(b: Uint8Array): { readonly width: number; readonly height: number } | null {
  const u16be = (i: number): number => (b[i]! << 8) | b[i + 1]!;
  const u32be = (i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
  // PNG: the signature, then IHDR (width, height)
  if (b.length >= 24 && u32be(0) === 0x89504e47 && u32be(4) === 0x0d0a1a0a && u32be(12) === 0x49484452) return { width: u32be(16), height: u32be(20) };
  // GIF: the logical screen
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) };
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  // JPEG: the first start-of-frame segment (SOF0 to SOF15, not DHT, JPG or DAC)
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16be(i + 7), height: u16be(i + 5) };
    i += 2 + u16be(i + 2);
  }
  return null;
}

const finite = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/**
 * The background still of one player: at most one decoded image is held, and it is closed (about 8 MB at 1920×1080)
 * as soon as a newer still replaces it or the background is cleared. A decode that finishes after a newer still or a
 * clear is closed at once and never shown.
 */
export class BackgroundStill implements BackgroundStillLike {
  private generation = 0;
  private shown: ShownStill | null = null;
  /** The decoded size of the still being decoded, as its header declares it (0: none, or not known). */
  private pendingBytes = 0;

  constructor(private readonly deps: BackgroundStillDeps) {}

  get current(): ShownStill | null {
    return this.shown;
  }

  /** The decoded stills' bytes: the one shown and the one being decoded. */
  get decodedBytes(): number {
    return (this.shown ? decodedBytes(this.shown.image.width, this.shown.image.height) : 0) + this.pendingBytes;
  }

  /**
   * Decodes `bytes` and shows them in `rect`, replacing the current still; one that cannot be decoded, or would be
   * over the memory budget, clears it.
   */
  show(bytes: Uint8Array, rect: ScreenRect): void {
    const gen = ++this.generation;
    const r: ScreenRect = { x: finite(rect.x, 0), y: finite(rect.y, 0), width: finite(rect.width, 1), height: finite(rect.height, 1) };
    const budget = this.deps.maxDecodedBytes?.() ?? Infinity;
    const size = encodedImageSize(bytes);
    const incoming = size ? decodedBytes(size.width, size.height) : 0;
    this.pendingBytes = incoming;
    if (incoming > budget) {
      this.overBudget(size!.width, size!.height, budget);
      return;
    }
    // the shown still goes first when it and the new one would not both fit
    if (this.shown && this.decodedBytes > budget) this.replace(null);
    let decoding: Promise<ImageBitmap>;
    try {
      decoding = this.deps.decode(bytes);
    } catch (e) {
      decoding = Promise.reject(e);
    }
    decoding.then(
      (image) => {
        if (gen !== this.generation) {
          image.close();
          return;
        }
        this.pendingBytes = 0;
        if (decodedBytes(image.width, image.height) <= budget) this.replace({ image, rect: r });
        else {
          // a header that did not say, or said less
          image.close();
          this.overBudget(image.width, image.height, budget);
        }
      },
      (e: unknown) => {
        if (gen !== this.generation) return;
        this.pendingBytes = 0;
        this.deps.onError?.(`a background image could not be decoded: ${e instanceof Error ? e.message : String(e)}`);
        this.replace(null);
      },
    );
  }

  /** Nothing is shown from now on, and no decode under way will be. */
  clear(): void {
    this.generation++;
    this.pendingBytes = 0;
    this.replace(null);
  }

  private overBudget(width: number, height: number, budget: number): void {
    this.pendingBytes = 0;
    const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
    this.deps.onError?.(`a ${width}x${height} background image (${mb(decodedBytes(width, height))} MB decoded) is over the memory budget of ${mb(budget)} MB`);
    this.replace(null);
  }

  private replace(next: ShownStill | null): void {
    const prev = this.shown;
    if (prev === null && next === null) return;
    this.shown = next;
    this.deps.onChange(next);
    prev?.image.close();
  }
}
