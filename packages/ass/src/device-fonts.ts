/*
 * Fonts installed on the device, for a family the subtitles name but nothing supplied (no attachment, [Fonts] entry
 * or file of the viewer's matches it). This is an addition to the libass port, not ported from libass: libass asks
 * its system font provider (fontconfig, CoreText, DirectWrite) for such a family, and a browser offers no list of
 * installed fonts, only CSS `local()`, which loads one face by its full or PostScript name. So each style of the
 * family is asked for by the names that face is likely to carry, and what layout needs from the face's tables is
 * measured with the browser instead:
 * - ascender and descender: `fontBoundingBoxAscent` and `fontBoundingBoxDescent` of the loaded face;
 * - weight and italic: the style whose names it was loaded by;
 * - coverage: every character counts as covered, so a character the face lacks is drawn by the browser's own
 *   fallback for it rather than by the default font, as libass would;
 * - ligatures: none from GSUB (advances still come from the browser's shaping of the run);
 * - underline and strike-out: typical proportions, since the canvas can't measure them.
 * So lines in a device font are laid out close to, but not exactly as, libass would lay them out with the same font.
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import type { FaceInfo } from './font-tables';

/** A face's vertical metrics as fractions of its em size, as the browser measured them. */
export interface DeviceFaceMetrics {
  readonly ascent: number;
  readonly descent: number;
}

/** Loads installed faces by their CSS `local()` names. */
export interface DeviceFontSource {
  /** Registers, under `cssFamily`, the first installed face named by `names` and measures it; null when none is. */
  load(cssFamily: string, names: readonly string[]): Promise<DeviceFaceMetrics | null>;
  unload(cssFamily: string): void;
}

export type DeviceStyle = 'regular' | 'bold' | 'italic' | 'boldItalic';
export const DEVICE_STYLES: readonly DeviceStyle[] = ['regular', 'bold', 'italic', 'boldItalic'];

const STYLE_WORDS: Record<DeviceStyle, readonly [full: string, ps: string]> = {
  regular: ['Regular', 'Regular'],
  bold: ['Bold', 'Bold'],
  italic: ['Italic', 'Italic'],
  boldItalic: ['Bold Italic', 'BoldItalic'],
};

/**
 * The names a style of `family` is likely installed under, for `local()`, which matches a face's full name or
 * PostScript name: "Family Bold" and "Family-Bold"; the regular face also as the bare family, which is how most
 * regular faces' full names read.
 */
export function localNames(family: string, style: DeviceStyle): string[] {
  const ps = family.replace(/\s+/g, '');
  const [full, psStyle] = STYLE_WORDS[style];
  return style === 'regular' ? [family, `${family} ${full}`, ps, `${ps}-${psStyle}`] : [`${family} ${full}`, `${ps}-${psStyle}`];
}

const UNITS_PER_EM = 1000;

/** A FaceInfo for an installed face: the family it was asked for, the style's weight, the measured metrics. */
export function deviceFaceInfo(family: string, style: DeviceStyle, m: DeviceFaceMetrics): FaceInfo {
  const bold = style === 'bold' || style === 'boldItalic';
  const italic = style === 'italic' || style === 'boldItalic';
  return {
    file: `local(${family})`, index: 0, families: [family], fullNames: [], postscriptName: null,
    weight: bold ? 700 : 400, italic, bold, isPostscript: false, unitsPerEm: UNITS_PER_EM, integerPpem: false,
    ascender: Math.round(m.ascent * UNITS_PER_EM), descender: -Math.round(m.descent * UNITS_PER_EM),
    underlinePosition: -100, underlineThickness: 70, strikeoutPosition: 260, strikeoutSize: 70,
    hasGlyph: () => true,
    glyphId: () => 1,
    clusters: (cps) => cps.map((_, i) => i),
  };
}

/** A CSS string for `local()`: quotes and backslashes escaped. */
const cssString = (s: string): string => `'${s.replace(/[\\']/g, (c) => `\\${c}`)}'`;

/**
 * The browser's installed fonts, through FontFaces in `fontSet` (the worker's self.fonts), measured on `ctx`. Where
 * `local()` finds nothing (or the browser refuses it) a face is simply missing, and the default font draws.
 */
export function createDeviceFontSource(fontSet: FontFaceSet, ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D): DeviceFontSource {
  const faces = new Map<string, FontFace>();
  return {
    async load(cssFamily, names) {
      let face: FontFace;
      try {
        face = new FontFace(cssFamily, names.map((n) => `local(${cssString(n)})`).join(', '));
        await face.load();
      } catch {
        return null;
      }
      fontSet.add(face);
      faces.set(cssFamily, face);
      ctx.save();
      ctx.font = `1000px "${cssFamily}"`;
      const m = ctx.measureText('Hg');
      ctx.restore();
      const ascent = m.fontBoundingBoxAscent / 1000;
      const descent = m.fontBoundingBoxDescent / 1000;
      // no font box (an older engine): proportions typical of Latin text faces
      return Number.isFinite(ascent) && Number.isFinite(descent) && ascent + descent > 0 ? { ascent, descent } : { ascent: 0.9, descent: 0.212 };
    },
    unload(cssFamily) {
      const face = faces.get(cssFamily);
      if (face) fontSet.delete(face);
      faces.delete(cssFamily);
    },
  };
}
