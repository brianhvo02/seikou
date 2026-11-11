/*
 * The parsed script: ASS_Track, ASS_Style and ASS_Event of libass, same fields and units.
 *
 * Ported from libass 0.17.5 (ass_types.h). libass is ISC-licensed; see packages/ass/NOTICE.
 * Modified for Seikou, 2026.
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later AND ISC
 */

/** YCbCr Matrix header values (enum ASS_YCbCrMatrix). */
export const YCbCr = {
  Default: 0, Unknown: 1, None: 2, Bt601Tv: 3, Bt601Pc: 4, Bt709Tv: 5, Bt709Pc: 6, Smpte240mTv: 7, Smpte240mPc: 8, FccTv: 9, FccPc: 10,
} as const;
/** One of `YCbCr`'s values: the colour matrix a script declares for its colours. */
export type YCbCrMatrix = (typeof YCbCr)[keyof typeof YCbCr];

/** Vertical alignment bit of `AssStyle.alignment`, libass `ass_types.h` `VALIGN_SUB`: text sits at the bottom, as subtitles do. */
export const VALIGN_SUB = 0;
/** Vertical alignment bit `VALIGN_CENTER`: text is centred vertically. */
export const VALIGN_CENTER = 8;
/** Vertical alignment bit `VALIGN_TOP`: text sits at the top of the frame. */
export const VALIGN_TOP = 4;
/** Horizontal alignment of `AssStyle.alignment`, libass `ass_types.h` `HALIGN_LEFT`: text is aligned to the left margin. */
export const HALIGN_LEFT = 1;
/** Horizontal alignment `HALIGN_CENTER`: text is centred between the margins. */
export const HALIGN_CENTER = 2;
/** Horizontal alignment `HALIGN_RIGHT`: text is aligned to the right margin. */
export const HALIGN_RIGHT = 3;

/**
 * One `[V4+ Styles]` line, libass `ASS_Style`. Sizes are script pixels (the script's PlayRes grid, scaled to the
 * frame at render time). A style supplies the starting state of each event that names it; override tags in the
 * event text change that state for the event, and `\r` returns to it.
 */
export interface AssStyle {
  /** The style's name, which an event's `Style` field and the `\r` tag refer to. */
  readonly name: string;
  /** The font family to draw with (`Fontname`); a leading `@` asks for the vertical form. */
  readonly fontName: string;
  /** The font size in script pixels (`Fontsize`). */
  readonly fontSize: number;
  /** 0xRRGGBBAA, AA = transparency (0 opaque, 255 clear). The fill colour of text (`PrimaryColour`). */
  readonly primaryColour: number;
  /** The colour of a karaoke syllable before it is sung (`SecondaryColour`), same layout as `primaryColour`. */
  readonly secondaryColour: number;
  /** The outline colour (`OutlineColour`); with BorderStyle 3 the colour of the box behind the text. */
  readonly outlineColour: number;
  /** The shadow colour (`BackColour`); with BorderStyle 3 the colour of the shadow of the box. */
  readonly backColour: number;
  /** Bold: 0 for regular, 1 for bold (the parser reduces any non-zero header value to 1). */
  readonly bold: number;
  /** Italic: 0 for upright, 1 for italic. */
  readonly italic: number;
  /** Underline: 0 or 1. */
  readonly underline: number;
  /** Strike-out: 0 or 1. */
  readonly strikeOut: number;
  /** Width and height scale of the glyphs as fractions, 1 meaning 100% (libass divides the header's percentages by 100). */
  readonly scaleX: number;
  readonly scaleY: number;
  /** Extra space between characters, script pixels; the parser keeps it at zero or above. */
  readonly spacing: number;
  /** Rotation about the z axis in degrees, counter-clockwise. */
  readonly angle: number;
  /** 1 draws an outline and a shadow, 3 draws an opaque box behind the text (`BorderStyle`). */
  readonly borderStyle: number;
  /** The outline width in script pixels. */
  readonly outline: number;
  /** The shadow distance in script pixels. */
  readonly shadow: number;
  /** libass's internal legacy (\a) numbering, VALIGN_* | HALIGN_*, as process_style stores it. */
  readonly alignment: number;
  /** Margins in script pixels: left, right and vertical (from the bottom or top edge, by alignment). */
  readonly marginL: number;
  readonly marginR: number;
  readonly marginV: number;
  /** The script's `Encoding` (a Windows character set number), carried as written. */
  readonly encoding: number;
  /** Carried from `ASS_Style.treat_fontname_as_pattern`, which libass leaves unused. */
  readonly treatFontNameAsPattern: number;
  /** A default `\blur` for events in this style, the same values as the tag. */
  readonly blur: number;
  /** Text justification independent of the alignment: 0 follows the alignment, 1 left, 2 centre, 3 right. */
  readonly justify: number;
}

/** One `Dialogue` line, libass `ASS_Event`: text kept as written, its override tags read at render time. */
export interface AssEvent {
  /** File order (external scripts have no ReadOrder field). Breaks ties between events on one layer. */
  readonly readOrder: number;
  /** Events on a higher layer draw over lower ones, and collisions are resolved within a layer only. */
  readonly layer: number;
  /** ms */
  readonly start: number;
  /** ms */
  readonly duration: number;
  /** Index into AssTrack.styles. */
  readonly style: number;
  /** The `Name` (actor) field, which rendering ignores. */
  readonly name: string;
  /** Margins in script pixels that override the style's when non-zero: left, right and vertical. */
  readonly marginL: number;
  readonly marginR: number;
  readonly marginV: number;
  /** The `Effect` field; the renderer does not draw its Banner and Scroll transitions. */
  readonly effect: string;
  /** The text with its `{...}` override blocks, `\N` and `\n` breaks and `\h` spaces still in it. */
  readonly text: string;
}

/** A parsed script, libass `ASS_Track`. */
export interface AssTrack {
  /** `ass` for a script with a `[V4+ Styles]` section, `ssa` for the older format, `unknown` if neither was seen. */
  readonly trackType: 'ass' | 'ssa' | 'unknown';
  /** `PlayResX` and `PlayResY`: the coordinate grid the script is written on; positions, sizes and margins are in it. */
  readonly playResX: number;
  readonly playResY: number;
  /** `LayoutResX` and `LayoutResY`: the grid layout is done on when given (0 otherwise), for scripts authored against another size. */
  readonly layoutResX: number;
  readonly layoutResY: number;
  /** `WrapStyle`: 0 smart wrap, 1 end-of-line wrap only, 2 no wrap, 3 smart wrap with the lower line wider. */
  readonly wrapStyle: number;
  /** `ScaledBorderAndShadow`: whether outline and shadow scale with the frame like everything else (true) or keep their size relative to the layout grid. */
  readonly scaledBorderAndShadow: boolean;
  /** `Kerning`: whether the shaper applies kerning pairs. */
  readonly kerning: boolean;
  /** `YCbCr Matrix`: the colour matrix the script's colours were authored in. */
  readonly ycbcrMatrix: YCbCrMatrix;
  /** `Language`: the script's language code, or null. */
  readonly language: string | null;
  /** Index 0 is libass's built-in "Default" (Arial 18). */
  readonly styles: readonly AssStyle[];
  /** The last style named "Default", else 0. */
  readonly defaultStyle: number;
  /** The dialogue events in file order. */
  readonly events: readonly AssEvent[];
  /** Fonts embedded in the script's `[Fonts]` section, decoded: file name and bytes. */
  readonly fonts: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  /** Dialogue lines dropped as malformed. */
  readonly skippedLines: number;
  /** Dialogue lines seen. */
  readonly eventLines: number;
  /** The [Events] Format line's fields (the format events were read with), when the script has one. */
  readonly eventFormat?: string | null;
}
