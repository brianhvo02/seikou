/*
 * The parsed script: ASS_Track, ASS_Style and ASS_Event of libass, same fields and units.
 *
 * Ported from libass 0.17.5 (ass_types.h). libass is ISC-licensed; see src/engine/NOTICE.
 * Modified for bluray-web, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

/** YCbCr Matrix header values (enum ASS_YCbCrMatrix). */
export const YCbCr = {
  Default: 0, Unknown: 1, None: 2, Bt601Tv: 3, Bt601Pc: 4, Bt709Tv: 5, Bt709Pc: 6, Smpte240mTv: 7, Smpte240mPc: 8, FccTv: 9, FccPc: 10,
} as const;
export type YCbCrMatrix = (typeof YCbCr)[keyof typeof YCbCr];

export const VALIGN_SUB = 0;
export const VALIGN_CENTER = 8;
export const VALIGN_TOP = 4;
export const HALIGN_LEFT = 1;
export const HALIGN_CENTER = 2;
export const HALIGN_RIGHT = 3;

export interface AssStyle {
  readonly name: string;
  readonly fontName: string;
  readonly fontSize: number;
  /** 0xRRGGBBAA, AA = transparency. */
  readonly primaryColour: number;
  readonly secondaryColour: number;
  readonly outlineColour: number;
  readonly backColour: number;
  readonly bold: number;
  readonly italic: number;
  readonly underline: number;
  readonly strikeOut: number;
  /** Fractions (libass divides the header's percentages by 100). */
  readonly scaleX: number;
  readonly scaleY: number;
  readonly spacing: number;
  readonly angle: number;
  readonly borderStyle: number;
  readonly outline: number;
  readonly shadow: number;
  /** libass's internal legacy (\a) numbering, VALIGN_* | HALIGN_*, as process_style stores it. */
  readonly alignment: number;
  readonly marginL: number;
  readonly marginR: number;
  readonly marginV: number;
  readonly encoding: number;
  readonly treatFontNameAsPattern: number;
  readonly blur: number;
  readonly justify: number;
}

export interface AssEvent {
  /** File order (external scripts have no ReadOrder field). */
  readonly readOrder: number;
  readonly layer: number;
  /** ms */
  readonly start: number;
  readonly duration: number;
  /** Index into AssTrack.styles. */
  readonly style: number;
  readonly name: string;
  readonly marginL: number;
  readonly marginR: number;
  readonly marginV: number;
  readonly effect: string;
  readonly text: string;
}

export interface AssTrack {
  readonly trackType: 'ass' | 'ssa' | 'unknown';
  readonly playResX: number;
  readonly playResY: number;
  readonly layoutResX: number;
  readonly layoutResY: number;
  readonly wrapStyle: number;
  readonly scaledBorderAndShadow: boolean;
  readonly kerning: boolean;
  readonly ycbcrMatrix: YCbCrMatrix;
  readonly language: string | null;
  /** Index 0 is libass's built-in "Default" (Arial 18). */
  readonly styles: readonly AssStyle[];
  /** The last style named "Default", else 0. */
  readonly defaultStyle: number;
  readonly events: readonly AssEvent[];
  readonly fonts: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  /** Dialogue lines dropped as malformed. */
  readonly skippedLines: number;
  /** Dialogue lines seen. */
  readonly eventLines: number;
}
