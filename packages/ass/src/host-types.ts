/*
 * The types the ASS renderer shares with its host: the rectangle it draws in, the text renderer contract the
 * compositor calls, and the memory limits the renderer reads.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TextRenderOptions {
  /** Added to every cue's times (a positive offset shows cues later). */
  readonly offsetUs: number;
  /** Font size factor, 0.5–2. */
  readonly scale: number;
  /** The video's storage size (its coded picture), which ASS layout can depend on; null when unknown. */
  readonly storage?: { readonly width: number; readonly height: number } | null;
}

/** A text subtitle renderer (SRT or ASS) as the player and compositor use it. */
export interface TextRendererLike {
  /** Draws inside `videoRect`; returns how many cues or events were drawn. */
  render(ctx: OffscreenCanvasRenderingContext2D, timeUs: number, videoRect: Rect, opts: TextRenderOptions): number;
  /** Whether a render at `timeUs` would differ from the last one. */
  changed(timeUs: number, opts: TextRenderOptions): boolean;
  /** Whether anything shows at `timeUs`. */
  visible(timeUs: number, opts: TextRenderOptions): boolean;
}

/** The memory limits `AssRenderer` reads; the engine's `MemoryProfile` satisfies it structurally. */
export interface AssRendererLimits {
  readonly assEventCacheBytes: number;
  readonly assLayerCacheBytes: number;
  readonly assMaskCacheBytes: number;
  /** Upper bound of the per-side supersampling of ASS text masks. */
  readonly maxTextSupersampling: number;
}
